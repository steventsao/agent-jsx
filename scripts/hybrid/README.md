# Hybrid OCR reproduction — same models, same results

**STATUS: GREEN (2026-08-03).** The hybrid layout+OCR pipeline is built twice on
the same input with the same two real models — once as a hand-written imperative
Python script, once in the agent-jsx composition grammar — and the outputs are
deep-equal with no normalization.

This is the PDF-PIPELINE.md Phase A/B methodology applied to live models instead
of fixture regions: *reference is the oracle, composition must reproduce it
exactly.* The prior pipeline swapped a **fixture** layout step for a compiled
target; this one swaps the fixture for **an actual layout model** and shows the
composition does not care.

## The stack

| Stage | Model | Source | Paper |
| --- | --- | --- | --- |
| Layout detection | DocLayout-YOLO (DocStructBench) | HF `juliozhao/DocLayout-YOLO-DocStructBench`, file `doclayout_yolo_docstructbench_imgsz1024.pt`, pip `doclayout-yolo==0.0.4` | arXiv 2410.12628; the layout stage inside MinerU (arXiv 2409.18839) |
| Text recognition | RapidOCR (PP-OCRv4 det + cls + rec, ONNX) | pip `rapidocr-onnxruntime==1.4.4`, ONNXRuntime 1.28.0, **CPU** | arXiv 2009.09941 (PP-OCR) |
| Page raster | pypdfium2 5.12.1 @ 150 DPI | — | — |

Runtime: Python 3.12.11, torch 2.13.0 (CPU only), Pillow 12.3.0, macOS arm64.
Frozen set in `requirements.lock.txt`.

RapidOCR was chosen over surya-ocr for the recognition stage because ONNXRuntime
on CPU is bit-reproducible run to run and the model set is ~20MB rather than
~1.5GB. Determinism is the acceptance bar here, not OCR accuracy — the pipeline
is not being benchmarked, it is being **reproduced**.

## Input

`fixtures/pdf/sample-pdf.ts` — the repo's committed ParseBench sample
(`docs/layout/2602.19961v1_p1.pdf`, arXiv 2602.19961 page 1), rendered to a
1241×1754 PNG at 150 DPI. The two paths reach that PDF *independently* (Phase A
through `sample_pdf.py`, Phase B through the TS fixture module) and the test
asserts both produce the same page sha256, so any later difference is
orchestration rather than input.

OmniDocBench samples: **not pulled** (see TODOs).

## Files

| Path | Role |
| --- | --- |
| `scripts/hybrid/engines.py` | The single implementation of every model call and every pixel operation. Subcommands `render-page`, `layout`, `crop`, `ocr`, `version`. Both paths shell into this. |
| `scripts/hybrid/reference.py` | **Phase A oracle.** Flat imperative script: render → layout → drop figures → crop → ocr → assemble. |
| `scripts/hybrid/reference-output.json` | The golden equality object. `{"segments":[{id,tag,bbox,text}]}` and nothing else. |
| `scripts/hybrid/reference-meta.json` | Provenance: page sha256, per-crop sha256 + pixel box, region counts. Not part of the equality object. |
| `scripts/hybrid/sample_pdf.py` | Decodes the base64 TS fixture into a real PDF. |
| `examples/hybrid/engines.ts` | **Phase B** engine adapter — `HybridEngines`, one `engines.py` subprocess per capability call. |
| `examples/hybrid/hybrid-pipeline.tsx` | **Phase B** composition: layout agent → tag dispatch → attenuated per-region OCR specialists → assemble `<task>`. |
| `tests/hybrid-repro.test.tsx` | The equality test (gated) + an always-on oracle-shape guard. |

## Why `crop` is an engine, not TS pixel math

The question under test is whether the *composition grammar* reproduces the
*hand-written pipeline*. If cropping were reimplemented in TypeScript, a one-pixel
rounding difference would fail the equality test for a reason that has nothing to
do with composition. So the crop is a capability like any other and its
implementation is the same `engines.py crop` subcommand Phase A calls. That both
paths really did OCR identical pixels is **asserted**, not assumed: the test
re-hashes every crop the composition produced and compares against the sha256s
in `reference-meta.json`.

## Tag mapping

DocStructBench emits 10 classes; the composition dispatches on three tags.

| DocStructBench class | Tag |
| --- | --- |
| `title`, `plain text`, `figure_caption`, `table_caption`, `table_footnote`, `isolate_formula`, `formula_caption` | `text` |
| `table` | `table` |
| `figure` | `figure` (dropped — no text layer, no specialist mounts) |
| `abandon` (headers/footers/page numbers) | **dropped entirely**, never silently folded into `text` |

On this page the model returns 13 regions: 12 `text`, 1 `figure`, 0 `table`.

## Determinism rules

Equality depends on all six; they live as `D1`–`D6` in `engines.py`.

- **D1** Everything on CPU. No MPS, no CUDA, single-threaded. torch/NumPy/random seeded 0.
- **D2** Layout confidence threshold fixed at 0.25, `imgsz` 1024. No call-time tuning.
- **D3** Regions sorted by `(y0, x0, x1, y1, tag, cls)` on rounded values, and only *then* assigned ids `r0..rN`. Model output order never leaks into the result.
- **D4** Every float crossing the process boundary goes through `q()` → 4 decimals. Nothing is rounded at comparison time.
- **D5** Crops computed in one place; box = `int(round(v * size))`, clamped, min 1px.
- **D6** OCR lines re-sorted top-to-bottom then left-to-right, whitespace collapsed. RapidOCR's own ordering is not trusted.

Ordering note: ids sort **numerically** (`r10` after `r9`). Lexicographic order
would put `r10`–`r12` between `r1` and `r2`; both paths implement the same rule
(`id_order` in `reference.py`, `idOrder` in `hybrid-pipeline.tsx`).

## Running it

```bash
# one-time: python env (~2 min, models download on first use: ~130MB)
cd scripts/hybrid
uv venv --python 3.12 .venv
VIRTUAL_ENV=.venv uv pip install -r pyproject.toml

# Phase A — regenerate the oracle (~30s)
scripts/hybrid/.venv/bin/python scripts/hybrid/reference.py

# Phase B — prove the composition reproduces it (~90s)
HYBRID_REPRO=1 bun test tests/hybrid-repro.test.tsx

# ordinary CI: the equality test skips, the oracle-shape guard runs
bun test tests
```

`reference-output.json` is committed and is the golden. Regenerate it only when
the pipeline spec changes, and review the diff — same rule as
`fixtures/pdf/golden-segments.json`.

## The claim, with transcript

Same two models, same page, two completely different orchestrations, identical
output. Phase A run twice is byte-identical (including every crop sha256):

```
$ scripts/hybrid/.venv/bin/python scripts/hybrid/reference.py
reference: 13 regions detected, 1 figure(s) dropped, 12 segments -> scripts/hybrid/reference-output.json
    r0 [text ] Unlocking Multimodal Document Intelligence: From Current Triumphs toFutu
    r1 [text ] Yibo Yan1.2,3, Jiahao Huo1.2,4, Guanbo Feng', Mingdong Ou2,*,Yi Cao² g L
    ...
   r12 [text ] Furthermore, as the general capabilities of Multi- modal Large Language

$ diff ref1.json scripts/hybrid/reference-output.json && echo OUTPUT: DETERMINISTIC
OUTPUT: DETERMINISTIC
$ diff meta1.json scripts/hybrid/reference-meta.json && echo META: DETERMINISTIC
META: DETERMINISTIC (page + all crop sha256 stable)
```

Phase B against that oracle:

```
$ HYBRID_REPRO=1 bun test tests/hybrid-repro.test.tsx
(pass) hybrid oracle — committed reference output > is a non-empty segment list with the pipeline's row shape
(pass) hybrid oracle — committed reference output > carries no figure regions — figures have no text layer and are dropped
(pass) hybrid oracle — committed reference output > has unique ids in numeric order (r10 after r9, not after r1)
(pass) hybrid oracle — committed reference output > has normalized top-left bboxes rounded to 4 places (engines.py rule D4)
(pass) hybrid oracle — committed reference output > recognized real text from the real page, not blanks
(pass) hybrid assembly — the deterministic <task> body > drops figures, keeps {id,tag,bbox,text}, orders ids numerically
(pass) hybrid assembly — the deterministic <task> body > treats an empty recognition as a completed segment, not a hole
(pass) hybrid reproduction — composition ≡ hand-written reference > starts from byte-identical page pixels [85704.27ms]
(pass) hybrid reproduction — composition ≡ hand-written reference > produces segments DEEP-EQUAL to the hand-written oracle
(pass) hybrid reproduction — composition ≡ hand-written reference > OCR'd byte-identical crops — attenuation yields the oracle's pixels
(pass) hybrid reproduction — composition ≡ hand-written reference > mounts one specialist per text region and NONE for figures
(pass) hybrid reproduction — composition ≡ hand-written reference > never puts page bytes in a child's config — children pull, never receive
(pass) hybrid reproduction — composition ≡ hand-written reference > the oracle bites: a shifted bbox cannot reproduce the golden text [5069.64ms]

 13 pass
 0 fail
 309 expect() calls
Ran 13 tests across 1 files. [90.87s]
```

Equality is `toEqual` on the entire segments array: exact strings, exact floats,
exact order, **no normalization**. If a normalization step is ever required, it
must be spelled out in the test comment and nowhere else.

The equality has teeth in both directions:

- **it bites** — re-cropping a region from a bbox shifted 12% down the page and
  running it through the same OCR engine yields different text (last test).
- **it is not trivially satisfied** — the composition must independently
  reproduce the figure drop, the numeric id ordering, the per-region attenuated
  crop, and the assembly shape. Any of those diverging fails the deep-equal.

## TODOs

- **Tables.** DocStructBench emits a `table` tag and the composition declares the
  dispatch branch, but this page contains no table, so the branch is unreached.
  Wiring TableFormer (via docling) and a `table` subcommand in `engines.py` is
  the natural next increment; text-region equality was the acceptance bar.
- **OmniDocBench.** Not pulled — the committed ParseBench fixture already gives a
  deterministic, offline, repo-native input. Adding 1–2
  `opendatalab/OmniDocBench` pages would widen the tag coverage (real tables,
  handwriting) and is the cheapest way to exercise the table branch.
- **Speed.** One short-lived python process per capability call (~5s of model
  load each) makes the live test ~90s. Deliberate — a live child agent pays the
  same cost — but a persistent line-delimited JSON worker would cut it to ~15s
  if the test ever needs to run per-commit.
