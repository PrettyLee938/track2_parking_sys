const crypto = require('node:crypto');

function canonicalWebhookValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function canonicalWebhookString(payload) {
  return Object.keys(payload)
    .filter((key) => key !== 'Signature')
    .sort((left, right) => left.localeCompare(right))
    .map((key) => canonicalWebhookValue(payload[key]))
    .join('|');
}

function computeWebhookSignature(payload) {
  return crypto.createHash('md5').update(canonicalWebhookString(payload), 'utf8').digest('hex');
}

function verifyWebhookSignature(payload, requireSignature = false) {
  const received = payload?.Signature;
  if (!received) {
    return { accepted: !requireSignature, status: 'missing', expected: computeWebhookSignature(payload) };
  }

  const expected = computeWebhookSignature(payload);
  const receivedBuffer = Buffer.from(String(received).toLowerCase());
  const expectedBuffer = Buffer.from(expected);
  const accepted = receivedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
  return { accepted, status: accepted ? 'valid' : 'invalid', expected };
}

module.exports = {
  canonicalWebhookString,
  computeWebhookSignature,
  verifyWebhookSignature,
};
