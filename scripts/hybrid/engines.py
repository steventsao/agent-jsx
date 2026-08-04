#!/usr/bin/env python
"""
Hybrid OCR engines — the SINGLE implementation of every model call and every
pixel operation used by BOTH reproduction paths:

  Phase A  scripts/hybrid/reference.py   (imperative Python oracle)
  Phase B  examples/hybrid/*.tsx         (agent-jsx composition, via engines.ts)

Both shell into THIS file. That is deliberate: the claim under test is
"the composition grammar reproduces the hand-written pipeline with the same
models", not "two reimplementations of cropping agree". Keeping the pixel math
and the model calls in one place means any divergence between A and B is a
divergence of ORCHESTRATION, which is the only thing the experiment is about.

Models (paper-backed, both real, both downloaded from HF):
  layout : DocLayout-YOLO  — juliozhao/DocLayout-YOLO-DocStructBench
           doclayout_yolo_docstructbench_imgsz1024.pt  (YOLO-v10 backbone)
           arXiv 2410.12628 (DocLayout-YOLO); the layout stage of MinerU
           (arXiv 2409.18839).
  ocr    : RapidOCR 1.4.4 ONNX (PP-OCRv4 det + rec + cls, ONNXRuntime CPU)
           arXiv 2009.09941 (PP-OCR) / PP-OCRv4.
  table  : RapidTable 3.0.2 / SLANet-plus ONNX (ONNXRuntime CPU) — the table
           structure recognizer from PP-Structure (arXiv 2210.05391), SLANet
           lineage surveyed in arXiv 2507.05595. Structure only: the cell TEXT
           comes from the same RapidOCR above, so a table region and a text
           region are recognized by the SAME recognizer.

Conventions (fixed, shared with examples/pdf/core/extract.ts):
  bbox = normalized TOP-LEFT origin {x0, y0, x1, y1}, 0 <= x0 < x1 <= 1.

Determinism rules (the equality bar depends on all of these):
  D1. Everything runs on CPU. No MPS, no CUDA. Torch/NumPy/random seeded 0.
  D2. Layout confidence threshold is FIXED (LAYOUT_CONF); no top-k, no NMS
      tuning at call time.
  D3. Regions are sorted by (y0, x0, x1, y1, tag) on 4-decimal-rounded values
      and only THEN assigned ids r0..rN. Model output order never leaks.
  D4. Every float leaving this file is rounded to 4 decimals via `q()` and
      serialized by json.dumps with sort_keys=True. No float is ever compared
      across paths unrounded.
  D5. Crops are computed HERE (subcommand `crop`), so both paths get
      byte-identical PNGs; the crop box is int(round(v * size)) clamped to the
      page and widened to at least 1px.
  D6. OCR lines are re-sorted top-to-bottom then left-to-right and joined with
      single spaces; internal whitespace is collapsed. RapidOCR's own ordering
      is not trusted.
  D7. TABLE ROWS MAPPING. SLANet emits a token stream that RapidTable turns
      into (a) an HTML table whose <td> cells already carry the matched OCR
      text and (b) `logic_points`, the same cells decoded as integer grid
      spans (row_start, row_end, col_start, col_end). BOTH derive from that one
      token stream, so the Nth <td> IS the Nth logic point; we assert that and
      raise rather than guess if it ever stops holding. Rows are then built by
      pure integer placement, never by geometry:
        - grid is (max row_end + 1) x (max col_end + 1), pre-filled with ""
        - cell i's text is written into EVERY (r, c) its span rectangle covers,
          so a colspan/rowspan cell repeats rather than leaving holes — a grid
          of strings has no way to say "merged", and repeating keeps every row
          the same width
        - cell text is HTML-unescaped, stripped of residual inline tags, and
          whitespace-collapsed by the same `_WS` rule as D6
      No float, no sort, no tolerance enters this path: the mapping is total
      and order-free, so it cannot disagree between the two phases.
      The `table` subcommand also returns the mapping's INPUTS (`spans` and
      `cells`, pre-placement) so the repetition can be verified instead of
      trusted; they are provenance only and never enter the equality object.
      Exercised by a real golden: fixtures/pubtabnet-PMC5343394_003_00.png
      carries 10 rowspan=2 merges that the model recovers.

Subcommands (all JSON on stdout):
  render-page <pdf> <out.png> [--dpi N]   -> {"path","width","height","dpi"}
  layout      <page.png>                  -> {"regions":[{id,tag,bbox,score}]}
  crop        <page.png> <out.png> --bbox x0,y0,x1,y1 -> {"path","box",...}
  ocr         <crop.png>                  -> {"text"}
  table       <crop.png>                  -> {"rows": [[cell, ...], ...],
                                              "spans": [[r0,r1,c0,c1], ...],
                                              "cells": [cell, ...]}
  version                                 -> {"models": {...}}
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import html as htmllib
import json
import os
import random
import re
import sys

# --- D1: pin every backend to CPU + single-threaded BEFORE torch is imported.
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "0")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("YOLO_VERBOSE", "false")

# ---------------------------------------------------------------------------
# Fixed knobs. Changing any of these invalidates reference-output.json.

RENDER_DPI = 150
LAYOUT_REPO = "juliozhao/DocLayout-YOLO-DocStructBench"
LAYOUT_FILE = "doclayout_yolo_docstructbench_imgsz1024.pt"
LAYOUT_IMGSZ = 1024
LAYOUT_CONF = 0.25
FLOAT_PLACES = 4

# Table structure recognizer. SLANet-plus is the PP-Structure table model
# (7.4MB ONNX) served by RapidTable; ONNXRuntime-CPU single-threaded is
# bit-reproducible run to run, same reason RapidOCR was picked over surya.
TABLE_MODEL = "slanet_plus"
TABLE_ENGINE_CFG = {"intra_op_num_threads": 1, "inter_op_num_threads": 1}

# DocStructBench classes -> our three-tag vocabulary. The composition only
# dispatches on {text, table, figure}; `abandon` (headers/footers/page numbers)
# is dropped entirely rather than silently folded into text.
TAG_MAP = {
    "title": "text",
    "plain text": "text",
    "figure_caption": "text",
    "table_caption": "text",
    "table_footnote": "text",
    "isolate_formula": "text",
    "formula_caption": "text",
    "figure": "figure",
    "table": "table",
    "abandon": None,
}


def q(v: float) -> float:
    """D4 — the ONLY float formatter. Every coordinate/score crosses the
    process boundary through this function, in both paths."""
    return round(float(v) + 0.0, FLOAT_PLACES)


def _seed() -> None:
    random.seed(0)
    try:
        import numpy as np

        np.random.seed(0)
    except Exception:  # pragma: no cover - numpy is a hard dep in practice
        pass
    try:
        import torch

        torch.manual_seed(0)
        torch.use_deterministic_algorithms(True, warn_only=True)
        torch.set_num_threads(1)
    except Exception:  # pragma: no cover
        pass


# Where `_emit` writes. `main` points this at the REAL stdout and then
# redirects sys.stdout to stderr, so model/hub chatter can never interleave
# with the JSON payload. None = write to whatever sys.stdout currently is.
_EMIT_SINK = None


def _emit(payload: dict) -> None:
    sink = _EMIT_SINK if _EMIT_SINK is not None else sys.stdout
    json.dump(payload, sink, sort_keys=True, ensure_ascii=False)
    sink.write("\n")


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# render-page


def cmd_render_page(args: argparse.Namespace) -> None:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(args.pdf)
    page = doc[0]
    scale = args.dpi / 72.0
    bitmap = page.render(scale=scale, draw_annots=False)
    image = bitmap.to_pil().convert("RGB")
    image.save(args.out, format="PNG", optimize=False, compress_level=6)
    _emit(
        {
            "path": os.path.abspath(args.out),
            "width": image.width,
            "height": image.height,
            "dpi": args.dpi,
            "sha256": _sha256(args.out),
        }
    )


# ---------------------------------------------------------------------------
# layout


_LAYOUT_MODEL = None


def _layout_model():
    global _LAYOUT_MODEL
    if _LAYOUT_MODEL is None:
        from huggingface_hub import hf_hub_download
        from doclayout_yolo import YOLOv10

        weights = hf_hub_download(LAYOUT_REPO, LAYOUT_FILE)
        _LAYOUT_MODEL = YOLOv10(weights)
    return _LAYOUT_MODEL


def detect_regions(page_png: str) -> list[dict]:
    """DocLayout-YOLO -> deterministic, tagged, normalized regions."""
    from PIL import Image

    _seed()
    with Image.open(page_png) as im:
        width, height = im.size

    model = _layout_model()
    results = model.predict(
        page_png,
        imgsz=LAYOUT_IMGSZ,
        conf=LAYOUT_CONF,
        device="cpu",
        verbose=False,
    )

    raw: list[dict] = []
    for result in results:
        names = result.names
        for box in result.boxes:
            cls_name = names[int(box.cls.item())]
            tag = TAG_MAP.get(cls_name)
            if tag is None:
                continue  # `abandon` and anything unmapped is dropped
            x0, y0, x1, y1 = (float(v) for v in box.xyxy[0].tolist())
            raw.append(
                {
                    "tag": tag,
                    "cls": cls_name,
                    "score": q(box.conf.item()),
                    "bbox": {
                        "x0": q(max(0.0, min(1.0, x0 / width))),
                        "y0": q(max(0.0, min(1.0, y0 / height))),
                        "x1": q(max(0.0, min(1.0, x1 / width))),
                        "y1": q(max(0.0, min(1.0, y1 / height))),
                    },
                }
            )

    # D3 — total order on rounded values, THEN stable ids.
    raw.sort(
        key=lambda r: (
            r["bbox"]["y0"],
            r["bbox"]["x0"],
            r["bbox"]["x1"],
            r["bbox"]["y1"],
            r["tag"],
            r["cls"],
        )
    )
    regions = []
    for i, r in enumerate(raw):
        regions.append(
            {"id": f"r{i}", "tag": r["tag"], "bbox": r["bbox"], "score": r["score"]}
        )
    return regions


def cmd_layout(args: argparse.Namespace) -> None:
    _emit({"regions": detect_regions(args.page)})


# ---------------------------------------------------------------------------
# crop  (D5 — the one and only crop implementation)


def crop_box(width: int, height: int, bbox: dict) -> tuple[int, int, int, int]:
    left = int(round(bbox["x0"] * width))
    top = int(round(bbox["y0"] * height))
    right = int(round(bbox["x1"] * width))
    bottom = int(round(bbox["y1"] * height))
    left = max(0, min(width - 1, left))
    top = max(0, min(height - 1, top))
    right = max(left + 1, min(width, right))
    bottom = max(top + 1, min(height, bottom))
    return left, top, right, bottom


def write_crop(page_png: str, out_png: str, bbox: dict) -> dict:
    from PIL import Image

    with Image.open(page_png) as im:
        im = im.convert("RGB")
        box = crop_box(im.width, im.height, bbox)
        im.crop(box).save(out_png, format="PNG", optimize=False, compress_level=6)
    return {
        "path": os.path.abspath(out_png),
        "box": list(box),
        "sha256": _sha256(out_png),
    }


def cmd_crop(args: argparse.Namespace) -> None:
    x0, y0, x1, y1 = (float(v) for v in args.bbox.split(","))
    _emit(write_crop(args.page, args.out, {"x0": x0, "y0": y0, "x1": x1, "y1": y1}))


# ---------------------------------------------------------------------------
# ocr


_OCR_ENGINE = None


def _ocr_engine():
    global _OCR_ENGINE
    if _OCR_ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR

        _OCR_ENGINE = RapidOCR()
    return _OCR_ENGINE


_WS = re.compile(r"\s+")


def _ocr_raw(crop_png: str) -> list:
    """The ONE RapidOCR invocation. `recognize` (text regions) and `table_cells`
    (table cells) both go through here, so a table's cell text and a paragraph's
    text are produced by the same recognizer on the same terms."""
    _seed()
    engine = _ocr_engine()
    result, _elapsed = engine(crop_png)
    return result or []


def recognize(crop_png: str) -> str:
    """RapidOCR -> one whitespace-collapsed reading-order string (D6)."""
    result = _ocr_raw(crop_png)
    if not result:
        return ""

    lines = []
    for box, text, score in result:
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        lines.append((q(min(ys)), q(min(xs)), _WS.sub(" ", str(text)).strip()))

    # Band-then-x reading order: same rule as examples/pdf/core/extract.ts.
    lines.sort(key=lambda t: (t[0], t[1]))
    return _WS.sub(" ", " ".join(t[2] for t in lines if t[2])).strip()


def cmd_ocr(args: argparse.Namespace) -> None:
    _emit({"text": recognize(args.crop)})


# ---------------------------------------------------------------------------
# table  (D7 — the one and only structure->rows mapping)

_TABLE_ENGINE = None


def _table_engine():
    global _TABLE_ENGINE
    if _TABLE_ENGINE is None:
        from rapid_table import EngineType, ModelType, RapidTable, RapidTableInput

        _TABLE_ENGINE = RapidTable(
            RapidTableInput(
                model_type=ModelType(TABLE_MODEL),
                engine_type=EngineType.ONNXRUNTIME,
                # `use_ocr` only decides whether RapidTable may run its OWN
                # recognizer when no ocr_results are supplied. We always supply
                # them (from `_ocr_raw`), so it never does; keeping the flag on
                # is what makes it emit the text-filled HTML we read cells from.
                use_ocr=True,
                engine_cfg=dict(TABLE_ENGINE_CFG),  # D1: single-threaded CPU
            )
        )
    return _TABLE_ENGINE


_TD = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
_TAG = re.compile(r"<[^>]+>")


def _cell_text(raw: str) -> str:
    """A <td> body -> one clean string. Same whitespace rule as D6."""
    return _WS.sub(" ", htmllib.unescape(_TAG.sub("", raw))).strip()


def table_cells(crop_png: str) -> dict:
    """SLANet structure + RapidOCR text -> the D7 mapping, with its inputs.

    Returns {"rows", "spans", "cells"} where `rows` is the rectangular grid of
    cell strings (the only part that reaches the equality object), and
    `spans`/`cells` are the model's OWN pre-placement output: the Nth entry of
    `cells` is the text of the Nth `<td>`, and the Nth entry of `spans` is its
    grid rectangle [row_start, row_end, col_start, col_end], inclusive.

    `spans`/`cells` exist so the span-repetition half of D7 can be CHECKED
    rather than trusted. Given them, `rows[r][c] == cells[i]` must hold for
    every (r, c) inside spans[i] — a property tests/hybrid-repro.test.tsx
    asserts against the committed provenance. They are recorded in
    reference-meta*.json, never in reference-output*.json: they are evidence
    about the mapping, not part of what the two phases must agree on.

    See D7 in the module docstring for the mapping rule. Returns empty lists
    for a crop the model finds no cells in — an empty table is a completed
    region, not an error, exactly as an empty recognition is for a text region.
    """
    empty: dict = {"rows": [], "spans": [], "cells": []}
    ocr_result = _ocr_raw(crop_png)
    boxes = [line[0] for line in ocr_result]
    texts = tuple(line[1] for line in ocr_result)
    scores = tuple(line[2] for line in ocr_result)

    engine = _table_engine()
    out = engine(crop_png, ocr_results=[[boxes, texts, scores]])

    htmls = getattr(out, "pred_htmls", None) or []
    points = getattr(out, "logic_points", None) or []
    if not htmls or len(points) == 0:
        return empty

    cells = [_cell_text(m) for m in _TD.findall(htmls[0])]
    spans = [[int(v) for v in p] for p in points[0]]

    # D7 — both come from the same token stream; if that ever stops being true
    # we must NOT guess an alignment. Fail loudly instead.
    if len(cells) != len(spans):
        raise SystemExit(
            f"table: {len(cells)} <td> cells but {len(spans)} logic points — "
            "structure/HTML alignment broke, refusing to guess a mapping"
        )
    if not spans:
        return empty

    n_rows = max(s[1] for s in spans) + 1
    n_cols = max(s[3] for s in spans) + 1
    grid = [["" for _ in range(n_cols)] for _ in range(n_rows)]
    for text, (r0, r1, c0, c1) in zip(cells, spans):
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                grid[r][c] = text
    return {"rows": grid, "spans": spans, "cells": cells}


def cmd_table(args: argparse.Namespace) -> None:
    # `rows` is what the composition consumes; `spans`/`cells` ride along as
    # provenance and are ignored by examples/hybrid/engines.ts, so adding them
    # cannot move reference-output*.json.
    _emit(table_cells(args.crop))


# ---------------------------------------------------------------------------
# version


def cmd_version(_args: argparse.Namespace) -> None:
    import importlib.metadata as md

    def ver(name: str) -> str:
        try:
            return md.version(name)
        except Exception:
            return "unknown"

    _emit(
        {
            "models": {
                "layout": {
                    "repo": LAYOUT_REPO,
                    "file": LAYOUT_FILE,
                    "imgsz": LAYOUT_IMGSZ,
                    "conf": LAYOUT_CONF,
                    "pkg": f"doclayout-yolo=={ver('doclayout-yolo')}",
                },
                "ocr": {
                    "engine": "RapidOCR (PP-OCRv4 det+cls+rec, ONNXRuntime CPU)",
                    "pkg": f"rapidocr-onnxruntime=={ver('rapidocr-onnxruntime')}",
                },
                "table": {
                    "engine": "RapidTable SLANet-plus (PP-Structure, ONNXRuntime CPU)",
                    "model_type": TABLE_MODEL,
                    "engine_cfg": TABLE_ENGINE_CFG,
                    "pkg": f"rapid-table=={ver('rapid-table')}",
                    "text_from": "same RapidOCR as the `ocr` subcommand",
                },
            },
            "runtime": {
                "python": sys.version.split()[0],
                "torch": ver("torch"),
                "onnxruntime": ver("onnxruntime"),
                "pypdfium2": ver("pypdfium2"),
                "pillow": ver("pillow"),
            },
            "render_dpi": RENDER_DPI,
            "float_places": FLOAT_PLACES,
            "tag_map": {k: v for k, v in TAG_MAP.items()},
        }
    )


# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="engines.py", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("render-page")
    p.add_argument("pdf")
    p.add_argument("out")
    p.add_argument("--dpi", type=int, default=RENDER_DPI)
    p.set_defaults(func=cmd_render_page)

    p = sub.add_parser("layout")
    p.add_argument("page")
    p.set_defaults(func=cmd_layout)

    p = sub.add_parser("crop")
    p.add_argument("page")
    p.add_argument("out")
    p.add_argument("--bbox", required=True, help="x0,y0,x1,y1 normalized")
    p.set_defaults(func=cmd_crop)

    p = sub.add_parser("ocr")
    p.add_argument("crop")
    p.set_defaults(func=cmd_ocr)

    p = sub.add_parser("table")
    p.add_argument("crop")
    p.set_defaults(func=cmd_table)

    p = sub.add_parser("version")
    p.set_defaults(func=cmd_version)

    args = parser.parse_args(argv)

    # stdout is the JSON channel and nothing else. The HF hub prints an
    # unauthenticated-requests notice and RapidTable's logger prints model
    # paths; both would otherwise land between the caller and the payload.
    # Pin `_emit` to the real stdout, then send everything else to stderr.
    global _EMIT_SINK
    _EMIT_SINK = sys.stdout
    try:
        with contextlib.redirect_stdout(sys.stderr):
            args.func(args)
    finally:
        _EMIT_SINK.flush()
        _EMIT_SINK = None
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
