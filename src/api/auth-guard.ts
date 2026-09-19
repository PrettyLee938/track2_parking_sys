import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService, User } from '../auth/service.js';

const cookie = (header: string | undefined, name: string) => header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
export const requestToken = (request: FastifyRequest) => request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : cookie(request.headers.cookie, 'session');

export async function currentUser(request: FastifyRequest, reply: FastifyReply, auth: AuthService, allowPasswordChange = false): Promise<User | null> {
  const header = request.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = requestToken(request);
  if (!bearer && token && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const csrf = cookie(request.headers.cookie, 'csrf');
    if (!csrf || request.headers['x-csrf-token'] !== csrf) { reply.code(403).send({ error: 'csrf-required' }); return null; }
  }
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
