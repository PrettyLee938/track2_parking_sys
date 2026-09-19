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
export type SignatureMode = "strict" | "lenient" | "monitor";

/** Level 1 sends Signature=null on every event. */
export function signatureStatus(payload: Record<string, unknown>): SigStatus {
  const received = payload.Signature;
  if (received === null || received === undefined) return "unsigned";
  if (typeof received !== "string" || received.length === 0) return "invalid";
  return computeSignature(payload) === String(received).toLowerCase() ? "valid" : "invalid";
}

/** Whether an event with this signature status may be acted on (see config.ts). */
export function trusted(sig: SigStatus, mode: SignatureMode): boolean {
  if (mode === "monitor") return true;
  if (mode === "lenient") return sig !== "invalid";
  return sig === "valid";
}

export interface IntakeResult {
  accept: boolean;
  sig: SigStatus;
  duplicate: boolean;
  seqNote: string;
}

/** Decides whether an incoming event should be processed, and keeps counters. */
export class Intake {
  private readonly seenIds = new Set<string>();
  lastSeq: number | null = null;
  readonly stats = { received: 0, accepted: 0, sig_valid: 0, sig_unsigned: 0, sig_invalid: 0, duplicates: 0, seq_gaps: 0 };

  constructor(private mode: SignatureMode) {}

  setMode(mode: SignatureMode): void { this.mode = mode; }
  get currentMode(): SignatureMode { return this.mode; }

  check(event: SimEventBase, durableDuplicate = false, mode = this.mode): IntakeResult {
    this.stats.received++;
    const sig = signatureStatus(event);
    this.stats[`sig_${sig}`]++;

    const eventId = event.EventId ?? "";
    const duplicate = durableDuplicate || (eventId !== "" && this.seenIds.has(eventId));
    if (duplicate) this.stats.duplicates++;

    let seqNote = "";
    const seq = /^\d+$/.test(String(event.SequenceId ?? "")) ? Number(event.SequenceId) : null;
    // Invalid/unsigned Level 2 deliveries must not advance liveness or sequence state.
    // A duplicate is recorded, but it is not a new sequence observation.
    const trustedForSequence = trusted(sig, mode) && !duplicate;
    if (trustedForSequence && seq !== null) {
      if (this.lastSeq !== null && seq !== this.lastSeq + 1) {
        seqNote = `expected ${this.lastSeq + 1}, got ${seq}`;
        this.stats.seq_gaps++;
      }
      if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq;
    }

    const accept = trusted(sig, mode) && !duplicate;
    if (accept) {
      if (eventId) this.seenIds.add(eventId);
      this.stats.accepted++;
    }
    return { accept, sig, duplicate, seqNote };
  }
}
