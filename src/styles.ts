/**
 * The library's only CSS, scoped to its shadow root: the page's styles cannot reach in, and these
 * cannot leak out. Colours are tokens on `:host`, redefined for dark mode; `init({ theme })` sets
 * `--ob-accent`, `--ob-font` and `--ob-radius` on the host itself, which wins over both, and
 * `data-scheme` on the host forces light or dark.
 */
const LIGHT = `
  --ob-bg: #ffffff;
  --ob-fg: #1c1c1e;
  --ob-muted: #6c6c70;
  --ob-line: #d1d1d6;
  --ob-soft: #f2f2f7;
  --ob-accent: #0a5cff;
  --ob-accent-fg: #ffffff;
  --ob-danger: #c4271c;
  --ob-ok: #1f7a3a;
  --ob-shadow: 0 12px 40px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08);
  --ob-scrim: rgba(0, 0, 0, 0.32);`;
const DARK = `
  --ob-bg: #1c1c1e;
  --ob-fg: #f2f2f7;
  --ob-muted: #a1a1a6;
  --ob-line: #3a3a3c;
  --ob-soft: #2c2c2e;
  --ob-accent: #4c8dff;
  --ob-accent-fg: #0b0b0c;
  --ob-danger: #ff6b60;
  --ob-ok: #4cd07a;
  --ob-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
  --ob-scrim: rgba(0, 0, 0, 0.5);`;
const FONT = 'var(--ob-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif)';

export const CSS = `
:host {
  all: initial;${LIGHT}
  font-family: ${FONT};
  font-size: 14px;
  line-height: 1.4;
  color: var(--ob-fg);
}
@media (prefers-color-scheme: dark) {
  :host(:not([data-scheme="light"])) {${DARK}
  }
}
:host([data-scheme="dark"]) {${DARK}
}
*, *::before, *::after { box-sizing: border-box; }
/* The host carries an inline \`all: initial\`, which beats \`:host\`: the type is set again here. */
.fab, .backdrop, .pick-bar, .pill {
  font-family: ${FONT};
  font-size: 14px;
  line-height: 1.4;
  color: var(--ob-fg);
  text-align: left;
  letter-spacing: normal;
}
p { margin: 0; }
h2 { font-family: inherit; }
[hidden] { display: none !important; }
button, input, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--ob-accent); outline-offset: 2px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

.fab {
  position: fixed;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 14px;
  border: 1px solid var(--ob-line);
  border-radius: 999px;
  background: var(--ob-bg);
  color: var(--ob-fg);
  box-shadow: var(--ob-shadow);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}
.fab:hover { background: var(--ob-soft); }
.fab svg { width: 16px; height: 16px; flex: none; color: var(--ob-accent); }
.fab.bottom-right { right: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }
.fab.bottom-left { left: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }
.fab.top-right { right: 16px; top: 16px; }
.fab.top-left { left: 16px; top: 16px; }

/* The error prompt (§3.6): a pill at the bottom, above the floating button when there is one. */
.pill {
  position: fixed;
  z-index: 3;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  right: 16px;
  max-width: calc(100vw - 32px);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 14px;
  border: 1px solid var(--ob-line);
  border-radius: 999px;
  background: var(--ob-bg);
  box-shadow: var(--ob-shadow);
  font-size: 13px;
  opacity: 1;
  transform: none;
  transition: opacity 200ms ease, transform 200ms ease;
}
.pill > span { text-wrap: balance; }
.pill.left { right: auto; left: 16px; }
.pill.above { bottom: calc(68px + env(safe-area-inset-bottom, 0px)); }
.pill.entering { opacity: 0; transform: translateY(8px); }
.pill .btn { padding: 5px 12px; border-radius: 999px; border: 0; background: var(--ob-accent); color: var(--ob-accent-fg); font-weight: 600; cursor: pointer; }
.pill .x { width: 26px; height: 26px; border: 0; border-radius: 50%; background: transparent; color: var(--ob-muted); cursor: pointer; font-size: 16px; line-height: 1; }
.pill .x:hover { background: var(--ob-soft); }
@media (max-width: 520px) {
  .pill, .pill.left { left: 16px; right: 16px; justify-content: space-between; }
}

/* ── The sheet: a head, a body that scrolls, and a bar that does not. ── */
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 3;
  background: var(--ob-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.sheet {
  position: relative;
  width: 100%;
  max-width: 460px;
  /* Never taller than the backdrop, which is the visual viewport (keyboard included). */
  max-height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--ob-bg);
  color: var(--ob-fg);
  border-radius: var(--ob-radius, 14px);
  box-shadow: var(--ob-shadow);
}
.head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 14px 6px 18px; }
.head h2 { margin: 0; font-size: 17px; font-weight: 650; }
form { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; margin: 0; }
.body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 14px; padding: 8px 18px 14px;
}
.foot {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 12px 18px calc(12px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--ob-line); background: var(--ob-bg);
}
.foot .status { flex: 1; min-width: 0; }
@media (max-width: 520px) {
  .backdrop { align-items: flex-end; padding: 8px 0 0; }
  .sheet { max-width: none; border-radius: var(--ob-radius, 14px) var(--ob-radius, 14px) 0 0; animation: ob-rise 180ms ease-out; }
}
@keyframes ob-rise { from { transform: translateY(24px); opacity: 0.6; } to { transform: none; opacity: 1; } }

.icon {
  width: 32px; height: 32px; border-radius: var(--ob-radius-sm, 10px); border: 0; background: transparent; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; color: var(--ob-muted); font-size: 20px; line-height: 1; flex: none;
}
.icon:hover { background: var(--ob-soft); color: var(--ob-fg); }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { position: relative; }
.chip input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.chip span {
  display: inline-block; padding: 6px 13px; border-radius: 999px; border: 1px solid var(--ob-line);
  background: var(--ob-bg); font-size: 13px; font-weight: 550;
}
.chip input:checked + span { background: var(--ob-accent); color: var(--ob-accent-fg); border-color: var(--ob-accent); }
.chip input:focus-visible + span { outline: 2px solid var(--ob-accent); outline-offset: 2px; }
label.field { display: flex; flex-direction: column; gap: 6px; font-weight: 600; font-size: 13px; }
textarea, input[type="email"] {
  width: 100%; border: 1px solid var(--ob-line); border-radius: var(--ob-radius-sm, 10px); padding: 10px 12px;
  background: var(--ob-bg); font-weight: 400; font-size: 16px;
}
textarea:focus, input[type="email"]:focus { outline: none; border-color: var(--ob-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ob-accent) 25%, transparent); }
textarea { min-height: 150px; resize: vertical; line-height: 1.45; }
@media (max-height: 600px) { textarea { min-height: 96px; } }
.hint { font-size: 12px; color: var(--ob-muted); font-weight: 400; }
.err { font-size: 12px; color: var(--ob-danger); font-weight: 500; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.btn {
  border: 1px solid var(--ob-line); background: var(--ob-bg); border-radius: var(--ob-radius-sm, 10px); padding: 8px 12px;
  cursor: pointer; font-size: 13px; font-weight: 600; white-space: nowrap;
}
.btn:hover { background: var(--ob-soft); }
.btn.small { padding: 6px 10px; font-size: 12.5px; }
.btn.primary { background: var(--ob-accent); border-color: var(--ob-accent); color: var(--ob-accent-fg); padding: 10px 18px; font-size: 15px; }
.btn.primary.small { padding: 6px 12px; font-size: 13px; }
.btn.primary:hover { filter: brightness(1.06); background: var(--ob-accent); }
.btn.primary:disabled { opacity: 0.6; cursor: default; }
.btn.link { border: 0; padding: 4px 6px; color: var(--ob-accent); background: transparent; }

.selected {
  display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: var(--ob-radius-sm, 10px);
  background: var(--ob-soft); font-size: 13px; min-width: 0;
}
.pick-thumb { flex: none; width: 84px; height: 56px; border-radius: 6px; overflow: hidden; background: var(--ob-bg); border: 1px solid var(--ob-line); }
.pick-thumb canvas { display: block; width: 100%; height: 100%; }
.pick-thumb.card { display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 4px 6px; font-size: 11px; line-height: 1.25; }
.pick-thumb.card b { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ob-accent); font-weight: 600; }
.pick-thumb.card span { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.sel-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sel-text code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sel-actions { display: flex; flex-direction: column; gap: 4px; flex: none; }

.shot { display: flex; flex-direction: column; gap: 8px; }
.check { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.check input { width: 18px; height: 18px; margin: 0; accent-color: var(--ob-accent); }
.thumb { position: relative; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; max-width: 100%; }
.shot-preview { padding: 0; border: 1px solid var(--ob-line); border-radius: var(--ob-radius-sm, 10px); overflow: hidden; background: var(--ob-soft); cursor: zoom-in; max-width: 100%; }
.shot-preview img { display: block; max-width: 100%; max-height: 140px; }
.icon.on-image { position: absolute; top: 4px; left: 4px; background: var(--ob-bg); width: 28px; height: 28px; border: 1px solid var(--ob-line); font-size: 16px; }
.preview { font-size: 12px; color: var(--ob-muted); text-wrap: pretty; }
.status { font-size: 13px; min-height: 1em; text-wrap: pretty; }
.hint, .err, .offer > span { text-wrap: pretty; }
.status.error { color: var(--ob-danger); }
.status.ok { color: var(--ob-ok); }
.offer { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--ob-muted); padding: 8px 10px; border-radius: var(--ob-radius-sm, 10px); background: var(--ob-soft); }

/* Sent: a check and one line over the sheet, then it closes. */
.done {
  position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 24px; text-align: center; background: var(--ob-bg); font-size: 16px; font-weight: 600;
}
.done p {
  /* Two even lines rather than a long one and a lone word: balance where the browser has it, and a
     measure near 30 characters where it does not, so the break falls near the middle anyway. */
  max-width: 30ch; text-wrap: balance;
}
.done .tick { width: 52px; height: 52px; border-radius: 50%; background: var(--ob-accent); color: var(--ob-accent-fg); display: flex; align-items: center; justify-content: center; animation: ob-pop 260ms ease-out; }
.done .tick svg { width: 28px; height: 28px; }
@keyframes ob-pop { from { transform: scale(0.6); opacity: 0; } to { transform: none; opacity: 1; } }

/* The screenshot editor: over the sheet, the image fitted, a bar of tools. */
.editor {
  position: fixed; inset: 0; z-index: 6; display: flex; flex-direction: column; gap: 8px; padding: 12px;
  background: rgba(10, 10, 12, 0.92); color: #f2f2f7;
}
.ed-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ed-bar .btn { background: #2c2c2e; border-color: #3a3a3c; color: #f2f2f7; }
.ed-bar .btn.primary { background: var(--ob-accent); border-color: var(--ob-accent); color: var(--ob-accent-fg); }
.ed-bar .grow { flex: 1; }
.seg { display: inline-flex; border: 1px solid #3a3a3c; border-radius: var(--ob-radius-sm, 10px); overflow: hidden; }
.seg button { border: 0; background: #2c2c2e; color: #f2f2f7; padding: 6px 12px; font-size: 13px; font-weight: 600; cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--ob-accent); color: var(--ob-accent-fg); }
.ed-hint { font-size: 12px; color: #a1a1a6; }
.ed-stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
.ed-stage canvas { max-width: 100%; max-height: 100%; cursor: crosshair; touch-action: none; border-radius: 6px; box-shadow: 0 6px 30px rgba(0, 0, 0, 0.5); }

/* The picker: the element outlined in the accent, everything else dimmed, a one-line hint on top. */
.pick-layer { position: fixed; inset: 0; z-index: 4; pointer-events: none; }
.pick-box {
  position: fixed; border: 2px solid var(--ob-accent); border-radius: 4px; pointer-events: none;
  box-shadow: 0 0 0 1px #ffffff, 0 0 0 100vmax rgba(0, 0, 0, 0.28);
  transition: left 60ms linear, top 60ms linear, width 60ms linear, height 60ms linear;
}
.pick-box.staged { border-width: 3px; }
.pick-tag {
  position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; padding: 2px 6px; border-radius: 4px;
  background: var(--ob-accent); color: var(--ob-accent-fg); font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap;
}
.pick-box.tag-below .pick-tag { bottom: auto; top: 100%; margin: 4px 0 0; }
.pick-bar {
  position: fixed; left: 50%; transform: translateX(-50%); top: calc(12px + env(safe-area-inset-top, 0px)); z-index: 5; pointer-events: auto;
  display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 24px);
  padding: 6px 6px 6px 14px; border-radius: 999px; background: var(--ob-bg); color: var(--ob-fg); box-shadow: var(--ob-shadow);
  font-size: 13px; font-weight: 600;
}
.pick-hint { min-width: 0; max-width: 34ch; text-wrap: balance; }
.pick-bar.bottom { top: auto; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); }

@media (prefers-reduced-motion: reduce) {
  .pill, .pill.entering { transition: none; transform: none; opacity: 1; }
  .sheet, .done .tick { animation: none; }
  .pick-box { transition: none; }
}
`;

export const BUG_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

export const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
