/**
 * Webhook intake: parsing, signature check, dedupe and sequence tracking.
 * Kept separate from the controller so it can be unit-tested with plain objects.
 *
 * Level 2 requires that only signed calls are acted on, and that unsigned ones are
 * still logged. Two safeguards make turning that on survivable on a live run:
 *
 *   - a *grace* budget: while no valid signature has been seen yet, a few failing
 *     events are still processed (and loudly flagged), so a wrong guess about the
 *     signing scheme does not silently drop every event of the run. The budget ends
 *     the instant one signature verifies - from then on a failure is a real failure.
 *   - an *autodetect* sweep: when the active scheme fails, every known variant is
 *     tried against the received digest. If one matches, it is adopted and logged.
 *
 * Note these digests are keyless MD5 over the payload: they prove integrity, not
 * origin, unless GPA_WEBHOOK_SECRET is set (then the secret is folded into the hash).
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

// ---------------------------------------------------------------------------
// signing schemes
// ---------------------------------------------------------------------------
type Payload = Record<string, unknown>;

const fields = (p: Payload) => Object.keys(p).filter((k) => k !== "Signature");
const sorted = (p: Payload) => fields(p).sort();
const values = (p: Payload, keys: string[]) => keys.map((k) => String(p[k]));
const pairs = (p: Payload, keys: string[]) => keys.map((k) => `${k}=${String(p[k])}`);

/** The exact string a scheme hashes. Named so a mismatch can be eyeballed. */
export interface SigVariant {
  id: string;
  basis(payload: Payload): string;
}

/** The scheme in the simulator's webhook documentation, verified by unit test. */
export const DEFAULT_VARIANT = "sorted-values-pipe";

export const SIG_VARIANTS: SigVariant[] = [
  { id: DEFAULT_VARIANT, basis: (p) => values(p, sorted(p)).join("|") },
  { id: "sorted-values-none", basis: (p) => values(p, sorted(p)).join("") },
  { id: "sorted-values-comma", basis: (p) => values(p, sorted(p)).join(",") },
  { id: "sorted-pairs-pipe", basis: (p) => pairs(p, sorted(p)).join("|") },
  { id: "sorted-pairs-amp", basis: (p) => pairs(p, sorted(p)).join("&") },
  { id: "order-values-pipe", basis: (p) => values(p, fields(p)).join("|") },
  { id: "order-values-none", basis: (p) => values(p, fields(p)).join("") },
  { id: "order-pairs-amp", basis: (p) => pairs(p, fields(p)).join("&") },
  {
    id: "json-minus-sig",
    basis: (p) => JSON.stringify(Object.fromEntries(fields(p).map((k) => [k, p[k]]))),
  },
];

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

function variant(id: string): SigVariant {
  return SIG_VARIANTS.find((v) => v.id === id) ?? SIG_VARIANTS[0];
}

/** How a shared secret is folded in, when one is configured. */
const SECRET_FORMS: Array<{ suffix: string; apply(basis: string, secret: string): string }> = [
  { suffix: "+secret-suffix", apply: (b, s) => b + s },
  { suffix: "+secret-prefix", apply: (b, s) => s + b },
  { suffix: "+secret-pipe-suffix", apply: (b, s) => `${b}|${s}` },
  { suffix: "+secret-pipe-prefix", apply: (b, s) => `${s}|${b}` },
];

/** Every (scheme, secret-form) pair worth trying, as id -> hashed string. */
export function allBases(payload: Payload, secret?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of SIG_VARIANTS) {
    const basis = v.basis(payload);
    out.set(v.id, basis);
    if (secret) for (const f of SECRET_FORMS) out.set(v.id + f.suffix, f.apply(basis, secret));
  }
  return out;
}

/** The string a scheme id hashes, including any secret form in the id. */
export function basisFor(payload: Payload, schemeId: string, secret?: string): string {
  const form = SECRET_FORMS.find((f) => schemeId.endsWith(f.suffix));
  const base = variant(form ? schemeId.slice(0, -form.suffix.length) : schemeId).basis(payload);
  return form && secret ? form.apply(base, secret) : base;
}

/** MD5 over the values of every field except Signature, ordered by field name. */
export function computeSignature(payload: Payload, schemeId = DEFAULT_VARIANT, secret?: string): string {
  return md5(basisFor(payload, schemeId, secret));
}

export type SigStatus = "valid" | "unsigned" | "invalid";

/** Level 1 sends Signature=null on every event. */
export function signatureStatus(payload: Payload, schemeId = DEFAULT_VARIANT, secret?: string): SigStatus {
  const received = payload.Signature;
  if (!received) return "unsigned";
  return computeSignature(payload, schemeId, secret) === String(received).toLowerCase() ? "valid" : "invalid";
}

/** Which schemes (if any) reproduce the digest the simulator sent. */
export function matchingSchemes(payload: Payload, secret?: string): string[] {
  const received = String(payload.Signature ?? "").toLowerCase();
  if (!received) return [];
  return [...allBases(payload, secret)].filter(([, basis]) => md5(basis) === received).map(([id]) => id);
}

// ---------------------------------------------------------------------------
// intake
// ---------------------------------------------------------------------------
/** A failing event kept for diagnosis, shown by GET /debug/signature. */
export interface SigSample {
  at: string;
  event_class: string;
  event_id: string;
  status: SigStatus;
  received: string | null;
  computed: string;
  /** The exact text hashed under the active scheme - compare it with the payload. */
  basis: string;
  /** Scheme ids that would have matched. Empty means none of them did. */
  matches: string[];
}

export interface IntakeResult {
  accept: boolean;
  sig: SigStatus;
  duplicate: boolean;
  seqNote: string;
  /** Accepted despite a failing signature, because grace was still available. */
  graced: boolean;
  /** Human-readable reason to log, when something noteworthy happened. */
  note: string;
}

export interface IntakeOptions {
  requireSignature: boolean;
  /** Failing events to process anyway before any signature has ever verified. */
  graceN?: number;
  /** Try the other known schemes when the active one fails. */
  autodetect?: boolean;
  /** Shared secret folded into the hash, if the simulator uses one. */
  secret?: string;
}

const MAX_SAMPLES = 5;

/** Decides whether an incoming event should be processed, and keeps counters. */
export class Intake {
  private readonly seenIds = new Set<string>();
  private readonly requireSignature: boolean;
  private readonly autodetect: boolean;
  private readonly secret?: string;
  lastSeq: number | null = null;
  /** The scheme in use; changes if autodetect finds a better one. */
  scheme = DEFAULT_VARIANT;
  /** Once a signature verifies, the scheme is known good and grace is over. */
  sawValid = false;
  graceLeft: number;
  readonly samples: SigSample[] = [];
  readonly stats = {
    received: 0, accepted: 0, sig_valid: 0, sig_unsigned: 0, sig_invalid: 0,
    sig_graced: 0, sig_autodetected: 0, duplicates: 0, seq_gaps: 0,
  };

  constructor(options: IntakeOptions | boolean) {
    const o: IntakeOptions = typeof options === "boolean" ? { requireSignature: options } : options;
    this.requireSignature = o.requireSignature;
    this.autodetect = o.autodetect ?? true;
    this.secret = o.secret || undefined;
    this.graceLeft = o.graceN ?? 0;
  }

  check(event: SimEventBase): IntakeResult {
    this.stats.received++;
    let note = "";
    let sig = signatureStatus(event, this.scheme, this.secret);

    // A wrong guess about the scheme looks exactly like a tampered event. Before
    // trusting that verdict, try the alternatives - but only until one scheme is
    // known to work, after which an invalid signature means what it says.
    if (sig === "invalid" && this.autodetect && !this.sawValid) {
      const [found] = matchingSchemes(event, this.secret);
      if (found) {
        this.scheme = found;
        this.stats.sig_autodetected++;
        sig = "valid";
        note = `signature scheme switched to '${found}'`;
      }
    }

    if (sig === "valid") this.sawValid = true;
    this.stats[`sig_${sig}`]++;
    if (sig !== "valid") this.recordSample(event, sig);

    const eventId = event.EventId ?? "";
    const duplicate = eventId !== "" && this.seenIds.has(eventId);
    if (duplicate) this.stats.duplicates++;

    let seqNote = "";
    const seq = /^\d+$/.test(String(event.SequenceId ?? "")) ? Number(event.SequenceId) : null;
    if (!duplicate && seq !== null) {
      if (this.lastSeq !== null && seq !== this.lastSeq + 1) {
        seqNote = `expected ${this.lastSeq + 1}, got ${seq}`;
        this.stats.seq_gaps++;
      }
      if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq;
    }

    let trusted = sig === "valid" || (sig === "unsigned" && !this.requireSignature);

    // Grace: spend the budget rather than drop the event, so a misconfigured
    // signature check cannot take the whole run down before anyone notices.
    let graced = false;
    if (!trusted && !this.sawValid && this.graceLeft > 0) {
      this.graceLeft--;
      this.stats.sig_graced++;
      graced = true;
      trusted = true;
      note = `signature ${sig} - accepted under grace, ${this.graceLeft} left (check GET /debug/signature)`;
    }

    const accept = trusted && !duplicate;
    if (accept) {
      if (eventId) this.seenIds.add(eventId);
      this.stats.accepted++;
    }
    return { accept, sig, duplicate, seqNote, graced, note };
  }

  private recordSample(event: SimEventBase, status: SigStatus): void {
    if (this.samples.length >= MAX_SAMPLES) return;
    const basis = basisFor(event, this.scheme, this.secret);
    this.samples.push({
      at: new Date().toISOString(),
      event_class: String(event.EventClass ?? ""),
      event_id: String(event.EventId ?? ""),
      status,
      received: event.Signature ? String(event.Signature) : null,
      computed: md5(basis),
      basis: basis.length > 500 ? `${basis.slice(0, 500)}…` : basis,
      matches: status === "invalid" ? matchingSchemes(event, this.secret) : [],
    });
  }

  /** Everything GET /debug/signature reports. */
  diagnosis() {
    return {
      scheme: this.scheme,
      require_signature: this.requireSignature,
      autodetect: this.autodetect,
      secret_configured: !!this.secret,
      saw_valid: this.sawValid,
      grace_left: this.graceLeft,
      known_schemes: SIG_VARIANTS.map((v) => v.id),
      stats: this.stats,
      samples: this.samples,
    };
  }
}
