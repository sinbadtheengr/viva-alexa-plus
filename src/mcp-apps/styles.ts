/**
 * F-8 · Shared stylesheet for the three views, inlined into every document.
 *
 * Sized for an Echo Show read from across a kitchen: large type, high contrast,
 * nothing that depends on hover. Colours are CSS custom properties so the host's
 * light/dark preference (or the OS's) flips the whole palette in one place.
 */
export const VIEW_CSS = String.raw`
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --surface: #f1f4f9;
  --text: #0b0f19;
  --muted: #3d4657;
  --accent: #0a4fc4;
  --track: #cfd6e4;
  --warn: #9a3b00;
  --border: #0b0f19;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #080b12; --surface: #141a26; --text: #f6f8fc; --muted: #c2cada;
    --accent: #8ab4ff; --track: #3a4457; --warn: #ffb27a; --border: #f6f8fc;
  }
}
:root[data-theme="dark"] {
  --bg: #080b12; --surface: #141a26; --text: #f6f8fc; --muted: #c2cada;
  --accent: #8ab4ff; --track: #3a4457; --warn: #ffb27a; --border: #f6f8fc;
}
* { box-sizing: border-box; }
html { font-size: clamp(18px, 2.2vw + 6px, 30px); }
body {
  margin: 0; padding: 0.8rem 1rem; background: var(--bg); color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  line-height: 1.3; overflow-wrap: anywhere;
}
main { max-width: 60rem; margin: 0 auto; display: flex; flex-direction: column; gap: 0.7rem; }
.eyebrow { font-size: 0.8rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0; }
.prompt { font-size: 1.7rem; font-weight: 700; line-height: 1.2; margin: 0; }
.bullets { margin: 0; padding-left: 1.3rem; font-size: 1.2rem; }
.bullets li { margin: 0.15rem 0; }
.card { background: var(--surface); border: 2px solid var(--border); border-radius: 0.6rem; padding: 0.7rem 0.9rem; }
.timer-label { font-size: 0.9rem; font-weight: 700; margin: 0; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.timer { font-size: 3.4rem; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1; margin: 0.1rem 0; }
.timer.over { color: var(--warn); }
.timer-of { font-size: 1rem; color: var(--muted); margin: 0; }
.bar { height: 0.7rem; background: var(--track); border-radius: 0.35rem; overflow: hidden; margin-top: 0.4rem; }
.bar > div { height: 100%; background: var(--accent); width: 0; }
.bar.over > div { background: var(--warn); }
.notice { font-size: 1.05rem; font-weight: 600; margin: 0; }
.notice.over { color: var(--warn); }
.followup { font-size: 1.5rem; font-weight: 700; margin: 0; }
.meter { display: none; align-items: flex-end; gap: 0.25rem; height: 2rem; }
.meter.on { display: flex; }
.meter span { flex: 1; max-width: 1rem; background: var(--accent); border-radius: 0.15rem; height: 8%; }
.meter-label { font-size: 0.8rem; color: var(--muted); margin: 0; display: none; }
.meter-label.on { display: block; }
.criteria { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 0.7rem; }
.criterion h2 { font-size: 1rem; margin: 0; }
.band { font-size: 3rem; font-weight: 800; line-height: 1; margin: 0.2rem 0; color: var(--accent); }
.criterion blockquote { margin: 0.3rem 0; padding-left: 0.6rem; border-left: 4px solid var(--accent); font-size: 1rem; }
.criterion .next { margin: 0.3rem 0 0; font-size: 1rem; font-weight: 600; }
.criterion .next b { text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.06em; color: var(--muted); display: block; }
.note { font-size: 1rem; font-weight: 600; margin: 0; }
.fine { font-size: 0.8rem; color: var(--muted); margin: 0; }
.err { border-color: var(--warn); }
.err p { margin: 0; font-size: 1.1rem; }
/* Wide screens (Echo Show 8/15): the three criteria sit side by side and the
   whole results view fits one screen without scrolling. */
@media (min-width: 700px) {
  .criteria { grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
  .criterion { padding: 0.5rem 0.65rem; }
  .criterion h2 { font-size: 0.85rem; }
  .band { font-size: 2.4rem; margin: 0.1rem 0; }
  .criterion blockquote, .criterion .next { font-size: 0.78rem; }
  .criterion .next b { font-size: 0.65rem; }
}
@media (max-width: 420px) {
  .timer { font-size: 3rem; }
  .prompt { font-size: 1.45rem; }
}
@media (max-height: 640px) and (min-width: 700px) {
  body { padding: 0.5rem 1rem; }
  main { gap: 0.45rem; }
  .timer { font-size: 3rem; }
}
@media (prefers-reduced-motion: no-preference) {
  .bar > div { transition: width 0.25s linear; }
  .meter span { transition: height 0.08s linear; }
}
`;
