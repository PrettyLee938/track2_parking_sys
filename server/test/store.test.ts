import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store";

describe("store migrations", () => {
  it("migrates the legacy users role check without losing accounts or foreign keys", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gpa-role-"));
    let store: Store | undefined;
    try {
      const db = new Database(path.join(dir, "gpa.db"));
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
          disabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          last_login_at TEXT
        );
        CREATE TABLE auth_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          expires_ms INTEGER NOT NULL
        );
        INSERT INTO users (id, username, password_hash, role, created_at)
          VALUES (1, 'legacy', 'hash', 'operator', '2026-01-01T00:00:00.000Z');
      `);
      db.close();

      store = new Store(dir);
      expect(store.findUser("legacy")?.role).toBe("operator");
      expect(store.createUser("maint", "hash", "maintenance").role).toBe("maintenance");
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store?.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("promotes a rejected retry but ignores a second accepted payment", () => {
    const store = new Store(":memory:");
    store.createInvoice({ invoiceId: "invoice:A", visitId: "visit:A", plate: "A", parkingAmount: 2, electricAmount: 0, basis: "test" });
    expect(store.recordPayment({ eventId: "fake", invoiceId: "invoice:A", visitId: "visit:A", plate: "A", amount: 2, accepted: false })).toBe("inserted");
    expect(store.recordPayment({ eventId: "real", invoiceId: "invoice:A", visitId: "visit:A", plate: "A", amount: 2, accepted: true })).toBe("inserted");
    expect(store.recordPayment({ eventId: "real-again", invoiceId: "invoice:A", visitId: "visit:A", plate: "A", amount: 2, accepted: true })).toBe("duplicate");
    expect(store.db.prepare("SELECT accepted FROM payments WHERE invoice_id = ?").get("invoice:A")).toEqual({ accepted: 1 });
    store.db.close();
  });
});