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

THREE pages, each of which the previous ones cannot stand in for:

  sample     fixtures/pdf/sample-pdf.ts    arXiv p1  -> 12 text, 1 figure
  table      fixtures/table-page.pdf       arXiv p32 -> 9 text, 1 table
  pubtabnet  fixtures/pubtabnet-…_00.png   PubTabNet -> 1 table, MERGED cells

A page with no table cannot exercise the table branch, and a table with no
merged cell cannot exercise D7's span repetition — which is what the third page
is for. It is also the only input that is already a raster: a PubTabNet table
crop, treated as a one-region page (see the note on `pubtabnet` in main()).

Writes, per page:
  reference-output[-…].json  — the equality object. NOTHING else goes here.
  reference-meta[-…].json    — provenance: model versions, page + crop sha256s,
                               and for table regions the model's pre-placement
                               spans/cells. Phase B re-derives the crop hashes
                               and must match, which proves both paths fed
                               identical pixels to the recognizers.

Run:  scripts/hybrid/.venv/bin/python scripts/hybrid/reference.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import engines  # noqa: E402  (same-directory single source of truth)
from sample_pdf import write_sample_pdf  # noqa: E402

TABLE_PDF = os.path.join(HERE, "fixtures", "table-page.pdf")
PUBTABNET_PNG = os.path.join(HERE, "fixtures", "pubtabnet-PMC5343394_003_00.png")


def id_order(region_id: str) -> tuple[int, str]:
    """`r10` sorts after `r9`, not after `r1`. Both paths use this rule."""
    m = re.fullmatch(r"r(\d+)", region_id)
    return (int(m.group(1)), region_id) if m else (1 << 30, region_id)


def load_page(src: str, page: str) -> None:
    """Materialize the page raster at `page`.

    A PDF is rendered at the pinned DPI. A PNG is ALREADY a page raster and is
    copied through byte-for-byte — re-encoding it would invent pixels that no
    model in this pipeline produced, and would make the committed fixture's
    sha256 stop describing what was actually recognized.
    """
    if src.lower().endswith(".png"):
        shutil.copyfile(src, page)
        return

    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(src)
    doc[0].render(scale=engines.RENDER_DPI / 72.0, draw_annots=False).to_pil().convert(
        "RGB"
    ).save(page, format="PNG", optimize=False, compress_level=6)


def run_page(src: str, work: str, output: str, meta_path: str, source: str) -> dict:
    """The whole pipeline for ONE page. Identical for every input — the only
    things that vary are how the raster is obtained (PDF render vs committed
    PNG) and which branch each region takes at step 4."""
    os.makedirs(work, exist_ok=True)  # one scratch dir per page; crop ids collide
    page = os.path.join(work, "page.png")

    from PIL import Image

    load_page(src, page)
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
    table_spans = {}
    for region in parseable:
        crop_png = os.path.join(work, f"{region['id']}.png")
        info = engines.write_crop(page, crop_png, region["bbox"])
        crop_hashes[region["id"]] = {"sha256": info["sha256"], "box": info["box"]}
        segment = {"id": region["id"], "tag": region["tag"], "bbox": region["bbox"]}
        if region["tag"] == "table":
            table = engines.table_cells(crop_png)
            segment["rows"] = table["rows"]
            # D7 evidence, NOT part of the equality object: every cell the model
            # placed across MORE than one grid position, with the text it placed
            # there. Given these, a test can check that each span really was
            # repeated into every position it covers instead of taking D7's word
            # for it. Only merged cells are recorded — for a 1x1 span there is
            # nothing to repeat, and listing all of them would bury the signal
            # (page 32's table has 60 cells and not one merge, which is the
            # whole reason the PubTabNet page had to be added).
            merged = [
                {"span": span, "text": text}
                for span, text in zip(table["spans"], table["cells"])
                if span[0] != span[1] or span[2] != span[3]
            ]
            rows = table["rows"]
            table_spans[region["id"]] = {
                "grid": [len(rows), len(rows[0]) if rows else 0],
                "cell_count": len(table["cells"]),
                "merged": merged,
            }
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
        "tables": table_spans,
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
            merged = len(table_spans.get(s["id"], {}).get("merged", []))
            head = " | ".join(rows[0])[:44] if rows else ""
            print(
                f"  {s['id']:>4} [table] {shape} grid, {merged} merged cell(s); "
                f"row0: {head}"
            )
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

    # PAGE 3 — a PubTabNet table with MERGED cells, so D7's span-repetition
    # branch runs against a golden instead of only being specified.
    #
    # This input is a table crop, not a page. It is nevertheless run through the
    # SAME unmodified pipeline: DocLayout-YOLO is given the crop as if it were a
    # page and genuinely returns a `table` region on it (score 0.64), so the
    # layout -> crop -> ParseTable path is real and nothing is hand-fed. Note
    # the layout box is TIGHTER than the PubTabNet frame — it clips the narrow
    # leading "S. No" column — which is a true model result and is reported as
    # such rather than corrected for.
    run_page(
        PUBTABNET_PNG,
        os.path.join(work, "pubtabnet"),
        os.path.join(HERE, "reference-output-pubtabnet.json"),
        os.path.join(HERE, "reference-meta-pubtabnet.json"),
        "scripts/hybrid/fixtures/pubtabnet-PMC5343394_003_00.png "
        "(PubTabNet; PMC5343394 Table 3, CC BY 4.0 — see fixtures/LICENSES.md)",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
