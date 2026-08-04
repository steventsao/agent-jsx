# Hybrid OCR reproduction — same models, same results

**STATUS: GREEN (2026-08-03).** The hybrid layout+OCR pipeline is built twice on
the same inputs with the same real models — once as a hand-written imperative
Python script, once in the agent-jsx composition grammar — and the outputs are
deep-equal with no normalization.

This is the PDF-PIPELINE.md Phase A/B methodology applied to live models instead
of fixture regions: *reference is the oracle, composition must reproduce it
exactly.* The prior pipeline swapped a **fixture** layout step for a compiled
target; this one swaps the fixture for **actual models** and shows the
composition does not care.

Two pages are reproduced, because a page with no table cannot prove the table
branch runs:

| Page | Input | Regions | Proves |
| --- | --- | --- | --- |
| p1 | `fixtures/pdf/sample-pdf.ts` | 12 text, 1 figure, 0 table | text branch + figure drop |
| p32 | `fixtures/table-page.pdf` | 9 text, 0 figure, **1 table** | table branch is reached, not just declared |

## The stack

| Stage | Model | Source | Paper |
| --- | --- | --- | --- |
| Layout detection | DocLayout-YOLO (DocStructBench) | HF `juliozhao/DocLayout-YOLO-DocStructBench`, file `doclayout_yolo_docstructbench_imgsz1024.pt`, pip `doclayout-yolo==0.0.4` | arXiv 2410.12628; the layout stage inside MinerU (arXiv 2409.18839) |
| Text recognition | RapidOCR (PP-OCRv4 det + cls + rec, ONNX) | pip `rapidocr-onnxruntime==1.4.4`, ONNXRuntime 1.28.0, **CPU** | arXiv 2009.09941 (PP-OCR) |
| Table structure | RapidTable **SLANet-plus** (ONNX, 7.4MB) | pip `rapid-table==3.0.2`, model `slanet-plus.onnx` from ModelScope `RapidAI/RapidTable` @ `v2.0.0`, sha256 `d57a942a…4514b`, **CPU** | PP-Structure (arXiv 2210.05391); SLANet lineage surveyed in arXiv 2507.05595 |
| Page raster | pypdfium2 5.12.1 @ 150 DPI | — | — |

Runtime: Python 3.12.11, torch 2.13.0 (CPU only), Pillow 12.3.0, macOS arm64.
Frozen set in `requirements.lock.txt`.

RapidOCR was chosen over surya-ocr for the recognition stage because ONNXRuntime
on CPU is bit-reproducible run to run and the model set is ~20MB rather than
~1.5GB. **SLANet-plus was chosen for the same reason** — it is the same
ONNXRuntime-CPU regime, 7.4MB, and single-threaded it reproduces bit-for-bit
(verified over three consecutive runs before it was wired in). Docling's
TableFormer was the documented fallback and was not needed. Determinism is the
acceptance bar here, not table-recognition accuracy — the pipeline is not being
benchmarked, it is being **reproduced**.

SLANet-plus recovers table *structure* only. The cell **text** comes from the
same RapidOCR call that a text region would get, so a table and a paragraph on
the same page are read by the same recognizer on the same terms; only the
assembler differs.

## Input

Both pages come from the **same paper**: arXiv 2602.19961v1, *Unlocking
Multimodal Document Intelligence: From Current Triumphs to Future Frontiers of
Visual Document Retrieval* (Yan et al.).

- **p1** — `fixtures/pdf/sample-pdf.ts`, the repo's already-committed ParseBench
  sample (`docs/layout/2602.19961v1_p1.pdf`), rendered to 1241×1754 at 150 DPI.
  The two paths reach that PDF *independently* (Phase A through
  `sample_pdf.py`, Phase B through the TS fixture module) and the test asserts
  both produce the same page sha256.
- **p32** — `fixtures/table-page.pdf` (210,808 bytes, sha256 `64e7577d…abe2`).
  Page 32 of the same paper, extracted with `pypdfium2` from the full 34-page
  PDF (`https://arxiv.org/pdf/2602.19961v1`, sha256 `cc59d21a…bf4c`). The
  extracted single page renders **pixel-identically** to the page in situ
  (asserted at extraction time), 1241×1754 at 150 DPI, and carries Table 7 — a
  12×5 grid. Unlike p1 there is no second decode path: both phases open this
  same file. The page sha256 is still asserted against the oracle's, so
  identical input pixels stay *proven*; what is not additionally exercised is
  the base64-fixture decode.

**Licensing.** Both pages are from a paper distributed under the *arXiv.org
perpetual, non-exclusive license* (`nonexclusive-distrib/1.0`) — not a Creative
Commons license. Page 1 of this exact paper was already committed to this
Apache-2.0 repo, so adding page 32 of the same document introduces **no new
rights surface**. That was the deciding factor; see below.

**OmniDocBench: checked, deliberately NOT used.** `opendatalab/OmniDocBench`
was inspected first, as the brief preferred. It declares **no formal open-source
license** — its card states the dataset is *"for research purposes only and not
for commercial use"*, and its pages are third-party PDFs "collected from public
online channels and community user contributions". Vendoring one of those images
into a public Apache-2.0 repo would put a non-commercial, unlicensed,
unknown-provenance artifact in the tree. The arXiv fallback the brief allowed for
is strictly safer *and* stronger for the experiment: same source document as the
existing fixture, same renderer, 210KB of vector PDF instead of a multi-MB
raster. **If the table page should be swapped for an OmniDocBench sample anyway,
that is a rights call for the repo owner, not a technical blocker** — the engine,
the goldens, and the tests are all page-agnostic.

## Files

| Path | Role |
| --- | --- |
| `scripts/hybrid/engines.py` | The single implementation of every model call and every pixel operation. Subcommands `render-page`, `layout`, `crop`, `ocr`, `table`, `version`. Both paths shell into this. |
| `scripts/hybrid/reference.py` | **Phase A oracle.** Flat imperative script, run once per page: render → layout → drop figures → crop → ocr/table → assemble. |
| `scripts/hybrid/reference-output.json` | The p1 golden. `{"segments":[{id,tag,bbox,text}]}` and nothing else. |
| `scripts/hybrid/reference-output-table.json` | The p32 golden. Text rows as above; the table row is `{id,tag,bbox,rows}`. |
| `scripts/hybrid/reference-meta[-table].json` | Provenance: page sha256, per-crop sha256 + pixel box, region counts. Not part of the equality object. |
| `scripts/hybrid/fixtures/table-page.pdf` | The p32 input (see Input). |
| `scripts/hybrid/sample_pdf.py` | Decodes the base64 TS fixture into a real PDF. |
| `examples/hybrid/engines.ts` | **Phase B** engine adapter — `HybridEngines`, one `engines.py` subprocess per capability call. |
| `examples/hybrid/hybrid-pipeline.tsx` | **Phase B** composition: layout agent → tag dispatch → attenuated per-region specialists → assemble `<task>`. |
| `tests/hybrid-repro.test.tsx` | The equality tests (gated, both pages) + an always-on oracle-shape guard over both goldens. |

## Why `crop` is an engine, not TS pixel math

The question under test is whether the *composition grammar* reproduces the
*hand-written pipeline*. If cropping were reimplemented in TypeScript, a one-pixel
rounding difference would fail the equality test for a reason that has nothing to
do with composition. So the crop is a capability like any other and its
implementation is the same `engines.py crop` subcommand Phase A calls. That both
paths really did recognize identical pixels is **asserted**, not assumed: the test
re-hashes every crop the composition produced and compares against the sha256s
in the meta files.

## Tag mapping

DocStructBench emits 10 classes; the composition dispatches on three tags.

| DocStructBench class | Tag | Specialist |
| --- | --- | --- |
| `title`, `plain text`, `figure_caption`, `table_caption`, `table_footnote`, `isolate_formula`, `formula_caption` | `text` | `OcrText` → RapidOCR |
| `table` | `table` | `ParseTable` → SLANet-plus + RapidOCR |
| `figure` | `figure` | **none** — no text layer, no specialist mounts |
| `abandon` (headers/footers/page numbers) | — | **dropped entirely**, never silently folded into `text` |

Segment rows are as narrow as the branch they came from: a text segment is
exactly `{id,tag,bbox,text}`, a table segment exactly `{id,tag,bbox,rows}`. The
unused key is *absent*, not `undefined` — deep-equality treats a
present-but-undefined key as absent, so writing `text: undefined` on a table
would quietly widen what the golden accepts.

## Determinism rules

Equality depends on all seven; they live as `D1`–`D7` in `engines.py`.

- **D1** Everything on CPU. No MPS, no CUDA, single-threaded (including
  ONNXRuntime `intra_op`/`inter_op` for the table model). torch/NumPy/random
  seeded 0.
- **D2** Layout confidence threshold fixed at 0.25, `imgsz` 1024. No call-time tuning.
- **D3** Regions sorted by `(y0, x0, x1, y1, tag, cls)` on rounded values, and
  only *then* assigned ids `r0..rN`. Model output order never leaks.
- **D4** Every float crossing the process boundary goes through `q()` → 4 decimals.
  Nothing is rounded at comparison time.
- **D5** Crops computed in one place; box = `int(round(v * size))`, clamped, min 1px.
- **D6** OCR lines re-sorted top-to-bottom then left-to-right, whitespace collapsed.
  RapidOCR's own ordering is not trusted.
- **D7** **Table rows mapping.** SLANet emits one token stream, from which
  RapidTable derives *both* an HTML table whose `<td>`s already carry the matched
  OCR text *and* `logic_points`, the same cells as integer grid spans
  `(row_start, row_end, col_start, col_end)`. Because both come from that one
  stream, the Nth `<td>` **is** the Nth logic point; `engines.py` asserts the
  counts match and **raises rather than guessing** an alignment if they ever
  stop matching. Rows are then built by pure integer placement, never geometry:
  the grid is `(max row_end + 1) × (max col_end + 1)` pre-filled with `""`, and
  each cell's text is written into **every** `(r, c)` its span rectangle covers —
  so a `colspan`/`rowspan` cell *repeats* rather than leaving a hole, and every
  row stays the same width. Cell text is HTML-unescaped, stripped of residual
  inline tags, and whitespace-collapsed by the same rule as D6. No float, no
  sort, and no tolerance enter this path.

Ordering note: ids sort **numerically** (`r10` after `r9`). Lexicographic order
would put `r10`–`r12` between `r1` and `r2`; both paths implement the same rule
(`id_order` in `reference.py`, `idOrder` in `hybrid-pipeline.tsx`).

`engines.py` also pins stdout to the JSON payload alone (model/hub chatter is
redirected to stderr), so the caller never has to fish a payload out of log noise.

## Running it

```bash
# one-time: python env (~2 min, models download on first use: ~140MB)
cd scripts/hybrid
uv venv --python 3.12 .venv
VIRTUAL_ENV=.venv uv pip install -r pyproject.toml

# Phase A — regenerate both oracles (~19s)
scripts/hybrid/.venv/bin/python scripts/hybrid/reference.py

# Phase B — prove the composition reproduces them (~55s)
HYBRID_REPRO=1 bun test tests/hybrid-repro.test.tsx

# ordinary CI: the equality tests skip, the oracle-shape guard runs
bun test tests
```

Both `reference-output*.json` are committed and are the goldens. Regenerate them
only when the pipeline spec changes, and review the diff — same rule as
`fixtures/pdf/golden-segments.json`.

## The claim, with transcript

Same models, same pages, two completely different orchestrations, identical
output. Phase A run twice is byte-identical across all four artifacts:

```
$ scripts/hybrid/.venv/bin/python scripts/hybrid/reference.py
reference[reference-output.json]: 13 regions detected, 1 figure(s) dropped, 0 table(s), 12 segments
    r0 [text ] Unlocking Multimodal Document Intelligence: From Current Triumphs toFutu
    ...
   r12 [text ] Furthermore, as the general capabilities of Multi- modal Large Language
reference[reference-output-table.json]: 10 regions detected, 0 figure(s) dropped, 1 table(s), 10 segments
    r0 [text ] Table 7:Amulti-dimensional comparison of representativeworksinMatryoshka
    r1 [table] 12x5 grid; row0: Representative Works | Modality | Target Task | Matryoshka O
    r2 [text ] the training paradigm itself, such as the sequen- (Zhang et al.,2025a)a
    ...
    r9 [text ] focusontheco-designof Futurework mustf agentsandVDRtoolstofoster amoreor

$ # re-run, then diff every artifact against the first run
  reference-output.json:        DETERMINISTIC
  reference-meta.json:          DETERMINISTIC   (page + all crop sha256 stable)
  reference-output-table.json:  DETERMINISTIC
  reference-meta-table.json:    DETERMINISTIC
```

Phase B against those oracles — **31 pass, 0 fail**, both pages:

```
$ HYBRID_REPRO=1 bun test tests/hybrid-repro.test.tsx
(pass) hybrid oracle — committed reference p1 (text + figure, no table) > ... [7 tests]
(pass) hybrid oracle — committed reference p32 (text + table, no figure) > ... [7 tests]
(pass) hybrid assembly — the deterministic <task> body > drops figures, keeps {id,tag,bbox,text}, orders ids numerically
(pass) hybrid assembly — the deterministic <task> body > treats an empty recognition as a completed segment, not a hole
(pass) hybrid assembly — the deterministic <task> body > emits rows (and NO text key) for a table region
(pass) … p1 … > live > starts from byte-identical page pixels [27413.48ms]
(pass) … p1 … > live > produces segments DEEP-EQUAL to the hand-written oracle
(pass) … p1 … > live > recognized byte-identical crops — attenuation yields the oracle's pixels
(pass) … p1 … > live > dispatches each region to its OWN specialist and NONE for figures
(pass) … p1 … > live > mounts exactly the table specialists the oracle says the page has
(pass) … p1 … > live > never puts page bytes in a child's config — children pull, never receive
(pass) … p1 … > live > the oracle bites: a shifted bbox cannot reproduce the golden segment [1663.00ms]
(pass) … p32 … > live > starts from byte-identical page pixels [23659.02ms]
(pass) … p32 … > live > produces segments DEEP-EQUAL to the hand-written oracle
(pass) … p32 … > live > recognized byte-identical crops — attenuation yields the oracle's pixels
(pass) … p32 … > live > dispatches each region to its OWN specialist and NONE for figures
(pass) … p32 … > live > mounts exactly the table specialists the oracle says the page has
(pass) … p32 … > live > never puts page bytes in a child's config — children pull, never receive
(pass) … p32 … > live > the oracle bites: a shifted bbox cannot reproduce the golden segment [2411.66ms]

 31 pass
 0 fail
 726 expect() calls
Ran 31 tests across 1 files. [55.19s]
```

Ordinary CI and typecheck:

```
$ bun test tests
 275 pass
 14 skip
 0 fail
 1258 expect() calls
Ran 289 tests across 35 files. [460.00ms]

$ bunx tsc --noEmit
(no output, exit 0)
```

Equality is `toEqual` on the entire segments array — exact strings, exact floats,
exact table grids, exact order, **no normalization** — plus an exact key-set
comparison, because deep-equality alone would let a table smuggle in an
undefined `text`. If a normalization step is ever required, it must be spelled
out in the test comment and nowhere else. There is currently none.

The equality has teeth in both directions:

- **it bites** — re-cropping a region from a bbox shifted 12% down the page and
  running it through the same engines yields different output. For p1 that is a
  different string; for p32 the shifted crop yields a real but *wrong* 6×5 grid
  of neighbouring body text, not an empty one, so the negative control is
  substantive rather than vacuous.
- **it is not trivially satisfied** — the composition must independently
  reproduce the figure drop, the numeric id ordering, the per-region attenuated
  crop, the tag→specialist dispatch, and the assembly shape. Any of those
  diverging fails the deep-equal.

## What adding tables cost the composition

The point of the exercise: extending a live pipeline with a new region type is
a *local* change. `examples/hybrid/hybrid-pipeline.tsx` gained a `ParseTable`
specialist and a second `map` over a filtered list. It did **not** change
attenuation (a table child gets the same zero-arg `crop` closure, and still
cannot name a bbox or see the page), the pull-don't-push rule, the figure drop,
the "empty result is complete, not pending" predicate, or the one-shot assemble
`<task>`. `engines.ts` gained one method on `HybridEngines` of exactly the same
shape as `ocr`.

Honest caveat: the table branch was previously *documented* but not *coded* —
every non-figure region mounted `OcrText`, so a table would have been flattened
into a single string rather than dispatched. Making the branch real therefore
required editing the composition, not only the engine adapter.

## TODOs

- **OmniDocBench.** Not vendored, for the licensing reason above. If wider tag
  coverage (handwriting, newspapers, multi-column exam papers) is wanted, the
  cheapest safe route is to download at eval time rather than commit a page.
- **Spanned cells.** D7 repeats a `colspan`/`rowspan` cell's text into every grid
  position it covers, because a `string[][]` cannot express "merged". No page
  tested so far actually contains a spanned cell — Table 7 is a plain 12×5 grid —
  so that rule is specified and implemented but not yet *exercised* by a golden.
  A page with a merged header cell would be the next useful fixture.
- **Speed.** One short-lived python process per capability call (~5s of model
  load each) makes the live test ~55s. Deliberate — a live child agent pays the
  same cost — but a persistent line-delimited JSON worker would cut it
  substantially if the test ever needs to run per-commit.
