const nonnegative = n => Number.isFinite(n) && n >= 0;
export function percentile(samples, fraction) {
  if (!samples.length) return null;
  return [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * fraction) - 1)];
}

export function summarize({ records = [], events = [], firstTokenMs = 5000, totalMs = 30_000 }) {
  const attempts = new Map(), closures = new Set();
  for (const record of records) {
    if (!record.turnHash || !record.attemptHash) continue;
    const turnKey = JSON.stringify([record.callHash, record.generationHash, record.turnHash]);
    const key = JSON.stringify([turnKey, record.attemptHash]);
    const attempt = attempts.get(key) ?? { turnKey };
    if (record.event === 'voice.turn.admission') attempt.admitted = true;
    if (record.event === 'voice.turn.closure' && record.closureConfirmed === true) closures.add(turnKey);
    if (record.event === 'voice.turn.first-token' && nonnegative(record.firstTokenMs)) attempt.first = record.firstTokenMs;
    if (record.event === 'voice.turn.completion') {
      if (nonnegative(record.totalMs)) attempt.total = record.totalMs;
      attempt.outcome = record.outcome;
    }
    attempts.set(key, attempt);
  }
  const admitted = [...attempts.values()].filter(a => a.admitted);
  const metric = (key, deadline) => {
    const samples = admitted.map(a => a[key]).filter(nonnegative);
    return { samples: samples.length, p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95),
      missed: admitted.filter(a => !nonnegative(a[key]) || a[key] > deadline || a.outcome === 'failed').length };
  };
  return { attempts: admitted.length, firstToken: metric('first', firstTokenMs), total: metric('total', totalMs),
    retries: records.filter(r => r.event === 'voice.turn.retry').length,
    reconciliationRetries: records.filter(r => r.event === 'voice.reconciliation-retry').length,
    reconnects: records.filter(r => r.event === 'voice.segment.reconnect').length,
    recoveries: events.filter(e => e.type === 'recovered').length,
    unclosed: admitted.filter(a => !closures.has(a.turnKey)).length,
    failed: admitted.filter(a => a.outcome === 'failed').length };
}

export function stopReason({ elapsedMs, maxDurationMs, capMicro, confirmedMicro, uncertainMicro,
  reservedMicro = 0, rateMicroPerMinute, stopReserveMicro }) {
  if (![elapsedMs, maxDurationMs, capMicro, confirmedMicro, uncertainMicro, reservedMicro,
    rateMicroPerMinute, stopReserveMicro].every(nonnegative) || capMicro > 8_000_000) return 'invalid-cost';
  const bound = Math.max(confirmedMicro + uncertainMicro + reservedMicro, Math.ceil(elapsedMs / 60_000 * rateMicroPerMinute));
  if (bound + stopReserveMicro >= capMicro) return 'cost-cap';
  if (elapsedMs >= maxDurationMs) return 'max-duration';
  return null;
}

/** Independent wall-clock backstop; the observer can only tighten the deadline. */
export function spendGuard(config, { abort, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false;
  const stop = reason => { if (!stopped) { stopped = true; abort(reason); } };
  const costMs = config.rateMicroPerMinute > 0
    ? Math.max(0, (config.capMicro - config.stopReserveMicro) / config.rateMicroPerMinute * 60_000) : Infinity;
  const timer = setTimer(() => stop(costMs < config.maxDurationMs ? 'cost-cap' : 'max-duration'), Math.min(costMs, config.maxDurationMs));
  return { check: costs => { const reason = stopReason({ ...config, ...costs }); if (reason) stop(reason); return reason; },
    dispose: () => clearTimer(timer) };
}

export const disruptionAt = (plan, elapsedMs) => plan.find(d => elapsedMs >= d.atMs && elapsedMs < d.atMs + d.durationMs) ?? null;
export function schedule(durationMs) {
  const turns = [];
  for (let atMs = 5000, ordinal = 0; atMs + 15_000 < durationMs; atMs += 20_000, ordinal++) {
    turns.push({ atMs, ordinal, bargeIn: ordinal % 3 === 1 });
  }
  return { turns, disruptions: [
    { atMs: Math.floor(durationMs * .3), durationMs: 1000, offline: true, latencyMs: 0 },
    { atMs: Math.floor(durationMs * .6), durationMs: 5000, offline: false, latencyMs: 400 },
  ] };
}

export function validateOptions(input = {}) {
  const mode = input.mode ?? 'fake', locale = input.locale ?? 'de';
  const minutes = Number(input.minutes ?? 5), maximum = Number(input.maxDuration ?? minutes);
  const capUsd = Number(input.capUsd ?? 8), rateUsd = Number(input.rateUsd ?? (mode === 'fake' ? 0 : .12));
  const reserveUsd = Number(input.reserveUsd ?? .25);
  if (![minutes, maximum].every(n => Number.isFinite(n) && n >= .5 && n <= 60)) throw new Error('duration must be 0.5–60 minutes');
  if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 8 || !Number.isFinite(reserveUsd) || reserveUsd < .1 || reserveUsd >= capUsd) throw new Error('cap must be at most $8 with at least $0.10 stop reserve');
  if (!['fake', 'live'].includes(mode) || !['de', 'en'].includes(locale)) throw new Error('Unknown mode or locale');
  if (mode === 'live' && !input.ops) throw new Error('Live starts require the separate OPS --ops gate');
  if (mode === 'live' && locale !== 'de') throw new Error('Only the approved DE run is enabled');
  if (!Number.isFinite(rateUsd) || rateUsd < 0 || (mode === 'live' && rateUsd <= 0)) throw new Error('Combined upstream rate bound required');
  if (mode === 'live' && (!input.url || !input.diagnostics)) throw new Error('OPS must supply an isolated HTTPS URL and sanitized diagnostics file');
  if (input.url && (new URL(input.url).protocol !== 'https:' || new URL(input.url).username || new URL(input.url).password)) throw new Error('OPS URL must be HTTPS without credentials');
  return { ...input, mode, locale, minutes, maxDurationMs: Math.min(minutes, maximum) * 60_000,
    capMicro: Math.floor(capUsd * 1_000_000), rateMicroPerMinute: Math.ceil(rateUsd * 1_000_000),
    stopReserveMicro: Math.ceil(reserveUsd * 1_000_000), firstTokenMs: 5000, totalMs: 30_000 };
}

// Closed projection: never write transcripts, URLs, cookies, credentials or raw errors.
export function diagnosticRecords(text, callHash) {
  return text.split('\n').flatMap(line => {
    let row; try { row = JSON.parse(line); } catch { return []; }
    if (!row?.event?.startsWith('voice.') || row.callHash !== callHash) return [];
    return [Object.fromEntries(Object.entries(row).filter(([key, value]) =>
      ['event', 'callHash', 'generationHash', 'turnHash', 'attemptHash', 'providerHash'].includes(key)
        ? typeof value === 'string' && (key === 'event' ? /^voice\.[a-z.-]+$/u.test(value) : /^[a-f0-9]{64}$/u.test(value))
        : ['firstTokenMs', 'totalMs', 'admissionMs', 'chargedMicro', 'reconciliationAgeMs'].includes(key) ? nonnegative(value)
          : ['closureConfirmed', 'costEstimated'].includes(key) ? typeof value === 'boolean'
            : key === 'outcome' && ['completed', 'failed'].includes(value)))];
  });
}

export function markdown(report) {
  const server = report.server, client = report.client;
  return `# AIT-139 voice soak (${report.mode}, ${report.locale})\n\n`
    + `Head: ${report.head}. Status: **${report.status}**; stop: ${report.stopReason}; duration: ${(report.elapsedMs / 60_000).toFixed(2)} min.\n\n`
    + `Server first token p50/p95: ${server.firstToken.p50Ms ?? 'unavailable'}/${server.firstToken.p95Ms ?? 'unavailable'} ms; total: ${server.total.p50Ms ?? 'unavailable'}/${server.total.p95Ms ?? 'unavailable'} ms. Deadline misses: ${server.firstToken.missed}/${server.total.missed}.\n\n`
    + `Client first response p50/p95: ${client.firstResponse.p50Ms ?? 'unavailable'}/${client.firstResponse.p95Ms ?? 'unavailable'} ms; missing responses: ${client.missingResponses}. Scripted turns: ${client.turns}; barge-in receipts: ${client.bargeIns}; retries: ${server.retries}; recoveries: ${server.recoveries}.\n\n`
    + `Wallet confirmed delta: $${(report.cost.confirmedMicro / 1_000_000).toFixed(6)}; uncertain: $${(report.cost.uncertainMicro / 1_000_000).toFixed(6)}; reserved: $${(report.cost.reservedMicro / 1_000_000).toFixed(6)}; cap: $${(report.config.capMicro / 1_000_000).toFixed(2)}. Reconciled: ${report.cost.reconciled}.\n\n`
    + `Fake voice uses simulated speech events plus actual WAV capture; it has no ASR, paid TTS or reasoning callbacks. Server token metrics are unavailable in fake mode. Client response timing is not token timing. This report is input for AIT-105, not live-provider acceptance.\n`;
}
