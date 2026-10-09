import type { PrivateBinding, UIGeneration, Terminal } from '../../../packages/core/src/plugin-contract.js';
import type { spawn } from 'node:child_process';

export interface CodexImagegenBinding extends PrivateBinding {
  plugin: 'codex-imagegen';
  maxMicro: 0;
  rates: { inputMicro: 0; outputMicro: 0 };
  routing: { codex: { binaryPath: string; codexHome: string; timeoutMs: number; trustedPromptsOnly: true }; [key: string]: unknown };
}
/** Dispatched calls add cost/duration. Preflight/refusal retains the exact shared zero report.
 * Zero token totals are successful monetary settlement units, not measured CLI token consumption.
 * Dispatched failures have outcome uncertain and omit usage; chargedMicro is the claim maximum (0). */
export type CodexImagegenTerminal = Terminal & { chargedMicro?: 0; durationMs?: number };
export const manifest: Readonly<object>;
export function createCodexImagegen(options: { binding: CodexImagegenBinding; spawnImpl?: typeof spawn }): UIGeneration & {
  id: 'codex-imagegen'; manifest: typeof manifest; binding: CodexImagegenBinding; billable: true; label: string;
  bind(binding: CodexImagegenBinding): ReturnType<typeof createCodexImagegen>;
};
