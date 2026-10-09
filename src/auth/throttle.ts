/**
 * F-9 / GAP-011 · Passcode guess throttling for the consent screen.
 *
 * The per-request attempt cap in consent.ts is not a defence on its own: GET
 * /authorize hands a fresh request id to anyone, so an attacker simply asks for a
 * new one. This throttle is keyed on something the attacker cannot mint for free.
 *
 * Two layers:
 *  - Per client IP: `maxFailures` wrong passcodes lock that IP out, for
 *    `lockBaseMs * 2^level` (capped at `lockMaxMs`). The level climbs with each
 *    repeat lockout and is forgotten after a quiet `windowMs`.
 *  - Global backstop across all IPs, for a distributed guesser or a proxy that
 *    collapses every client onto one address: once `globalMaxFailures` wrong
 *    guesses land inside `globalWindowMs`, the whole endpoint drops into slow
 *    mode and admits one attempt per `globalSlowMs`. It never hard-disables:
 *    the window rolls over by itself and normal service resumes.
 *
 * Time is injected, and memory is bounded (`maxTrackedIps`).
 */

export interface ThrottleConfig {
  readonly maxFailures: number;
  readonly lockBaseMs: number;
  readonly lockMaxMs: number;
  /** Failures (and the lock level) are forgotten after this long without a new failure. */
  readonly windowMs: number;
  readonly globalMaxFailures: number;
  readonly globalWindowMs: number;
  /** In global slow mode, one attempt is admitted per this interval. */
  readonly globalSlowMs: number;
  readonly maxTrackedIps: number;
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  maxFailures: 5,
  lockBaseMs: 60_000,
  lockMaxMs: 60 * 60_000,
  windowMs: 15 * 60_000,
  globalMaxFailures: 50,
  globalWindowMs: 10 * 60_000,
  globalSlowMs: 30_000,
  maxTrackedIps: 10_000,
};

export type ThrottleVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number; readonly scope: "ip" | "global" };

interface IpEntry {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
  level: number;
}

export class PasscodeThrottle {
  private readonly ips = new Map<string, IpEntry>();
  private globalFailures = 0;
  private globalWindowStart = 0;
  private nextSlowSlotAt = 0;

  constructor(
    private readonly config: ThrottleConfig = DEFAULT_THROTTLE,
    private readonly now: () => number = Date.now,
  ) {}

  /** Number of IPs currently tracked (exposed for the memory-bound test). */
  get trackedIps(): number {
    return this.ips.size;
  }

  /**
   * Asks whether a passcode attempt from `ip` may be evaluated at all. Call before
   * comparing the passcode. An admitted attempt in global slow mode consumes the slot.
   */
  check(ip: string): ThrottleVerdict {
    const t = this.now();
    const entry = this.ips.get(ip);
    if (entry && entry.lockedUntil > t) {
      return { allowed: false, retryAfterMs: entry.lockedUntil - t, scope: "ip" };
    }
    this.rollGlobalWindow(t);
    if (this.globalFailures >= this.config.globalMaxFailures) {
      if (t < this.nextSlowSlotAt) {
        return { allowed: false, retryAfterMs: this.nextSlowSlotAt - t, scope: "global" };
      }
      this.nextSlowSlotAt = t + this.config.globalSlowMs;
    }
    return { allowed: true };
  }

  /** Records a wrong passcode. Returns the lock this failure caused, if any. */
  recordFailure(ip: string): ThrottleVerdict {
    const t = this.now();
    this.rollGlobalWindow(t);
    this.globalFailures += 1;

    let entry = this.ips.get(ip);
    if (entry && this.isStale(entry, t)) entry = undefined;
    if (!entry) entry = { failures: 0, lastFailureAt: t, lockedUntil: 0, level: 0 };
    if (t - entry.lastFailureAt >= this.config.windowMs) entry.failures = 0;
    entry.failures += 1;
    entry.lastFailureAt = t;

    let verdict: ThrottleVerdict = { allowed: true };
    if (entry.failures >= this.config.maxFailures) {
      const lockMs = Math.min(this.config.lockMaxMs, this.config.lockBaseMs * 2 ** entry.level);
      entry.level += 1;
      entry.failures = 0;
      entry.lockedUntil = t + lockMs;
      verdict = { allowed: false, retryAfterMs: lockMs, scope: "ip" };
    }
    this.ips.delete(ip); // re-insert so Map order is least-recently-failed first
    this.ips.set(ip, entry);
    this.enforceBound(t);
    return verdict;
  }

  /** A correct passcode clears that IP's strikes (it was not locked, or check() would have refused). */
  recordSuccess(ip: string): void {
    this.ips.delete(ip);
  }

  private rollGlobalWindow(t: number): void {
    if (t - this.globalWindowStart >= this.config.globalWindowMs) {
      this.globalWindowStart = t;
      this.globalFailures = 0;
      this.nextSlowSlotAt = 0;
    }
  }

  private isStale(entry: IpEntry, t: number): boolean {
    return Math.max(entry.lockedUntil, entry.lastFailureAt) + this.config.windowMs <= t;
  }

  private enforceBound(t: number): void {
    if (this.ips.size <= this.config.maxTrackedIps) return;
    for (const [key, entry] of this.ips) {
      if (this.isStale(entry, t)) this.ips.delete(key);
    }
    // Still over: drop the oldest. An evicted IP merely gets a clean slate; the
    // global backstop is what bounds a many-address attacker.
    for (const key of this.ips.keys()) {
      if (this.ips.size <= this.config.maxTrackedIps) break;
      this.ips.delete(key);
    }
  }
}

/**
 * Collapses an address to the unit an attacker controls cheaply: IPv4 as-is,
 * IPv4-mapped IPv6 as IPv4, other IPv6 to its /64.
 */
export function normalizeIp(raw: string | undefined): string {
  if (!raw) return "unknown";
  let ip = raw.trim().toLowerCase();
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(":")) return ip;
  const compressed = ip.includes("::");
  const [head = "", tail = ""] = ip.split("::", 2);
  const headParts = head ? head.split(":") : [];
  const tailParts = compressed && tail ? tail.split(":") : [];
  const missing = compressed ? 8 - headParts.length - tailParts.length : 0;
  const groups = [...headParts, ...Array<string>(Math.max(0, missing)).fill("0"), ...tailParts];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
