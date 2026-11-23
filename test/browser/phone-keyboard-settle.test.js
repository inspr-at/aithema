// AIT-618 r6 (AIT-597 split method): the AIT-618 r4/r5 settle registration and the r5 late-add registration,
// moved out of phone-dock.test.js unchanged (names, options, order, same fixture and helpers) so the shard
// packer weighs them as their own workload; phone-dock.test.js alone exceeded the 405 s target and 420 s ceiling.
import { test } from 'node:test';
import { keyboardHostLateAddCheck, keyboardLateHeaderSlotCheck, keyboardSettleCheck } from './keyboard-room-check.js';
test('AIT-618 r4/r5 (TICK Q1 (a) + r4 M1, Codex gate2c M1 + gate3c M2): ONE keyboard-up state: a header tap or a real Pause that disables the composer moves nothing (footer, dock, Mic, Send, notice, band, Pause); the settle (injected clock) ends it only on a stale height, it is kept while the viewport stays keyboard-small (held at 308, partial recovery to 340, zoomed), and it ends in one reflow when the viewport grows back; a height drop after blur opens no state (320x568 vv308 EN/DE image dock)', { timeout:420_000 }, keyboardSettleCheck);
test('AIT-618 r5 (Codex gate3c M4, TICK (a) grow-only latch): the host adding Contact into the pause column while the keyboard is up grows the row 44 -> 88 once (only Pause moves, x 170, y +44, focus kept), and removing it keeps 88 (320x568 vv308/vv340 EN/DE image dock)', { timeout:300_000 }, keyboardHostLateAddCheck);
test('AIT-635: late Contact during pinch zoom clears Pause on the first frame and keeps the 88 px rail through unzoom', { timeout:300_000 }, t => keyboardLateHeaderSlotCheck(t, 'contact-launcher', true));
test('AIT-635: a late account slot control clears Pause on the first frame and keeps the other controls fixed', { timeout:300_000 }, t => keyboardLateHeaderSlotCheck(t, 'account', false));
