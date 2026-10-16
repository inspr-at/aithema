# AIT-219: measured document extractor ceiling

Decision: raise `EXTRACTOR_LIMITS.maxBytes` from 2 to **20 MiB** and core
`UPLOAD_LIMITS.maxRequestBytes` from 8 to **21 MiB**. Keep all worker, archive,
page and output bounds unchanged. At 20 MiB the worst normal-fixture heap, RSS
and wall-time headroom is **86.8%, 62.6% and 98.5%**, respectively.

## Measurement method

Measured at 2026-10-16T01:20:42.228Z on **mbp2606**, Apple M5 Max, macOS kernel
27.0.0, Node v24.20.0, unpdf 1.8.0. Measurement source commit:
`f834db7111` (before the production ceiling change).

`scripts/extractor-measurement.test.js` generates exact-sized inputs at runtime.
Each case runs three times, sequentially, through `runExtractorProcess` and the
actual text/PDF/OOXML worker and parser. Only the existing byte-admission check
is bypassed to measure larger inputs before raising it. Fork serialization,
permission sandbox, offline preload, 128 MiB V8 old-space flag, 384 MiB RSS
watchdog, 10-second deadline and reaping remain active. Wall time covers worker
startup, input transfer, parsing, result transfer and reaping; fixture generation
and host sniffing are excluded. The separate HTTP test covers the complete
upload route, native multipart transport, storage admission and real extraction.

Heap is the maximum V8 GC before/after live-object byte count and the final
`process.memoryUsage().heapUsed` reading from a measurement-only preload.
Both V8 trace field spellings are supported. RSS is the greater of the worker
OS high-water mark (`resourceUsage().maxRSS`) and production watchdog samples.
For killed workers the OS final reading is unavailable, so RSS is a sampled
peak/lower bound. The watchdog samples every 25 ms: a transient RSS overshoot
is possible before termination. `maxHeapMb` controls V8 old-space, not total
JS heap or RSS; total heap can transiently exceed 128 MiB while V8 terminates.
The probe and GC tracing run only in the opt-in harness, not production or
normal regression tests. Buffer/external-string memory is covered by RSS.

Fixtures contain:

- Text-heavy PDF: 100 valid pages, uncompressed text content streams; text
  extraction stops at 60,000 characters. Pages kept decrease as each page grows.
- Image-heavy PDF: 20 valid grayscale image pages with short text captions;
  no rendering or OCR is requested. All 20 captions survive.
- DOCX: valid ZIP method-0 (stored) XML in document/header/footer parts, each
  below 8 MiB plus markup. This measures large decoded text without relaxing
  the independent 16 MiB part ceiling. It is not a survey of Office producers.
- Plain text: literal UTF-8 requirements sentences.
- OOXML bomb: a finite 1 MiB deflate expansion above 100:1, plus stored media
  to reach exactly 20 MiB; no stored part exceeds 16 MiB. The compression
  ratio trips independently of file size, both at admission and inside the worker.
- Many-object PDF: about 190,650 referenced empty content-stream objects in a
  valid 20 MiB PDF. The object graph reaches the parser and trips V8/RSS bounds.

No sample documents are shipped. These synthetic cases support the input
ceiling; hostile or unusually complex documents can still be refused under
the unchanged bounds. Hosts with less capacity must lower their limits.

## Results

Each row shows **maxima across three runs**; pages/characters kept agree in
all three runs. MiB means 1,048,576 bytes. A dash means an unpaginated format
(DOCX/text still retain one segment). Full per-run values are in
[`extractor-limits-results.json`](extractor-limits-results.json).

| Format | Input MiB | Runs | Peak heap MiB | Peak RSS MiB | Wall ms | Pages kept | Chars kept | Outcome |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| text-pdf | 2 | 3 | 16.71 | 90.09 | 190.56 | 4 | 60,000 | accepted, truncated |
| image-pdf | 2 | 3 | 14.79 | 87.03 | 116.85 | 20 | 849 | accepted |
| docx | 2 | 3 | 8.66 | 60.55 | 70.99 | — | 60,000 | accepted, truncated |
| text | 2 | 3 | 8.63 | 60.34 | 70.91 | — | 60,000 | accepted, truncated |
| text-pdf | 5 | 3 | 22.15 | 109.56 | 185.21 | 2 | 60,000 | accepted, truncated |
| image-pdf | 5 | 3 | 14.79 | 96.11 | 109.79 | 20 | 849 | accepted |
| docx | 5 | 3 | 8.66 | 69.45 | 72.75 | — | 60,000 | accepted, truncated |
| text | 5 | 3 | 8.62 | 69.14 | 75.60 | — | 60,000 | accepted, truncated |
| text-pdf | 10 | 3 | 16.33 | 113.78 | 192.12 | 1 | 60,000 | accepted, truncated |
| image-pdf | 10 | 3 | 15.06 | 109.62 | 110.78 | 20 | 849 | accepted |
| docx | 10 | 3 | 8.66 | 84.64 | 79.54 | — | 60,000 | accepted, truncated |
| text | 10 | 3 | 8.62 | 84.22 | 126.81 | — | 60,000 | accepted, truncated |
| text-pdf | 15 | 3 | 16.60 | 129.17 | 139.51 | 1 | 60,000 | accepted, truncated |
| image-pdf | 15 | 3 | 15.06 | 124.56 | 112.66 | 20 | 849 | accepted |
| docx | 15 | 3 | 8.66 | 100.02 | 142.20 | — | 60,000 | accepted, truncated |
| text | 15 | 3 | 8.63 | 99.41 | 90.91 | — | 60,000 | accepted, truncated |
| text-pdf | 20 | 3 | 16.93 | 143.62 | 141.98 | 1 | 60,000 | accepted, truncated |
| image-pdf | 20 | 3 | 13.57 | 137.39 | 147.55 | 20 | 849 | accepted |
| docx | 20 | 3 | 8.66 | 115.16 | 110.49 | — | 60,000 | accepted, truncated |
| text | 20 | 3 | 8.63 | 114.30 | 87.84 | — | 60,000 | accepted, truncated |
| ooxml-bomb | 20 | 3 | 8.66 | 94.50 | 75.10 | 0 | 0 | unreadable (limit) |
| many-objects-pdf | 20 | 3 | 174.82 | 387.09 | 589.92 | 0 | 0 | unreadable (limit) |

The normal 20 MiB worst cases are 16.93 MiB heap, 143.63 MiB RSS and
147.55 ms. Across all normal sizes the maxima are 22.15 MiB heap, 143.63 MiB
RSS and 192.12 ms. No resource-bound increase is justified or needed.

All three OOXML bomb runs return `limit` before inflation. All three many-object
PDF runs return `limit`, through V8 heap termination or the 384 MiB RSS
watchdog. The normal regression repeats these checks
without instrumentation, asserts child reaping, and extracts a small PDF afterward.

## Request encoding and the other 2 MB check

`packages/ui/src/session-element.js` posts `FormData`;
`packages/server/src/upload-multipart.js` scans literal byte views, passes only
bounded metadata to native `formData()`, and rejects `Content-Transfer-Encoding`.
There is no base64 expansion. A 21 MiB core request budget leaves 1 MiB for
framing a 20 MiB file, well above the bounded multipart headers and scalar
fields. The server and UI already use 20 MiB files and 64 MiB requests, so
those ceilings do not need changing. The HTTP test explicitly lowers the server
request ceiling to the new core value, compares admitted bytes byte-for-byte,
checks framing below 64 KiB, waits for accepted/truncated extraction and verifies
original bytes are discarded. One extra source byte is refused with HTTP 413.

`packages/core/src/chat-completions.js:227` counts incoming provider SSE response
bytes (and an incomplete-event buffer) in the chat response stream. It is not
on the document upload/extractor path and remains unchanged.

## Reproduction and validation

Commit first; run only on mbp2606 through the authorized remote runner:

```sh
EVIDENCE_OUT="$PWD/.data/ait-219-measurement" FULL_LOG=1 \
  remote-browser.sh "$PWD" unit scripts/extractor-measurement.test.js
```

The opt-in harness writes all 66 per-run measurements and first-run GC traces
into the copied-back evidence directory. The committed JSON is the measurement
run above; regenerate the summary by grouping format/size and taking maxima.

Red-before commit `f834db7111` ran on mbp2606: the measurement and two existing
safety/lowered-limit assertions passed; seven new assertions failed under the
old 2 MiB/8 MiB limits (including the large HTTP route refusal). Production
changes follow this evidence. Regression coverage includes all four formats at
exactly 20 MiB, cap + 1 with reason `limit` before worker spawn, every host
ceiling staying lower-only, OOXML ratio rejection in admission and the worker,
many-object PDF termination/reaping/recovery, and the real HTTP route at the cap.
