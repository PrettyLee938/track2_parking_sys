const crypto = require('node:crypto');

function equal(value, expected) {
  const left = Buffer.from(String(value));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authenticate(request, config) {
  const header = request.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }

  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  if (equal(username, config.adminUsername) && equal(password, config.adminPassword)) {
    return { username, role: 'admin' };
  }
  if (equal(username, config.operatorUsername) && equal(password, config.operatorPassword)) {
    return { username, role: 'operator' };
  }
  return null;
}

module.exports = { authenticate };
