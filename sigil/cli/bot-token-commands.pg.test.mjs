import test from 'node:test';

test('bot token command PostgreSQL coverage requires a disposable test database', { skip: !process.env.SIGIL_TEST_DATABASE_URL }, () => {});
