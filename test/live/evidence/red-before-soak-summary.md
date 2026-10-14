# AIT-139 voice soak (fake, de)

Head: df3b139491. Status: **failed**; stop: max-duration; duration: 5.00 min.

Server first token p50/p95: unavailable/unavailable ms; total: unavailable/unavailable ms. Deadline misses: 0/0.

Client first response p50/p95: 16.400000005960464/24.099999994039536 ms; missing responses: 0. Scripted turns: 14; barge-in receipts: 5; retries: 0; recoveries: 1.

Wallet confirmed delta: $0.000000; uncertain: $0.000000; reserved: $0.000000; cap: $8.00. Reconciled: true.

Fake voice uses simulated speech events plus actual WAV capture; it has no ASR, paid TTS or reasoning callbacks. Server token metrics are unavailable in fake mode. Client response timing is not token timing. This report is input for AIT-105, not live-provider acceptance.
