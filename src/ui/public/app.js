// Viva demo client: the Alexa+ stand-in.
//
// It does what Alexa+ would do with our MCP server: sign in with OAuth 2.1 +
// PKCE, call the seven tools, read each tool's `content` text aloud, listen for
// the candidate's answer, and pass the transcript to submit_response. All
// timing comes from the server (get_status); this file never invents a deadline.
import * as L from "./lib.js";

const $ = (id) => document.getElementById(id);
const OAUTH_KEY = "viva.oauth"; // PKCE verifier + state, needed across the redirect
const MCP_SESSION_KEY = "viva.mcpSession"; // an identifier, not a credential

const state = {
  cfg: null,
  token: null, // access token: memory only, sent in the Authorization header only
  mcpSession: null,
  nextId: 1,
  exam: null, // { id, locale, prompt, bullets, speakSeconds, prepSeconds, phase }
  sync: null, // clock anchor from the last get_status / advance_phase
  allowance: null, // seconds allowed in the current timed phase
  busy: false,
  advancing: false,
  answering: false,
  answerStartedAt: 0,
  samples: [],
};

// --------------------------------------------------------------------------
// Small UI helpers
// --------------------------------------------------------------------------

function show(id, on = true) { $(id).hidden = !on; }
function banner(message) { $("banner").textContent = message ?? ""; show("banner", Boolean(message)); }
function setConn(text) { $("conn").textContent = text; }

function log(line) {
  const el = $("log");
  if (el.textContent === "No requests yet.") el.textContent = "";
  el.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
  el.scrollTop = el.scrollHeight;
  console.info("[viva]", line);
  const s = L.summariseLatency(state.samples);
  $("logSummary").textContent = `${s.count} calls, median ${s.medianMs.toFixed(0)} ms, worst ${s.maxMs.toFixed(0)} ms`;
}

function addTurn(who, text) {
  const li = document.createElement("li");
  const w = document.createElement("span");
  w.className = "who";
  w.textContent = `${who}: `;
  li.append(w, document.createTextNode(text));
  $("turns").append(li);
  show("viewTurns");
}

// --------------------------------------------------------------------------
// OAuth 2.1 + PKCE (S256) against our own authorization server
// --------------------------------------------------------------------------

async function beginSignIn() {
  const { cfg } = state;
  if (location.origin !== new URL(cfg.issuer).origin) {
    banner(`Open this page at ${new URL("/demo/", cfg.issuer).href} so the sign-in redirect returns to the same origin.`);
    return;
  }
  const meta = await (await fetch("/.well-known/oauth-authorization-server")).json();
  const verifier = L.randomToken(32);
  const challenge = await L.codeChallengeS256(verifier);
  const st = L.randomToken(16);
  sessionStorage.setItem(OAUTH_KEY, JSON.stringify({ verifier, state: st, tokenEndpoint: meta.token_endpoint }));
  location.assign(
    L.buildAuthorizeUrl({
      authorizationEndpoint: meta.authorization_endpoint,
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      challenge,
      state: st,
      resource: cfg.resource,
      scope: cfg.scope,
    }),
  );
}

/** Handles the redirect back from the consent screen, if this load is one. */
async function completeSignIn() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(OAUTH_KEY) ?? "null"); } catch { /* treat as absent */ }
  const result = L.parseAuthorizationResponse(location.search, saved?.state ?? null);
  if (result.kind === "none") return false;

  history.replaceState(null, "", location.pathname); // the code never lingers in the address bar
  sessionStorage.removeItem(OAUTH_KEY);

  if (result.kind === "error") {
    banner(result.error === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed: ${result.error}.`);
    return false;
  }
  const t0 = performance.now();
  const res = await fetch(saved.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: L.buildTokenRequestBody({
      code: result.code,
      clientId: state.cfg.clientId,
      redirectUri: state.cfg.redirectUri,
      verifier: saved.verifier,
      resource: state.cfg.resource,
    }),
  });
  const ms = performance.now() - t0;
  log(L.formatLogLine({ tool: "token", ms, ok: res.ok, status: res.status }));
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    banner(`Token exchange failed: ${body.error_description ?? body.error ?? res.status}`);
    return false;
  }
  state.token = body.access_token;
  return true;
}

// --------------------------------------------------------------------------
// MCP over Streamable HTTP
// --------------------------------------------------------------------------

class SignInRequired extends Error {}

async function post(body, { expectResponse }) {
  const t0 = performance.now();
  const res = await fetch(state.cfg.mcpUrl, {
    method: "POST",
    headers: L.mcpHeaders({ token: state.token, sessionId: state.mcpSession }),
    body: JSON.stringify(body),
  });
  const t1 = performance.now();
  const text = await res.text();
  state.samples.push(t1 - t0);
  const label = body.method === "tools/call" ? body.params.name : body.method;
  log(L.formatLogLine({ tool: label, ms: t1 - t0, ok: res.ok, status: res.status }));
  if (res.status === 401) {
    state.token = null;
    setConn("Signed out");
    throw new SignInRequired("Your session expired. Sign in again.");
  }
  return { res, text, t0, t1, messages: res.ok && expectResponse ? L.parseResponseBody(res.headers.get("content-type"), text) : [] };
}

async function ensureMcpSession() {
  if (state.mcpSession) return;
  const stored = sessionStorage.getItem(MCP_SESSION_KEY);
  if (stored) { state.mcpSession = stored; return; }
  const id = state.nextId++;
  const { res, text, messages } = await post(L.initializeRequest(id, { name: "viva-demo-client", version: "0.1.0" }), { expectResponse: true });
  if (!res.ok) {
    throw new Error(`MCP initialize failed (HTTP ${res.status}): ${text.slice(0, 200)}.`);
  }
  L.responseFor(messages, id);
  state.mcpSession = res.headers.get("mcp-session-id");
  if (state.mcpSession) sessionStorage.setItem(MCP_SESSION_KEY, state.mcpSession);
  await post(L.jsonRpcNotification("notifications/initialized"), { expectResponse: false });
}

async function callTool(name, args = {}, retried = false) {
  await ensureMcpSession();
  const id = state.nextId++;
  const { res, messages, t0, t1, text } = await post(L.toolCallRequest(id, name, args), { expectResponse: true });
  if (res.status === 404 && !retried) {
    // Server restarted: the remembered MCP session id is dead. Start a new one.
    state.mcpSession = null;
    sessionStorage.removeItem(MCP_SESSION_KEY);
    return callTool(name, args, true);
  }
  if (!res.ok) throw new Error(`${name} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  const outcome = L.toolOutcome(L.responseFor(messages, id));
  return { ...outcome, t0, t1 };
}

// --------------------------------------------------------------------------
// Voice: speechSynthesis out, SpeechRecognition in
// --------------------------------------------------------------------------

const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;

function speak(text) {
  const synth = window.speechSynthesis;
  if (!$("voiceOut").checked || !synth || !text) return Promise.resolve();
  synth.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text.replace(/^— /gm, ""));
    if (state.exam?.locale) u.lang = state.exam.locale;
    // Some engines never fire onend; never let that stall the exam.
    const guard = setTimeout(resolve, 3000 + text.length * 90);
    const done = () => { clearTimeout(guard); resolve(); };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  });
}

const listener = { rec: null, active: false, committed: "", runFinal: "", runInterim: "" };

function transcriptSoFar() {
  return `${listener.committed} ${listener.runFinal}`.trim() || listener.runInterim.trim();
}

function renderTranscript() {
  const box = $("liveTranscript");
  box.textContent = "";
  const finalText = `${listener.committed} ${listener.runFinal}`.trim();
  box.append(document.createTextNode(finalText));
  if (listener.runInterim) {
    const span = document.createElement("span");
    span.className = "interim";
    span.textContent = ` ${listener.runInterim}`;
    box.append(span);
  }
  if (!finalText && !listener.runInterim) box.innerHTML = "&nbsp;";
}

function showTypedFallback(why) {
  show("typedArea");
  $("btnListen").hidden = true;
  if (why) banner(why);
}

function startListening() {
  if (!Recognition) { showTypedFallback(); return; }
  stopListening();
  listener.active = true;
  const rec = new Recognition();
  listener.rec = rec;
  rec.lang = state.exam.locale;
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let fin = "", interim = "";
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) fin += `${r[0].transcript} `; else interim += r[0].transcript;
    }
    listener.runFinal = fin.trim();
    listener.runInterim = interim;
    renderTranscript();
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
      listener.active = false;
      showTypedFallback("Microphone unavailable, so type your answer instead.");
    }
  };
  rec.onend = () => {
    // Continuous recognition stops itself after silence; fold the run in and resume.
    listener.committed = `${listener.committed} ${listener.runFinal}`.trim();
    listener.runFinal = "";
    listener.runInterim = "";
    if (listener.active && listener.rec === rec) { try { rec.start(); } catch { /* already started */ } }
  };
  try { rec.start(); } catch { /* ignore double start */ }
  $("btnListen").textContent = "Listening... (tap to pause)";
}

function stopListening() {
  listener.active = false;
  const rec = listener.rec;
  listener.rec = null;
  if (rec) { try { rec.stop(); } catch { /* ignore */ } }
  $("btnListen").textContent = "Start listening";
}

function resetTranscript() {
  Object.assign(listener, { committed: "", runFinal: "", runInterim: "" });
  $("typed").value = "";
  renderTranscript();
}

// --------------------------------------------------------------------------
// Exam flow
// --------------------------------------------------------------------------

function setPhase(phase) {
  state.exam.phase = phase;
  $("phaseName").textContent = phase;
}

function renderExam() {
  const e = state.exam;
  $("cuePrompt").textContent = e.prompt;
  const ul = $("cueBullets");
  ul.textContent = "";
  for (const b of e.bullets) { const li = document.createElement("li"); li.textContent = b; ul.append(li); }
  $("examMeta").textContent = `${e.exam.toUpperCase()} part ${e.part} · ${e.locale} · ${e.topic}`;
}

async function startExam() {
  if (state.busy) return;
  state.busy = true; banner("");
  try {
    const sel = JSON.parse($("selExam").value);
    const topic = $("selTopic").value;
    const out = await callTool("start_exam", {
      exam: sel.exam,
      part: Number($("selPart").value),
      locale: sel.locale,
      ...(topic ? { topic } : {}),
    });
    if (out.isError) { banner(out.text); return; }
    const d = out.data;
    state.exam = { id: d.sessionId, exam: d.exam, part: d.part, locale: d.locale, topic: d.topic,
      prompt: d.prompt, bullets: d.bullets, speakSeconds: d.speakSeconds, prepSeconds: d.prepSeconds, phase: d.phase };
    state.sync = null; state.allowance = null; state.answering = false;
    $("turns").textContent = ""; show("viewTurns", false);
    show("viewSetup", false); show("viewResults", false); show("viewExam");
    show("answerArea", false); show("elapsedBox", false); show("overrunNote", false);
    $("examiner").textContent = out.text;
    addTurn("Examiner", out.text);
    renderExam(); setPhase(d.phase);
    $("clock").textContent = "--:--"; $("clockLabel").textContent = "Clock not started";
    show("btnAdvance");
  } catch (err) { handleError(err); } finally { state.busy = false; }
  // Read the prompt, then start the clock, as the tool description tells Alexa+ to.
  if (state.exam && state.exam.phase === "briefing") {
    await speak($("examiner").textContent);
    if (state.exam.phase === "briefing") await advance();
  }
}

async function advance() {
  if (state.advancing || !state.exam) return;
  state.advancing = true; banner("");
  try {
    const out = await callTool("advance_phase", { sessionId: state.exam.id });
    if (out.isError) { banner(out.text); return; }
    const phase = out.data.phase;
    setPhase(phase);
    state.sync = L.makeClockSync(out.data.secondsRemaining, out.t0, out.t1);
    show("btnAdvance", false);
    $("examiner").textContent = out.text;
    addTurn("Examiner", out.text);
    if (phase === "prep") {
      state.allowance = state.exam.prepSeconds;
      $("clockLabel").textContent = "Preparation time left";
      scheduleSync();
      await speak(out.text);
    } else if (phase === "speaking") {
      state.allowance = state.exam.speakSeconds;
      $("clockLabel").textContent = "Speaking time left";
      show("elapsedBox");
      scheduleSync();
      await speak(out.text);
      beginAnswering();
    }
  } catch (err) { handleError(err); } finally { state.advancing = false; }
}

function beginAnswering() {
  state.answering = true;
  state.answerStartedAt = performance.now();
  show("answerArea");
  show("elapsedBox");
  resetTranscript();
  startListening();
}

async function submit() {
  if (state.busy || !state.exam || !state.answering) return;
  const typedMode = !$("typedArea").hidden;
  stopListening();
  if (!typedMode) await new Promise((r) => setTimeout(r, 500)); // let the recogniser flush its last result
  const transcript = (typedMode ? $("typed").value : transcriptSoFar()).trim();
  if (!transcript) { banner("Nothing to submit yet. Say or type your answer first."); if (!typedMode) startListening(); return; }
  state.busy = true; banner("");
  let next = null;
  try {
    addTurn("Candidate", transcript);
    const out = await callTool("submit_response", { sessionId: state.exam.id, transcript });
    if (out.isError) { banner(out.text); state.answering = true; return; }
    state.answering = false;
    state.sync = null; // follow-up phase has no deadline
    setPhase(out.data.phase);
    $("examiner").textContent = out.text;
    addTurn("Examiner", out.text);
    show("overrunNote", out.data.overrun);
    if (out.data.overrun) {
      $("overrunNote").textContent = `That answer ran ${out.data.overrunSeconds} seconds over the limit. It was accepted and will be scored.`;
    }
    $("clockLabel").textContent = "Follow-up questions are not timed";
    $("clock").textContent = "--:--";
    $("clock").className = "clock";
    next = out.data.exhausted ? "score" : "listen";
    await speak(out.text);
  } catch (err) { handleError(err); } finally { state.busy = false; }
  if (next === "score") await scoreAndShow();
  else if (next === "listen") beginAnswering();
}

// --------------------------------------------------------------------------
// Clock: driven by get_status, interpolated locally between reads
// --------------------------------------------------------------------------

let syncTimer = null;

async function readStatus() {
  if (!state.exam) return null;
  const out = await callTool("get_status", { sessionId: state.exam.id });
  if (out.isError) { banner(out.text); return null; }
  state.sync = L.makeClockSync(out.data.secondsRemaining, out.t0, out.t1);
  if (out.data.phase !== state.exam.phase) setPhase(out.data.phase);
  show("overrunNote", Boolean(out.data.overrun) && state.exam.phase === "speaking");
  if (out.data.overrun && state.exam.phase === "speaking") {
    $("overrunNote").textContent = "Time is up. Please conclude. Your answer will still be accepted and scored.";
  }
  return out.data;
}

function scheduleSync() {
  clearTimeout(syncTimer);
  if (!state.sync || !state.exam) return;
  syncTimer = setTimeout(async () => {
    try { await readStatus(); } catch (err) { handleError(err); return; }
    scheduleSync();
  }, L.nextSyncDelayMs(state.sync, performance.now()));
}

let confirming = false;
setInterval(() => {
  if (!state.exam) return;
  const now = performance.now();
  const clock = $("clock");
  const left = L.secondsLeft(state.sync, now);
  if (left !== null) {
    clock.textContent = L.formatClock(left);
    clock.className = left <= 0 ? "clock over" : left <= 10 ? "clock low" : "clock";
    if (state.exam.phase === "speaking") {
      $("elapsed").textContent = L.formatElapsed(L.elapsedSeconds(state.allowance, state.sync, now));
    }
    // Prep has run out locally: confirm with the server before moving on.
    if (left <= 0 && state.exam.phase === "prep" && !confirming && !state.advancing) {
      confirming = true;
      readStatus()
        .then((s) => { if (s && s.phase === "prep" && s.secondsRemaining === 0) return advance(); })
        .catch(handleError)
        .finally(() => { confirming = false; });
    }
  } else if (state.answering) {
    $("elapsed").textContent = L.formatElapsed((now - state.answerStartedAt) / 1000);
  }
}, 200);

// --------------------------------------------------------------------------
// Scoring and results
// --------------------------------------------------------------------------

async function scoreAndShow() {
  show("viewExam", false); show("viewResults");
  $("scores").textContent = ""; show("btnAgain", false); show("btnRetry", false);
  $("resultStatus").textContent = "Working out your results...";
  try {
    const out = await callTool("score_session", { sessionId: state.exam.id });
    if (out.isError) { $("resultStatus").textContent = out.text; return; }
    await speak(out.text);
    await pollResults(out.data.pollAfterMs);
  } catch (err) { handleError(err); }
}

async function pollResults(firstDelayMs) {
  const giveUpAt = performance.now() + 60000;
  let delay = L.pollDelayMs(firstDelayMs);
  for (;;) {
    await new Promise((r) => setTimeout(r, delay));
    const out = await callTool("get_results", { sessionId: state.exam.id });
    if (out.isError) { $("resultStatus").textContent = out.text; show("btnAgain"); return; }
    const d = out.data;
    if (d.status === "pending") {
      if (performance.now() > giveUpAt) {
        $("resultStatus").textContent = "Scoring is still pending. You can check again.";
        show("btnRetry");
        return;
      }
      delay = L.pollDelayMs(d.pollAfterMs);
      continue;
    }
    renderResults(d);
    show("btnAgain");
    await speak(out.text);
    return;
  }
}

function renderResults(d) {
  const box = $("scores");
  box.textContent = "";
  if (d.status === "unavailable") {
    $("resultStatus").textContent = `No marks available. ${d.reason}`;
    return;
  }
  $("resultStatus").textContent = d.status === "partial" ? d.note : "Your marks";
  for (const s of d.scores) {
    const card = document.createElement("div");
    card.className = "score";
    const label = document.createElement("div"); label.className = "label"; label.textContent = s.label;
    const band = document.createElement("div"); band.className = "band"; band.textContent = s.band;
    const ev = document.createElement("blockquote"); ev.textContent = s.evidence;
    const imp = document.createElement("div"); imp.className = "improve";
    const b = document.createElement("strong"); b.textContent = "To improve: ";
    imp.append(b, document.createTextNode(s.improvement));
    card.append(label, band, ev, imp);
    box.append(card);
  }
  if (d.progressRecorded === false) {
    const p = document.createElement("p"); p.className = "note";
    p.textContent = "These marks could not be filed to your practice history.";
    box.append(p);
  }
}

async function showProgress() {
  try {
    const out = await callTool("get_progress", {});
    $("progressText").textContent = out.text;
    show("progressText");
    await speak(out.text);
  } catch (err) { handleError(err); }
}

// --------------------------------------------------------------------------
// Setup and errors
// --------------------------------------------------------------------------

function handleError(err) {
  if (err instanceof SignInRequired) {
    show("viewConnect"); show("viewSetup", false);
  }
  banner(err.message ?? String(err));
}

function populateSetup() {
  const { catalog, defaults } = state.cfg;
  const selExam = $("selExam");
  selExam.textContent = "";
  catalog.forEach((c) => {
    const o = document.createElement("option");
    o.value = JSON.stringify({ exam: c.exam, locale: c.locale });
    o.textContent = `${c.exam.toUpperCase()} · ${c.locale}`;
    if (c.exam === defaults.exam && c.locale === defaults.locale) o.selected = true;
    selExam.append(o);
  });
  const currentEntry = () => {
    const sel = JSON.parse(selExam.value);
    return catalog.find((c) => c.exam === sel.exam && c.locale === sel.locale);
  };
  const fillParts = () => {
    document.documentElement.lang = currentEntry().locale;
    const parts = Object.keys(currentEntry().parts);
    $("selPart").textContent = "";
    for (const p of parts) { const o = document.createElement("option"); o.value = p; o.textContent = `Part ${p}`; $("selPart").append(o); }
    fillTopics();
  };
  const fillTopics = () => {
    $("selTopic").textContent = "";
    const any = document.createElement("option"); any.value = ""; any.textContent = "Examiner's choice"; $("selTopic").append(any);
    for (const t of currentEntry().parts[$("selPart").value] ?? []) {
      const o = document.createElement("option"); o.value = t; o.textContent = t; $("selTopic").append(o);
    }
  };
  selExam.onchange = fillParts;
  $("selPart").onchange = fillTopics;
  fillParts();
}

function showSignedIn() {
  setConn(state.cfg.authEnabled ? "Signed in" : "Auth off (local dev)");
  show("viewConnect", false); show("viewSetup");
}

function resetToSetup() {
  state.exam = null; state.sync = null; state.answering = false;
  stopListening(); window.speechSynthesis?.cancel();
  show("viewResults", false); show("viewExam", false); show("viewTurns", false); show("viewSetup");
}

async function main() {
  state.cfg = await (await fetch("config.json")).json();
  populateSetup();
  $("btnConnect").onclick = () => beginSignIn().catch(handleError);
  $("btnStart").onclick = startExam;
  $("btnAdvance").onclick = advance;
  $("btnSubmit").onclick = submit;
  $("btnProgress").onclick = showProgress;
  $("btnAgain").onclick = resetToSetup;
  $("btnRetry").onclick = () => { show("btnRetry", false); pollResults(250).catch(handleError); };
  $("btnListen").onclick = () => (listener.active ? stopListening() : startListening());

  if (!state.cfg.authEnabled) { showSignedIn(); return; }
  try {
    if (await completeSignIn()) showSignedIn();
  } catch (err) { handleError(err); }
}

main().catch((err) => banner(`Could not load the demo: ${err.message}`));
