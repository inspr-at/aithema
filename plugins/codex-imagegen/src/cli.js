import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginError } from '@inspr/aithema-core';
import { runCodex } from './process.js';

// Installed codex-cli 0.162.0, `codex exec --help` (2026-10-09):
// L19-25: -c/--config accepts dotted TOML keys; shell_environment_policy is an example.
// L33-35: --strict-config; L37-38: -i/--image; L40-41: -m/--model;
// L53-56: --sandbox workspace-write; L87-97:
// --skip-git-repo-check, --ephemeral ("without persisting session files"),
// --ignore-user-config ("auth still uses CODEX_HOME"), --ignore-rules.
// L30-31: --disable FEATURE == -c features.<name>=false; L27-28: --enable.
// `codex features list`: L126 shell_tool stable true, L152 unified_exec stable true,
// L67 image_generation stable true, L131 skip_host_skill_discovery false.
// Other `codex features list` lines for each switch below: shell_snapshot L124,
// unified_exec_tty L153, code_mode L20, code_mode_host L22, apps L8, plugins L99,
// hooks L65, browser_use L15, browser_use_external L16, browser_use_full_cdp_access
// L17, computer_use L32, in_app_browser L69, in_app_local_automation L72,
// view_image L160, multi_agent L88, multi_agent_v2 L90, memories L85,
// external_agent_memory_import L51, skill_search L130, skill_mcp_dependency_install
// L129, workspace_dependencies L164, sleep_tool L132, tool_suggest L145,
// request_permissions_tool L111, stable_environment_tools L134,
// agent_message_board L1, goals L54, chronicle L18, daemon_auto_start L38.
// IMPORTANT: `features list --disable unified_exec -c features.unified_exec=false`
// still returns "unified_exec stable true" on this build. apply_patch_freeform
// (L5) is REMOVED, not an effective apply_patch off-switch. Hence the mandatory
// trustedPromptsOnly binding; help alone must never be treated as tool isolation.
const disabledFeatures = [
  'shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot',
  'code_mode', 'code_mode_host', 'apps', 'plugins', 'hooks',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'computer_use', 'in_app_browser', 'in_app_local_automation', 'view_image',
  'multi_agent', 'multi_agent_v2', 'memories', 'external_agent_memory_import',
  'skill_search', 'skill_mcp_dependency_install', 'workspace_dependencies',
  'sleep_tool', 'tool_suggest', 'request_permissions_tool', 'stable_environment_tools',
  'agent_message_board', 'goals', 'chronicle', 'daemon_auto_start',
];
const featureArgs = () => [
  ...disabledFeatures.flatMap(name => ['--disable', name]),
  '--enable', 'image_generation', '--enable', 'skip_host_skill_discovery',
];

// -c keys use the dotted TOML override documented in exec help L19-25.
// Their existence was also checked WITHOUT rendering via `codex features list -c
// KEY="INVALID"`: the installed parser rejects invalid types/variants for
// sandbox_mode, sandbox_workspace_write.{writable_roots,network_access,
// exclude_tmpdir_env_var,exclude_slash_tmp}, shell_environment_policy.{inherit,
// ignore_default_excludes,exclude,include_only,set}, project_doc_max_bytes,
// project_doc_fallback_filenames, mcp_servers, web_search and allow_login_shell.
// No config files or personal docs supply defaults for these safety settings.
export function configArgs(effort) {
  return [
    `model_reasoning_effort=${JSON.stringify(effort)}`,
    'sandbox_mode="workspace-write"', 'approval_policy="never"',
    'sandbox_workspace_write.network_access=false',
    'sandbox_workspace_write.writable_roots=[]',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    'mcp_servers={}', 'web_search="disabled"',
    'project_doc_max_bytes=0', 'project_doc_fallback_filenames=[]',
    'shell_environment_policy.inherit="none"',
    'shell_environment_policy.ignore_default_excludes=false',
    'shell_environment_policy.exclude=["*"]',
    'shell_environment_policy.include_only=[]', 'shell_environment_policy.set={}',
    'allow_login_shell=false',
  ].flatMap(value => ['-c', value]);
}
export function codexArgs(binding) {
  // workspace-write is the least permissive listed mode that permits an output
  // file. cwd is the sole writable root; both implicit system temp roots are off.
  return ['exec', '-m', binding.model, ...configArgs(binding.effort),
    '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral',
    '--ignore-user-config', '--ignore-rules', '--strict-config', ...featureArgs()];
}

export async function validateCodexHome(directory) {
  // Inspect names and metadata only, never authentication bytes. A dedicated
  // home may be empty before login; the only admitted file is a regular auth.json.
  if (!(await lstat(directory)).isDirectory()) throw new PluginError('unavailable');
  for (const name of await readdir(directory)) {
    if (name !== 'auth.json' || !(await lstat(join(directory, name))).isFile()) {
      throw new PluginError('unavailable');
    }
  }
}

export async function checkCLI({ binding, binaryPath, directory, env, signal, spawnImpl }) {
  const base = { binaryPath, directory, env, signal, spawnImpl, brief: '', capture: true };
  // Help parses the EXACT render argv but exits before authentication/provider
  // work. Reject incompatible flags and missing help evidence before dispatch.
  const help = await runCodex({ ...base, args: [...codexArgs(binding), '--help'] });
  for (const flag of ['--config', '--model', '--image', '--sandbox', '--skip-git-repo-check', '--ephemeral',
    '--ignore-user-config', '--ignore-rules', '--strict-config', '--disable', '--enable']) {
    if (!help.includes(flag)) throw new PluginError('unavailable');
  }
  // This local listing actually parses the pinned config and feature names;
  // unlike --help, it cannot silently accept an unknown feature. It has no
  // --ignore-user-config option, so probes use a fresh empty temporary home
  // instead of the operator's account. Never attach design content to either
  // startup command; neither command needs or receives authentication files.
  const listing = await runCodex({ ...base,
    args: ['features', 'list', ...configArgs(binding.effort), ...featureArgs()] });
  const enabled = new Map(listing.split('\n').flatMap(line => {
    const match = /^(\S+)\s+.+?\s+(true|false)\s*$/u.exec(line);
    return match ? [[match[1], match[2] === 'true']] : [];
  }));
  for (const feature of disabledFeatures) {
    if (!enabled.has(feature) || (enabled.get(feature) &&
      !(feature === 'unified_exec' && binding.routing.codex.trustedPromptsOnly === true))) {
      throw new PluginError('unavailable');
    }
  }
  if (enabled.get('image_generation') !== true || enabled.get('skip_host_skill_discovery') !== true) {
    throw new PluginError('unavailable');
  }
}
