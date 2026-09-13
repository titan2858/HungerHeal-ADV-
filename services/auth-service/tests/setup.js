// Test configuration must be set BEFORE any module that reads it is imported,
// because config/env.js validates process.env at import time. Hence every test
// file imports this first, then uses dynamic import() for the app.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI =
  process.env.TEST_MONGO_URI ||
  'mongodb://hungerheal:hungerheal_dev_pw@localhost:27018/?authSource=admin';
// A separate database from hh_auth so running tests never touches dev data.
process.env.MONGO_DB_NAME = 'hh_auth_test';
process.env.JWT_SECRET = 'test_secret_must_be_at_least_16_chars';
// 4 instead of 10: bcrypt is intentionally slow, and 12 hashes at production
// cost would add seconds to the suite for no extra confidence.
process.env.BCRYPT_ROUNDS = '4';
process.env.LOG_LEVEL = 'silent';

// These tests run against the real dockerized MongoDB rather than an in-memory
// stand-in. It is one less moving part, and it exercises the actual unique
// index and schema validation that production relies on.
export const donorPayload = (overrides = {}) => ({
  role: 'DONOR',
  name: 'Asha Donor',
  email: `donor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`,
  phone: '+91 9876543210',
  password: 'goodpass1',
  ...overrides,
});

export const agentPayload = (overrides = {}) => ({
  role: 'AGENT',
  name: 'Ravi Agent',
  email: `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`,
  phone: '+91 9876500000',
  password: 'goodpass1',
  capabilities: {
    vehicleType: 'MOTORCYCLE',
    hasInsulatedTransport: true,
    hasRefrigeration: false,
    categoriesHandled: ['COOKED_PREPARED', 'BAKERY'],
  },
  ...overrides,
});
