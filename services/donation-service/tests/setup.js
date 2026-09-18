// Must run before any module that reads configuration is imported.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI =
  process.env.TEST_MONGO_URI ||
  'mongodb://hungerheal:hungerheal_dev_pw@localhost:27018/?authSource=admin';
process.env.MONGO_DB_NAME = 'hh_donations_test';
process.env.JWT_SECRET = 'test_secret_must_be_at_least_16_chars';
// The unit suite covers HTTP behaviour and persistence, not the broker, so it
// runs without Kafka. The publish path is exercised separately: the event
// BUILDER is unit-tested directly, and real publishing is proven end to end by
// scripts/smoke-donation.sh against the running stack.
process.env.KAFKA_ENABLED = 'false';
process.env.UPLOAD_DIR = 'uploads-test';
process.env.LOG_LEVEL = 'silent';

import jwt from 'jsonwebtoken';

export const donorToken = (overrides = {}) =>
  jwt.sign(
    {
      sub: overrides.sub ?? '65b000000000000000000001',
      role: 'DONOR',
      email: 'donor@example.com',
      name: 'Asha Donor',
      phone: '+91 9876543210',
      ...overrides,
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'hungerheal-auth' },
  );

export const agentToken = (overrides = {}) =>
  jwt.sign(
    {
      sub: overrides.sub ?? '65b000000000000000000002',
      role: 'AGENT',
      email: 'agent@example.com',
      name: 'Ravi Agent',
      phone: '+91 9876500000',
      ...overrides,
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'hungerheal-auth' },
  );

// Tomorrow, so bestBefore is always in the future.
export const futureDate = () => new Date(Date.now() + 24 * 3600 * 1000).toISOString();

export const validDonation = (overrides = {}) => ({
  title: 'Leftover biryani from a wedding',
  description: 'Approximately 40 servings, freshly cooked this evening',
  category: 'COOKED_PREPARED',
  quantityAmount: 40,
  quantityUnit: 'SERVINGS',
  pickupAddress: '12 MG Road, Bengaluru 560001',
  lat: 12.9716,
  lng: 77.5946,
  bestBefore: futureDate(),
  ...overrides,
});
