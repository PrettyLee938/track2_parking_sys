import type Database from "better-sqlite3";
import type { Role, UserView } from "@gpa/shared";

export interface UserRow extends UserView { password_hash: string }

const toUser = (row: Record<string, unknown>): UserView => ({
  id: row.id as number, username: row.username as string, role: row.role as Role, disabled: !!row.disabled,
  created_at: row.created_at as string, last_login_at: (row.last_login_at as string | null) ?? null,
});

export function countUsers(db: Database.Database): number {
  return (db.prepare("SELECT count(*) n FROM users").get() as { n: number }).n;
}

export function listUsers(db: Database.Database): UserView[] {
  return (db.prepare("SELECT * FROM users ORDER BY id").all() as Record<string, unknown>[]).map(toUser);
}

export function findUser(db: Database.Database, username: string): UserRow | undefined {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as Record<string, unknown> | undefined;
  return row ? { ...toUser(row), password_hash: row.password_hash as string } : undefined;
}

export function getUser(db: Database.Database, id: number): UserView | undefined {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? toUser(row) : undefined;
}

export function createUser(db: Database.Database, username: string, passwordHash: string, role: Role): UserView {
  const info = db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
    .run(username, passwordHash, role, new Date().toISOString());
  return getUser(db, Number(info.lastInsertRowid))!;
}

export function updateUser(db: Database.Database, id: number, changes: { role?: Role; disabled?: boolean; passwordHash?: string }): UserView | undefined {
  if (changes.role !== undefined) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(changes.role, id);
  if (changes.disabled !== undefined) db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(changes.disabled ? 1 : 0, id);
  if (changes.passwordHash !== undefined) db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(changes.passwordHash, id);
  return getUser(db, id);
}

export const countOtherActiveAdmins = (db: Database.Database, excludeId: number) =>
  (db.prepare("SELECT count(*) n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(excludeId) as { n: number }).n;

export function touchLogin(db: Database.Database, id: number): void {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

export function createAuthSession(db: Database.Database, tokenHash: string, userId: number, expiresMs: number): void {
  db.prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_ms) VALUES (?, ?, ?, ?)")
    .run(tokenHash, userId, new Date().toISOString(), expiresMs);
}

export function userForSession(db: Database.Database, tokenHash: string, nowMs: number): UserView | undefined {
  const row = db.prepare(`SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_ms > ? AND u.disabled = 0`).get(tokenHash, nowMs) as Record<string, unknown> | undefined;
  return row ? toUser(row) : undefined;
}

export const deleteAuthSession = (db: Database.Database, tokenHash: string) => {
  db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
};
export const deleteAuthSessionsForUser = (db: Database.Database, userId: number) => {
  db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
};
export const purgeExpiredAuthSessions = (db: Database.Database, nowMs: number) => {
  db.prepare("DELETE FROM auth_sessions WHERE expires_ms <= ?").run(nowMs);
};
