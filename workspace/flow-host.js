import { identityBinding } from './flow-shell/identity.js';
import './flow-shell/inspr-flow-shell.js';

const CONSEQUENTIAL = new Set(['flow:start-intent', 'flow:review-batch', 'flow:save-proposal']);
const MOUNT_PATTERN = /^(?:\/[A-Za-z0-9_-]+)+$/;

const shell = document.querySelector('inspr-flow-shell');
const raw = document.getElementById('aithema-flow-state');

function readState() {
  if (!raw || !raw.textContent) return null;
  try {
    return JSON.parse(raw.textContent);
  } catch {
    return null;
  }
}

function readPublicBasePath() {
  const meta = document.querySelector('meta[name="aithema-public-base-path"]');
  const value = meta?.getAttribute('content') ?? '';
  if (!value) return '';
  if (!MOUNT_PATTERN.test(value)) return '';
  return value;
}

const mount = readPublicBasePath();

function appPathname() {
  const pathname = window.location.pathname;
  if (!mount) return pathname;
  if (pathname === mount) return '/';
  if (pathname.startsWith(`${mount}/`)) return pathname.slice(mount.length) || '/';
  return pathname;
}

function projectIntentUrl() {
  const match = appPathname().match(/^\/projects\/[^/]+/);
  return match ? `${mount}${match[0]}/flow-intents` : `${mount}/flow-intents`;
}

function healthUrl() {
  return `${mount}/health`;
}

function scrollToId(id) {
  document.getElementById(id)?.scrollIntoView({ block: 'start' });
}

const state = readState();
if (shell && state) {
  shell.shellState = state;
}

shell?.addEventListener('flow-intent', async (event) => {
  const detail = event.detail;
  if (!detail || detail.error) {
    if (detail?.error) shell.showNotice(detail.error);
    return;
  }
  if (detail.type === 'flow:header-identity' || detail.type === 'flow:header-account') {
    scrollToId('identity-access');
    return;
  }
  if (detail.type === 'flow:header-project') {
    scrollToId('workspace-projects');
    return;
  }
  if (detail.type === 'flow:view-drafts') {
    scrollToId('workspace-review');
    return;
  }
  if (detail.type === 'flow:health') {
    try {
      const response = await fetch(healthUrl(), { headers: { accept: 'application/json' } });
      const body = await response.json();
      shell.showNotice(body.ok ? 'Workspace health probe succeeded. This is not delivery evidence.' : 'Workspace health probe failed.');
    } catch {
      shell.showNotice('Workspace health probe failed.');
    }
    return;
  }
  if (detail.type === 'flow:navigate-stage' || detail.type === 'flow:toggle-map') {
    return;
  }
  if (!CONSEQUENTIAL.has(detail.type)) return;

  const payload = {
    ...detail,
    identity: identityBinding(shell.shellState.identity),
  };
  try {
    const response = await fetch(projectIntentUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({ error: 'Flow intent could not be read.' }));
    if (!response.ok) {
      shell.showNotice(body.error || 'Flow intent was rejected. No delivery work started.');
      return;
    }
    if (body.notice) shell.showNotice(body.notice);
    if (body.location && body.routed === 'workspace-review') {
      const target = new URL(body.location, window.location.origin);
      if (target.pathname === window.location.pathname && target.hash) {
        scrollToId(target.hash.slice(1));
      }
    }
  } catch {
    shell.showNotice('Flow intent could not be revalidated. No delivery work started.');
  }
});
