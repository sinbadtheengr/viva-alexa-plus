import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuthConfigError, loadAuthConfig } from "../src/auth/config.js";
import { DEFAULT_THROTTLE, PasscodeThrottle, normalizeIp, type ThrottleConfig } from "../src/auth/throttle.js";
import { Corpus } from "../src/exam/corpus.js";
import { silentLogger } from "../src/mcp/logging.js";
import { item } from "./fixtures.js";

/** GAP-011 / QA S1 · passcode guessing must be limited across new request ids. */

const SEC = 1000;
const cfg: ThrottleConfig = {
  maxFailures: 3,
  lockBaseMs: 60 * SEC,
  lockMaxMs: 240 * SEC,
  windowMs: 600 * SEC,
  globalMaxFailures: 10,
  globalWindowMs: 300 * SEC,
  globalSlowMs: 30 * SEC,
  maxTrackedIps: 5,
};

function setup(overrides: Partial<ThrottleConfig> = {}) {
  let t = 1_000_000;
  const throttle = new PasscodeThrottle({ ...cfg, ...overrides }, () => t);
  return {
    throttle,
    advance: (ms: number) => void (t += ms),
    fail: (ip: string, n = 1) => {
      let last;
      for (let i = 0; i < n; i++) last = throttle.recordFailure(ip);
      return last!;
    },
  };
}

describe("PasscodeThrottle · per IP", () => {
  it("locks an IP after N failures and reports how long", () => {
    const { throttle, fail } = setup();
    expect(fail("1.1.1.1", 2).allowed).toBe(true);
    const locking = fail("1.1.1.1");
    expect(locking).toMatchObject({ allowed: false, retryAfterMs: 60 * SEC, scope: "ip" });
    expect(throttle.check("1.1.1.1")).toMatchObject({ allowed: false, scope: "ip" });
  });

  it("leaves other IPs unaffected", () => {
    const { throttle, fail } = setup();
    fail("1.1.1.1", 3);
    expect(throttle.check("2.2.2.2")).toEqual({ allowed: true });
  });

  it("counts down Retry-After and recovers when the lock expires", () => {
    const { throttle, fail, advance } = setup();
    fail("1.1.1.1", 3);
    advance(45 * SEC);
    expect(throttle.check("1.1.1.1")).toMatchObject({ allowed: false, retryAfterMs: 15 * SEC });
    advance(15 * SEC);
    expect(throttle.check("1.1.1.1")).toEqual({ allowed: true });
  });

  it("doubles the lock on repeat lockouts and stops at the cap", () => {
    const { fail, advance } = setup();
    const locks: number[] = [];
    for (let i = 0; i < 5; i++) {
      const v = fail("1.1.1.1", 3);
      if (v.allowed) throw new Error("expected a lock");
      locks.push(v.retryAfterMs / SEC);
      advance(v.retryAfterMs);
    }
    expect(locks).toEqual([60, 120, 240, 240, 240]);
  });

  it("forgets the backoff level after a quiet window", () => {
    const { fail, advance } = setup();
    const first = fail("1.1.1.1", 3);
    if (first.allowed) throw new Error("expected a lock");
    advance(first.retryAfterMs + cfg.windowMs);
    const again = fail("1.1.1.1", 3);
    expect(again).toMatchObject({ allowed: false, retryAfterMs: 60 * SEC });
  });

  it("forgets stale partial failures too", () => {
    const { throttle, fail, advance } = setup();
    fail("1.1.1.1", 2);
    advance(cfg.windowMs);
    expect(fail("1.1.1.1", 2).allowed).toBe(true); // 2 fresh, not 4
    expect(throttle.check("1.1.1.1").allowed).toBe(true);
  });

  it("a success clears the strikes", () => {
    const { throttle, fail } = setup();
    fail("1.1.1.1", 2);
    throttle.recordSuccess("1.1.1.1");
    expect(fail("1.1.1.1", 2).allowed).toBe(true);
  });

  it("bounds memory: tracked IPs never exceed the cap", () => {
    const { throttle, fail } = setup({ globalMaxFailures: 1_000_000 });
    for (let i = 0; i < 50; i++) fail(`10.0.0.${i}`);
    expect(throttle.trackedIps).toBeLessThanOrEqual(cfg.maxTrackedIps);
  });

  it("evicts stale entries before live ones", () => {
    const { throttle, fail, advance } = setup({ globalMaxFailures: 1_000_000 });
    for (let i = 0; i < 5; i++) fail(`10.0.0.${i}`);
    advance(cfg.windowMs + 1);
    fail("9.9.9.9");
    expect(throttle.trackedIps).toBe(1);
  });
});

describe("PasscodeThrottle · global backstop", () => {
  it("slows everyone down once many IPs have failed, then recovers by itself", () => {
    const { throttle, fail, advance } = setup({ maxTrackedIps: 1000 });
    for (let i = 0; i < 10; i++) fail(`10.0.0.${i}`); // 10 distinct IPs, one failure each
    // Slow mode: one attempt per interval, from any IP.
    expect(throttle.check("8.8.8.8")).toEqual({ allowed: true });
    expect(throttle.check("8.8.4.4")).toMatchObject({ allowed: false, scope: "global" });
    advance(30 * SEC);
    expect(throttle.check("8.8.4.4")).toEqual({ allowed: true });
    // The window rolls over: full service resumes, not a permanent lockout.
    advance(cfg.globalWindowMs);
    expect(throttle.check("8.8.4.4")).toEqual({ allowed: true });
    expect(throttle.check("8.8.8.8")).toEqual({ allowed: true });
  });

  it("does not engage below the ceiling", () => {
    const { throttle, fail } = setup({ maxTrackedIps: 1000 });
    for (let i = 0; i < 9; i++) fail(`10.0.0.${i}`);
    expect(throttle.check("8.8.8.8")).toEqual({ allowed: true });
    expect(throttle.check("8.8.4.4")).toEqual({ allowed: true });
  });
});

describe("normalizeIp", () => {
  it("keeps IPv4, unmaps IPv4-in-IPv6, and collapses IPv6 to a /64", () => {
    expect(normalizeIp("203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("2001:db8:1:2::9")).toBe(normalizeIp("2001:0db8:0001:0002:ffff::1"));
    expect(normalizeIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizeIp(undefined)).toBe("unknown");
  });
});

describe("throttle configuration", () => {
  const base = { VIVA_DEMO_PASSCODE: "x" };
  it("has sane defaults", () => {
    const c = loadAuthConfig(base as NodeJS.ProcessEnv);
    expect(c.throttle).toEqual(DEFAULT_THROTTLE);
    expect(c.trustProxy).toBeUndefined();
  });
  it("reads overrides and rejects nonsense", () => {
    const c = loadAuthConfig({
      ...base,
      VIVA_CONSENT_MAX_FAILURES: "2",
      VIVA_CONSENT_LOCK_SECONDS: "5",
      VIVA_TRUST_PROXY: "1",
    } as NodeJS.ProcessEnv);
    expect(c.throttle.maxFailures).toBe(2);
    expect(c.throttle.lockBaseMs).toBe(5000);
    expect(c.trustProxy).toBe(1);
    expect(() => loadAuthConfig({ ...base, VIVA_CONSENT_MAX_FAILURES: "0" } as NodeJS.ProcessEnv)).toThrow(AuthConfigError);
    expect(() => loadAuthConfig({ ...base, VIVA_TRUST_PROXY: "true" } as NodeJS.ProcessEnv)).toThrow(AuthConfigError);
  });
});

// ---------------------------------------------------------------- over HTTP

const PASSCODE = "throttle-test-passcode";
const CLIENT_ID = "throttle-client";
const REDIRECT_URI = "https://client.example/callback";
const HOSTILE_NAME = `<script>alert("x")</script> & 'Co'`;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function start(extraEnv: Record<string, string> = {}) {
  let t = 5_000_000;
  const auth = loadAuthConfig({
    VIVA_ISSUER_URL: "http://127.0.0.1:1",
    VIVA_RESOURCE_URL: "http://127.0.0.1:1/mcp",
    VIVA_DEMO_PASSCODE: PASSCODE,
    VIVA_CONSENT_MAX_FAILURES: "3",
    VIVA_CONSENT_LOCK_SECONDS: "60",
    VIVA_OAUTH_CLIENTS: JSON.stringify([
      { client_id: CLIENT_ID, client_name: HOSTILE_NAME, redirect_uris: [REDIRECT_URI] },
    ]),
    ...extraEnv,
  } as NodeJS.ProcessEnv);
  const built = await createApp({
    corpus: Corpus.fromItems([item()]),
    auth,
    logger: silentLogger,
    consentClock: () => t,
  });
  const server = built.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  servers.push(server);
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    advance: (ms: number) => void (t += ms),
  };
}

async function pendingRid(origin: string): Promise<string> {
  const challenge = createHash("sha256").update(randomBytes(32)).digest("base64url");
  const url = new URL(`${origin}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    resource: "http://127.0.0.1:1/mcp",
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  return new URL(res.headers.get("location")!, origin).searchParams.get("rid")!;
}

async function attempt(origin: string, passcode: string, ip?: string) {
  const rid = await pendingRid(origin); // a brand new rid every time, as an attacker would
  return fetch(`${origin}/consent`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(ip ? { "x-forwarded-for": ip } : {}),
    },
    body: new URLSearchParams({ rid, passcode, action: "approve" }),
    redirect: "manual",
  });
}

const gotCode = (res: Response) =>
  Boolean(res.headers.get("location") && new URL(res.headers.get("location")!).searchParams.get("code"));

describe("consent POST throttling (HTTP)", () => {
  it("locks out guessing even when every guess uses a fresh request id", async () => {
    const { origin } = await start();
    expect((await attempt(origin, "g1")).status).toBe(401);
    expect((await attempt(origin, "g2")).status).toBe(401);
    const third = await attempt(origin, "g3");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
    for (let i = 0; i < 20; i++) expect((await attempt(origin, `more-${i}`)).status).toBe(429);
  });

  it("refuses the correct passcode while locked, then accepts it after the lock expires", async () => {
    const { origin, advance } = await start();
    for (let i = 0; i < 3; i++) await attempt(origin, `bad-${i}`);

    const locked = await attempt(origin, PASSCODE);
    expect(locked.status).toBe(429);
    expect(gotCode(locked)).toBe(false);

    advance(59_000);
    expect((await attempt(origin, PASSCODE)).status).toBe(429);
    advance(1_000);
    expect(gotCode(await attempt(origin, PASSCODE))).toBe(true);
  });

  it("renders the lockout in the consent page style, escaped, with a Retry-After", async () => {
    const { origin } = await start();
    for (let i = 0; i < 2; i++) await attempt(origin, `bad-${i}`);
    const res = await attempt(origin, "bad-3");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('class="error" role="alert"');
    expect(html).toContain("Too many incorrect passcodes. Try again in 60 seconds.");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;");
    expect(html).not.toContain("<script>alert");
  });

  it("ignores X-Forwarded-For unless a proxy is explicitly trusted", async () => {
    const { origin } = await start();
    // Rotating the header must not buy fresh attempts.
    await attempt(origin, "a", "198.51.100.1");
    await attempt(origin, "b", "198.51.100.2");
    expect((await attempt(origin, "c", "198.51.100.3")).status).toBe(429);
    expect((await attempt(origin, PASSCODE, "198.51.100.4")).status).toBe(429);
  });

  it("with trust proxy, keys on the forwarded client so other clients are unaffected", async () => {
    const { origin } = await start({ VIVA_TRUST_PROXY: "1" });
    for (let i = 0; i < 3; i++) await attempt(origin, `bad-${i}`, "198.51.100.1");
    expect((await attempt(origin, PASSCODE, "198.51.100.1")).status).toBe(429);
    expect(gotCode(await attempt(origin, PASSCODE, "198.51.100.2"))).toBe(true);
  });

  it("global backstop slows distributed guessing, then recovers", async () => {
    const { origin, advance } = await start({
      VIVA_TRUST_PROXY: "1",
      VIVA_CONSENT_GLOBAL_MAX_FAILURES: "6",
      VIVA_CONSENT_GLOBAL_WINDOW_SECONDS: "300",
      VIVA_CONSENT_GLOBAL_SLOW_SECONDS: "30",
    });
    // Two failures from each of three addresses: no single IP locks, the global ceiling trips.
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
      for (let i = 0; i < 2; i++) expect((await attempt(origin, "bad", ip)).status).toBe(401);
    }
    // A fresh, unlocked IP with the right passcode: first attempt takes the slot...
    expect(gotCode(await attempt(origin, PASSCODE, "203.0.113.50"))).toBe(true);
    // ...the next one inside the slow interval waits.
    const slowed = await attempt(origin, PASSCODE, "203.0.113.51");
    expect(slowed.status).toBe(429);
    expect(Number(slowed.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await slowed.text()).toContain("across the service");
    advance(30_000);
    expect(gotCode(await attempt(origin, PASSCODE, "203.0.113.51"))).toBe(true);
    advance(300_000);
    expect(gotCode(await attempt(origin, PASSCODE, "203.0.113.52"))).toBe(true);
    expect(gotCode(await attempt(origin, PASSCODE, "203.0.113.53"))).toBe(true);
  });

  it("still lets a caller cancel while locked, and keeps correct-passcode flow when not locked", async () => {
    const { origin } = await start();
    for (let i = 0; i < 3; i++) await attempt(origin, `bad-${i}`);
    const rid = await pendingRid(origin);
    const res = await fetch(`${origin}/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ rid, passcode: "", action: "deny" }),
      redirect: "manual",
    });
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });
});
