/**
 * Webhook intake: parsing, signature check, dedupe, replay window, rate limit and
 * sequence tracking.
 *
 * Kept separate from the controller so it can be unit-tested with plain objects, and
 * separate from app.ts so the classification is one decision in one place. The rule
 * throughout is conservative: anything we are not sure about is recorded whole and not
 * acted on. A delivery is never silently dropped - app.ts writes every one of them,
 * payload included, because rejected deliveries are the evidence for the security page
 * (and a rejected payment_made is a car trying to leave without paying).
 */
import { createHash } from "node:crypto";
import type { DeliveryRejection, SimEventBase } from "@gpa/shared";

type Reviver = (key: string, value: unknown, context?: { source: string }) => unknown;

/**
 * Parse a webhook body keeping every number as the exact text the simulator sent
 * (1.0 stays "1.0"), so the signature is computed over what the simulator hashed.
 * Uses JSON.parse source-text access (Node >= 21).
 */
export function parseRaw(body: string): SimEventBase {
  const reviver: Reviver = (_key, value, context) =>
    typeof value === "number" && context ? context.source : value;
  const parsed = JSON.parse(body, reviver as Parameters<typeof JSON.parse>[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("not a JSON object");
  return parsed as SimEventBase;
}

/** MD5 over the values of every field except Signature, ordered by field name. */
export function computeSignature(payload: Record<string, unknown>): string {
  const joined = Object.keys(payload)
    .filter((k) => k !== "Signature")
    .sort()
    .map((k) => String(payload[k]))
    .join("|");
  return createHash("md5").update(joined, "utf8").digest("hex");
}

export type SigStatus = "valid" | "unsigned" | "invalid";
export type SignatureMode = "strict" | "lenient" | "monitor";

/** Level 1 sends Signature=null on every event. */
export function signatureStatus(payload: Record<string, unknown>): SigStatus {
  const received = payload.Signature;
  if (!received) return "unsigned";
  return computeSignature(payload) === String(received).toLowerCase() ? "valid" : "invalid";
}

/** Whether an event with this signature status may be acted on (see config.ts). */
export function trusted(sig: SigStatus, mode: SignatureMode): boolean {
  if (mode === "monitor") return true;
  if (mode === "lenient") return sig !== "invalid";
  return sig === "valid";
}

/**
 * How far a delivery's ServerDateTime is from our clock, in seconds, or null when the
 * event carries no usable stamp (then there is nothing to check and it is let through).
 * ServerDateTime is "2026-09-12 15:26:50" local wall-clock time on the simulator machine.
 */
export function clockSkewS(serverDateTime: unknown, nowMs = Date.now()): number | null {
  if (typeof serverDateTime !== "string" || !serverDateTime) return null;
  const t = Date.parse(serverDateTime.replace(" ", "T"));
  return Number.isNaN(t) ? null : Math.abs(nowMs - t) / 1000;
}

/**
 * Deliveries allowed per source, as a token bucket: `perSecond` refill, `burst` ceiling.
 * Disabled (always allows) when perSecond is 0 - the default, because the simulator's
 * three Level 3 emitters burst legitimately and we would rather queue than refuse.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly perSecond: number, private readonly burst: number, private readonly now = () => Date.now()) {}

  get enabled(): boolean {
    return this.perSecond > 0;
  }

  allow(source: string): boolean {
    if (!this.enabled) return true;
    const now = this.now();
    const bucket = this.buckets.get(source) ?? { tokens: this.burst, at: now };
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond);
    bucket.at = now;
    // Sources are IPs, and in practice there is exactly one (the simulator). Keeping a
    // bucket per source is bounded by whoever can reach the port.
    this.buckets.set(source, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

export interface IntakeResult {
  accept: boolean;
  sig: SigStatus;
  duplicate: boolean;
  /** Why it was not acted on; null when accepted. */
  rejection: DeliveryRejection | null;
  seqNote: string;
}

export interface IntakeInput {
  /** The durable answer from the store: the same EventId with the same or a different payload. */
  identity?: "new" | "duplicate" | "conflict";
  mode?: SignatureMode;
  /** Seconds of tolerated clock difference on ServerDateTime; 0 = do not check. */
  replayWindowS?: number;
  nowMs?: number;
}

const ZERO_STATS = {
  received: 0, accepted: 0, sig_valid: 0, sig_unsigned: 0, sig_invalid: 0, duplicates: 0, seq_gaps: 0,
  tampered: 0, stale: 0, rate_limited: 0, malformed: 0, forbidden_source: 0,
};

/** Decides whether an incoming event should be processed, and keeps counters. */
export class Intake {
  /**
   * Ids seen since startup. A fast path only: the durable check is
   * `store.eventIdentity()`, which also survives a restart and can tell a replayed
   * payload apart from a rewritten one. Bounded so a long run cannot grow it forever.
   */
  private readonly seenIds = new Set<string>();
  lastSeq: number | null = null;
  readonly stats = { ...ZERO_STATS };

  constructor(private readonly mode: SignatureMode, private readonly cacheSize = 5000) {}

  /** Deliveries refused before they could be classified (rate limit, bad JSON, wrong source). */
  countRefused(rejection: Extract<DeliveryRejection, "rate_limited" | "malformed" | "forbidden_source">): void {
    this.stats.received++;
    this.stats[rejection]++;
  }

  check(event: SimEventBase, input: IntakeInput = {}): IntakeResult {
    const mode = input.mode ?? this.mode;
    this.stats.received++;
    const sig = signatureStatus(event);
    this.stats[`sig_${sig}`]++;

    const eventId = event.EventId ?? "";
    // Same id, different payload: somebody rewrote a delivery we already have on record.
    // Never acted on, whatever the signature says.
    const tampered = input.identity === "conflict";
    const duplicate = !tampered && (input.identity === "duplicate" || (eventId !== "" && this.seenIds.has(eventId)));
    if (tampered) this.stats.tampered++;
    if (duplicate) this.stats.duplicates++;

    let seqNote = "";
    const seq = /^\d+$/.test(String(event.SequenceId ?? "")) ? Number(event.SequenceId) : null;
    if (!duplicate && !tampered && seq !== null) {
      if (this.lastSeq !== null && seq !== this.lastSeq + 1) {
        seqNote = `expected ${this.lastSeq + 1}, got ${seq}`;
        this.stats.seq_gaps++;
      }
      if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq;
    }

    // Replay window last of the payload checks: a stale delivery that is also a duplicate
    // is better reported as the duplicate it is.
    const window = input.replayWindowS ?? 0;
    const skew = window > 0 ? clockSkewS(event.ServerDateTime, input.nowMs) : null;
    const stale = !tampered && !duplicate && skew !== null && skew > window;
    if (stale) this.stats.stale++;

    const rejection: DeliveryRejection | null =
      tampered ? "tampered"
        : duplicate ? "duplicate"
          : stale ? "stale"
            : !trusted(sig, mode) ? (sig === "unsigned" ? "unsigned" : "bad_signature")
              : null;

    const accept = rejection === null;
    if (accept) {
      if (eventId) this.remember(eventId);
      this.stats.accepted++;
    }
    return { accept, sig, duplicate, rejection, seqNote };
  }

  private remember(eventId: string) {
    if (this.cacheSize <= 0) return;
    if (this.seenIds.size >= this.cacheSize) {
      // Oldest first: Set preserves insertion order, and evicting one per insert keeps
      // the cache at its ceiling without a second data structure.
      const oldest = this.seenIds.values().next().value;
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
    this.seenIds.add(eventId);
  }
}
