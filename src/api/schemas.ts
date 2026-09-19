const string = { type: 'string', minLength: 1 };
const boolean = { type: 'boolean' };
const integer = { type: 'integer', minimum: 0 };

export const idParams = { params: { type: 'object', required: ['id'], properties: { id: string }, additionalProperties: false } };
export const login = { body: { type: 'object', required: ['username', 'password'], properties: { username: string, password: string }, additionalProperties: false } };
export const password = { body: { type: 'object', required: ['password'], properties: { password: string }, additionalProperties: false } };
export const user = { body: { type: 'object', required: ['username', 'password', 'role'], properties: { username: string, password: string, role: { type: 'string', enum: ['operator'] } }, additionalProperties: false } };
export const active = { ...idParams, body: { type: 'object', required: ['active'], properties: { active: boolean }, additionalProperties: false } };
export const arrival = { body: { type: 'object', required: ['plate', 'type', 'accessible', 'needsCharging'], properties: { plate: string, type: { type: 'string', enum: ['normal', 'electric'] }, accessible: boolean, needsCharging: boolean }, additionalProperties: false } };
export const invoice = { ...idParams, body: { type: 'object', required: ['durationMinutes', 'parkingRateCentsPerHour', 'electricityKwh', 'electricityRateCentsPerKwh'], properties: { durationMinutes: integer, parkingRateCentsPerHour: integer, electricityKwh: { type: 'number', minimum: 0 }, electricityRateCentsPerKwh: integer }, additionalProperties: false } };
export const payment = { ...idParams, body: { type: 'object', required: ['amountCents'], properties: { amountCents: integer, paymentId: string }, additionalProperties: false } };
export const override = { ...idParams, body: { type: 'object', required: ['password', 'reason'], properties: { password: string, reason: string }, additionalProperties: false } };
export const equipment = { ...idParams, body: { type: 'object', required: ['enabled'], properties: { enabled: boolean }, additionalProperties: false } };
export const gate = { ...idParams, body: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['open', 'close'] } }, additionalProperties: false } };
export const correction = { ...idParams, body: { type: 'object', minProperties: 1, additionalProperties: true } };
