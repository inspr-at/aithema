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
fields. The server's effective request ceiling is the core 21 MiB ceiling or a
lower host setting. `AITHEMA_UPLOAD_MAX_REQUEST_BYTES` above the core ceiling
is rejected at configuration time; a host cannot raise it. The UI receives the
server ceiling in upload responses. The HTTP test uses the default server
request ceiling, compares admitted bytes byte-for-byte,
checks framing below 64 KiB, waits for accepted/truncated extraction and verifies
original bytes are discarded. One extra source byte is refused with HTTP 413.

`packages/core/src/chat-completions.js:227` counts incoming provider SSE response
bytes (and an incomplete-event buffer) in the chat response stream. It is not
on the document upload/extractor path and remains unchanged.

## Pending jobs and resident memory (round 2)

Admission reserves **three requests per server process**, shared across handler
instances: one running request and up to two pending requests. Reservation begins
before `readBody` and ends only when **every file in that request** is terminal.
The existing lower request-concurrency settings still apply. A full budget
returns HTTP **429** with `upload-rate-limit` before reading or parsing the body;
the UI sends batches sequentially and retries this busy response up to three
total attempts, waiting 5 then 10 seconds (or longer if `Retry-After` requires it).
This is necessary because HTTP 202 retains the reservation through extraction,
so sequential requests alone can still fill it. Only exhausted attempts show the
busy/try-again message in the existing notice slot. Parsing errors, denied admission,
replays, withdrawal, cancellation, deadline expiry and shutdown release reservations.
If an earlier extraction changes the input revision during admission of the next
request, that uncommitted request also returns retryable busy. Retrying revalidates
ownership, consent and the new revision; stored receipt byte conflicts remain 409.

A separate process-wide FIFO semaphore encloses `storage.uploadBytes`, sniffing,
runtime admission and extraction. **Only one job loads source bytes**; waiting
jobs hold IDs/metadata and leave originals in SQLite. Thus queued extraction jobs
hold **zero source bytes**, including old durable backlogs recovered after restart.
Recovery drains through the same semaphore and blocks new admission while the
recovered reservation count fills the budget. Cancelled/expired waiters remove
themselves without loading their bytes. Running cancellation retains the semaphore
until extraction settles and the worker has been reaped.

The SQLite result is an owned byte array; `uploadBytes` returns a view rather than
copying it again. The core extractor still snapshots caller-owned input before
waiting on its worker slot, preserving isolation from caller mutation. IPC still
serializes the one running job. Worker bounds and the measurements above are unchanged.

For capacity planning, let `Q = 3`, `R = min(21 MiB, host request ceiling)`,
`B = min(20 MiB, host file ceiling)`, and `W = 384 MiB` (or a lower worker RSS
setting). A conservative worst-case live payload allowance is:

```text
queued source bytes = 0
parent payload bytes <= 2 * Q * R + 3 * B
                     = 126 MiB + 60 MiB = 186 MiB at the defaults
RSS_total <= RSS_base + RSS_SQLite + RSS_transport + S_sniff + 2*Q*R + 3*B + W
             + GC/allocator slack + watchdog overshoot
          = fixed/service overhead + 570 MiB + GC/allocator slack + watchdog overshoot
```

`2*Q*R` conservatively allows a complete body plus transient input/staging bytes
for every admitted request, even while another job is running. `3*B` allows the
one loaded SQLite result, its isolation snapshot and IPC serialization. Multipart
parts are views. `S_sniff` is the bounded parent MIME/archive inspection workspace;
SQLite cache, connection buffers and ordinary session/output metadata are separate
service overhead. This is a live-memory capacity formula, not a hard RSS promise:
V8/SQLite allocators can retain freed pages, and the unchanged 25 ms worker RSS
watchdog can overshoot before reaping. Hosts must allow that headroom. Incoming
traffic cannot multiply the queued source-byte term or the three body reservations.

Round-2 regression uses eight concurrent streamed 20 MiB uploads and an injected
slow extractor. The byte counter observes stored-source loads through completion:
three requests are accepted, five get retryable 429 without body reads, only one
20 MiB source is loaded at once, later traffic remains refused after HTTP 202,
and admitted jobs finish FIFO. Separate withdrawal, deadline and shutdown cases
verify queued jobs never load bytes and that all three reservations and the byte
semaphore remain reusable. Existing real-worker cancellation/reaping tests still apply.
Multi-file and restart cases also cover reservation lifetime and duplicate resume.

Round-2 red-before commit `684dfc76e5` ran on mbp2606 at 2026-10-16 01:44 UTC:
all seven selected assertions failed under the old queue/request behavior (four
large requests admitted instead of three, queued loads before the byte slot,
and the old 64 MiB default). The tests completed in 834 ms.

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
