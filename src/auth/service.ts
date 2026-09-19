import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Role } from '../domain/types.js';
import type { Database } from '../db/database.js';
import { hashPassword, verifyPassword } from './passwords.js';

export interface User {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  active: boolean;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const userFromRow = (row: Record<string, unknown>): User => ({
  id: String(row.id), username: String(row.username), role: row.role as Role,
  mustChangePassword: Boolean(row.must_change_password), active: Boolean(row.active)
});

export class AuthService {
  constructor(private readonly db: Database, private readonly idleMs: number, private readonly clock = () => Date.now()) {}

  async seedAdmin(username?: string, password?: string) {
    if (!username || !password || this.db.get('SELECT id FROM users WHERE role = :role', { ':role': 'admin' })) return false;
    this.db.run('INSERT INTO users (id, username, role, password_hash, created_at) VALUES (:id, :username, :role, :hash, :created)', {
      ':id': randomUUID(), ':username': username, ':role': 'admin', ':hash': hashPassword(password), ':created': new Date(this.clock()).toISOString()
    });
    return true;
  }

  hasAdmin() { return Boolean(this.db.get('SELECT id FROM users WHERE role = :role AND active = 1', { ':role': 'admin' })); }

  verifyPassword(user: User, password: string) {
    const row = this.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = :id AND active = 1', { ':id': user.id });
    return Boolean(row && verifyPassword(password, row.password_hash));
  }

  async login(username: string, password: string) {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM users WHERE username = :username AND active = 1', { ':username': username });
    if (!row || !verifyPassword(password, String(row.password_hash))) throw new Error('invalid-credentials');
    const token = randomBytes(32).toString('base64url');
    const now = new Date(this.clock()).toISOString();
    this.db.run('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (:token, :user, :created, :seen)', { ':token': tokenHash(token), ':user': row.id, ':created': now, ':seen': now });
    return { token, csrfToken: randomBytes(24).toString('base64url'), user: userFromRow(row) };
  }

  async authenticate(token: string | undefined): Promise<User | null> {
    if (!token) return null;
    const row = this.db.get<Record<string, unknown>>('SELECT u.*, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = :token AND u.active = 1', { ':token': tokenHash(token) });
    if (!row) return null;
    if (this.clock() - Date.parse(String(row.last_seen_at)) > this.idleMs) { await this.logout(token); return null; }
    this.db.run('UPDATE sessions SET last_seen_at = :seen WHERE token_hash = :token', { ':seen': new Date(this.clock()).toISOString(), ':token': tokenHash(token) });
    return userFromRow(row);
  }

  async logout(token: string) { this.db.run('DELETE FROM sessions WHERE token_hash = :token', { ':token': tokenHash(token) }); }

  async changePassword(user: User, password: string) {
    this.db.run('UPDATE users SET password_hash = :hash, must_change_password = 0 WHERE id = :id', { ':hash': hashPassword(password), ':id': user.id });
  }

  async reauthenticate(user: User, password: string) {
    if (!this.verifyPassword(user, password)) throw new Error('invalid-credentials');
    return true;
  }

  async createUser(actor: User, username: string, password: string, role: Role): Promise<User> {
    if (actor.role !== 'admin') throw new Error('forbidden');
    if (role !== 'operator') throw new Error('invalid-role');
    const id = randomUUID();
    this.db.run('INSERT INTO users (id, username, role, password_hash, created_at) VALUES (:id, :username, :role, :hash, :created)', { ':id': id, ':username': username, ':role': role, ':hash': hashPassword(password), ':created': new Date(this.clock()).toISOString() });
    return { id, username, role, mustChangePassword: true, active: true };
  }

  async setActive(actor: User, id: string, active: boolean) {
    if (actor.role !== 'admin') throw new Error('forbidden');
    this.db.run('UPDATE users SET active = :active WHERE id = :id', { ':active': active ? 1 : 0, ':id': id });
  }

  invalidateAll() { this.db.run('DELETE FROM sessions'); }
}
