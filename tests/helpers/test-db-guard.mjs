// Safety guard for destructive test SQL (Finding 3).
//
// Every test entry point that runs destructive statements (TRUNCATE / DROP /
// DELETE, or a from-scratch schema load) MUST call assertDisposableTestDb() BEFORE
// connecting. It parses DATABASE_URL and refuses to proceed unless the target is
// the exact disposable local database on the isolated project's host and port:
//
//   host     = 127.0.0.1 (or localhost)
//   port     = 54342         (the l2ai_project_assess DB port)
//   database = l2ai_assess_test
//
// Development (`.../postgres` on 54342), the Class Intake stack (54322) and any
// remote host are rejected before a connection is opened.

const EXPECTED = {
  hosts: new Set(['127.0.0.1', 'localhost', '::1']),
  port: '54342',
  database: 'l2ai_assess_test'
};

export function assertDisposableTestDb(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Destructive tests require the disposable l2ai_assess_test database.');
  }
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL; refusing to run destructive SQL.');
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error(`Refusing destructive SQL: unexpected protocol "${url.protocol}".`);
  }
  const host = url.hostname;
  const port = url.port || '5432';
  const database = url.pathname.replace(/^\//, '');
  if (!EXPECTED.hosts.has(host)) {
    throw new Error(`Refusing destructive SQL: host "${host}" is not a local loopback host. Expected one of ${[...EXPECTED.hosts].join(', ')}.`);
  }
  if (port !== EXPECTED.port) {
    throw new Error(`Refusing destructive SQL: port "${port}" is not the isolated project DB port ${EXPECTED.port} (dev/Class Intake ports are rejected).`);
  }
  if (database !== EXPECTED.database) {
    throw new Error(`Refusing destructive SQL: database "${database}" is not the disposable test database "${EXPECTED.database}".`);
  }
  return { host, port, database };
}

// For the migration-upgrade test we must CREATE/DROP throwaway databases. That
// needs a connection to the maintenance `postgres` database, and throwaway names
// that cannot possibly be the dev database, the Class Intake stack, or anything
// shared. This guard enforces: the maintenance connection is on the isolated
// loopback host+port (derived from DATABASE_URL), and every throwaway DB name
// carries the dedicated `l2ai_migtest_` prefix. Anything else is rejected before
// a CREATE/DROP runs.
const THROWAWAY_PREFIX = 'l2ai_migtest_';

export function maintenanceUrlForTests(connectionString = process.env.DATABASE_URL) {
  // Validates host/port/db against the disposable target, then swaps the database
  // to `postgres` so CREATE/DROP DATABASE can run.
  const { host, port } = assertDisposableTestDb(connectionString);
  const url = new URL(connectionString);
  url.pathname = '/postgres';
  return { url: url.href, host, port };
}

export function assertThrowawayDbName(name) {
  if (typeof name !== 'string' || !name.startsWith(THROWAWAY_PREFIX) || !/^[a-z0-9_]+$/.test(name) || name.length > 48) {
    throw new Error(`Refusing CREATE/DROP DATABASE: "${name}" is not a valid disposable throwaway name (must start with "${THROWAWAY_PREFIX}" and contain only [a-z0-9_]).`);
  }
  // Belt and braces: never allow the known real databases.
  for (const forbidden of ['postgres', 'l2ai_assess_test', 'milestoneproject']) {
    if (name === forbidden) throw new Error(`Refusing CREATE/DROP DATABASE on protected database "${name}".`);
  }
  return name;
}

export { THROWAWAY_PREFIX };
