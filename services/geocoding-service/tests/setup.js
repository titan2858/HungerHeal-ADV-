process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret_must_be_at_least_16_chars';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
// The offline provider on purpose: the suite must not depend on OpenCage being
// up, on network access, or on spending a real daily quota to run.
process.env.GEOCODER_PROVIDER = 'offline';
process.env.LOG_LEVEL = 'silent';
// Short TTLs so expiry is observable within a test run rather than in 30 days.
process.env.CACHE_TTL_SECONDS = '60';
process.env.NEGATIVE_CACHE_TTL_SECONDS = '5';

import jwt from 'jsonwebtoken';

export const token = (role = 'DONOR') =>
  jwt.sign(
    {
      sub: '65b000000000000000000001',
      role,
      email: 'donor@example.com',
      name: 'Asha Donor',
      phone: '+91 9876543210',
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'hungerheal-auth' },
  );
