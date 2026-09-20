/**
 * Webhook intake: parsing, signature check, dedupe and sequence tracking.
 * Kept separate from the controller so it can be unit-tested with plain objects.
 */
import { createHash } from "node:crypto";
import type { SimEventBase } from "@gpa/shared";

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

/** A stable hash independent of JSON whitespace or object-key order. */
export function payloadHash(payload: unknown): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  };
  return createHash("sha256").update(stable(payload), "utf8").digest("hex");
}

/** Level 1 sends Signature=null on every event. */
export function signatureStatus(payload: Record<string, unknown>): SigStatus {
  const received = payload.Signature;
  if (!received) return "unsigned";
  return computeSignature(payload) === String(received).toLowerCase() ? "valid" : "invalid";
}

export interface IntakeResult {
  accept: boolean;
  sig: SigStatus;
  duplicate: boolean;
  conflict: boolean;
  seqNote: string;
}

export interface SignatureAssessment {
  sig: SigStatus;
  trusted: boolean;
}

export interface PersistedIntakeOutcome {
  accept: boolean;
  duplicate: boolean;
  conflict: boolean;
  seqNote: string;
  lastSeq: number | null;
}

/** Decides whether an incoming event should be processed, and keeps counters. */
export class Intake {
  private readonly seenIds = new Map<string, string>();
  lastSeq: number | null = null;
  readonly stats = { received: 0, accepted: 0, sig_valid: 0, sig_unsigned: 0, sig_invalid: 0, duplicates: 0, seq_gaps: 0 };

  constructor(private readonly requireSignature: boolean) {}

  assess(event: SimEventBase): SignatureAssessment {
    const sig = signatureStatus(event);
    const trusted = sig === "valid" || (sig === "unsigned" && !this.requireSignature);
    return { sig, trusted };
  }

  /** Update process-local counters only after the delivery transaction commits. */
  recordPersisted(sig: SigStatus, outcome: PersistedIntakeOutcome): void {
    this.stats.received++;
    this.stats[`sig_${sig}`]++;
    if (outcome.accept) this.stats.accepted++;
    if (outcome.duplicate) this.stats.duplicates++;
    if (outcome.seqNote) this.stats.seq_gaps++;
    this.lastSeq = outcome.lastSeq;
  }

  recordMalformed(): void {
    this.stats.received++;
  }

  restoreSequence(lastSeq: number | null): void {
    this.lastSeq = lastSeq;
  }

  /**
   * In-memory helper retained for focused unit tests. The HTTP path uses the
   * SQLite-backed transaction so accepted IDs and sequence state survive restart.
   */
  check(event: SimEventBase): IntakeResult {
    this.stats.received++;
    const { sig, trusted } = this.assess(event);
    this.stats[`sig_${sig}`]++;

    const eventId = event.EventId ?? "";
    const hash = payloadHash(event);
    const priorHash = eventId ? this.seenIds.get(eventId) : undefined;
    const duplicate = trusted && priorHash === hash;
    const conflict = trusted && priorHash !== undefined && priorHash !== hash;
    if (duplicate) this.stats.duplicates++;

    let seqNote = "";
    const seq = /^\d+$/.test(String(event.SequenceId ?? "")) ? Number(event.SequenceId) : null;
    if (trusted && !duplicate && !conflict && seq !== null) {
      if (this.lastSeq !== null && seq !== this.lastSeq + 1) {
        seqNote = `expected ${this.lastSeq + 1}, got ${seq}`;
        this.stats.seq_gaps++;
      }
      if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq;
    }

    const accept = trusted && !duplicate && !conflict;
    if (accept && eventId) {
      this.seenIds.set(eventId, hash);
    }
    if (accept) {
      this.stats.accepted++;
    }
    return { accept, sig, duplicate, conflict, seqNote };
  }
}
