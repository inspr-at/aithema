// START ai-settings.css, settings-compact.css, landing-presets.css and local.css,
// ported to the host tokens without START branding (INSPR D3). Every changing value
// sits in a fixed box: hover, saves and gauge updates never move a control.
export const settingsStyles = `
:host { --aithema-gauge-quality:#0ccfc6; --aithema-gauge-speed:#ffb314; --aithema-gauge-cost:#e4775b;
  --aithema-gauge-privacy:#48b886; --aithema-gauge-voice:#1bced5; --aithema-gauge-images:#a181fa; }
.visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.engine { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:.2rem 1rem; }
.engine__text { min-width:0; display:grid; gap:.1rem; }
.engine__label { font-size:.7rem; color:var(--aithema-muted); }
/* The choice wraps rather than ending in "…"; the band scrolls if a long one needs it. */
.engine__value { font-size:.92rem; font-weight:650; overflow-wrap:anywhere; }
.engine__detail { font-size:.72rem; color:var(--aithema-muted); overflow-wrap:anywhere; }
.settings-open { display:inline-flex; align-items:center; gap:.4rem; min-height:2.75rem; font-size:.8rem; white-space:nowrap; }
.settings-open svg, .chooser__continue svg, .done svg { display:block; flex:none; }

dialog.settings { padding:0; margin:auto; border:1px solid var(--aithema-line); border-radius:1.1rem; color:var(--aithema-ink);
  width:min(78rem, calc(100vw - 1rem)); height:min(47rem, calc(100dvh - 1rem)); max-width:none; max-height:none; overflow:hidden;
  background:linear-gradient(125deg,var(--aithema-surface),var(--aithema-paper)); box-shadow:0 28px 100px #10233535,0 2px 12px #392a1912;
  font:.875rem/1.4 var(--aithema-font); }
dialog.settings::backdrop { background:rgb(12 28 39 / .36); backdrop-filter:blur(6px); }
.settings__frame { display:flex; flex-direction:column; height:100%; min-height:0; }
.settings :is(button,input,select,textarea,summary,a,[tabindex]):focus-visible { outline:3px solid var(--aithema-accent); outline-offset:2px; }
.settings :is(button,select,summary,.select__button) { min-height:2.75rem; }
.settings button:disabled { cursor:not-allowed; }
.settings h2, .settings h3, .settings h4, .settings h5, .settings p, .settings figure { margin:0; }
.settings details { border-top:0; padding:0; font-size:inherit; } .settings details p { padding:0; }
.settings__header { flex:none; display:grid; grid-template-columns:auto minmax(0,1fr); align-items:end; gap:0 2rem; padding:.6rem 1.6rem 0; }
.settings__title { font:400 1.9rem/1.15 Georgia,serif; letter-spacing:-.02em; padding-bottom:.45rem; }
.settings__tabs { display:flex; gap:.4rem; border-bottom:1px solid var(--aithema-line); }
/* GUI-27: the selected tab is marked by ink text and an accent icon, never by a line only it has. Weight never changes. */
.settings__tabs button { flex:1; display:flex; align-items:center; justify-content:center; gap:.45rem; border:0; border-radius:.45rem .45rem 0 0;
  background:transparent; padding:.55rem .3rem; white-space:nowrap; font-weight:600; color:var(--aithema-muted); }
.settings__tabs button[aria-selected=true] { color:var(--aithema-ink); }
.tab-icon { display:grid; place-items:center; width:1.15rem; height:1.15rem; color:var(--aithema-muted); }
.settings__tabs button[aria-selected=true] .tab-icon { color:var(--aithema-accent); }
.tab-icon svg { display:block; width:100%; height:100%; }
.settings__body { flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; padding:1.2rem 1.6rem; }
.settings-panel { display:grid; gap:1.4rem; min-width:0; }
.settings-panel[data-panel=model] { grid-template-columns:minmax(0,1.08fr) minmax(0,1fr) minmax(0,.95fr); align-items:start; }
.settings-column { display:grid; gap:1.4rem; align-content:start; min-width:0; }
.settings-field { border:0; margin:0; padding:0; min-width:0; display:grid; gap:.55rem; }
.settings-field legend { padding:0; margin-bottom:.55rem; font:400 1.3rem/1.2 Georgia,serif; color:color-mix(in oklab,var(--aithema-ink) 85%,transparent); }
.help-term { border-radius:.25rem; }
.presets { display:grid; gap:.15rem; }
.preset-option { display:flex; align-items:center; gap:.75rem; width:100%; padding:.3rem .4rem; border:0; border-radius:.5rem;
  background:transparent; text-align:left; }
.preset-option:hover { background:color-mix(in srgb,var(--aithema-accent) 8%,transparent); }
.preset-option[aria-disabled=true] { color:var(--aithema-muted); cursor:help; }
.radio { flex:none; width:1.05rem; height:1.05rem; border-radius:50%; border:1.25px solid var(--aithema-muted); background:var(--aithema-surface); }
[aria-checked=true]>.radio, [aria-pressed=true] .radio { border:5px solid var(--aithema-accent); }
.preset-icon { flex:none; display:grid; place-items:center; width:1.5rem; height:1.5rem; color:var(--aithema-accent); }
.preset-icon svg { display:block; width:100%; height:100%; }
.preset-name { flex:1; min-width:0; }
.option-status { flex:none; width:8.5rem; text-align:right; font-size:.68rem; line-height:1.25; color:var(--aithema-muted); overflow-wrap:anywhere; }
.option-status[data-kind=unavailable] { color:var(--aithema-warning); } .option-status[data-kind=consent] { color:var(--aithema-accent); }
.select { position:relative; min-width:0; }
.select__button { display:flex; align-items:center; gap:.6rem; width:100%; padding:.45rem .75rem; text-align:left;
  border:1px solid var(--aithema-line); border-radius:.65rem; background:linear-gradient(120deg,#ffffff9e,#fcfbf770); }
.select__button[aria-expanded=true] { border-color:var(--aithema-accent); box-shadow:0 0 0 1px color-mix(in srgb,var(--aithema-accent) 30%,transparent); }
.select__button[aria-disabled=true] { color:var(--aithema-muted); cursor:help; }
.select__value { flex:1; min-width:0; display:flex; align-items:center; gap:.6rem; font-weight:550; }
.select__menu { position:absolute; z-index:5; left:0; right:0; top:calc(100% + .25rem); max-height:17rem; overflow-y:auto; overscroll-behavior:contain;
  padding:.3rem; border:1px solid var(--aithema-line); border-radius:.7rem; background:var(--aithema-surface); box-shadow:0 8px 28px #09252d24; }
.select__option { display:flex; align-items:center; gap:.55rem; width:100%; padding:.45rem .5rem; border:0; border-radius:.45rem; background:transparent; text-align:left; }
.select__option:hover, .select__option:focus-visible { background:color-mix(in srgb,var(--aithema-accent) 10%,transparent); }
.select__option[aria-selected=true] { background:color-mix(in srgb,var(--aithema-accent) 14%,var(--aithema-surface)); }
.select__option[aria-disabled=true] { color:var(--aithema-muted); cursor:help; }
.option-label { flex:1; min-width:0; display:flex; flex-wrap:wrap; align-items:baseline; gap:.1rem .5rem; }
.option-label strong { font-weight:600; overflow-wrap:anywhere; }
.option-label small { color:var(--aithema-muted); font-size:.72rem; border-left:1px solid var(--aithema-line); padding-left:.5rem; }
.option-check { flex:none; width:1rem; color:var(--aithema-accent); visibility:hidden; }
.select__option[aria-selected=true] .option-check { visibility:visible; }
.effort-area { display:grid; } .effort-area>* { grid-area:1/1; min-width:0; }
.effort { display:grid; gap:.1rem; } .effort label { font-weight:600; }
.effort__track { display:flex; align-items:center; gap:.75rem; font-size:.75rem; color:var(--aithema-muted); }
.effort__track input { flex:1; min-width:0; height:2.75rem; margin:0; accent-color:var(--aithema-accent); }
.effort output { justify-self:center; font-size:.75rem; color:var(--aithema-muted); min-height:1.1rem; }
.note { font-size:.75rem; color:var(--aithema-muted); line-height:1.5; }
.notice-area { display:grid; border-radius:.45rem; padding:.55rem .7rem; }
.notice-area>* { grid-area:1/1; min-width:0; }
.notice-area[data-kind]:not([data-kind=""]) { background:color-mix(in srgb,var(--aithema-amber) 9%,transparent); }
.notice-body { display:grid; gap:.45rem; align-content:start; }
.notice-measure { visibility:hidden; pointer-events:none; user-select:none; display:grid; gap:.45rem; }
.notice-text { font-size:.78rem; line-height:1.45; }
.notice-action { justify-self:start; font-size:.78rem; }
.gauge-panel { position:relative; overflow:hidden; padding:1rem .7rem; border-radius:.85rem;
  background:radial-gradient(ellipse at 25% 0%,#fffefd,transparent 65%),linear-gradient(155deg,#faf8f3,#f7f9f6 55%,#e6f0ef); }
.gauges { position:relative; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1rem .5rem; }
.gauge { min-width:0; text-align:center; --liquid:var(--aithema-gauge-quality); }
.gauge--speed { --liquid:var(--aithema-gauge-speed); } .gauge--cost { --liquid:var(--aithema-gauge-cost); }
.gauge--privacy { --liquid:var(--aithema-gauge-privacy); } .gauge--voice { --liquid:var(--aithema-gauge-voice); }
.gauge--images { --liquid:var(--aithema-gauge-images); }
.gauge__value { display:block; height:1.6rem; margin-bottom:.3rem; font:400 1.15rem/1.4 Georgia,serif; font-variant-numeric:tabular-nums;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.85; }
.gauge__glass { position:relative; width:clamp(3.4rem,6vw,4.6rem); height:clamp(7rem,12vw,9.4rem); margin:auto; padding:.35rem; border:1px solid #fffef8;
  border-radius:1.9rem; background:linear-gradient(100deg,#d0d0b14d,#ffffffe6 11%,#fff7 18%,#e7e8d940 47%,#fff8 80%,#90aaa76b);
  box-shadow:inset 2px 0 3px #fff,inset -2px 0 3px #7b908340,0 5px 12px #163b3820,0 1px 1px #d8ac7760; }
.gauge__inside { position:relative; height:100%; overflow:hidden; border-radius:1.55rem; background:linear-gradient(90deg,#c3b69435,#fff8 24%,#fffffd0d 60%,#879d8f22); }
.gauge__level { --wave:4px; position:absolute; inset:0; transform:translateY(var(--empty,100%)); transition:transform 1.3s cubic-bezier(.22,.75,.18,1); }
.gauge__fluid { position:absolute; left:0; right:0; top:calc(var(--wave) / 2 - 1px); height:calc(100% + 30px);
  background:radial-gradient(ellipse at 32% 35%,color-mix(in srgb,var(--liquid) 45%,white),transparent 35%),
  linear-gradient(90deg,color-mix(in srgb,var(--liquid) 72%,black),var(--liquid) 24%,var(--liquid) 65%,color-mix(in srgb,var(--liquid) 72%,black)); }
.gauge__wave { position:absolute; height:var(--wave); width:400%; max-width:none; left:-200%; top:calc(var(--wave) / -2); fill:var(--liquid);
  animation:gauge-flow 4.8s linear infinite; transition:height .85s ease, top .85s ease; }
.gauge__wave--back { fill:color-mix(in srgb,var(--liquid) 45%,white); opacity:.8; animation:gauge-flow-back 6.3s linear infinite; }
.gauge__level.is-splashing { --wave:24px; }
.gauge__glint { position:absolute; inset:5px 5px 7px; border-radius:1.2rem; pointer-events:none;
  background:linear-gradient(92deg,transparent 5%,#fff9 10%,#fff2 19%,transparent 27%,transparent 71%,#fffa 86%,transparent 94%); }
.gauge__bubbles { position:absolute; width:3px; height:3px; bottom:20%; left:35%; border-radius:50%; background:#fff9; opacity:.4;
  box-shadow:15px -13px 2px #fff5,-8px -24px 1px #fff5,17px -56px 1px #fff6; animation:gauge-drift 6s ease-in-out infinite alternate; }
.gauge__rim { position:absolute; inset:3px 12px auto; height:8px; border:1px solid #ffffffc0; border-radius:50%; background:#fff3; }
.gauge__etch { position:absolute; inset:0; display:grid; place-items:center; pointer-events:none; color:var(--aithema-ink); opacity:.35; }
.gauge__etch svg { display:block; width:1.6rem; height:1.6rem; }
.gauge figcaption { margin-top:.35rem; font-size:.8rem; line-height:1.2; }
/* Two reserved lines: a long (German) detail wraps instead of ending in "…", and no gauge moves. */
.gauge__detail { display:block; margin-top:.15rem; min-height:2.6em; overflow-wrap:anywhere; font-size:.64rem; line-height:1.3; color:var(--aithema-muted); }
@keyframes gauge-flow { to { transform:translateX(50%); } }
@keyframes gauge-flow-back { from { transform:translateX(50%); } to { transform:translateX(0); } }
@keyframes gauge-drift { to { transform:translateY(-12px); } }
/* The help line sits on one hairline above the footer, not in a box. */
.settings-context { flex:none; display:flex; align-items:center; gap:.85rem; margin:0 1.6rem .5rem; padding:.6rem 0 0; border-top:1px solid var(--aithema-line);
  color:var(--aithema-muted); font-size:.75rem; line-height:1.5; }
.context-icon { flex:none; display:grid; place-items:center; width:1.2rem; height:1.2rem; border-radius:50%; border:1.5px solid var(--aithema-accent); color:var(--aithema-accent); font:700 .7rem/1 Georgia,serif; }
.context-text { flex:1; min-width:0; display:grid; align-items:center; }
.context-text>p { grid-area:1/1; overflow-wrap:anywhere; }
.context-measure { visibility:hidden; user-select:none; pointer-events:none; }
.settings__footer { flex:none; position:relative; display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); align-items:center; gap:1rem; padding:.4rem 1.6rem 1rem; }
.footer-links { display:flex; flex-wrap:wrap; align-items:center; gap:0 1rem; min-width:0; }
.footer-links :is(summary,.link) { display:inline-flex; align-items:center; min-height:2.75rem; padding:0; border:0; background:none; cursor:pointer;
  font-size:.72rem; color:var(--aithema-muted); text-decoration:underline; text-decoration-color:color-mix(in srgb,currentColor 35%,transparent); text-underline-offset:3px; }
.disclosure summary { list-style:none; } .disclosure summary::-webkit-details-marker { display:none; }
.disclosure__body { position:absolute; z-index:6; left:1.6rem; bottom:calc(100% + .5rem); width:min(34rem,calc(100% - 3.2rem)); max-height:min(22rem,50dvh);
  overflow:auto; display:grid; gap:.6rem; padding:1rem; border:1px solid var(--aithema-line); border-radius:.75rem; background:var(--aithema-surface);
  box-shadow:0 10px 28px #10233530; font-size:.75rem; line-height:1.5; }
.save-state { display:grid; grid-template-columns:1rem minmax(0,auto) auto; align-items:center; gap:.45rem; min-width:0; max-width:26rem;
  color:var(--aithema-muted); font-size:.72rem; }
.save-check { color:var(--aithema-accent); visibility:hidden; }
.settings[data-save-state=saved] .save-check { visibility:visible; }
.settings[data-save-state=failed] .save-state { color:var(--aithema-error); }
.save-status { min-height:2.2em; display:flex; align-items:center; overflow-wrap:anywhere; }
.save-retry { min-height:2rem; padding:.2rem .6rem; font-size:.72rem; }
.save-retry[data-visible=false] { visibility:hidden; }
.done { justify-self:end; display:inline-flex; align-items:center; justify-content:center; gap:.6rem; min-width:7rem; padding:.6rem 1.1rem;
  border:1px solid color-mix(in srgb,var(--aithema-ink) 70%,transparent); border-radius:.7rem; color:#fff; font-weight:600;
  background:linear-gradient(145deg,color-mix(in srgb,var(--aithema-ink) 85%,var(--aithema-accent)),var(--aithema-ink)); }
.done:hover { background:var(--aithema-ink); }
.general { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1.6rem; align-items:start; }
.general section { display:grid; gap:.6rem; align-content:start; }
.general h3 { font:400 1.25rem/1.2 Georgia,serif; }
.general button { justify-self:start; margin-left:-.85rem; }
.status-line { font-size:.85rem; }
.local { display:grid; gap:1.1rem; }
.local__heading { display:flex; gap:.8rem; align-items:center; }
.local__heading h3 { font:400 1.3rem/1.2 Georgia,serif; }
.local__workspace { display:grid; grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr); gap:1.4rem; align-items:start; }
.local__connection, .local__help, .local__chat { display:grid; gap:.7rem; align-content:start; min-width:0; }
.local h4 { font-size:1rem; font-weight:650; } .local h5 { font-size:.9rem; font-weight:650; }
.local label { font-weight:600; font-size:.82rem; }
.local :is(input,select,textarea) { width:100%; min-height:2.75rem; padding:.45rem .6rem; border:1px solid var(--aithema-line);
  border-radius:.55rem; background:var(--aithema-surface); color:inherit; font:inherit; }
.local textarea { resize:none; min-height:4.5rem; }
.hint { font-size:.72rem; color:var(--aithema-muted); line-height:1.45; }
.local__actions { display:flex; flex-wrap:wrap; align-items:center; gap:.6rem; }
.local-status { flex-basis:100%; min-height:1.4em; font-size:.75rem; color:var(--aithema-muted); }
.local-error { color:var(--aithema-error); font-size:.8rem; }
.local__model { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.4rem .6rem; align-items:end; } .local__model label { grid-column:1/-1; }
.local ol { margin:0; padding-left:1.2rem; display:grid; gap:.5rem; font-size:.8rem; list-style:decimal; }
.local ol li::marker { color:var(--aithema-accent); font-weight:600; }
.local pre { margin:.3rem 0; padding:.6rem; overflow:auto; border-radius:.5rem; background:color-mix(in srgb,var(--aithema-ink) 7%,transparent); font-size:.72rem; }
.local code.origin { display:inline-block; font-size:.75rem; overflow-wrap:anywhere; }
.recovery { display:grid; gap:.4rem; padding:.7rem; border-radius:.45rem; background:color-mix(in srgb,var(--aithema-amber) 9%,transparent); }
.setup-details { display:grid; gap:.6rem; } .setup-details summary { cursor:pointer; font-weight:600; }
.local__messages { height:12rem; overflow:auto; display:grid; align-content:start; gap:.5rem; padding:.6rem; border:1px solid var(--aithema-line); border-radius:.6rem; }
.local__messages .message { display:grid; gap:.1rem; font-size:.82rem; white-space:pre-wrap; overflow-wrap:anywhere; }
.local__messages strong { font-size:.68rem; color:var(--aithema-muted); }
.local__chat-head { display:flex; align-items:center; gap:.6rem; } .local__chat-head h4 { flex:1; }
.badge { font-size:.75rem; color:var(--aithema-muted); }
.local__composer { display:grid; gap:.4rem; } .local__composer .actions { display:flex; justify-content:flex-end; gap:.5rem; }

.conversation { position:relative; }
.intro { position:absolute; inset:0; z-index:2; grid-column:1/-1; grid-row:4/5; overflow:auto; overflow-anchor:none; overscroll-behavior:contain;
  scrollbar-gutter:stable; padding:calc(1rem + var(--aithema-slack-top,0px)) 1.25rem calc(1rem + var(--aithema-slack-bottom,0px)); background:var(--aithema-surface); display:grid; align-content:start; }
.intro[data-mode=chooser] { grid-row:2/5; }
.chooser { display:grid; gap:.9rem; }
.chooser h3, .ready h3 { font:600 1.05rem/1.3 Georgia,serif; margin:0; }
.chooser__list { display:grid; max-width:44rem; border-bottom:1px solid var(--aithema-line); }
/* GUI-27: a plain list on hairlines, not a row of equal tiles. Selection is the filled
   radio and the accent name; hover only tints the name. Nothing moves or resizes. */
.chooser-option { display:grid; grid-template-columns:1.05rem 1.5rem minmax(0,1fr); column-gap:.8rem; align-items:start; width:100%; min-width:0;
  padding:.75rem .2rem; border:0; border-top:1px solid var(--aithema-line); border-radius:0; background:none; text-align:left; }
.chooser-option:hover { background:none; }
.chooser-option .radio { margin-top:.15rem; }
.chooser-option__icon { display:grid; place-items:center; width:1.35rem; height:1.35rem; color:var(--aithema-accent); }
.chooser-option__icon svg { display:block; width:100%; height:100%; }
.chooser-option__text { display:grid; gap:.15rem; min-width:0; }
.chooser-option strong { font:600 1.02rem/1.25 Georgia,serif; color:var(--aithema-ink); }
.chooser-option:hover:not([aria-disabled=true]) strong { color:color-mix(in srgb,var(--aithema-accent) 35%,var(--aithema-ink)); }
.chooser-option[aria-pressed=true] strong { color:var(--aithema-accent); }
.chooser-option__detail { display:grid; gap:.05rem; line-height:1.4; }
.chooser-option__detail>:first-child { font-size:.8rem; } .chooser-option__detail>:last-child { font-size:.74rem; color:var(--aithema-muted); }
.chooser-option[aria-disabled=true] { cursor:help; } .chooser-option[aria-disabled=true] :is(strong,.chooser-option__icon,.chooser-option__detail>*) { color:var(--aithema-muted); }
.chooser-option__note { font-size:.7rem; color:var(--aithema-warning); } .chooser-option__note:empty { display:none; }
.chooser__action { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.8rem; align-items:center; }
.chooser__hint { display:grid; gap:.2rem; min-width:0; }
.chooser__summary { display:grid; } .chooser__summary>* { grid-area:1/1; }
.chooser__summary strong { font:600 .86rem/1.4 Georgia,serif; }
.chooser__measure { visibility:hidden; pointer-events:none; user-select:none; }
.chooser__hint>span { font-size:.72rem; color:var(--aithema-muted); }
.chooser__continue { display:inline-flex; align-items:center; gap:.5rem; min-height:2.9rem; padding:.45rem .8rem .45rem 1.1rem; color:#fff; font-weight:650;
  border:1px solid color-mix(in srgb,var(--aithema-ink) 70%,transparent); border-radius:.8rem;
  background:linear-gradient(135deg,color-mix(in srgb,var(--aithema-ink) 85%,var(--aithema-accent)),var(--aithema-ink)); }
.chooser__continue:hover:not(:disabled) { background:var(--aithema-ink); }
.chooser__arrow { display:grid; place-items:center; width:1.4rem; height:2rem; }
.chooser__error { min-height:1.3em; font-size:.75rem; color:var(--aithema-error); }
.ready { display:grid; gap:.6rem; max-width:34rem; }
.ready dl { display:grid; gap:.45rem; margin:0; }
.ready__row { display:grid; grid-template-columns:minmax(7.5rem,1fr) minmax(0,1.6fr); align-items:center; gap:.7rem; min-height:1.5rem; }
.ready dt, .ready dd { display:flex; align-items:center; gap:.45rem; margin:0; font-size:.8rem; }
.ready dd { justify-content:flex-end; text-align:right; }
.ready__check { display:grid; place-items:center; flex:none; width:1.1rem; height:1.1rem; border-radius:50%; visibility:hidden;
  color:var(--aithema-accent); background:color-mix(in srgb,var(--aithema-accent) 12%,transparent); font-size:.65rem; }
.ready__row[data-state=confirmed] .ready__check, .ready__row[data-state=selected] .ready__check { visibility:visible; }
.ready__row[data-state=off] dd { color:var(--aithema-muted); } .ready__row[data-state=pending] dd { color:var(--aithema-warning); }
.ready__actions { display:flex; flex-wrap:wrap; gap:.25rem; margin-left:-.85rem; } .ready__actions button { font-size:.8rem; }
.turn small.engine-tag { display:block; margin-top:.35rem; font-size:.64rem; color:var(--aithema-muted); }

@media(max-width:75rem) { .settings-panel[data-panel=model] { grid-template-columns:minmax(0,1.1fr) minmax(0,1fr); }
  .settings-overview { grid-column:1/-1; } }
@media(max-width:60rem) {
  .settings__header { grid-template-columns:1fr; } .settings__title { font-size:1.6rem; padding-bottom:.2rem; }
  .settings-panel[data-panel=model], .general, .local__workspace { grid-template-columns:minmax(0,1fr); }
  .settings__footer { grid-template-columns:minmax(0,1fr) auto; } .footer-links { grid-column:1/-1; } }
@media(max-width:40rem) {
  dialog.settings { width:calc(100vw - .5rem); height:calc(100dvh - .5rem); border-radius:.8rem; }
  .settings__header { padding:.5rem .8rem 0; } .settings__title { font-size:1.35rem; }
  .settings__tabs { gap:.1rem; } .settings__tabs button { font-size:.75rem; gap:.25rem; padding-inline:.15rem; }
  .settings__body { padding:.9rem .8rem; } .settings-field legend { font-size:1.1rem; }
  .option-status { width:6.2rem; }
  .settings-context { margin:0 .8rem .3rem; padding:.45rem .6rem; font-size:.68rem; }
  .settings__footer { grid-template-columns:minmax(0,1fr); gap:.3rem; padding:.2rem .8rem .7rem; }
  .done { justify-self:stretch; width:100%; } .disclosure__body { left:.8rem; width:calc(100% - 1.6rem); }
  .gauges { gap:.7rem .3rem; } .gauge__glass { width:3.3rem; height:6.6rem; } .gauge__value { font-size:1rem; }
  .intro { padding:calc(.75rem + var(--aithema-slack-top,0px)) .8rem calc(.75rem + var(--aithema-slack-bottom,0px)); } .chooser { gap:.6rem; }
  .chooser-option { grid-template-columns:1.05rem minmax(0,1fr); padding:.6rem .1rem; } .chooser-option__icon { display:none; }
  .chooser-option strong { font-size:.95rem; }
  .chooser__action { grid-template-columns:minmax(0,1fr); } .chooser__continue { justify-content:space-between; }
  .ready__row { grid-template-columns:minmax(6.2rem,1fr) minmax(0,1.3fr); gap:.4rem; } .ready dt, .ready dd { font-size:.74rem; } }
/* AIT-116 dark tokens: primary buttons invert with the ink, and light glass and fields follow the surface. */
@media(prefers-color-scheme:dark) {
  .done, .chooser__continue { color:var(--aithema-paper); }
  .select__button { background:var(--aithema-surface); }
  .gauge-panel { background:linear-gradient(155deg,var(--aithema-surface),var(--aithema-paper)); }
  .gauge__glass { border-color:var(--aithema-line); box-shadow:inset 1px 0 2px #ffffff1f,0 5px 12px #00000040;
    background:linear-gradient(100deg,#ffffff0d,#ffffff24 11%,#ffffff12 18%,transparent 47%,#ffffff14 80%,#ffffff08); }
  .gauge__inside { background:color-mix(in srgb,var(--aithema-ink) 6%,transparent); } }
@media(prefers-reduced-motion:reduce) { .gauge__level, .gauge__wave { transition:none !important; } }
`;
