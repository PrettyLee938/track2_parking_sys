import { describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { Database } from '../src/db/database.js';

describe('application authentication', () => {
  it('seeds an Admin, authenticates a session, and invalidates it on logout', async () => {
    const auth = new AuthService(new Database(':memory:'), 30_000);
    await auth.seedAdmin('admin', 'first-secret');
    const login = await auth.login('admin', 'first-secret');
    expect(login.user.role).toBe('admin');
    expect((await auth.authenticate(login.token))?.username).toBe('admin');
    await auth.logout(login.token);
    expect(await auth.authenticate(login.token)).toBeNull();
  });

  it('expires idle sessions and prevents an Operator from creating users', async () => {
    let now = 1_000;
    const auth = new AuthService(new Database(':memory:'), 100, () => now);
    await auth.seedAdmin('admin', 'secret');
    const admin = await auth.login('admin', 'secret');
    const operator = await auth.createUser(admin.user, 'operator', 'op-secret', 'operator');
    expect(operator.role).toBe('operator');
    await expect(auth.createUser(operator, 'blocked', 'secret', 'operator')).rejects.toThrow('forbidden');
    now += 101;
    expect(await auth.authenticate(admin.token)).toBeNull();
  });
});
