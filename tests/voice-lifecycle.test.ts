import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

function harness() {
  const source = readFileSync(new URL("../src/ui/public/app.js", import.meta.url), "utf8");
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", hidden: false,
      append() {}, innerHTML: "" });
    return elements.get(id);
  };
  const recognizers: any[] = [];
  class Recognition {
    starts = 0;
    constructor() { recognizers.push(this); }
    start() { this.starts++; }
    stop() {}
  }
  const context = createContext({ Recognition, $: element,
    state: { exam: { locale: "en-US" } }, show: (id: string, visible = true) => {
      element(id).hidden = !visible;
    }, banner: (message: string) => { element("banner").textContent = message; },
    document: { createTextNode: (value: string) => value, createElement: () => ({}) },
  });
  runInContext(source.slice(source.indexOf("const listener ="), source.indexOf("// Exam flow")), context);
  return { element, recognizers, run: (code: string) => runInContext(code, context) };
}

describe("browser speech recognition lifecycle", () => {
  it("ignores delayed callbacks from the previous question", () => {
    const h = harness();
    h.run("startListening(); listener.runFinal = 'first answer'; stopListening(); resetTranscript(); startListening(); listener.runFinal = 'second answer'");
    const old = h.recognizers[0];
    old.onend();
    old.onresult({ results: [{ isFinal: true, 0: { transcript: "stale words" } }] });
    expect(h.run("transcriptSoFar()")).toBe("second answer");
  });

  it("preserves words when paused and requests a user click after recognition ends", () => {
    const h = harness();
    h.run("startListening(); listener.runFinal = 'my answer'; stopListening(); startListening()");
    expect(h.run("transcriptSoFar()")).toBe("my answer");
    const current = h.recognizers[1];
    current.onend();
    expect(current.starts).toBe(1);
    expect(h.element("btnListen").textContent).toBe("Start listening");
    expect(h.element("banner").textContent).toContain("Click Start listening");
  });

  it("shows a typed fallback and preserves captured text on a service error", () => {
    const h = harness();
    h.run("startListening(); listener.runFinal = 'captured words'");
    h.recognizers[0].onerror({ error: "network" });
    expect(h.element("banner").textContent).toContain("network");
    expect(h.element("typedArea").hidden).toBe(false);
    expect(h.element("typed").value).toBe("captured words");
  });
});
