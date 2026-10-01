// Runs in every test worker before the test file imports the app (config is read at import time).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shiftsched_test';
process.env.MAIL_MODE = 'memory';
process.env.BCRYPT_COST = '4';
process.env.JOBS_ENABLED = 'false';
process.env.COOKIE_SECURE = 'true';
process.env.RATE_LIMIT_USER_PER_MIN = '100000';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.KIOSK_RATE_LIMIT = '100000';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.APP_URL = 'https://app.example';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
