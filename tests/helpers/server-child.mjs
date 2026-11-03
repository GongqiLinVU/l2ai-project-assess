// Child-process server for the genuine cross-process restart test.
//
// Starts the real app on the port given as argv[2], binding 127.0.0.1, and prints
// "READY <port>" on stdout once listening. Run as its own OS process so that
// killing it truly clears all module-level in-memory state (snapshot cache,
// analysis tokens) — unlike closing a createApp() instance within one process.
//
// DATABASE_URL is inherited from the environment (the disposable test database).
import { createApp } from '../../server.mjs';

const port = Number(process.argv[2] || 0);
const app = createApp();
app.listen(port, '127.0.0.1', () => {
  const actual = app.address().port;
  process.stdout.write('READY ' + actual + '\n');
});

// Exit promptly when the parent asks (SIGTERM) so the restart is clean.
process.on('SIGTERM', () => process.exit(0));
