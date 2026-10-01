import { WhisperCppSpeechToText } from '../../../runtime/speech/index.js';
import { config, host, sttRequest } from './helpers.mjs';
const fixtureHost = host({ after() {} }, true);
const adapter = new WhisperCppSpeechToText(config(fixtureHost.client, undefined, {
  maxMicro: 0, command: process.execPath, args: [process.argv[2], 'stall', process.argv[3]], modelPath: process.argv[2],
}));
for await (const chunk of adapter.streamTranscribe(sttRequest())) {
  process.stdout.write(chunk);
}
