import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { adminUser, currentUser, requestToken } from './auth-guard.js';
import type { AuditService } from '../services/audit.js';
import * as schema from './schemas.js';

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService, audit: AuditService) {
  app.post('/api/v1/auth/login', { schema: schema.login }, async (request, reply) => {
    try {
      const body = request.body as { username?: string; password?: string };
      const result = await auth.login(body.username || '', body.password || '');
      audit.record('login', 'user', result.user.id, {}, result.user.id);
      reply.header('set-cookie', [`session=${result.token}; HttpOnly; SameSite=Strict; Path=/`, `csrf=${result.csrfToken}; SameSite=Strict; Path=/`]);
      return { user: result.user };
    } catch (error) {
      return reply.code(401).send({ error: error instanceof Error ? error.message : 'invalid-credentials' });
    }
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const user = await currentUser(request, reply, auth, true); if (!user) return;
    const token = requestToken(request) || '';
    await auth.logout(token); audit.record('logout', 'user', user.id, {}, user.id); reply.header('set-cookie', ['session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/', 'csrf=; Max-Age=0; SameSite=Strict; Path=/']); return { ok: true };
  });

  app.post('/api/v1/auth/change-password', { schema: schema.password }, async (request, reply) => {
    const user = await currentUser(request, reply, auth, true); if (!user) return;
    const body = request.body as { password?: string }; if (!body.password) return reply.code(400).send({ error: 'password-required' });
    await auth.changePassword(user, body.password); audit.record('password-changed', 'user', user.id, {}, user.id); return { ok: true };
  });

  app.get('/api/v1/me', async (request, reply) => { const user = await currentUser(request, reply, auth, true); return user || undefined; });

  app.post('/api/v1/admin/users', { schema: schema.user }, async (request, reply) => {
    const actor = await adminUser(request, reply, auth); if (!actor) return;
    const body = request.body as { username?: string; password?: string; role?: 'admin' | 'operator' };
    if (!body.username || !body.password || !body.role) return reply.code(400).send({ error: 'username-password-role-required' });
    try { const created = await auth.createUser(actor, body.username, body.password, body.role); audit.record('user-created', 'user', created.id, { username: created.username, role: created.role }, actor.id); return created; } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'user-create-failed' }); }
  });

  app.patch('/api/v1/admin/users/:id', { schema: schema.active }, async (request, reply) => {
    const actor = await adminUser(request, reply, auth); if (!actor) return;
    const body = request.body as { active?: boolean }; const id = (request.params as { id: string }).id; await auth.setActive(actor, id, body.active !== false); audit.record('user-status-changed', 'user', id, { active: body.active !== false }, actor.id); return { ok: true };
  });
}
