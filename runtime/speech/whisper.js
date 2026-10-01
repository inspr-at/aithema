import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../contracts/validate.js';
import { withCancellation } from '../ports/cancellation.js';
import { SpeechAttempt } from './attempt.js';
import { abortError, approved, checkAbort, speechError, wavInput } from './common.js';

const supervisor = fileURLToPath(new URL('./whisper-supervisor.js', import.meta.url));

/** Separately installed whisper.cpp CLI. Each bounded utterance is one child
 * invocation, one zero-cost hold and one claim. No shell or executable choice
 * from browser input; the model path and command are operator-owned.
 */
export class WhisperCppSpeechToText extends SpeechAttempt {
  constructor(config) {
    super(config, 'stt', true);
    if (process.platform === 'win32') throw new TypeError('whisper.cpp supervision requires POSIX process groups');
    if (config.maxMicro !== 0 || typeof config.command !== 'string' || !isAbsolute(config.command)
        || typeof config.modelPath !== 'string' || !isAbsolute(config.modelPath)
        || !Array.isArray(config.args ?? []) || !(config.args ?? []).every((arg) => typeof arg === 'string')) {
      throw new TypeError('whisper.cpp requires zero cost and absolute operator command/model paths');
    }
    if (!Array.isArray(config.allowedModels) || config.allowedModels.length !== 1) throw new TypeError('One approved whisper model per operator model path required');
    this.modelId = approved(config.modelId, undefined, config.allowedModels, 'model');
    this.allowedModels = Object.freeze([...config.allowedModels]);
    this.command = config.command;
    this.args = Object.freeze([...(config.args ?? [])]);
    this.modelPath = config.modelPath;
    this.executionLocation = 'local';
  }

  async *streamTranscribe(request) {
    yield* this.run(request, () => {
      approved(request.model, this.modelId, this.allowedModels, 'model');
      const audio = wavInput(request, this.limits);
      const language = request.language ?? 'auto';
      if (!/^(?:auto|[a-z]{2})$/.test(language)) throw new TypeError('Invalid whisper language');
      return { bytes: Buffer.from(canonicalJson({ audio: audio.toString('base64'), command: this.command,
        args: this.args, modelPath: this.modelPath, language })) };
    }, async (prepared, bytes, signal, emit) => {
      checkAbort(signal);
      const child = spawn(process.execPath, [supervisor], { detached: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      let failure, stderrBytes = 0;
      // Attach before any IO: spawn errors must not become unhandled events.
      const closed = new Promise((resolve) => {
        child.once('error', (error) => { failure = error; });
        child.once('close', (code) => resolve(code));
      });
      child.stdin.on('error', (error) => { failure ??= error; });
      child.stdio[3].on('error', (error) => { failure ??= error; });
      const stop = () => { child.stdio[3].destroy(); child.stdin.destroy(); child.stdout.destroy(); };
      signal.addEventListener('abort', stop, { once: true });
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > this.limits.maxResponseBytes) { failure = speechError('response_too_large', 'whisper stderr exceeds its bound'); stop(); }
      });
      child.stdin.end(bytes);
      let buffer = '', total = 0, chars = 0, emitted = false;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        const iterator = child.stdout[Symbol.asyncIterator]();
        while (true) {
          const { value, done } = await withCancellation(() => iterator.next(), signal, abortError, stop);
          if (done) break;
          total += value.length;
          if (total > this.limits.maxResponseBytes) throw speechError('response_too_large', 'whisper output exceeds its bound');
          buffer += decoder.decode(value, { stream: true });
          if (Buffer.byteLength(buffer) > this.limits.maxBufferedBytes) throw speechError('response_too_large', 'whisper line exceeds its bound');
          const lines = buffer.split(/\r?\n/); buffer = lines.pop();
          for (const line of lines) {
            checkAbort(signal);
            if (!line.trim()) continue;
            const text = `${emitted ? ' ' : ''}${line.trim()}`;
            chars += text.length;
            if (chars > this.limits.maxTextChars) throw speechError('response_too_large', 'whisper text exceeds its bound');
            emitted = true; await emit(text);
          }
        }
        buffer += decoder.decode();
        const code = await withCancellation(() => closed, signal, abortError, stop);
        checkAbort(signal);
        if (failure || code !== 0) throw speechError('child_failed', 'whisper.cpp process failed');
        if (buffer.trim()) {
          const text = `${emitted ? ' ' : ''}${buffer.trim()}`;
          if (chars + text.length > this.limits.maxTextChars) throw speechError('response_too_large', 'whisper text exceeds its bound');
          emitted = true; await emit(text);
        }
        if (!emitted) throw speechError('invalid_output', 'whisper.cpp produced no transcription');
      } finally {
        signal.removeEventListener('abort', stop);
        stop();
        await closed; // supervisor kills/reaps the group and cleans audio first
      }
    });
  }

  async transcribe(request) {
    let text = '';
    for await (const chunk of this.streamTranscribe(request)) text += chunk;
    checkAbort(request.signal);
    return { text };
  }
}
