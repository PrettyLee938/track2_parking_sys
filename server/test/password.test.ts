import { describe, expect, it } from "vitest";
import { hashPassword, hasRole, verifyPassword } from "../src/auth";

describe("passwords", () => {
  it("hashes with a per-password salt and verifies", async () => {
    const a = await hashPassword("correct horse"), b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("wrong horse", a)).toBe(false);
  });
  it("ranks admin above operator", () => {
    const u = (role: "admin" | "operator", disabled = false) => ({ id: 1, username: "u", role, disabled, created_at: "", last_login_at: null });
    expect(hasRole(u("admin"), "operator")).toBe(true);
    expect(hasRole(u("operator"), "admin")).toBe(false);
    expect(hasRole(u("admin", true), "operator")).toBe(false);
  });
});
