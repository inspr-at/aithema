import { PluginError } from '@inspr/aithema-core/invocation';
import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { usdCostMicro } from '@inspr/aithema-core/cost';

const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const zero = () => ({ providerSeconds: 0, providerMinutes: 0, pausedSeconds: 0, visitorSeconds: 0,
  upstreamMicro: 0, visitorMicro: 0, characters: 0, providerCredits: 0, costEstimated: false });

/** GET-only config read; no agent edits or model invocation. Quotes stay server-side. */
export function createTextSpeech({ binding, fetchImpl, resolveSecret, readJson }) {
  const get = async (path, options) => {
    const key = await resolveSecret(binding.secretRef);
    if (!key) throw new PluginError('unavailable');
    const response = await fetchImpl(`${binding.apiBaseUrl}${path}`, { headers: { 'xi-api-key': key }, signal: options.signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new PluginError('unavailable'); }
    return readJson(response, 262_144, options);
  };
  return {
    quoteSpeakText(request, options) {
      return voiceOperation(options, async opts => {
        if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 16_384 ||
          !finite(binding.usdPerCredit)) throw new PluginError('unavailable');
        const agent = await get(`/v1/convai/agents/${encodeURIComponent(binding.agentId)}`, opts);
        const tts = agent?.conversation_config?.tts;
        if (agent.agent_id !== binding.agentId || !id(tts?.voice_id) || !id(tts?.model_id)) throw new PluginError('unavailable');
        const voice = await get(`/v1/voices/${encodeURIComponent(tts.voice_id)}`, opts);
        // Legacy shared voices can have an account-dependent surcharge. Without
        // an authoritative quote for that surcharge, retain the text fallback.
        if (voice.voice_id !== tts.voice_id || voice.sharing?.rate > 0) throw new PluginError('unavailable');
        const models = await get('/v1/models', opts), model = Array.isArray(models) && models.find(item => item.model_id === tts.model_id);
        const multiplier = model?.model_rates?.character_cost_multiplier, discount = model?.model_rates?.cost_discount_multiplier;
        if (!model?.can_do_text_to_speech || !finite(multiplier) || !finite(discount)) throw new PluginError('unavailable');
        const maxMicro = usdCostMicro(binding.usdPerCredit, Math.ceil(request.text.length * multiplier * discount));
        if (maxMicro === null) throw new PluginError('unavailable');
        return { maxMicro, opaque: { voiceId: tts.voice_id, modelId: tts.model_id, text: request.text } };
      });
    },
    async speakText({ text, quote }, options) {
      if (quote?.opaque?.text !== text || !id(quote?.opaque?.voiceId) || !id(quote?.opaque?.modelId)) throw new PluginError('not-admitted');
      let dispatched = false, usage, refused = false;
      try {
        return await voiceOperation(options, async opts => {
          const key = await resolveSecret(binding.secretRef);
          if (!key) throw new PluginError('unavailable');
          await options.attempt.consume(); opts.signal.throwIfAborted(); dispatched = true;
          const response = await fetchImpl(`${binding.apiBaseUrl}/v1/text-to-speech/${encodeURIComponent(quote.opaque.voiceId)}/stream?output_format=pcm_16000`, {
            method: 'POST', signal: opts.signal, redirect: 'error', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/pcm' },
            body: JSON.stringify({ text, model_id: quote.opaque.modelId, apply_text_normalization: 'off' }),
          });
          if (!response.ok) {
            refused = [401, 403, 422, 429].includes(response.status);
            await response.body?.cancel(); throw new PluginError('unavailable');
          }
          // ElevenLabs documents character-cost as charged credits, and x-character-count as usage.
          // Never accept usage from the browser or mark a missing receipt as zero cost.
          const creditsHeader = response.headers.get('character-cost'), charactersHeader = response.headers.get('x-character-count');
          const credits = creditsHeader === null ? NaN : Number(creditsHeader), characters = charactersHeader === null ? text.length : Number(charactersHeader);
          const upstreamMicro = finite(credits) ? usdCostMicro(binding.usdPerCredit, credits) : null;
          if (upstreamMicro !== null && Number.isSafeInteger(characters) && characters >= 0) usage = {
            ...zero(), characters, providerCredits: credits, upstreamMicro, visitorMicro: upstreamMicro,
            costSource: 'elevenlabs.tts.character-cost', usdPerCredit: binding.usdPerCredit,
          };
          const reader = response.body?.getReader();
          if (!reader) throw new PluginError('invalid-output');
          const chunks = []; let size = 0;
          const cancel = () => { void reader.cancel().catch(() => {}); };
          opts.signal.addEventListener('abort', cancel, { once: true });
          try {
            for (;;) {
              const { value, done } = await reader.read(); opts.signal.throwIfAborted(); if (done) break;
              size += value.byteLength; if (size > 4_194_304) throw new PluginError('limit'); chunks.push(Buffer.from(value));
            }
          } finally { cancel(); opts.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
          if (!size || size % 2) throw new PluginError('invalid-output');
          return { audio: { format: 'pcm_16000', data: Buffer.concat(chunks).toString('base64') }, usage };
        });
      } finally {
        if (typeof options.report === 'function') await options.report({
          outcome: !dispatched || refused ? 'cancelled' : usage ? 'completed' : 'uncertain',
          closureConfirmed: !dispatched || refused || Boolean(usage),
          usage: !dispatched || refused ? zero() : usage ?? null,
          chargedMicro: !dispatched || refused ? 0 : usage?.upstreamMicro ?? quote.maxMicro,
        });
      }
    },
  };
}
