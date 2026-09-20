/**
 * Dashboard authentication: accounts with a role, and cookie-based login sessions.
 *
 * - Passwords are hashed with scrypt (node:crypto), each with its own random salt.
 * - A login creates a random 256-bit token; the browser keeps it in an HttpOnly,
 *   SameSite=Strict cookie and the database keeps only its SHA-256 hash.
 * - Repeated failed logins for a username are throttled.
 * - Admin is the dashboard superuser; Maintenance and Operator are separate capabilities.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { Role, UserView } from "@gpa/shared";
import type { Settings } from "./config";
import type { Store } from "./store";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

/** "scrypt$N$r$p$salt$hash" (base64url parts) - parameters travel with the hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(key, expected);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Role check: admin satisfies every requirement. */
export function hasRole(user: UserView | null | undefined, required: Role): boolean {
  if (!user || user.disabled) return false;
  return user.role === "admin" || user.role === required;
}

export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
export const MIN_PASSWORD_LENGTH = 8;

export function validateCredentials(username: string | undefined, password: string | undefined): string | null {
  if (username !== undefined && !USERNAME_PATTERN.test(username)) return "username must be 3-32 letters, digits, _ . or -";
  if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

export type LoginContext = { sourceIp?: string; userAgent?: string };
export type LoginResult =
  | { ok: true; token: string; user: UserView; previousAttempts: ReturnType<Store["recentLoginAttemptsForUser"]>; attemptId: number }
  | { ok: false; reason: "invalid" | "throttled"; retryAfterS?: number };

export class AuthService {
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly store: Store, private readonly cfg: Pick<Settings,
    "sessionTtlH" | "loginMaxFailures" | "loginLockoutS" | "adminUsername" | "adminPassword">) {}

  /**
   * First start: create the admin account. Its password comes from GPA_ADMIN_PASSWORD,
   * or is generated and returned so the caller can print it once.
   */
  async bootstrap(): Promise<{ username: string; generatedPassword?: string } | null> {
    if (this.store.countUsers() > 0) return null;
    const generated = this.cfg.adminPassword ? undefined : randomBytes(9).toString("base64url");
    const password = this.cfg.adminPassword ?? generated!;
    this.store.createUser(this.cfg.adminUsername, await hashPassword(password), "admin");
    return { username: this.cfg.adminUsername, generatedPassword: generated };
  }

  async login(username: string, password: string, context: LoginContext = {}): Promise<LoginResult> {
    const key = username.toLowerCase(), now = Date.now();
    const f = this.failures.get(key);
    const row = this.store.findUser(username);
    const source = { username, userId: row?.id ?? null, sourceIp: context.sourceIp ?? null, userAgent: context.userAgent ?? null };
    if (f && f.until > now) {
      this.store.recordLoginAttempt({ ...source, success: false, category: "throttled" });
      this.store.recordAudit({ actorId: row?.id ?? null, actorUsername: row?.username ?? null,
        action: "auth.login.failed", target: username, details: { category: "throttled", source_ip: context.sourceIp ?? null } });
      return { ok: false, reason: "throttled", retryAfterS: Math.ceil((f.until - now) / 1000) };
    }

    // Hash even when the user does not exist, so timing does not reveal valid usernames.
    const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok || row.disabled) {
      const count = (f?.count ?? 0) + 1;
      const locked = count >= this.cfg.loginMaxFailures;
      this.failures.set(key, { count: locked ? 0 : count, until: locked ? now + this.cfg.loginLockoutS * 1000 : 0 });
      const category = !row ? "unknown_user" : row.disabled ? "disabled_account" : "invalid_password";
      this.store.recordLoginAttempt({ ...source, success: false, category });
      this.store.recordAudit({ actorId: row?.id ?? null, actorUsername: row?.username ?? null,
        action: "auth.login.failed", target: username, details: { category, source_ip: context.sourceIp ?? null } });
      return { ok: false, reason: "invalid" };
    }
    this.failures.delete(key);
    const previousAttempts = this.store.recentLoginAttemptsForUser(row.id, 3);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    const attemptId = this.store.recordLoginAttempt({ ...source, success: true, category: "success" });
    this.store.createAuthSession(tokenHash, row.id, now + this.cfg.sessionTtlH * 3600_000);
    this.store.setAuthSessionLoginAttempt(tokenHash, attemptId);
    this.store.recordAudit({ actorId: row.id, actorUsername: row.username, action: "auth.login.success", details: { source_ip: context.sourceIp ?? null } });
    this.store.touchLogin(row.id);
    this.store.purgeExpiredAuthSessions(now);
    const { password_hash, ...user } = row;
    return { ok: true, token, user: { ...user, last_login_at: new Date().toISOString() }, previousAttempts, attemptId };
  }

  loginAttemptsForToken(token: string | undefined, limit = 3) {
    if (!token) return [];
    const tokenHash = sha256(token);
    const user = this.store.userForSession(tokenHash, Date.now());
    const attemptId = this.store.sessionLoginAttemptId(tokenHash, Date.now());
    if (!user || attemptId === null) return [];
    return this.store.previousLoginAttempts(user.id, attemptId, limit);
  }

  userForToken(token: string | undefined): UserView | null {
    if (!token) return null;
    return this.store.userForSession(sha256(token), Date.now()) ?? null;
  }

  logout(token: string | undefined): void {
    if (token) this.store.deleteAuthSession(sha256(token));
  }

  /** Sign a user out everywhere (after a password change, role change or disable). */
  revokeAll(userId: number): void {
    this.store.deleteAuthSessionsForUser(userId);
  }
}

// A valid hash of a random password: verifying against it costs the same as a real one.
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(43);
