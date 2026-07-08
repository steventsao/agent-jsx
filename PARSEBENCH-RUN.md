# ParseBench run — live compiled pipeline

*Workers since renamed agent-fiber-\* → agent-jsx-\*; transcripts below are verbatim from the original runs.*

Evaluation of the **deployed** compiled pipeline worker against real ParseBench
pages. No framework changes; this records what the live worker returned,
faithfully — including where it breaks.

- **Worker:** `https://agent-fiber-pdf-compiled.steventsao.workers.dev`
  (`POST /run` `{pdfB64, regions}` → `{ok, runId}`; `GET /result` → `{done, segments}`, latest run only).
- **Reference primitive:** `targets/pdf/core/extract.ts` (byte-identical to the
  worker's `compat/pdf-compiled/src/domain/extract.ts` — verified with `diff`).
  Local reference is computed with the *same* `extractTextLayer`, so live and
  local must be byte-equal.
- **Regions:** derived per page from *real* text-item coordinates — a full-page
  region + two vertical bands (split at the content y-midpoint) + two columns
  (split at the content x-midpoint). The scanned candidate also gets a
  guaranteed-empty margin region.
- **Repro:** `bun scripts/pdf/eval-build-regions.tsx` (writes
  `scripts/pdf/eval-regions.json`, a large regenerable intermediate) then
  `bun scripts/pdf/eval-run-live.ts` (writes `scripts/pdf/eval-results.json`).
- Run date: 2026-07-07. bun 1.3.2.

## Per-PDF results

| # | file | category | size | b64 | #regions | done? | live===local? | latency (POST→done) | text snippet (region `full`) |
|---|------|----------|-----:|----:|---------:|:-----:|:-------------:|--------------------:|------------------------------|
| 1 | `text/text_simple__results.pdf` | text | 66 KB | 88 KB | 5 | ✅ | ✅ 5/5 | 4003 ms | `1997D0107 — SV — 21.07.2012 — 003.001 — 1 Detta dokument är …` |
| 2 | `text/text_simple__edited.pdf` | text | 77 KB | 102 KB | 5 | ✅ | ✅ 5/5 | 4054 ms | `N ATIO N AL U N IO N FIRE I N SURA N CE COMPA N Y OF PITTSBURGH, PA …` |
| 3 | `layout/20240924_000946_P40U_HOWLKAL1IL81NTE2.1_p44.pdf` | layout | 185 KB | 246 KB | 5 | ✅ | ✅ 5/5 | 4109 ms | `42 STARHILL GLOBAL REIT Australia Properties David Jones Tenure Freehold …` |
| 4 | `table/222876fb_page22.pdf` | table | 29 KB | 38 KB | 5 | ✅ | ✅ 5/5 | 3889 ms | `LTC2228/LTC2227/LTC2226 APPLICATIONS INFORMATION digital outputs of the …` |
| 5 | `chart/US_Professional_Services_Partner_Compensation_Survey_2024_p11.pdf` | chart | 120 KB | 160 KB | 5 | ✅ | ✅ 5/5 | 3549 ms | `Diverse region, inclusive workforces: Diversity and inclusion policy … in Asia Pacific` |
| 6 | `text/text_ocr__p4013.pdf` | "scanned"* | 161 KB | 214 KB | 6 | ✅ | ✅ 6/6 | 4493 ms | `UNCLASSIFIED (RESTRICTED) ITEM NO 13 LIGHT AIRCRAFT PHOTOGRAPHIC MODIFICATION. …` |

`b64` is the base64 length actually posted through the DO state channel.
**31/31 regions byte-equal. 6/6 pages done.** Every returned segment id matched
the posted region ids (so `/result` reflected the correct run, not the bundled
sample). Raw evidence — full live and local text for every region — is in
`scripts/pdf/eval-results.json`.

\* Picked as the "weak/empty text layer" candidate — but it is **not** empty
(see finding 3).

## State-channel size probe

The mission flags that `applyState` pushes `pdfB64` through DO state. No
ParseBench page is large enough to hit that, so I escalated synthetic `pdfB64`
payloads (single trivial region) and watched `POST /run`:

| pdfB64 size | `POST /run` |
|------------:|-------------|
| 0.5 MB | `200 {ok:true}` |
| 1.0 MB | `200 {ok:true}` |
| 1.5 MB | `200 {ok:true}` |
| **2.0 MB** | **`200 {ok:true}`** — last size that works |
| **2.25 MB** | **`500`** — first size that fails |
| 2.5 / 2.75 / 3 / 4 / 6 / 8 MB | `500` |

Server-side error (captured via `wrangler tail`, 3 requests, `outcome:exception`
on the `/run` URL):

```
SqlError: SQL query failed: string or blob too big: SQLITE_TOOBIG
```

The Agents SDK persists the whole agent state — which embeds `pdfB64` — into the
Durable Object's SQLite storage, and a single value above ~2 MiB trips
`SQLITE_TOOBIG`. **Ceiling: pdfB64 ≤ ~2.0 MB base64 (≈ a ~1.5 MB decoded PDF).**
Not a 1101 — it is a caught exception surfaced as HTTP 500.

## Findings

**What the pipeline handles well**

1. **Byte-perfect environment parity.** All 31 regions across all 6 real PDFs
   returned text byte-equal to the local `bun` reference. The compiled pipeline
   running in workerd (child DO + unpdf) reproduces the reference primitive
   exactly — center-in-bbox membership and banded reading order behave
   identically in both environments. This is the core result: **the deployed
   compiled description equals the local oracle on real, unseen inputs.**

2. **Multi-byte Unicode round-trips through DO state + JSON.** PDF #1 carries
   Swedish diacritics (`är`, `ä`, `å`), em-dashes (`—`, 3-byte UTF-8), and the
   geometric char `►` — all returned byte-equal. Extraction, DO state
   serialization, and the JSON transport preserve multi-byte text.
   *Caveat: ParseBench has no CJK page, so CJK specifically was not exercised —
   but the non-ASCII bytes present did round-trip exactly.*

3. **Empty regions correctly return `""` — and don't hang the pipeline.**
   No ParseBench page has an empty text layer (min 21 text items; the
   `text_ocr` page is OCR'd and carries **62** embedded text items, so its name
   misleads). I added a guaranteed-empty 2%-corner margin region to PDF #6:
   extraction returned `""`, live===local (both `""`), and `done` still became
   `true`. This is worth calling out because it works *despite* a fragile spot
   (see below).

4. **Fan-out + `done` derivation are correct under real load.** Each page fanned
   out one child DO per region (`extract:<runId>:<regionId>`), each child ran its
   `<task>` once, and the parent's derived `done` flipped true only after every
   region reported. Sequential runs never leaked a prior run's segments (fresh
   `runId` namespaces children; `applyState` resets `segments`).

**Where it breaks / is fragile (the valuable part)**

5. **Hard state-channel ceiling at ~2 MB base64** (see probe above):
   `SQLITE_TOOBIG` → HTTP 500. Any PDF larger than ~1.5 MB decoded cannot be
   run through this worker as built, because the whole PDF travels inside DO
   state. All 6 ParseBench pages (≤ 246 KB b64) and the bundled 378 KB sample
   (~504 KB b64) sit comfortably under it, so it never bites on ParseBench —
   but it is a real, low ceiling for a "PDF pipeline" and the failure is a raw
   500, not a graceful error.

6. **Latent fragility in the parent's `pending` filter (currently masked).**
   `pdf-pipeline.tsx` computes `pending = regions.filter(r => !segments[r.id])`.
   An empty-string segment (`""`) is **falsy**, so an empty region is *never*
   removed from `pending` and the parent keeps re-rendering its child on every
   state change. It does not loop forever *today* only because the child's own
   once-guard (`state.extracted`) stops it re-running the task, and `/result`
   counts the segment via `!== undefined` (not truthiness). Two different
   truthiness rules happen to cancel out. If the child guard ever changed, an
   empty region would re-fan-out indefinitely. (Confirmed benign here: PDF #6's
   empty-margin region reached `done` in 4493 ms with no runaway.)

7. **Letter-spaced headings garble** (primitive limitation, identical live and
   local). When a PDF emits a heading as one text-item-per-glyph, the
   reading-order join spaces every item: `NATIONAL UNION` →
   `N ATIO N AL U N IO N` (PDF #2), `HEIDRICK & ST…` → `H E I D R I C K & S T`
   (PDF #5). Faithful to the text items, but not human-readable. Not a
   live/local divergence — both sides produce it — but a real quality gap for
   downstream use.

8. **Tables and charts collapse to a flat text stream.** The table page (#4,
   an LTC2228 datasheet) extracts all cell text but with **no row/column
   structure** — it is one linear string in band order. The chart page (#5)
   yields only the text layer (title, axis/legend labels, the source note — its
   `band-lower` had just 3 items); chart *graphics* and plotted values are
   invisible to text-layer extraction. Both are expected for a text-layer-only
   primitive, but mean this pipeline is not, on its own, a table or chart
   extractor.

## Honest gaps in this run

- **No truly scanned (zero-text-layer) page exists in ParseBench** — every page
  has ≥ 21 text items — so the "scanned page returns empty" scenario was
  exercised only via a synthetic empty region, not a real image-only page.
- **Latency is quantized to the 500 ms poll interval** (POST→first `done` poll),
  so the numbers are upper bounds; true server completion is within
  [latency − 500 ms, latency]. Size did not visibly affect it (29 KB and 246 KB
  b64 both ≈ 4 s) — cost is dominated by DO fan-out, not PDF bytes.
- **No CJK** page in the corpus (see finding 2).
