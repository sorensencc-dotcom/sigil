// Guards every test/tool that runs `DROP SCHEMA public CASCADE` against a
// live connection string. A connection string is only "disposable" if its
// database name ends in `_test` -- anything else (including the documented
// dev/relay database, `sigil`) is refused before any destructive query runs.
export function assertDisposableTestDatabase(connectionString) {
  if (!connectionString) throw new Error('assertDisposableTestDatabase: connectionString is required');
  let dbName;
  try {
    dbName = new URL(connectionString).pathname.replace(/^\//, '');
  } catch (error) {
    throw new Error(`assertDisposableTestDatabase: could not parse connection string: ${error.message}`);
  }
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run a schema-dropping test against database "${dbName}" -- its name doesn't end in "_test", ` +
      'so it does not look disposable. This guard exists because this exact class of test previously wiped the ' +
      'live dev/relay database when SIGIL_TEST_DATABASE_URL was pointed at it by mistake. Point the env var at a ' +
      'database whose name ends in "_test" (e.g. sigil_test) instead.'
    );
  }
}
