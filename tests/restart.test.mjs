// Genuine cross-process restart test for the first-save retry.
//
//   npm run test:restart   (loads .env.test -> disposable l2ai_assess_test)
//
// Unlike opening a second createApp() in the same process, this spawns the server
// as a real child OS process, performs the first save, KILLS that process (so all
// module-level in-memory state — snapshot cache and analysis tokens — is truly
// gone), then spawns a FRESH process and retries the same first save. The retry
// must resolve via the DB-persisted idempotency key and return the original
// interview/run without creating a duplicate. A payload-changed retry after the
// restart must conflict rather than silently discard edits.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { getPool, closePool } from '../lib/db.mjs';
import { assertDisposableTestDb } from './helpers/test-db-guard.mjs';

const CHILD = new URL('./helpers/server-child.mjs', import.meta.url).pathname;

// Spawn the server as its own OS process; resolve once it prints READY <port>.
function startServer() {
  const child = spawn(process.execPath, [CHILD, '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env }           // inherits DATABASE_URL (disposable test db)
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = d => {
      buf += d.toString();
      const m = buf.match(/READY (\d+)/);
      if (m) {
        child.stdout.off('data', onData);
        resolve({ child, port: Number(m[1]) });
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', code => { if (!/READY/.test(buf)) reject(new Error('child exited early: ' + code)); });
  });
}

async function killServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');                 // hard crash: no graceful in-memory flush
  await once(child, 'exit');
}

const post = (base, route, data) =>
  fetch(base + route, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

before(() => { assertDisposableTestDb(); });
beforeEach(async () => { assertDisposableTestDb(); await getPool().query('truncate interview, analysis_draft cascade'); });
after(async () => { await closePool(); });

test('ACTUAL OS-process restart: lost first-save response -> retry returns original, no duplicate', async () => {
  // Process 1: prepare + first save, then HARD KILL (simulating a crash/restart
  // after the response was lost before the client recorded the interview id).
  const a = await startServer();
  const baseA = 'http://127.0.0.1:' + a.port;
  const key = 'xproc-' + Date.now();
  let draftId, qid, firstInterviewId, firstRunId, firstPid = a.child.pid;
  try {
    const snap = await (await post(baseA, '/api/resolve', { url: 'https://github.com/GongqiLinVU/milestoneproject', demo: true })).json();
    const prep = await (await post(baseA, '/api/analyse', { snapshotId: snap.id, paths: ['README.md'], focus: 'xproc restart', history: '' })).json();
    draftId = prep.draftId; qid = prep.analysis.questions[0].qid;
    assert.ok(draftId, 'draft persisted (restart-safe)');
    const saved = await (await post(baseA, '/api/save', {
      draftId, idempotencyKey: key, title: 'XProc', focus: 'xproc restart', history: '',
      responses: [{ questionId: qid, studentSelfReport: 'answer before crash' }]
    })).json();
    firstInterviewId = saved.interview.id; firstRunId = saved.selectedRun.id;
    assert.ok(firstInterviewId);
  } finally {
    await killServer(a.child);
  }

  // Process 2: a brand-new OS process (different pid, empty in-memory state).
  const b = await startServer();
  assert.notEqual(b.child.pid, firstPid, 'genuinely a different OS process');
  const baseB = 'http://127.0.0.1:' + b.port;
  try {
    // Identical retry -> original record, no duplicate.
    const res = await post(baseB, '/api/save', {
      draftId, idempotencyKey: key, title: 'XProc', focus: 'xproc restart', history: '',
      responses: [{ questionId: qid, studentSelfReport: 'answer before crash' }]
    });
    assert.equal(res.status, 200, 'retry across a real restart succeeds');
    const body = await res.json();
    assert.equal(body.interview.id, firstInterviewId, 'ORIGINAL interview');
    assert.equal(body.selectedRun.id, firstRunId, 'ORIGINAL run (no duplicate)');
    assert.equal(body.selectedRun.responses[0].studentSelfReport, 'answer before crash');
    assert.equal((await (await post(baseB, '/api/interviews', {})).json()).interviews.filter(i => i.id === firstInterviewId).length, 1, 'exactly one interview');

    // Payload-CHANGED retry across the restart -> conflict, edits not discarded.
    const changed = await post(baseB, '/api/save', {
      draftId, idempotencyKey: key, title: 'XProc', focus: 'xproc restart', history: '',
      responses: [{ questionId: qid, studentSelfReport: 'DIFFERENT answer typed after the crash' }]
    });
    assert.equal(changed.status, 409, 'changed retry conflicts across a real restart too');
    const opened = await (await post(baseB, '/api/open', { interviewId: firstInterviewId })).json();
    assert.equal(opened.selectedRun.responses[0].studentSelfReport, 'answer before crash', 'committed record unchanged');
  } finally {
    await killServer(b.child);
  }
});
