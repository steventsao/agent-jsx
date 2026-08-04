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

Three pages are reproduced. Each one exists because the previous ones cannot
stand in for it — a page with no table cannot prove the table branch runs, and a
table with no merged cell cannot prove the span-repetition rule runs:

| Page | Input | Regions | Proves |
| --- | --- | --- | --- |
| p1 | `fixtures/pdf/sample-pdf.ts` | 12 text, 1 figure, 0 table | text branch + figure drop |
| p32 | `fixtures/table-page.pdf` | 9 text, 0 figure, **1 table** | table branch is reached, not just declared |
| PubTabNet | `fixtures/pubtabnet-PMC5343394_003_00.png` | 0 text, 0 figure, **1 table with 10 merges** | **D7's colspan/rowspan repetition runs** |

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

The first two pages come from the **same paper**: arXiv 2602.19961v1, *Unlocking
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

- **PubTabNet** — `fixtures/pubtabnet-PMC5343394_003_00.png` (64,612 bytes,
  486×267, sha256 `d2436658…67d3`). Table 3 of PMC5343394, from IBM's
  **PubTabNet** table-recognition corpus. This one is not a page at all: it is a
  table *crop*, and it is here for one reason — it has **merged cells**, which
  neither arXiv page does. Ground truth ships alongside it as
  `…_003_00.gt.json`. Both phases open this same committed PNG, and its sha256
  is asserted against the oracle's page hash and against the GT file's, so the
  golden is provably tied to the licensed raster.

  *A crop, run as a page — honestly.* The obvious worry is that feeding a bare
  crop to a page-layout model means hand-feeding the region. It does not:
  DocLayout-YOLO is given the crop exactly as it is given a page, and genuinely
  returns one `table` region on it (score 0.6402), so the full
  layout → crop → ParseTable path runs and no layout output is fabricated. Two
  consequences are reported rather than corrected for: the detected box is
  *tighter* than PubTabNet's frame — it clips the narrow leading "S. No" column,
  so the pipeline recognizes a 21×**4** grid where GT is 21×**5** — and 10 of
  GT's 20 merges live in that clipped column and are therefore never seen. Both
  facts are in the agreement report below. The crop-level fallback (one fixed
  region covering the whole image) was **not** needed and is not used.

**Licensing.** The first two pages are from a paper distributed under the *arXiv.org
perpetual, non-exclusive license* (`nonexclusive-distrib/1.0`) — not a Creative
Commons license. Page 1 of this exact paper was already committed to this
Apache-2.0 repo, so adding page 32 of the same document introduces **no new
rights surface**. That was the deciding factor; see below.

**PubTabNet licensing.** This fixture *does* add a rights surface, so it was
cleared before it was vendored. PubTabNet splits into two rights holders and
both are honoured in `fixtures/LICENSES.md`:

| Artefact | Holder | Licence |
| --- | --- | --- |
| the `.gt.json` annotation | IBM | **CDLA-Permissive-1.0** — full text reproduced, as its §3.1(a) requires of anyone republishing |
| the `.png` raster | the article's authors | **CC BY 4.0** |

IBM's `LICENSE.md` is explicit that it does *not* own the images: they are PMC
Open Access pages, whose terms are **per article**. So the corpus licence proves
nothing about any single image, and PMC5343394 was checked on its own —
`license="CC BY"` from the NCBI OA service, plus the article's verbatim
`<permissions>` statement, both quoted in `fixtures/LICENSES.md`.
`fetch_pubtabnet_fixture.py` re-runs that check on every fetch and **refuses to
write the fixture** if the article is not CC BY, so the rule is enforced rather
than remembered.

**One honest wart: these are not IBM's original PNG bytes.** The fixture was
acquired per-row through the HF datasets-server (no bulk download — the corpus
is 11GB and reading the original PNG would have meant pulling a ~99MB parquet
row group). That endpoint serves images through a CDN that re-encodes them to
JPEG, and the signed URL cannot be re-pointed at the original (`image.png` →
HTTP 403). The committed PNG is therefore that JPEG rendition, losslessly
re-encoded — same 486×267 frame, same table, slightly different pixels from
IBM's. Both hashes are recorded in the `.gt.json` so the chain is checkable end
to end, and CC BY's "indicate if changes were made" is satisfied in
`LICENSES.md`. This costs the experiment nothing: the equality bar is that the
two *phases* read the same committed bytes, not that those bytes match IBM's
encoder. It does mean the reported accuracy number is measured on a slightly
lossy raster.

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

PubTabNet is the counter-example that shows what the bar actually is. It is also
a third-party document corpus, and it *was* vendored — because it names its
licence (CDLA-Permissive-1.0), names the terms on its images (PMC Open Access),
and those terms resolve to a specific, checkable per-article licence. The
objection to OmniDocBench was never "third-party data"; it was unlicensed data of
unknown provenance.

## Files

| Path | Role |
| --- | --- |
| `scripts/hybrid/engines.py` | The single implementation of every model call and every pixel operation. Subcommands `render-page`, `layout`, `crop`, `ocr`, `table`, `version`. Both paths shell into this. |
| `scripts/hybrid/reference.py` | **Phase A oracle.** Flat imperative script, run once per page: render → layout → drop figures → crop → ocr/table → assemble. |
| `scripts/hybrid/reference-output.json` | The p1 golden. `{"segments":[{id,tag,bbox,text}]}` and nothing else. |
| `scripts/hybrid/reference-output-table.json` | The p32 golden. Text rows as above; the table row is `{id,tag,bbox,rows}`. |
| `scripts/hybrid/reference-output-pubtabnet.json` | The PubTabNet golden — one table row, 21×4, with 10 repeated spans. |
| `scripts/hybrid/reference-meta[-table\|-pubtabnet].json` | Provenance: page sha256, per-crop sha256 + pixel box, region counts, and per table the model's **merged** cells with their spans. Not part of the equality object. |
| `scripts/hybrid/fixtures/table-page.pdf` | The p32 input (see Input). |
| `scripts/hybrid/fixtures/pubtabnet-PMC5343394_003_00.png` | The PubTabNet input — a real table crop with merged cells. |
| `scripts/hybrid/fixtures/pubtabnet-PMC5343394_003_00.gt.json` | Its ground truth (annotation + derived grid/spans) and full provenance. |
| `scripts/hybrid/fixtures/LICENSES.md` | CDLA-Permissive-1.0 in full, the article's CC BY statement verbatim, and the exact HF row the fixture came from. |
| `scripts/hybrid/fetch_pubtabnet_fixture.py` | Reproduces both PubTabNet artifacts from scratch, licence check included. |
| `scripts/hybrid/sample_pdf.py` | Decodes the base64 TS fixture into a real PDF. |
| `examples/hybrid/engines.ts` | **Phase B** engine adapter — `HybridEngines`, one `engines.py` subprocess per capability call. |
| `examples/hybrid/hybrid-pipeline.tsx` | **Phase B** composition: layout agent → tag dispatch → attenuated per-region specialists → assemble `<task>`. |
| `tests/hybrid-repro.test.tsx` | The equality tests (gated, all three pages) + always-on guards over all three goldens: oracle shape, D7 span repetition, and the ground-truth report. |

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

  **D7 is exercised, not just specified.** This used to be the rule's weak
  point: it was implemented and documented, but no page in the repro contained a
  merged cell, so the repetition branch never ran. The PubTabNet page fixes
  that — SLANet recovers **10 `rowspan=2` cells** on it, and the golden shows
  each one's text in *both* of its rows. To make that checkable rather than
  merely asserted, `engines.py table` also returns the mapping's **inputs** —
  the model's pre-placement `spans` and `cells` — which `reference.py` records
  in the meta file for every merged cell. The tests then verify
  `rows[r][c] == cells[i]` at every position each span covers. Those fields are
  provenance only: `examples/hybrid/engines.ts` reads `rows` and ignores them, so
  adding them could not and did not move any golden. The p32 meta now records
  `"merged": []` against 60 cells, which is the evidence that page could never
  have exercised this rule.

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

# Phase A — regenerate all three oracles (~22s)
scripts/hybrid/.venv/bin/python scripts/hybrid/reference.py

# Phase B — prove the composition reproduces them (~64s)
HYBRID_REPRO=1 bun test tests/hybrid-repro.test.tsx

# ordinary CI: the equality tests skip; the oracle-shape guard, the D7 span
# check and the ground-truth report all run (no models, no python)
bun test tests

# only if the PubTabNet fixture must be re-acquired — re-fetches the pinned
# row, re-checks the article licence, rewrites the PNG + GT byte-identically
scripts/hybrid/.venv/bin/python scripts/hybrid/fetch_pubtabnet_fixture.py
```

All three `reference-output*.json` are committed and are the goldens. Regenerate
them only when the pipeline spec changes, and review the diff — same rule as
`fixtures/pdf/golden-segments.json`.

## The claim, with transcript

Same models, same pages, two completely different orchestrations, identical
output. Phase A run twice is byte-identical across all six artifacts:

```
$ scripts/hybrid/.venv/bin/python scripts/hybrid/reference.py
reference[reference-output.json]: 13 regions detected, 1 figure(s) dropped, 0 table(s), 12 segments
    r0 [text ] Unlocking Multimodal Document Intelligence: From Current Triumphs toFutu
    ...
   r12 [text ] Furthermore, as the general capabilities of Multi- modal Large Language
reference[reference-output-table.json]: 10 regions detected, 0 figure(s) dropped, 1 table(s), 10 segments
    r0 [text ] Table 7:Amulti-dimensional comparison of representativeworksinMatryoshka
    r1 [table] 12x5 grid, 0 merged cell(s); row0: Representative Works | Modality | Target Tas
    r2 [text ] the training paradigm itself, such as the sequen- (Zhang et al.,2025a)a
    ...
    r9 [text ] focusontheco-designof Futurework mustf agentsandVDRtoolstofoster amoreor
reference[reference-output-pubtabnet.json]: 1 regions detected, 0 figure(s) dropped, 1 table(s), 1 segments
    r0 [table] 21x4 grid, 10 merged cell(s); row0: Questions |  | Response Frequency(n=25i)Perc

$ # re-run, then diff every artifact against the first run
  reference-output.json              DETERMINISTIC
  reference-meta.json                DETERMINISTIC   (page + all crop sha256 stable)
  reference-output-table.json        DETERMINISTIC
  reference-meta-table.json          DETERMINISTIC
  reference-output-pubtabnet.json    DETERMINISTIC
  reference-meta-pubtabnet.json      DETERMINISTIC
```

Adding the third page did **not** move the first two — regenerating everything
with the PubTabNet page wired in leaves both existing goldens byte-identical:

```
$ cmp <before adding page 3> <after>
GOLDEN reference-output.json:        BYTE-IDENTICAL
GOLDEN reference-output-table.json:  BYTE-IDENTICAL
```

The two *meta* files do change, additively: each gained the `tables` block
described under D7. `reference-meta-table.json` now records
`"r1": {"grid": [12,5], "cell_count": 60, "merged": []}` — sixty cells on page
32's table and not one merge, which is the evidence that page could never have
exercised D7's repetition branch.

Phase B against those oracles — **54 pass, 0 fail**, all three pages:

```
$ HYBRID_REPRO=1 bun test tests/hybrid-repro.test.tsx
(pass) hybrid oracle — committed reference p1 (text + figure, no table) > … [8 tests]
(pass) hybrid oracle — committed reference p32 (text + table, no figure) > … [8 tests]
(pass) hybrid oracle — committed reference PubTabNet PMC5343394 (table with MERGED cells) > … [8 tests]
(pass) hybrid ground truth — PubTabNet PMC5343394 (reported, not gated) > the golden was produced from the licensed fixture, not a lookalike
(pass) hybrid ground truth — PubTabNet PMC5343394 (reported, not gated) > the fixture actually carries merged cells — otherwise it proves nothing

  PubTabNet GT agreement (REPORTED — not an assertion)
    fixture          PMC5343394_003_00.png  486x267  (PMC5343394, CC BY 4.0)
    GT grid          21x5, 20 merged cells
    model grid       21x4, 10 merged cells
    frame offset     1 GT column(s) — layout clipped the leading "S. No" column
    cell agreement   67.9%  (57/84 exact, whitespace/case-insensitive)
    span geometry    10/10 model spans match a GT span exactly

(pass) hybrid ground truth — PubTabNet PMC5343394 (reported, not gated) > REPORTS cell agreement and span structure against ground truth
(pass) hybrid assembly — the deterministic <task> body > … [3 tests]
(pass) … p1 … > live > starts from byte-identical page pixels [28027.92ms]
(pass) … p1 … > live > produces segments DEEP-EQUAL to the hand-written oracle
(pass) … p1 … > live > recognized byte-identical crops — attenuation yields the oracle's pixels
(pass) … p1 … > live > dispatches each region to its OWN specialist and NONE for figures
(pass) … p1 … > live > mounts exactly the table specialists the oracle says the page has
(pass) … p1 … > live > never puts page bytes in a child's config — children pull, never receive
(pass) … p1 … > live > the COMPOSITION's own grid repeats every merged cell across its span (D7)
(pass) … p1 … > live > the oracle bites: a shifted bbox cannot reproduce the golden segment [1677.57ms]
(pass) … p32 … > live > starts from byte-identical page pixels [23544.77ms]
(pass) … p32 … > live > produces segments DEEP-EQUAL to the hand-written oracle
(pass) … p32 … > live > recognized byte-identical crops — attenuation yields the oracle's pixels
(pass) … p32 … > live > dispatches each region to its OWN specialist and NONE for figures
(pass) … p32 … > live > mounts exactly the table specialists the oracle says the page has
(pass) … p32 … > live > never puts page bytes in a child's config — children pull, never receive
(pass) … p32 … > live > the COMPOSITION's own grid repeats every merged cell across its span (D7)
(pass) … p32 … > live > the oracle bites: a shifted bbox cannot reproduce the golden segment [2488.64ms]
(pass) … PubTabNet … > live > starts from byte-identical page pixels [5843.78ms]
(pass) … PubTabNet … > live > produces segments DEEP-EQUAL to the hand-written oracle
(pass) … PubTabNet … > live > recognized byte-identical crops — attenuation yields the oracle's pixels
(pass) … PubTabNet … > live > dispatches each region to its OWN specialist and NONE for figures
(pass) … PubTabNet … > live > mounts exactly the table specialists the oracle says the page has
(pass) … PubTabNet … > live > never puts page bytes in a child's config — children pull, never receive
(pass) … PubTabNet … > live > the COMPOSITION's own grid repeats every merged cell across its span (D7)
(pass) … PubTabNet … > live > the oracle bites: a shifted bbox cannot reproduce the golden segment [2587.52ms]

 54 pass
 0 fail
 1071 expect() calls
Ran 54 tests across 1 files. [64.21s]
```

Ordinary CI and typecheck:

```
$ bun test tests
 288 pass
 24 skip
 0 fail
 1547 expect() calls
Ran 312 tests across 35 files. [321.00ms]

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
  of neighbouring body text, not an empty one; for the PubTabNet page it yields a
  real but wrong **19×4 grid with zero merged cells** — the shift slices through
  the `rowspan=2` pairs and destroys exactly the structure the fixture exists to
  demonstrate. In all three cases the negative control is substantive rather
  than vacuous.
- **it is not trivially satisfied** — the composition must independently
  reproduce the figure drop, the numeric id ordering, the per-region attenuated
  crop, the tag→specialist dispatch, and the assembly shape. Any of those
  diverging fails the deep-equal.

## Ground truth: reported, never gated

The PubTabNet page is the first input that ships with an **answer key**, which
raises a question the other two never posed: should the pipeline be asserted
*correct*, not just *reproducible*?

No — and the separation is deliberate. SLANet does not reproduce PubTabNet's
ground truth and is not asked to. Asserting agreement would mean an unrelated
model upgrade shows up as a failure of the composition, which is the only thing
under test. So the equality gate stays exactly what it was — **reference ≡
composition** — and accuracy is *printed*:

```
  PubTabNet GT agreement (REPORTED — not an assertion)
    GT grid          21x5, 20 merged cells
    model grid       21x4, 10 merged cells
    frame offset     1 GT column(s) — layout clipped the leading "S. No" column
    cell agreement   67.9%  (57/84 exact, whitespace/case-insensitive)
    span geometry    10/10 model spans match a GT span exactly
```

Reading it:

- **67.9% of cells match exactly.** The misses are recognition noise on a small,
  slightly lossy raster — `56` read as `95`, `39` as `6E`, `55.0` as `055` — not
  structural errors. Structure is what this fixture is for, and structure is
  clean.
- **10/10 spans are exactly right.** Every merged cell the model reported has the
  same rectangle as a GT merge. It found half of GT's twenty because the other
  ten live in the "S. No" column that layout clipped away; of what it *saw*, it
  got the geometry perfect.
- **The frame offset is searched, not hard-coded.** The test tries every possible
  column alignment and reports the best one, so the number cannot be quietly
  tuned by asserting a convenient offset. It independently lands on 1, which is
  the shift layout's clipping implies.

What *is* asserted around ground truth is provenance, not accuracy: that the
golden's page sha256 equals the licensed fixture's, that the annotation is the
CC BY article's, and that the fixture still has merged cells at all — a guard
against a future re-fetch silently landing on a plain grid and turning D7 back
into an unexercised rule.

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
- ~~**Spanned cells.**~~ **Done** — the PubTabNet page exercises D7 with 10
  `rowspan=2` cells, and the tests check the repetition against the model's own
  pre-placement spans. What a `string[][]` still cannot express is *merged*: a
  reader of the golden sees the same string twice and cannot tell a merge from a
  genuine repeat. Only the meta file distinguishes them. Widening the segment
  shape to carry spans would fix that, at the cost of changing the equality
  object — worth doing only if a consumer actually needs it.
- **Only `rowspan` is exercised.** All ten merges on this fixture are vertical.
  D7 treats both axes identically (one loop per axis, no special-casing), and
  candidates with `colspan` merges were surveyed, but a golden with a horizontal
  merge — a spanning header — would close the last gap. Several CC BY candidates
  were found during selection; `fetch_pubtabnet_fixture.py` needs only a new
  pinned offset to add one.
- **The raster is not IBM's original PNG.** It is the datasets-server's JPEG
  rendition, losslessly re-encoded — see the licensing section. Costs the
  equality bar nothing, but slightly depresses the reported agreement number.
  Fixing it means reading a ~99MB parquet row group, which was out of scope.
- **Speed.** One short-lived python process per capability call (~5s of model
  load each) makes the live test ~64s. Deliberate — a live child agent pays the
  same cost — but a persistent line-delimited JSON worker would cut it
  substantially if the test ever needs to run per-commit. The PubTabNet page is
  the cheapest of the three (~6s) because it has exactly one region.
