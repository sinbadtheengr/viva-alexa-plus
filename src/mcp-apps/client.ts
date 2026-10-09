/**
 * F-8 · The browser-side script shared by all three views.
 *
 * It is a string, not a module, because an MCP Apps resource must be one
 * self-contained document: no bundle, no network. It speaks the small subset of
 * the MCP Apps host protocol it needs (ui/initialize, tool-result notifications,
 * host-context-changed, teardown) directly over postMessage.
 *
 * Rules the code below holds itself to:
 *  - Time comes from the server. A countdown is `phaseDeadline - serverNow` as
 *    the tool reported it, minus the time elapsed locally since the result
 *    arrived. The client's wall clock is never compared with the server's, so a
 *    skewed Echo clock cannot move the deadline.
 *  - Everything is written with textContent. Candidate words and model output
 *    reach the DOM, so nothing is ever parsed as HTML.
 *  - No pronunciation anywhere; the results view renders only the criteria the
 *    server returned and never fills a gap.
 *  - The pure functions are published on globalThis.__VIVA__ and the DOM boots
 *    only when a document exists, which is how the unit tests exercise them.
 *
 * Written without template literals or backslashes so it embeds verbatim.
 */
export const CLIENT_JS = String.raw`
(function () {
  "use strict";

  function isNum(x) { return typeof x === "number" && isFinite(x); }

  // Milliseconds left in the phase (negative once past the deadline), or null
  // when the payload carries no server deadline.
  function remainingMs(p, receivedAt, now) {
    if (!p || !isNum(p.phaseDeadline) || !isNum(p.serverNow)) return null;
    return (p.phaseDeadline - p.serverNow) - (now - receivedAt);
  }

  function formatClock(ms) {
    var s = Math.ceil(Math.abs(ms) / 1000);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  // Which layout a payload wants. The resource only supplies the default.
  function viewFor(payload, isError, fallback) {
    if (isError) return "error";
    var v = payload && payload.view;
    if (v === "cue_card") return "cue";
    if (v === "speaking" || v === "clock") return "speaking";
    if (v === "results" || v === "scoring") return "results";
    if (payload && payload.error) return "error";
    return fallback;
  }

  // Share of the phase that has elapsed, clamped to 0..1.
  function progress(totalSeconds, remaining) {
    if (!isNum(totalSeconds) || totalSeconds <= 0 || remaining === null) return null;
    var done = (totalSeconds * 1000 - remaining) / (totalSeconds * 1000);
    return Math.max(0, Math.min(1, done));
  }

  var core = { remainingMs: remainingMs, formatClock: formatClock, viewFor: viewFor, progress: progress };
  globalThis.__VIVA__ = core;
  if (typeof document === "undefined") return;

  var DEFAULT_VIEW = document.documentElement.getAttribute("data-default-view") || "cue";
  var root = document.getElementById("root");
  var state = { payload: null, text: "", isError: false, receivedAt: 0 };
  var live = null;
  var audio = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function phaseLabel(phase) {
    if (phase === "prep") return "Preparation time";
    if (phase === "speaking") return "Speaking time";
    return "Time left";
  }

  function timerCard(p, mode) {
    var card = el("div", "card");
    var label = el("p", "timer-label", mode === "elapsed" ? "Elapsed" : phaseLabel(p.phase));
    var big = el("p", "timer", "");
    var of = el("p", "timer-of", "");
    var bar = el("div", "bar");
    var fill = el("div");
    bar.appendChild(fill);
    var over = el("p", "notice over", "");
    card.appendChild(label); card.appendChild(big); card.appendChild(of);
    card.appendChild(bar); card.appendChild(over);
    live = { mode: mode, p: p, label: label, big: big, of: of, bar: bar, fill: fill, over: over, meter: null };
    return card;
  }

  function tick() {
    if (!live) return;
    var p = live.p;
    var rem = remainingMs(p, state.receivedAt, performance.now());
    if (rem === null) return;
    var isOver = rem <= 0;
    var total = isNum(p.phaseSeconds) ? p.phaseSeconds : null;
    if (live.mode === "elapsed" && total !== null) {
      var elapsed = total * 1000 - rem;
      live.big.textContent = formatClock(Math.max(0, elapsed));
      live.of.textContent = "of " + formatClock(total * 1000);
    } else if (isOver) {
      live.big.textContent = "+" + formatClock(rem);
      live.of.textContent = "past the limit";
    } else {
      live.big.textContent = formatClock(rem);
      live.of.textContent = total !== null ? "of " + formatClock(total * 1000) : "";
    }
    var frac = progress(total, rem);
    live.fill.style.width = frac === null ? "0%" : Math.round(frac * 100) + "%";
    live.big.className = isOver ? "timer over" : "timer";
    live.bar.className = isOver ? "bar over" : "bar";
    live.over.textContent = isOver ? "Time is up for this phase." : "";
  }

  function eyebrowFor(p) {
    var parts = [];
    if (p.exam) parts.push(String(p.exam).toUpperCase());
    if (p.part) parts.push("Part " + p.part);
    if (p.topic) parts.push(p.topic);
    return parts.join(" · ");
  }

  function renderCue(main, p) {
    if (eyebrowFor(p)) main.appendChild(el("p", "eyebrow", eyebrowFor(p)));
    main.appendChild(el("p", "prompt", p.prompt || state.text));
    if (p.bullets && p.bullets.length) {
      var ul = el("ul", "bullets");
      p.bullets.forEach(function (b) { ul.appendChild(el("li", null, b)); });
      main.appendChild(ul);
    }
    if (remainingMs(p, state.receivedAt, performance.now()) !== null) {
      main.appendChild(timerCard(p, "remaining"));
    } else if (isNum(p.prepSeconds) || isNum(p.speakSeconds)) {
      var t = [];
      if (isNum(p.prepSeconds) && p.prepSeconds > 0) t.push("Preparation " + formatClock(p.prepSeconds * 1000));
      if (isNum(p.speakSeconds)) t.push("Speaking " + formatClock(p.speakSeconds * 1000));
      var card = el("div", "card");
      card.appendChild(el("p", "notice", t.join(" · ")));
      main.appendChild(card);
    }
  }

  function renderSpeaking(main, p) {
    main.appendChild(el("p", "eyebrow", "Speaking"));
    var timed = remainingMs(p, state.receivedAt, performance.now()) !== null;
    if (timed) {
      var elapsedMode = p.phase === "speaking" && isNum(p.phaseSeconds);
      main.appendChild(timerCard(p, elapsedMode ? "elapsed" : "remaining"));
      if (p.phase === "speaking") {
        var m = el("div", "meter");
        for (var i = 0; i < 16; i++) m.appendChild(el("span"));
        var ml = el("p", "meter-label", "Microphone level (on this device only, never recorded)");
        main.appendChild(m); main.appendChild(ml);
        live.meter = m; live.meterLabel = ml;
        startMeter();
      }
    }
    if (typeof p.followUp === "string" && p.followUp) {
      main.appendChild(el("p", "followup", p.followUp));
    } else if (!timed || p.exhausted) {
      main.appendChild(el("p", "followup", state.text));
    }
  }

  function bandCaption(band) {
    return /^[0-9]/.test(String(band)) ? "Band" : "Level";
  }

  function renderResults(main, p) {
    if (p.status === "complete" || p.status === "partial") {
      main.appendChild(el("p", "eyebrow", "Your results"));
      var grid = el("div", "criteria");
      (p.scores || []).forEach(function (s) {
        var c = el("section", "card criterion");
        c.appendChild(el("h2", null, s.label || s.criterion));
        c.appendChild(el("p", "fine", bandCaption(s.band)));
        c.appendChild(el("p", "band", s.band));
        c.appendChild(el("blockquote", null, s.evidence));
        var nx = el("p", "next");
        nx.appendChild(el("b", null, "To improve"));
        nx.appendChild(document.createTextNode(s.improvement));
        c.appendChild(nx);
        grid.appendChild(c);
      });
      main.appendChild(grid);
      if (p.status === "partial" && p.note) main.appendChild(el("p", "note", p.note));
      main.appendChild(el("p", "fine", "Pronunciation is not assessed: Viva works from a transcript, not audio."));
      return;
    }
    // pending and unavailable are shown exactly as the tool spoke them.
    main.appendChild(el("p", "eyebrow", p.status === "pending" ? "Scoring" : "Results"));
    var msg = el("div", "card");
    msg.appendChild(el("p", "followup", p.status === "unavailable" && p.reason ? p.reason : state.text));
    main.appendChild(msg);
  }

  function renderError(main, p) {
    var card = el("div", "card err");
    card.appendChild(el("p", null, state.text || "Something went wrong."));
    if (p && p.legalActions && p.legalActions.length) {
      card.appendChild(el("p", "fine", "You can: " + p.legalActions.join(", ")));
    }
    main.appendChild(card);
  }

  function render() {
    live = null;
    while (root.firstChild) root.removeChild(root.firstChild);
    var main = el("main");
    root.appendChild(main);
    var p = state.payload || {};
    if (typeof p.locale === "string" && p.locale) document.documentElement.setAttribute("lang", p.locale);
    if (!state.payload && !state.text) {
      main.appendChild(el("p", "eyebrow", "Viva"));
      main.appendChild(el("p", "followup", "Waiting for your exam to begin."));
      return;
    }
    var v = viewFor(state.payload, state.isError, DEFAULT_VIEW);
    document.documentElement.setAttribute("data-view", v);
    if (v === "error") renderError(main, p);
    else if (v === "results") renderResults(main, p);
    else if (v === "speaking") renderSpeaking(main, p);
    else renderCue(main, p);
    tick();
  }

  // ---- microphone level (optional; absent means no meter, never a fake one) ----
  function stopMeter() {
    if (!audio) return;
    try { audio.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { audio.ctx.close(); } catch (e) {}
    audio = null;
  }
  function startMeter() {
    if (audio || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    audio = { pending: true };
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { audio = null; return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var ctx = new Ctx();
      var src = ctx.createMediaStreamSource(stream);
      var an = ctx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      audio = { stream: stream, ctx: ctx, an: an, data: new Uint8Array(an.frequencyBinCount) };
      meterLoop();
    }).catch(function () { audio = null; });
  }
  function meterLoop() {
    if (!audio || !audio.an) return;
    if (live && live.meter) {
      audio.an.getByteFrequencyData(audio.data);
      var bars = live.meter.children;
      var step = Math.floor(audio.data.length / bars.length) || 1;
      for (var i = 0; i < bars.length; i++) {
        var v = audio.data[i * step] / 255;
        bars[i].style.height = Math.max(8, Math.round(v * 100)) + "%";
      }
      live.meter.className = "meter on";
      live.meterLabel.className = "meter-label on";
    }
    requestAnimationFrame(meterLoop);
  }

  // ---- host protocol ----
  function send(msg) {
    msg.jsonrpc = "2.0";
    window.parent.postMessage(msg, "*");
  }
  function applyHost(ctx) {
    if (ctx && (ctx.theme === "light" || ctx.theme === "dark")) {
      document.documentElement.setAttribute("data-theme", ctx.theme);
    }
  }
  function onToolResult(params) {
    var result = params || {};
    var text = "";
    (result.content || []).forEach(function (c) { if (c && c.type === "text") text += (text ? " " : "") + c.text; });
    state = {
      payload: result.structuredContent || null,
      text: text,
      isError: result.isError === true,
      receivedAt: performance.now()
    };
    var wasSpeaking = live && live.meter;
    render();
    if (wasSpeaking && !(live && live.meter)) stopMeter();
  }
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === "ui/notifications/tool-result") onToolResult(m.params);
    else if (m.method === "ui/notifications/host-context-changed") applyHost(m.params);
    else if (m.method === "ui/resource-teardown" && m.id !== undefined) { stopMeter(); send({ id: m.id, result: {} }); }
    else if (m.id !== undefined && m.method) send({ id: m.id, result: {} });
  });

  if (window.parent === window) {
    render();
  } else {
    window.addEventListener("message", function once(ev) {
      var m = ev.data;
      if (ev.source !== window.parent || !m || m.id !== 1 || !m.result) return;
      window.removeEventListener("message", once);
      applyHost(m.result.hostContext);
      send({ method: "ui/notifications/initialized", params: {} });
    });
    send({
      id: 1,
      method: "ui/initialize",
      params: { appInfo: { name: "viva-view", version: "0.1.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" }
    });
    render();
  }
  setInterval(tick, 250);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(function () {
      if (window.parent !== window) {
        send({ method: "ui/notifications/size-changed", params: { width: document.body.scrollWidth, height: document.body.scrollHeight } });
      }
    }).observe(document.body);
  }
})();
`;
