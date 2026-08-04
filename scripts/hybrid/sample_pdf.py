"""Decode the repo's committed ParseBench sample (fixtures/pdf/sample-pdf.ts,
a base64 TS module) into a real PDF file. Same bytes every run.

The base64 lives in ONE string literal, so we slice the literal rather than
"cleaning" the payload -- `+` and `/` are valid base64 and must survive."""
from __future__ import annotations
import base64, hashlib, os

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(REPO, "fixtures", "pdf", "sample-pdf.ts")

def sample_pdf_bytes() -> bytes:
    text = open(SRC, "r", encoding="utf-8").read()
    i = text.index("SAMPLE_PDF_B64")
    seg = text[i:]
    a = seg.index('"')
    b = seg.index('"', a + 1)
    data = base64.b64decode(seg[a + 1 : b], validate=True)
    if not data.startswith(b"%PDF") or b"%%EOF" not in data[-32:]:
        raise SystemExit("decoded sample is not a complete PDF")
    return data

def write_sample_pdf(out: str) -> str:
    with open(out, "wb") as fh:
        fh.write(sample_pdf_bytes())
    return out

if __name__ == "__main__":
    import sys
    d = sample_pdf_bytes()
    print(write_sample_pdf(sys.argv[1]), len(d), hashlib.sha256(d).hexdigest()[:16])
