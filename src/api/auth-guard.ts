import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService, User } from '../auth/service.js';

export async function currentUser(request: FastifyRequest, reply: FastifyReply, auth: AuthService, allowPasswordChange = false): Promise<User | null> {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const user = await auth.authenticate(token);
  if (!user) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  if (user.mustChangePassword && !allowPasswordChange) {
    reply.code(403).send({ error: 'password-change-required' });
    return null;
  }
  return user;
}

export async function adminUser(request: FastifyRequest, reply: FastifyReply, auth: AuthService): Promise<User | null> {
  const user = await currentUser(request, reply, auth);
  if (user && user.role !== 'admin') {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return user;
}
