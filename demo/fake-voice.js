import { createElevenLabsClient } from '../plugins/elevenlabs/src/client.js';

/** Deterministic in-process agent. Only host persistence/control uses localhost. */
export function createFakeVoice({ control, persistEvent, copy }) {
  let callbacks, id, eventId = 0, lastAssistant, muted = false, volume = 1, open = false;
  const say = (role, message) => {
    if (!open || muted && role === 'user') return;
    const event_id = ++eventId;
    callbacks.onModeChange({ mode: role === 'agent' ? 'speaking' : 'listening' });
    callbacks.onMessage({ role, message, event_id });
    if (role === 'agent') lastAssistant = { event_id, message };
  };
  const sdk = { async startSession(options) {
    callbacks = options; open = true; muted = false; id = options.fakeProviderSessionId;
    queueMicrotask(() => { if (open) { options.onConnect({ conversationId: id }); say('agent', copy.fakeVoiceGreeting); } });
    return { getId: () => id, getInputVolume: () => muted ? 0 : .25, getOutputVolume: () => volume * .6, setMicMuted: value => { muted = value; }, setVolume: value => { volume = value.volume; },
      sendUserMessage(text) { say('user', text); say('agent', copy.fakeVoiceReply); },
      sendContextualUpdate() {}, async endSession() { open = false; } };
  } };
  let providerSessionId;
  const wrappedControl = { ...control,
    async start(...args) { const grant = await control.start(...args); providerSessionId = grant.providerSessionId; return grant; },
    async recover(...args) { const grant = await control.recover(...args); providerSessionId = grant.providerSessionId; return grant; },
  };
  const client = createElevenLabsClient({ sdk: { startSession: options => sdk.startSession({ ...options, fakeProviderSessionId: providerSessionId }) },
    control: wrappedControl, persistEvent: event => persistEvent(event, { providerSessionId }) });
  return { client,
    speak(text = copy.fakeVoiceStatement) { say('user', text); say('agent', copy.fakeVoiceReply); },
    bargeIn(prefix = copy.fakeVoiceHeard) {
      if (!open || muted || !lastAssistant?.message.startsWith(prefix)) return;
      callbacks.onInterruption({ event_id: ++eventId });
      callbacks.onAgentResponseCorrection({ event_id: lastAssistant.event_id,
        original_agent_response: lastAssistant.message, corrected_agent_response: prefix });
      callbacks.onModeChange({ mode: 'listening' });
    },
    disconnect() { if (open) callbacks.onDisconnect(); },
    snapshot: () => ({ open, muted, volume }),
  };
}
