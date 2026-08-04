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

Subcommands (all JSON on stdout):
  render-page <pdf> <out.png> [--dpi N]   -> {"path","width","height","dpi"}
  layout      <page.png>                  -> {"regions":[{id,tag,bbox,score}]}
  crop        <page.png> <out.png> --bbox x0,y0,x1,y1 -> {"path","box",...}
  ocr         <crop.png>                  -> {"text"}
  version                                 -> {"models": {...}}
"""

from __future__ import annotations

import argparse
import hashlib
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


def _emit(payload: dict) -> None:
    json.dump(payload, sys.stdout, sort_keys=True, ensure_ascii=False)
    sys.stdout.write("\n")


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


def recognize(crop_png: str) -> str:
    """RapidOCR -> one whitespace-collapsed reading-order string (D6)."""
    _seed()
    engine = _ocr_engine()
    result, _elapsed = engine(crop_png)
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

    p = sub.add_parser("version")
    p.set_defaults(func=cmd_version)

    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
