#!/usr/bin/env python
"""
PHASE A — the hand-written imperative reference. This is the ORACLE.

A flat, boring, top-to-bottom script. No agents, no composition, no framework:
just the hybrid OCR pipeline as anyone would write it once.

    page  = render(sample.pdf, 150dpi)
    regs  = layout(page)                # DocLayout-YOLO
    regs  = [r for r in regs if r.tag != "figure"]
    segs  = [{**r, text: ocr(crop(page, r.bbox))} for r in regs]   # RapidOCR
    out   = {"segments": sorted(segs, by numeric id)}

Every model call and every pixel operation is delegated to engines.py, which
is also what the agent-jsx composition (Phase B) calls. See engines.py for the
determinism rules D1-D6 that make byte-equality between the two paths possible.

Writes:
  reference-output.json  — the equality object. NOTHING else goes in here.
  reference-meta.json    — provenance: model versions, page + crop sha256s.
                           Phase B re-derives the crop hashes and must match,
                           which proves both paths OCR'd identical pixels.

Run:  scripts/hybrid/.venv/bin/python scripts/hybrid/reference.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import engines  # noqa: E402  (same-directory single source of truth)
from sample_pdf import write_sample_pdf  # noqa: E402

OUTPUT = os.path.join(HERE, "reference-output.json")
META = os.path.join(HERE, "reference-meta.json")


def id_order(region_id: str) -> tuple[int, str]:
    """`r10` sorts after `r9`, not after `r1`. Both paths use this rule."""
    m = re.fullmatch(r"r(\d+)", region_id)
    return (int(m.group(1)), region_id) if m else (1 << 30, region_id)


def main() -> int:
    work = tempfile.mkdtemp(prefix="hybrid-ref-")

    # 1. the input document: the repo's committed ParseBench arXiv page 1.
    pdf = write_sample_pdf(os.path.join(work, "page.pdf"))
    page = os.path.join(work, "page.png")

    import pypdfium2 as pdfium
    from PIL import Image

    doc = pdfium.PdfDocument(pdf)
    doc[0].render(scale=engines.RENDER_DPI / 72.0, draw_annots=False).to_pil().convert(
        "RGB"
    ).save(page, format="PNG", optimize=False, compress_level=6)
    with Image.open(page) as im:
        page_size = [im.width, im.height]
    page_sha = engines._sha256(page)

    # 2. layout detection over the whole page.
    regions = engines.detect_regions(page)

    # 3. figures carry no text layer -- they are dropped, never OCR'd.
    parseable = [r for r in regions if r["tag"] != "figure"]

    # 4. per-region crop -> recognize.
    segments = []
    crop_hashes = {}
    for region in parseable:
        crop_png = os.path.join(work, f"{region['id']}.png")
        info = engines.write_crop(page, crop_png, region["bbox"])
        crop_hashes[region["id"]] = {"sha256": info["sha256"], "box": info["box"]}
        segments.append(
            {
                "id": region["id"],
                "tag": region["tag"],
                "bbox": region["bbox"],
                "text": engines.recognize(crop_png),
            }
        )

    # 5. deterministic assembly.
    segments.sort(key=lambda s: id_order(s["id"]))
    result = {"segments": segments}

    with open(OUTPUT, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2, sort_keys=True, ensure_ascii=False)
        fh.write("\n")

    meta = {
        "source": "fixtures/pdf/sample-pdf.ts (ParseBench 2602.19961v1_p1.pdf, arXiv p1)",
        "page": {"sha256": page_sha, "size": page_size, "dpi": engines.RENDER_DPI},
        "layout": {
            "detected": len(regions),
            "figures_dropped": len(regions) - len(parseable),
            "ocr_regions": len(parseable),
        },
        "crops": crop_hashes,
    }
    with open(META, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, sort_keys=True, ensure_ascii=False)
        fh.write("\n")

    print(
        f"reference: {len(regions)} regions detected, "
        f"{len(regions) - len(parseable)} figure(s) dropped, "
        f"{len(segments)} segments -> {os.path.relpath(OUTPUT)}"
    )
    for s in segments:
        print(f"  {s['id']:>4} [{s['tag']:<5}] {s['text'][:72]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
