import { palette } from './styles.js';

export const actorRoleStyles = `
.footer-left { display:flex; align-items:center; gap:20px; justify-self:start; min-width:0; }
.actor-role { position:relative; display:grid; flex:none; font-size:12.5px; }
.actor-reservation,.actor-trigger { grid-area:1/1; }
.actor-reservation { visibility:hidden; display:grid; pointer-events:none; }
.actor-reservation > span { grid-area:1/1; white-space:pre; min-height:44px; display:flex; align-items:center; }
.actor-trigger { display:flex; align-items:center; min-height:44px; padding:0; border-radius:0; font:inherit; white-space:nowrap; color:var(--aithema-muted); background:none; }
.actor-trigger:hover,.actor-trigger[aria-expanded=true] { color:var(--aithema-ink); background:none; }
.actor-spark { display:inline-grid; width:11px; height:11px; margin-left:5px; color:var(--aithema-accent); }
.actor-value { font-weight:500; color:color-mix(in srgb,var(--aithema-ink) 80%,var(--aithema-muted)); }
.actor-trigger-text { white-space:pre; }
.actor-spark svg { width:11px; height:11px; } .actor-chevron { width:10px; height:10px; margin-left:6px; color:var(--aithema-muted); }
.actor-popover { --role-paper:#102b42; --role-ink:${palette.dark.ink}; --role-muted:${palette.dark.muted}; --role-accent:${palette.dark.accent}; --role-error:${palette.dark.error}; --role-line:rgba(234,241,246,.12);
  position:absolute; left:-16px; bottom:calc(100% + 12px); z-index:16; box-sizing:border-box; width:372px; max-width:calc(100vw - 24px);
  padding:10px 6px 4px; border-radius:12px; background:var(--role-paper); color:var(--role-ink); font-size:12.5px; line-height:1.5; white-space:normal;
  box-shadow:0 0 0 1px var(--aithema-line),0 18px 40px -16px rgba(0,0,0,.5); }
.actor-context { padding:2px 10px 10px; color:var(--role-muted); }
.actor-account { padding:2px 10px 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--role-muted); }
.actor-why { display:grid; grid-template-columns:11px minmax(0,1fr); gap:7px; height:3em; margin:0; overflow:hidden; }
.actor-why-spark svg { width:11px; height:11px; color:var(--role-accent); margin-top:.32em; }
.actor-reason b { font-weight:600; color:var(--role-ink); }
.actor-reason { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.actor-why[data-kind=chosen] { grid-template-columns:minmax(0,1fr); align-content:center; }
.actor-why[data-kind=chosen] .actor-why-spark { display:none; }
.actor-radios { margin:0; padding:4px 0; border:0; border-top:1px solid var(--role-line); min-width:0; display:grid; }
.actor-option { display:grid; grid-template-columns:18px minmax(0,1fr); gap:12px; align-items:center; box-sizing:border-box; height:44px; padding:0 10px; border-radius:8px; font-size:14px; line-height:1.3; color:var(--role-ink); cursor:pointer; user-select:none; }
.actor-option:hover { background:rgba(255,255,255,.07); }
.actor-dot { display:grid; place-items:center; width:18px; height:18px; }
.actor-dot > * { grid-area:1/1; }
.actor-option input { appearance:none; -webkit-appearance:none; margin:0; width:16px; height:16px; border-radius:50%; cursor:inherit; background:transparent; box-shadow:inset 0 0 0 1.5px var(--role-muted); }
.actor-option input:checked { box-shadow:inset 0 0 0 1.5px var(--role-accent),inset 0 0 0 4.5px var(--role-paper),inset 0 0 0 8px var(--role-accent); }
.actor-option input:focus-visible { outline:none; }
.actor-option:has(input:focus-visible) { outline:2px solid var(--role-accent); outline-offset:-2px; }
.actor-spin { width:16px; height:16px; color:var(--role-accent); visibility:hidden; }
.actor-option[data-pending] input { opacity:0; }
.actor-option[data-pending] .actor-spin { visibility:visible; animation:actor-spin .8s linear infinite; }
@keyframes actor-spin { to { transform:rotate(360deg); } }
.actor-option:has(input:disabled) { color:color-mix(in srgb,var(--role-ink) 45%,var(--role-paper)); cursor:default; }
.actor-option:has(input:disabled):hover { background:none; }
.actor-option input:disabled { box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--role-muted) 45%,var(--role-paper)); }
.actor-status { display:flex; align-items:center; flex-wrap:wrap; align-content:center; box-sizing:border-box; height:36px; padding:0 10px; margin:0; border-top:1px solid var(--role-line); color:var(--role-muted); font-size:12.5px; line-height:1.35; }
.actor-status-icon { display:inline-block; width:14px; height:14px; margin-right:6px; vertical-align:-2.5px; }
.actor-status-sep { white-space:pre; }
.actor-status[data-phase=error] { color:var(--role-error); }
.actor-status[data-phase=stale],.actor-status[data-phase=saved] { color:var(--role-ink); }
.actor-retry { padding:0; position:relative; border-radius:3px; background:none; color:var(--role-ink); text-decoration:underline; text-underline-offset:3px; font:inherit; }
.actor-retry::before { content:''; position:absolute; inset:-13px 0; }
.actor-sheet { --role-paper:var(--aithema-surface); --role-ink:var(--aithema-ink); --role-muted:var(--aithema-muted); --role-accent:var(--aithema-accent); --role-error:var(--aithema-error); --role-line:var(--aithema-line);
  box-sizing:border-box; position:fixed; inset:auto 0 0; margin:0; border:0; width:100%; max-width:none; max-height:calc(100dvh - 48px); overflow:auto; overscroll-behavior:contain;
  padding:6px 8px calc(14px + env(safe-area-inset-bottom)); border-radius:22px 22px 0 0; background:var(--aithema-surface); color:var(--aithema-ink); box-shadow:0 -1px 0 var(--aithema-line),0 -24px 60px -24px rgba(0,0,0,.4); }
.actor-sheet::backdrop { background:rgba(0,0,0,.28); }
.actor-sheet header { display:flex; align-items:center; justify-content:space-between; min-height:56px; padding-left:14px; }
.actor-sheet h2 { font:700 20px/1.2 var(--aithema-display); letter-spacing:-.01em; margin:0; }
.actor-close { width:44px; height:44px; font-size:24px; color:var(--aithema-muted); }
.actor-sheet-section,.actor-processing { padding:12px 14px 8px; }
.actor-sheet h3 { font:700 17.5px/1.3 var(--aithema-display); letter-spacing:-.005em; margin:0; }
.actor-sheet .actor-context { margin-top:6px; padding:0 0 10px; font-size:14px; line-height:1.45; }
.actor-sheet .actor-why { height:2.9em; grid-template-columns:12px minmax(0,1fr); gap:8px; }
.actor-sheet .actor-why[data-kind=chosen] { grid-template-columns:minmax(0,1fr); }
.actor-sheet .actor-radios { margin:0 -8px; padding:6px 0; }
.actor-sheet .actor-option { height:50px; padding:0 8px; font-size:16px; grid-template-columns:20px minmax(0,1fr); gap:14px; }
.actor-sheet .actor-dot,.actor-sheet .actor-option input,.actor-sheet .actor-spin { width:20px; height:20px; }
.actor-sheet .actor-option input:checked { box-shadow:inset 0 0 0 1.5px var(--role-accent),inset 0 0 0 5.5px var(--role-paper),inset 0 0 0 10px var(--role-accent); }
.actor-sheet .actor-status { margin:0 -8px; padding:0 8px; height:44px; border:0; font-size:14px; }
.actor-sheet .actor-status[data-phase=error] { display:block; padding-top:2px; }
.actor-sheet .actor-status[data-phase=error] > span { display:block; }
.actor-sheet .actor-status[data-phase=error] .actor-status-icon { display:inline-block; width:14px; height:14px; margin-right:6px; vertical-align:-2.5px; }
.actor-status-sep { display:none; }
.actor-sheet .actor-retry { margin-left:20px; }
.actor-processing { border-top:1px solid var(--aithema-line); margin-top:6px; padding-top:16px; }
.actor-processing > button { display:flex; align-items:center; width:100%; min-height:50px; padding:0; text-align:left; color:var(--aithema-ink); font-size:16px; }
.actor-processing > button::after { content:'›'; margin-left:auto; }
.actor-role [hidden],.actor-sheet [hidden] { display:none; }
@media(max-width:599px) { .actor-role { display:none; } .footer-left { gap:0; } }
@media(prefers-reduced-motion:reduce) { .actor-spin { animation:none !important; } }
`;
