#!/usr/bin/env python
"""
PHASE A — the hand-written imperative reference. This is the ORACLE.

A flat, boring, top-to-bottom script. No agents, no composition, no framework:
just the hybrid OCR pipeline as anyone would write it once.

    page  = render(page.pdf, 150dpi)
    regs  = layout(page)                # DocLayout-YOLO
    regs  = [r for r in regs if r.tag != "figure"]
    segs  = [{**r, text: ocr(crop(page, r.bbox))}   for text regions   # RapidOCR
             {**r, rows: table(crop(page, r.bbox))} for table regions] # SLANet+
    out   = {"segments": sorted(segs, by numeric id)}

Every model call and every pixel operation is delegated to engines.py, which
is also what the agent-jsx composition (Phase B) calls. See engines.py for the
determinism rules D1-D7 that make byte-equality between the two paths possible.

TWO pages, because a page with no table cannot exercise the table branch:

  sample  fixtures/pdf/sample-pdf.ts   arXiv 2602.19961v1 p1  -> 12 text, 1 figure
  table   fixtures/table-page.pdf      arXiv 2602.19961v1 p32 -> 9 text, 1 table

Writes, per page:
  reference-output[-table].json  — the equality object. NOTHING else goes here.
  reference-meta[-table].json    — provenance: model versions, page + crop
                                   sha256s. Phase B re-derives the crop hashes
                                   and must match, which proves both paths fed
                                   identical pixels to the recognizers.

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

TABLE_PDF = os.path.join(HERE, "fixtures", "table-page.pdf")


def id_order(region_id: str) -> tuple[int, str]:
    """`r10` sorts after `r9`, not after `r1`. Both paths use this rule."""
    m = re.fullmatch(r"r(\d+)", region_id)
    return (int(m.group(1)), region_id) if m else (1 << 30, region_id)


def run_page(pdf: str, work: str, output: str, meta_path: str, source: str) -> dict:
    """The whole pipeline for ONE page. Identical for both inputs — the only
    thing that varies is which branch each region takes at step 4."""
    os.makedirs(work, exist_ok=True)  # one scratch dir per page; crop ids collide
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

    # 3. figures carry no text layer -- they are dropped, never recognized.
    parseable = [r for r in regions if r["tag"] != "figure"]

    # 4. per-region crop -> recognize. A `text` region gets one string; a
    #    `table` region gets a grid of cell strings. Same crop, same OCR
    #    engine underneath, different assembler.
    segments = []
    crop_hashes = {}
    for region in parseable:
        crop_png = os.path.join(work, f"{region['id']}.png")
        info = engines.write_crop(page, crop_png, region["bbox"])
        crop_hashes[region["id"]] = {"sha256": info["sha256"], "box": info["box"]}
        segment = {"id": region["id"], "tag": region["tag"], "bbox": region["bbox"]}
        if region["tag"] == "table":
            segment["rows"] = engines.table_rows(crop_png)
        else:
            segment["text"] = engines.recognize(crop_png)
        segments.append(segment)

    # 5. deterministic assembly.
    segments.sort(key=lambda s: id_order(s["id"]))
    result = {"segments": segments}

    with open(output, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2, sort_keys=True, ensure_ascii=False)
        fh.write("\n")

    tables = [s for s in segments if s["tag"] == "table"]
    meta = {
        "source": source,
        "page": {"sha256": page_sha, "size": page_size, "dpi": engines.RENDER_DPI},
        "layout": {
            "detected": len(regions),
            "figures_dropped": len(regions) - len(parseable),
            "ocr_regions": len(parseable),
            "table_regions": len(tables),
        },
        "crops": crop_hashes,
    }
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, sort_keys=True, ensure_ascii=False)
        fh.write("\n")

    print(
        f"reference[{os.path.basename(output)}]: {len(regions)} regions detected, "
        f"{len(regions) - len(parseable)} figure(s) dropped, "
        f"{len(tables)} table(s), {len(segments)} segments"
    )
    for s in segments:
        if s["tag"] == "table":
            rows = s["rows"]
            shape = f"{len(rows)}x{len(rows[0]) if rows else 0}"
            head = " | ".join(rows[0])[:60] if rows else ""
            print(f"  {s['id']:>4} [table] {shape} grid; row0: {head}")
        else:
            print(f"  {s['id']:>4} [text ] {s['text'][:72]}")
    return meta


def main() -> int:
    work = tempfile.mkdtemp(prefix="hybrid-ref-")

    # PAGE 1 — the repo's committed ParseBench arXiv page 1. No tables on it;
    # this golden must not move when the table branch is added.
    run_page(
        write_sample_pdf(os.path.join(work, "sample.pdf")),
        os.path.join(work, "sample"),
        os.path.join(HERE, "reference-output.json"),
        os.path.join(HERE, "reference-meta.json"),
        "fixtures/pdf/sample-pdf.ts (ParseBench 2602.19961v1_p1.pdf, arXiv p1)",
    )

    # PAGE 2 — page 32 of the SAME arXiv paper, which carries a real table.
    run_page(
        TABLE_PDF,
        os.path.join(work, "table"),
        os.path.join(HERE, "reference-output-table.json"),
        os.path.join(HERE, "reference-meta-table.json"),
        "scripts/hybrid/fixtures/table-page.pdf (arXiv 2602.19961v1 p32)",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
