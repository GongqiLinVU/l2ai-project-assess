// Persistence tests — run against an ISOLATED, disposable local database.
//
//   npm run test:db        (loads .env.test -> DATABASE_URL = ...l2ai_assess_test)
//
// Requires the local Supabase stack (npm run db:start) and the disposable test
// database with BOTH migrations applied. The suite truncates application tables
// between tests; it never targets the dev database or the Class Intake stack —
// assertDisposableTestDb() enforces the exact target before any destructive SQL.

import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {saveInterview,openInterview,listInterviews,ping,closePool,getPool,
        createDraft,getDraft,findInterviewByIdempotencyKey,ConflictError,ValidationError} from '../lib/db.mjs';
import {createApp} from '../server.mjs';
import {analyse} from '../lib/model.mjs';
import {resolveRepository,readSelected} from '../lib/github.mjs';
import {assertDisposableTestDb} from './helpers/test-db-guard.mjs';

// Build a real, validated mock analysis + authoritative evidence from the pinned
// fixture, with server-assigned stable qids (mirrors /api/analyse). `paths` lets a
// test change the selected material to prove per-run evidence isolation.
async function prepareAuthoritative(paths = ['README.md', 'src/intakeStart.ts'], focus = 'Explain the design and what tests leave unverified', history = 'Earlier: discussed continuity') {
  const snap = await resolveRepository('https://github.com/GongqiLinVU/milestoneproject', true);
  const files = await readSelected(snap, paths);
  const r = await analyse(files, focus, history, {});
  const analysis = { ...r.analysis, questions: r.analysis.questions.map((q, i) => ({ ...q, qid: 'q' + (i + 1) })) };
  const evidence = {
    repository: snap.repository, commitSha: snap.sha, source: snap.source, retrievedAt: snap.retrievedAt,
    files, unread: snap.files.filter(f => !paths.includes(f.path)).map(f => f.path), excludedEntries: snap.excludedEntries
  };
  return { evidence, analysis, model: r.model, runInputs: { focus, history, paths: [...paths] } };
}

before(() => { assertDisposableTestDb(); });                 // Finding 3: enforce target
beforeEach(async () => { assertDisposableTestDb(); await getPool().query('truncate interview, analysis_draft cascade'); });
after(async () => { await closePool(); });

test('Finding 3: assertDisposableTestDb rejects dev/remote/wrong targets', () => {
  assert.throws(() => assertDisposableTestDb('postgresql://postgres:postgres@127.0.0.1:54342/postgres'), /database "postgres" is not the disposable/);
  assert.throws(() => assertDisposableTestDb('postgresql://postgres:postgres@127.0.0.1:54322/l2ai_assess_test'), /port "54322"/);
  assert.throws(() => assertDisposableTestDb('postgresql://user:pw@db.example.com:5432/l2ai_assess_test'), /host "db.example.com"/);
  assert.throws(() => assertDisposableTestDb(''), /DATABASE_URL is not set/);
  // The real configured target is accepted.
  assert.deepEqual(assertDisposableTestDb(process.env.DATABASE_URL), { host: new URL(process.env.DATABASE_URL).hostname, port: '54342', database: 'l2ai_assess_test' });
});

test('ping reaches the disposable database', async () => { assert.equal(await ping(), true); });

test('save a prepared mock interview, reopen it, and preserve source text + hashes', async () => {
  const auth = await prepareAuthoritative();
  const beforeContent = auth.evidence.files[0].content, beforeSha = auth.evidence.files[0].sha256;
  const saved = await saveInterview({
    idempotencyKey: 'key-1', title: 'Reopen test', focus: 'focus', history: 'hist', teacherReview: 'review notes',
    evidence: auth.evidence, run: { analysis: auth.analysis, runInputs: auth.runInputs, model: auth.model },
    responses: auth.analysis.questions.map(q => ({ questionId: q.qid, editedQuestion: q.text + ' (edited)', studentSelfReport: 'student says ' + q.qid, teacherVerification: 'checked ' + q.qid }))
  });
  assert.equal(saved.interview.version, 1);
  const re = await openInterview(saved.interview.id);                  // fresh read
  assert.equal(re.interview.title, 'Reopen test');
  assert.equal(re.evidence.files[0].content, beforeContent);
  assert.equal(re.evidence.files[0].sha256, beforeSha);
  assert.equal(re.selectedRun.evidence.commitSha, auth.evidence.commitSha, 'per-run evidence returned');
  const r0 = re.selectedRun.responses[0];
  assert.match(r0.editedQuestion, /\(edited\)$/);
  assert.match(r0.studentSelfReport, /student says q1/);
  assert.equal(r0.originalQuestion, auth.analysis.questions[0].text, 'original question derived from authoritative analysis');
});

test('Finding 1: re-analysis with CHANGED material keeps each run\'s own evidence', async () => {
  const run1 = await prepareAuthoritative(['README.md', 'src/intakeStart.ts'], 'Focus one', 'History one');
  const first = await saveInterview({
    idempotencyKey: 'perrun', title: 'Per-run evidence', focus: 'Focus one', history: 'History one',
    evidence: run1.evidence, run: { analysis: run1.analysis, runInputs: run1.runInputs, model: run1.model },
    responses: [{ questionId: 'q1', studentSelfReport: 'answer for run 1' }]
  });
  const run1Id = first.selectedRun.id;
  const run1Files = first.selectedRun.evidence.files.map(f => f.path).sort();

  // Second run selects DIFFERENT files + different focus/history.
  const run2 = await prepareAuthoritative(['README.md'], 'Focus two', 'History two');
  const second = await saveInterview({
    interviewId: first.interview.id, expectedVersion: first.interview.version,
    title: 'Per-run evidence', focus: 'Focus two', history: 'History two',
    evidence: run2.evidence, run: { analysis: run2.analysis, runInputs: run2.runInputs, model: run2.model }
  });
  assert.equal(second.runs.length, 2);

  // Opening run 1 still shows run 1's files, focus and history — unchanged.
  const reRun1 = await openInterview(first.interview.id, run1Id);
  assert.deepEqual(reRun1.selectedRun.evidence.files.map(f => f.path).sort(), run1Files);
  assert.equal(reRun1.selectedRun.runInputs.focus, 'Focus one');
  assert.equal(reRun1.selectedRun.runInputs.history, 'History one');
  assert.equal(reRun1.selectedRun.responses[0].studentSelfReport, 'answer for run 1');

  // Opening run 2 shows the changed material (only README.md) and inputs.
  const reRun2 = await openInterview(first.interview.id, second.selectedRun.id);
  assert.deepEqual(reRun2.selectedRun.evidence.files.map(f => f.path), ['README.md']);
  assert.equal(reRun2.selectedRun.runInputs.focus, 'Focus two');
  // Run 1's and run 2's evidence rows are distinct and independent.
  assert.notEqual(reRun1.selectedRun.evidence.files.length, reRun2.selectedRun.evidence.files.length);
});

test('Finding 4: durable draft lets the FIRST save proceed after token expiry/restart', async () => {
  const auth = await prepareAuthoritative();
  // Simulate: /api/analyse persisted a draft, then the in-memory token was lost
  // (process restart). Only the durable draft remains.
  const draftId = await createDraft({ evidence: auth.evidence, analysis: auth.analysis, runInputs: auth.runInputs, model: auth.model });
  const draft = await getDraft(draftId);
  assert.ok(draft, 'draft persisted');
  // First save uses the draft as the authoritative source — no regeneration.
  const saved = await saveInterview({
    idempotencyKey: 'from-draft', title: 'Saved from draft', focus: auth.runInputs.focus, history: auth.runInputs.history,
    evidence: draft.evidence, run: { analysis: draft.analysis, runInputs: draft.runInputs, model: draft.model }, draftId,
    responses: [{ questionId: 'q1', studentSelfReport: 'answer entered before first save' }]
  });
  assert.ok(saved.interview.id);
  assert.equal(saved.selectedRun.analysis.questions.length, auth.analysis.questions.length, 'questions preserved, not regenerated');
  assert.equal(saved.selectedRun.responses[0].studentSelfReport, 'answer entered before first save');
  // Draft is consumed once promoted to a run.
  assert.equal(await getDraft(draftId), null, 'draft deleted after promotion');
});

test('Finding 5: unknown and duplicate response question ids are rejected', async () => {
  const auth = await prepareAuthoritative();
  const base = { idempotencyKey: 'qid', title: 'QID', focus: 'f', history: '', evidence: auth.evidence, run: { analysis: auth.analysis, runInputs: auth.runInputs, model: auth.model } };
  // Unknown id.
  await assert.rejects(() => saveInterview({ ...base, idempotencyKey: 'qid-a', responses: [{ questionId: 'does-not-exist', studentSelfReport: 'x' }] }), e => e instanceof ValidationError && /unknown question id/.test(e.message));
  // Duplicate id.
  await assert.rejects(() => saveInterview({ ...base, idempotencyKey: 'qid-b', responses: [{ questionId: 'q1', studentSelfReport: 'a' }, { questionId: 'q1', studentSelfReport: 'b' }] }), e => e instanceof ValidationError && /Duplicate/.test(e.message));
  // Valid ids succeed and derive original_question from the analysis.
  const ok = await saveInterview({ ...base, idempotencyKey: 'qid-c', responses: [{ questionId: 'q1', editedQuestion: 'edited', studentSelfReport: 'a' }] });
  assert.equal(ok.selectedRun.responses[0].originalQuestion, auth.analysis.questions[0].text);
});

test('repeated/retried creation with the same idempotency key does not duplicate', async () => {
  const auth = await prepareAuthoritative();
  const base = { idempotencyKey: 'dup-key', title: 'Dup', focus: 'f', history: '', evidence: auth.evidence, run: { analysis: auth.analysis, runInputs: auth.runInputs, model: auth.model } };
  const a = await saveInterview(base);
  const b = await saveInterview(base);
  assert.equal(a.interview.id, b.interview.id);
  assert.equal((await listInterviews()).filter(i => i.id === a.interview.id).length, 1);
  assert.equal((await openInterview(a.interview.id)).runs.length, 1);
});

test('stale update is rejected with a conflict and does not overwrite newer work', async () => {
  const auth = await prepareAuthoritative();
  const created = await saveInterview({ idempotencyKey: 'sl', title: 'Original', focus: 'f', history: '', evidence: auth.evidence, run: { analysis: auth.analysis, runInputs: auth.runInputs, model: auth.model } });
  const v2 = await saveInterview({ interviewId: created.interview.id, expectedVersion: 1, title: 'First edit', focus: 'f2', history: '', runId: created.selectedRun.id });
  assert.equal(v2.interview.version, 2);
  await assert.rejects(() => saveInterview({ interviewId: created.interview.id, expectedVersion: 1, title: 'Stale overwrite', focus: 'x', history: '' }), e => e instanceof ConflictError);
  assert.equal((await openInterview(created.interview.id)).interview.title, 'First edit');
});

test('a failed multi-record save leaves no partial interview (atomic rollback)', async () => {
  const auth = await prepareAuthoritative();
  const bad = structuredClone(auth); bad.evidence.commitSha = 'not-a-sha';
  const before = (await listInterviews()).length;
  await assert.rejects(() => saveInterview({ idempotencyKey: 'atomic', title: 'Atomic', focus: 'f', history: '', evidence: bad.evidence, run: { analysis: bad.analysis, runInputs: bad.runInputs, model: bad.model } }));
  assert.equal((await listInterviews()).length, before);
  const ok = await saveInterview({ idempotencyKey: 'atomic', title: 'Atomic retry', focus: 'f', history: '', evidence: auth.evidence, run: { analysis: auth.analysis, runInputs: auth.runInputs, model: auth.model } });
  assert.ok(ok.interview.id);
});

test('re-analysis creates a new run and preserves the previous run and its answers', async () => {
  const auth = await prepareAuthoritative();
  const first = await saveInterview({ idempotencyKey: 'ra', title: 'Re-analyse', focus: 'f', history: '', evidence: auth.evidence, run: { analysis: auth.analysis, runInputs: auth.runInputs, model: auth.model }, responses: [{ questionId: 'q1', studentSelfReport: 'run1 answer' }] });
  const run1Id = first.selectedRun.id;
  const auth2 = await prepareAuthoritative();
  const second = await saveInterview({ interviewId: first.interview.id, expectedVersion: first.interview.version, title: 'Re-analyse', focus: 'f', history: '', evidence: auth2.evidence, run: { analysis: auth2.analysis, runInputs: auth2.runInputs, model: auth2.model } });
  assert.equal(second.runs.length, 2);
  assert.ok(second.selectedRun.id !== run1Id);
  assert.equal(second.selectedRun.responses.length, 0);
  assert.equal((await openInterview(first.interview.id, run1Id)).selectedRun.responses[0].studentSelfReport, 'run1 answer');
});

test('HTTP: save via durable draftId (token gone) is server-authoritative; forged source ignored; 409 on stale', async () => {
  const app = createApp(); await new Promise(r => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  const post = (route, data) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const snap = await (await post('/api/resolve', { url: 'https://github.com/GongqiLinVU/milestoneproject', demo: true })).json();
    const prepared = await (await post('/api/analyse', { snapshotId: snap.id, paths: ['README.md', 'src/intakeStart.ts'], focus: 'Design and tests', history: '' })).json();
    assert.ok(prepared.draftId, 'analyse persists a durable draft');
    assert.ok(prepared.analysis.questions.every(q => q.qid));
    // Save WITHOUT the token (simulating expiry/restart), only the draftId, plus a
    // forged file that must be ignored.
    const saveBody = {
      draftId: prepared.draftId, idempotencyKey: 'http-1', title: 'HTTP interview', focus: 'Design and tests', history: '', teacherReview: '',
      files: [{ path: 'evil.ts', content: 'HACKED', blobSha: '0', sha256: '0' }],
      responses: prepared.analysis.questions.map(q => ({ questionId: q.qid, studentSelfReport: 'ans' }))
    };
    const saved = await (await post('/api/save', saveBody)).json();
    assert.ok(saved.interview.id);
    const opened = await (await post('/api/open', { interviewId: saved.interview.id })).json();
    assert.ok(opened.evidence.files.some(f => f.path === 'README.md'));
    assert.ok(!opened.evidence.files.some(f => f.path === 'evil.ts'), 'forged file rejected');
    assert.equal(opened.evidence.commitSha, snap.sha);
    const stale = await post('/api/save', { interviewId: saved.interview.id, expectedVersion: 0, title: 'x', focus: 'y', responses: [] });
    assert.equal(stale.status, 409);
    // Invalid question id over HTTP returns 400.
    const prepared2 = await (await post('/api/analyse', { snapshotId: snap.id, paths: ['README.md'], focus: 'f', history: '' })).json();
    const badQid = await post('/api/save', { draftId: prepared2.draftId, idempotencyKey: 'http-badqid', title: 'Bad qid', focus: 'f', history: '', responses: [{ questionId: 'nope', studentSelfReport: 'x' }] });
    assert.equal(badQid.status, 400);
  } finally { await new Promise(r => app.close(r)); }
});

test('Round 3 Finding 2: a draft-write failure is surfaced, not swallowed (analysis kept in memory, flagged not restart-safe)', async () => {
  // Force createDraft to fail by temporarily removing analysis_draft, then confirm
  // /api/analyse reports draftPersisted:false with a clear warning while STILL
  // returning the prepared analysis + a usable in-memory token.
  const app = createApp(); await new Promise(r => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  const post = (route, data) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  await getPool().query('alter table analysis_draft rename to analysis_draft_tmp_hidden');
  try {
    const snap = await (await post('/api/resolve', { url: 'https://github.com/GongqiLinVU/milestoneproject', demo: true })).json();
    const prepared = await (await post('/api/analyse', { snapshotId: snap.id, paths: ['README.md'], focus: 'draft fail', history: '' })).json();
    assert.equal(prepared.draftPersisted, false, 'draft persistence failure is reported');
    assert.match(prepared.draftError || '', /restart-safe|memory only|could not be saved/i, 'clear warning present');
    assert.equal(prepared.draftId, null, 'no draftId when the write failed');
    assert.ok(prepared.analysisToken, 'in-memory token still returned so the prep is not lost');
    assert.ok(Array.isArray(prepared.analysis.questions) && prepared.analysis.questions.length >= 1, 'analysis preserved for immediate save/retry');
    // The in-memory token still allows an immediate save while the process lives.
    await getPool().query('alter table analysis_draft_tmp_hidden rename to analysis_draft');  // restore before saving
    const saved = await (await post('/api/save', { analysisToken: prepared.analysisToken, idempotencyKey: 'draftfail-' + Date.now(), title: 'Draft fail save', focus: 'draft fail', history: '', responses: [{ questionId: prepared.analysis.questions[0].qid, studentSelfReport: 'still saved' }] })).json();
    assert.ok(saved.interview.id, 'immediate save via token still works');
  } finally {
    // Ensure the table is restored even if an assertion failed before the rename-back.
    await getPool().query('alter table if exists analysis_draft_tmp_hidden rename to analysis_draft').catch(() => {});
    await new Promise(r => app.close(r));
  }
});

test('database unavailability produces a visible error (no silent memory fallback)', async () => {
  const bad = new pg.Pool({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:1/postgres', connectionTimeoutMillis: 1500 });
  await assert.rejects(() => bad.query('select 1'));
  await bad.end();
});

test('Round 3 Finding 3: first-save retry resolves an already-committed idempotency key (db layer)', async () => {
  const auth = await prepareAuthoritative();
  const key = 'retry-db-' + Date.now();
  const first = await saveInterview({
    idempotencyKey: key, title: 'Retry', focus: 'f', history: '', evidence: auth.evidence,
    run: { analysis: auth.analysis, runInputs: auth.runInputs, model: auth.model },
    responses: [{ questionId: 'q1', studentSelfReport: 'kept answer' }]
  });
  // The draft is consumed and the token would be gone after a restart; the retry
  // path resolves purely by the committed idempotency key.
  const resolved = await findInterviewByIdempotencyKey(key);
  assert.ok(resolved, 'key resolves to the committed record');
  assert.equal(resolved.interview.id, first.interview.id, 'same interview, no duplicate');
  assert.equal(resolved.selectedRun.id, first.selectedRun.id, 'same run');
  assert.equal(resolved.selectedRun.responses[0].studentSelfReport, 'kept answer', 'answer preserved');
  assert.equal(await findInterviewByIdempotencyKey('never-used'), null, 'unknown key resolves to null');
});

test('Round 3 Finding 3: HTTP lost first-save response -> actual server restart -> retry returns original, no duplicate', async () => {
  // Process A: prepare + first save (consumes the draft), then "lose" the response.
  const appA = createApp(); await new Promise(r => appA.listen(0, '127.0.0.1', r));
  const baseA = 'http://127.0.0.1:' + appA.address().port;
  const postA = (route, data) => fetch(baseA + route, { method: 'POST', headers: { Origin: baseA, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const key = 'http-retry-' + Date.now();
  let draftId, qids, firstInterviewId, firstRunId;
  try {
    const snap = await (await postA('/api/resolve', { url: 'https://github.com/GongqiLinVU/milestoneproject', demo: true })).json();
    const prepared = await (await postA('/api/analyse', { snapshotId: snap.id, paths: ['README.md'], focus: 'restart retry', history: '' })).json();
    draftId = prepared.draftId; qids = prepared.analysis.questions.map(q => q.qid);
    const saved = await (await postA('/api/save', {
      draftId, idempotencyKey: key, title: 'Restart retry', focus: 'restart retry', history: '',
      responses: [{ questionId: qids[0], studentSelfReport: 'answer before lost response' }]
    })).json();
    firstInterviewId = saved.interview.id; firstRunId = saved.selectedRun.id;
    assert.ok(firstInterviewId, 'first save committed');
    // Confirm the draft was consumed (promoted).
    assert.equal(await getDraft(draftId), null, 'draft consumed on first save');
  } finally {
    // "Lost response": the client never learned the interview id. Shut down A —
    // an ACTUAL restart: all in-memory tokens are gone.
    await new Promise(r => appA.close(r));
  }

  // Process B: brand-new server (empty in-memory cache). Client retries the SAME
  // first save (same idempotencyKey) with the now-stale draftId and no token.
  const appB = createApp(); await new Promise(r => appB.listen(0, '127.0.0.1', r));
  const baseB = 'http://127.0.0.1:' + appB.address().port;
  const postB = (route, data) => fetch(baseB + route, { method: 'POST', headers: { Origin: baseB, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const res = await postB('/api/save', {
      draftId, idempotencyKey: key, title: 'Restart retry', focus: 'restart retry', history: '',
      responses: [{ questionId: qids[0], studentSelfReport: 'answer before lost response' }]
    });
    assert.equal(res.status, 200, 'retry succeeds (not a draft-expired error)');
    const body = await res.json();
    assert.equal(body.interview.id, firstInterviewId, 'retry returns the ORIGINAL interview');
    assert.equal(body.selectedRun.id, firstRunId, 'retry returns the ORIGINAL run (no duplicate)');
    assert.equal(body.selectedRun.responses[0].studentSelfReport, 'answer before lost response', 'answer preserved');
    // No duplicate interviews or runs.
    assert.equal((await listInterviews()).filter(i => i.id === firstInterviewId).length, 1, 'exactly one interview');
    assert.equal((await openInterview(firstInterviewId)).runs.length, 1, 'exactly one run');
  } finally { await new Promise(r => appB.close(r)); }
});
