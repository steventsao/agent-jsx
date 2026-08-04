#!/usr/bin/env python
"""
Acquire the PubTabNet merged-cell fixture — the ONLY way the committed files in
fixtures/pubtabnet-* were produced. Re-running this script must reproduce them
byte-for-byte; that is what makes the fixture's provenance auditable rather
than asserted.

WHY THIS FIXTURE EXISTS
-----------------------
engines.py rule D7 says a colspan/rowspan cell's text is repeated into EVERY
grid position its span rectangle covers. Until now that rule was implemented
and specified but never *exercised*: neither page in the repro carries a merged
cell. This fixture is a real table with 20 `rowspan="2"` merges, so the
repetition path actually runs and a golden pins its result.

ACQUISITION (per-row only — no bulk download)
---------------------------------------------
Rows come from the HF datasets-server `/rows` endpoint, 100 at a time, which
streams individual records out of the dataset without downloading it. The
underlying corpus is PubTabNet (IBM); `nhhsag12/pubtabnet-with-html` is used
because it is the only per-row-readable mirror that carries the table image,
the `__key__` (hence the PMC article id, needed for the image licence check)
AND the HTML annotation in ONE row. Its `__url__` column records that it was
built from `ajimeno/PubTabNet`, the mirror the licence audit covered.

KNOWN PROVENANCE LIMITATION — READ THIS
---------------------------------------
The datasets-server serves images through its cached-assets CDN, which
re-encodes them: the bytes it returns for a `png` column are JPEG, and the
signed URL cannot be re-pointed at the original (`image.png` -> HTTP 403).
Reading IBM's ORIGINAL PNG bytes would mean pulling a ~99MB parquet row group
(or the 11GB source tarball), i.e. a bulk download, which is out of scope here.

So the committed raster is the datasets-server JPEG rendition of PubTabNet's
PMC5343394_003_00.png, losslessly re-encoded to PNG. Same 486x267 frame, same
table, slightly different pixels from IBM's original. Both the served JPEG's
sha256 and the committed PNG's sha256 are recorded in the .gt.json so the whole
chain is checkable. This costs the experiment nothing — determinism and the
A/B equality bar are about the two paths reading the SAME committed bytes, not
about matching IBM's encoder — but it is a real caveat and is not buried.

Run:  scripts/hybrid/.venv/bin/python scripts/hybrid/fetch_pubtabnet_fixture.py
"""

from __future__ import annotations

import hashlib
import html as htmllib
import io
import json
import os
import re
import sys
import urllib.request
from datetime import date
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")

# --- The exact row this fixture came from. Pinned, not searched, so a re-run
#     cannot silently drift to a different table.
DATASET = "nhhsag12/pubtabnet-with-html"
CONFIG, SPLIT, OFFSET = "default", "train", 263
EXPECT_KEY = "pubtabnet/train/PMC5343394_003_00"
PMC_ID = "PMC5343394"
STEM = "pubtabnet-PMC5343394_003_00"

UA = "agent-jsx-hybrid-fixture/1.0 (https://github.com/steventsao/agent-jsx)"

_WS = re.compile(r"\s+")
_TAG = re.compile(r"<[^>]+>")


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=timeout).read()


# ---------------------------------------------------------------------------
# GT annotation -> grid + spans.
#
# PubTabNet's annotation is an HTML table whose <td>s carry colspan/rowspan.
# Placing those cells on a grid uses EXACTLY the semantics engines.py D7 uses
# for the model's own logic_points: a cell occupies every (r, c) in its span
# rectangle. That is deliberate — it means "GT grid" and "model grid" are the
# same kind of object and can be compared position-by-position.


class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows: list[list[dict]] = []
        self.cur: list[dict] | None = None
        self.buf: list[str] | None = None

    def handle_starttag(self, tag: str, attrs) -> None:
        a = dict(attrs)
        if tag == "tr":
            self.cur = []
            self.rows.append(self.cur)
        elif tag in ("td", "th") and self.cur is not None:
            self.buf = []
            self.cur.append(
                {
                    "cs": int(a.get("colspan", 1)),
                    "rs": int(a.get("rowspan", 1)),
                    "text": "",
                }
            )

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self.buf is not None and self.cur:
            self.cur[-1]["text"] = _WS.sub(" ", " ".join(self.buf)).strip()
            self.buf = None

    def handle_data(self, data: str) -> None:
        if self.buf is not None and data.strip():
            self.buf.append(data.strip())


def parse_gt(html: str) -> tuple[list[list[str]], list[list[int]], list[str]]:
    """-> (grid, spans, cells). `spans` are [r0, r1, c0, c1] inclusive."""
    parser = _TableParser()
    parser.feed(html)

    occupied: set[tuple[int, int]] = set()
    spans: list[list[int]] = []
    cells: list[str] = []
    for ri, row in enumerate(parser.rows):
        ci = 0
        for cell in row:
            while (ri, ci) in occupied:
                ci += 1
            r0, r1 = ri, ri + cell["rs"] - 1
            c0, c1 = ci, ci + cell["cs"] - 1
            for r in range(r0, r1 + 1):
                for c in range(c0, c1 + 1):
                    occupied.add((r, c))
            spans.append([r0, r1, c0, c1])
            cells.append(_WS.sub(" ", htmllib.unescape(_TAG.sub("", cell["text"]))).strip())
            ci = c1 + 1

    if not spans:
        return [], [], []
    n_rows = max(s[1] for s in spans) + 1
    n_cols = max(s[3] for s in spans) + 1
    grid = [["" for _ in range(n_cols)] for _ in range(n_rows)]
    for text, (r0, r1, c0, c1) in zip(cells, spans):
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                grid[r][c] = text
    return grid, spans, cells


# ---------------------------------------------------------------------------


def article_license(pmc_id: str) -> dict:
    """The image's rights, straight from NCBI. PubTabNet images are PMC Open
    Access pages, whose terms are PER ARTICLE — the corpus licence says nothing
    about any individual image, so this has to be checked for the exact PMC id
    being vendored."""
    oa = _get(f"https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id={pmc_id}").decode(
        "utf8", "replace"
    )
    lic = re.search(r'license="([^"]+)"', oa)
    citation = re.search(r'citation="([^"]+)"', oa)

    xml = _get(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
        f"?db=pmc&id={pmc_id[3:]}&rettype=xml"
    ).decode("utf8", "replace")
    block = re.search(r"<permissions>.*?</permissions>", xml, re.S)
    statement = _WS.sub(" ", _TAG.sub("", block.group(0))).strip() if block else ""
    title = re.search(r"<article-title[^>]*>(.*?)</article-title>", xml, re.S)

    return {
        "pmc_id": pmc_id,
        "oa_service_license": lic.group(1) if lic else "unknown",
        "citation": citation.group(1) if citation else "",
        "article_title": _WS.sub(" ", _TAG.sub("", title.group(1))).strip() if title else "",
        "license_statement_verbatim": statement,
        "checked_via": [
            f"https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id={pmc_id}",
            f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmc_id}/",
        ],
    }


def main() -> int:
    from PIL import Image

    os.makedirs(FIXTURES, exist_ok=True)

    # 1. the pinned row (per-row read; nothing else is downloaded)
    rows_url = (
        f"https://datasets-server.huggingface.co/rows?dataset={DATASET.replace('/', '%2F')}"
        f"&config={CONFIG}&split={SPLIT}&offset={OFFSET}&length=1"
    )
    row = json.loads(_get(rows_url))["rows"][0]["row"]
    if row["__key__"] != EXPECT_KEY:
        raise SystemExit(
            f"row {OFFSET} is {row['__key__']!r}, expected {EXPECT_KEY!r} — the "
            "dataset was reordered; re-pin OFFSET rather than accepting a different table"
        )

    # 2. the raster. `served` is the CDN's JPEG rendition (see module docstring).
    served = _get(row["png"]["src"])
    served_sha = _sha256_bytes(served)
    with Image.open(io.BytesIO(served)) as im:
        im = im.convert("RGB")
        png_path = os.path.join(FIXTURES, f"{STEM}.png")
        # Same encoder settings engines.py uses everywhere, so the re-encode is
        # reproducible from the served bytes by anyone repeating this.
        im.save(png_path, format="PNG", optimize=False, compress_level=6)
        size = [im.width, im.height]
    png_sha = _sha256_bytes(open(png_path, "rb").read())

    # 3. the annotation (CDLA-Permissive-1.0; the part IBM owns)
    grid, spans, cells = parse_gt(row["html"])
    merged = [s for s in spans if s[0] != s[1] or s[2] != s[3]]
    if not merged:
        raise SystemExit("fixture has no merged cell — it cannot exercise D7")

    lic = article_license(PMC_ID)
    if "CC BY" not in lic["oa_service_license"]:
        raise SystemExit(
            f"{PMC_ID} is {lic['oa_service_license']!r}, not CC BY — do not vendor it"
        )

    gt = {
        "_comment": (
            "PubTabNet ground truth for one table. `grid` places every cell at "
            "every position its span covers — the SAME rule engines.py D7 applies "
            "to the model's logic_points, so GT and model grids are comparable "
            "position-by-position. GT is REPORTED against, never asserted equal: "
            "see tests/hybrid-repro.test.tsx."
        ),
        "filename": EXPECT_KEY.split("/")[-1] + ".png",
        "image": {
            "committed_png": f"{STEM}.png",
            "sha256": png_sha,
            "size": size,
            "served_asset_sha256": served_sha,
            "served_asset_format": "JPEG (datasets-server cached-assets rendition)",
            "reencode": "PIL Image.save(format=PNG, optimize=False, compress_level=6)",
        },
        "provenance": {
            "corpus": "PubTabNet (IBM) — https://github.com/ibm-aur-nlp/PubTabNet",
            "hf_dataset": DATASET,
            "hf_upstream": row.get("__url__", ""),
            "config": CONFIG,
            "split": SPLIT,
            "offset": OFFSET,
            "key": row["__key__"],
            "fetched": date.today().isoformat(),
            "endpoint": "https://datasets-server.huggingface.co/rows (per-row; no bulk download)",
        },
        "licenses": {
            "annotation": "CDLA-Permissive-1.0 (IBM) — see fixtures/LICENSES.md",
            "image": lic,
        },
        "html": row["html"],
        "grid": grid,
        "spans": spans,
        "cells": cells,
        "shape": [len(grid), len(grid[0])],
        "merged_cell_count": len(merged),
    }
    gt_path = os.path.join(FIXTURES, f"{STEM}.gt.json")
    with open(gt_path, "w", encoding="utf-8") as fh:
        json.dump(gt, fh, indent=2, sort_keys=True, ensure_ascii=False)
        fh.write("\n")

    print(f"image      {png_path}")
    print(f"           {size[0]}x{size[1]}  sha256 {png_sha[:16]}…  ({os.path.getsize(png_path)} bytes)")
    print(f"           served JPEG sha256 {served_sha[:16]}…")
    print(f"ground truth {gt_path}")
    print(f"           {len(grid)}x{len(grid[0])} grid, {len(cells)} cells, {len(merged)} merged")
    print(f"license    {PMC_ID}: {lic['oa_service_license']} — {lic['citation']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
