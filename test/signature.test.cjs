const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalWebhookString,
  computeWebhookSignature,
  verifyWebhookSignature,
} = require('../src/signature.cjs');

const documentedPayload = {
  EventClass: 'car_spot_action',
  CarPlateNumber: 'WAW 228',
  SpotName: 'ENTRY1',
  SpotType: 'EntrySpot',
  Direction: 'CarOut',
  PlannedParkingDurationInMinutes: '0',
  EventId: 'efa2d3ac-1a6e-47d4-9099-3457270e30ee',
  SequenceId: 405,
  ServerDateTime: '2026-09-12 14:25:50',
  RealDateTime: '2026-09-12 14:51:37',
};

test('matches the signature algorithm and example from the simulator documentation', () => {
  assert.equal(
    canonicalWebhookString(documentedPayload),
    'WAW 228|CarOut|car_spot_action|efa2d3ac-1a6e-47d4-9099-3457270e30ee|0|2026-09-12 14:51:37|405|2026-09-12 14:25:50|ENTRY1|EntrySpot',
  );
  assert.equal(computeWebhookSignature(documentedPayload), '80beadedc24aea52b9c6222aba1815d3');
});

test('accepts missing signatures only when strict mode is disabled', () => {
  assert.equal(verifyWebhookSignature(documentedPayload, false).accepted, true);
  assert.equal(verifyWebhookSignature(documentedPayload, true).accepted, false);
  const signed = { ...documentedPayload, Signature: computeWebhookSignature(documentedPayload) };
  assert.deepEqual(
    { accepted: verifyWebhookSignature(signed, true).accepted, status: verifyWebhookSignature(signed, true).status },
    { accepted: true, status: 'valid' },
  );
});
