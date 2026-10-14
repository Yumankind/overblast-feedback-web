/**
 * The library's only CSS, scoped to its shadow root: the page's styles cannot reach in, and these
 * cannot leak out. Colours are tokens on `:host`, redefined for dark mode.
 */
export const CSS = `
:host {
  all: initial;
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
  --ob-pick: #ff3b30;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  color: var(--ob-fg);
}
@media (prefers-color-scheme: dark) {
  :host {
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
  }
}
*, *::before, *::after { box-sizing: border-box; }
/* The host carries an inline \`all: initial\`, which beats \`:host\`: the type is set again here. */
.fab, .backdrop, .pick-bar {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
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
.fab svg { width: 16px; height: 16px; flex: none; }
.fab.bottom-right { right: 16px; bottom: 16px; }
.fab.bottom-left { left: 16px; bottom: 16px; }
.fab.top-right { right: 16px; top: 16px; }
.fab.top-left { left: 16px; top: 16px; }

.backdrop {
  position: fixed;
  inset: 0;
  z-index: 3;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.sheet {
  width: 100%;
  max-width: 440px;
  max-height: calc(100vh - 32px);
  overflow: auto;
  background: var(--ob-bg);
  color: var(--ob-fg);
  border-radius: 14px;
  box-shadow: var(--ob-shadow);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
@media (max-width: 520px) {
  .backdrop { align-items: flex-end; padding: 0; }
  .sheet { max-width: none; border-radius: 16px 16px 0 0; max-height: 92vh; padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px)); }
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.head h2 { margin: 0; font-size: 17px; font-weight: 650; }
.icon {
  width: 32px; height: 32px; border-radius: 8px; border: 0; background: transparent; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; color: var(--ob-muted); font-size: 20px; line-height: 1;
}
.icon:hover { background: var(--ob-soft); color: var(--ob-fg); }
fieldset { border: 0; margin: 0; padding: 0; }
legend { padding: 0; margin-bottom: 6px; font-size: 12px; color: var(--ob-muted); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { position: relative; }
.chip input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.chip span {
  display: inline-block; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--ob-line);
  background: var(--ob-bg); font-size: 13px;
}
.chip input:checked + span { background: var(--ob-fg); color: var(--ob-bg); border-color: var(--ob-fg); }
.chip input:focus-visible + span { outline: 2px solid var(--ob-accent); outline-offset: 2px; }
label.field { display: flex; flex-direction: column; gap: 6px; font-weight: 600; font-size: 13px; }
textarea, input[type="email"] {
  width: 100%; border: 1px solid var(--ob-line); border-radius: 10px; padding: 10px 12px;
  background: var(--ob-bg); font-weight: 400; font-size: 15px;
}
textarea { min-height: 110px; resize: vertical; }
.hint { font-size: 12px; color: var(--ob-muted); font-weight: 400; }
.err { font-size: 12px; color: var(--ob-danger); font-weight: 500; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.btn {
  border: 1px solid var(--ob-line); background: var(--ob-bg); border-radius: 10px; padding: 8px 12px;
  cursor: pointer; font-size: 13px; font-weight: 600;
}
.btn:hover { background: var(--ob-soft); }
.btn.primary { background: var(--ob-accent); border-color: var(--ob-accent); color: var(--ob-accent-fg); padding: 10px 16px; font-size: 15px; }
.btn.primary:disabled { opacity: 0.6; cursor: default; }
.btn.link { border: 0; padding: 4px 6px; color: var(--ob-accent); background: transparent; }
.selected {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; background: var(--ob-soft);
  font-size: 13px; min-width: 0;
}
.selected code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.check { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.check input { width: 18px; height: 18px; margin: 0; accent-color: var(--ob-accent); }
.thumb { position: relative; display: inline-block; max-width: 100%; }
.thumb img { display: block; max-width: 100%; max-height: 120px; border-radius: 8px; border: 1px solid var(--ob-line); }
.thumb .icon { position: absolute; top: 4px; right: 4px; background: var(--ob-bg); width: 28px; height: 28px; border: 1px solid var(--ob-line); }
.preview { font-size: 12px; color: var(--ob-muted); }
.status { font-size: 13px; min-height: 1em; }
.status.error { color: var(--ob-danger); }
.status.ok { color: var(--ob-ok); }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
.offer { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--ob-muted); padding: 8px 10px; border-radius: 10px; background: var(--ob-soft); }

.pick-layer { position: fixed; inset: 0; z-index: 4; pointer-events: none; }
.pick-box {
  position: fixed; border: 2px solid var(--ob-pick); background: rgba(255, 59, 48, 0.12); border-radius: 3px;
  pointer-events: none; transition: all 60ms linear;
}
.pick-bar {
  position: fixed; left: 50%; transform: translateX(-50%); top: 12px; z-index: 5; pointer-events: auto;
  display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px);
  padding: 8px 8px 8px 14px; border-radius: 999px; background: var(--ob-bg); color: var(--ob-fg); box-shadow: var(--ob-shadow);
  font-size: 13px;
}
.pick-bar.bottom { top: auto; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); }
`;

export const BUG_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
