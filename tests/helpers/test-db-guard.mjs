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
