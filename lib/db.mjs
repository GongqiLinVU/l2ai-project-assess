// Server-side persistence for L2AI Project Assess.
//
// Separated from the HTTP entry point (server.mjs). Uses a direct Postgres
// connection via `pg` (NOT the Supabase Data API). The database is the source of
// truth. There is NO silent fall-back to memory-only storage: if the database is
// unavailable, these functions throw and the caller must surface a visible error.
//
// Integrity rules enforced here:
//   * Evidence and validated analysis come from the server-authoritative payload
//     the caller passes in (derived from /api/analyse), never from browser-
//     submitted source text or provenance.
//   * Multi-record writes run inside a single transaction (atomic): a failure
//     leaves no partial interview.
//   * First create is idempotent on a client save key (dedupes double-clicks).
//   * Updates use optimistic concurrency on interview.version; a stale version is
//     rejected with a typed ConflictError instead of overwriting newer work.
//   * A new analysis inserts a new analysis_run; prior runs and their responses
//     are preserved.

import pg from 'pg';

export class ConflictError extends Error {
  constructor(message) { super(message); this.name = 'ConflictError'; }
}
export class NotFoundError extends Error {
  constructor(message) { super(message); this.name = 'NotFoundError'; }
}

let pool = null;

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not configured; database persistence is required.');
    pool = new pg.Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000
    });
    // Surface background pool errors rather than crashing the process silently.
    pool.on('error', (err) => { console.error('pg pool error:', err.message); });
  }
  return pool;
}

export async function closePool() {
  if (pool) { const p = pool; pool = null; await p.end(); }
}

// Simple liveness check used by the health endpoint and tests.
export async function ping() {
  const { rows } = await getPool().query('select 1 as ok');
  return rows[0].ok === 1;
}

// Shape helpers -------------------------------------------------------------

function mapInterviewRow(r) {
  return {
    id: r.id,
    title: r.title,
    focus: r.focus,
    history: r.history,
    teacherReview: r.teacher_review,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

// List saved interviews with enough information to identify them, newest first.
export async function listInterviews() {
  const { rows } = await getPool().query(
    `select i.id, i.title, i.focus, i.version, i.updated_at,
            e.repository, e.commit_sha,
            (select count(*) from analysis_run r where r.interview_id = i.id) as run_count
       from interview i
       left join evidence_snapshot e on e.interview_id = i.id
      order by i.updated_at desc
      limit 200`
  );
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    focus: r.focus,
    version: r.version,
    updatedAt: r.updated_at,
    repository: r.repository,
    commitSha: r.commit_sha,
    runCount: Number(r.run_count)
  }));
}

// Save an interview.
//
// payload = {
//   interviewId?,          // present => update existing
//   expectedVersion?,      // required for update; optimistic concurrency token
//   idempotencyKey?,       // used for first create dedupe
//   title, focus, history, teacherReview,   // teacher-editable
//   evidence: { repository, commitSha, source, retrievedAt, files, unread, excludedEntries }, // server-authoritative
//   run: {                 // server-authoritative analysis for a (new) run
//     analysis, runInputs, model
//   } | null,              // null => save edits only, no new run
//   runId?,                // target run for responses (when not creating a new run)
//   responses: [{ questionId, originalQuestion, editedQuestion, studentSelfReport, teacherVerification }]
// }
//
// Returns the full reopened record (same shape as openInterview).
export async function saveInterview(payload) {
  const client = await getPool().connect();
  try {
    await client.query('begin');

    let interviewId = payload.interviewId;
    let newVersion;
    // True when a create was short-circuited because its idempotency key already
    // produced an interview (a double-click / retry of the SAME first save).
    let idempotentReplay = false;

    if (!interviewId) {
      // ---- First create (idempotent on idempotencyKey) ----
      if (payload.idempotencyKey) {
        const existing = await client.query(
          'select id, version from interview where idempotency_key = $1',
          [payload.idempotencyKey]
        );
        if (existing.rowCount > 0) {
          // A prior create with the same key already succeeded. Return the stored
          // record unchanged rather than inserting a duplicate or mutating it.
          interviewId = existing.rows[0].id;
          newVersion = existing.rows[0].version;
          idempotentReplay = true;
        }
      }
      if (!interviewId) {
        const ins = await client.query(
          `insert into interview (title, focus, history, teacher_review, idempotency_key, version)
           values ($1,$2,$3,$4,$5,1) returning id, version`,
          [payload.title, payload.focus, payload.history ?? '', payload.teacherReview ?? '', payload.idempotencyKey ?? null]
        );
        interviewId = ins.rows[0].id;
        newVersion = ins.rows[0].version;
      }
    }

    if (idempotentReplay) {
      // Nothing to write; the first save already persisted this interview.
      await client.query('commit');
      return await openInterview(interviewId, null);
    }

    if (interviewId && newVersion === undefined) {
      // ---- Update existing with optimistic concurrency ----
      if (!Number.isInteger(payload.expectedVersion)) {
        throw new ConflictError('A version is required to update an existing interview.');
      }
      const upd = await client.query(
        `update interview
            set title = $1, focus = $2, history = $3, teacher_review = $4,
                version = version + 1
          where id = $5 and version = $6
          returning version`,
        [payload.title, payload.focus, payload.history ?? '', payload.teacherReview ?? '', interviewId, payload.expectedVersion]
      );
      if (upd.rowCount === 0) {
        // Either the interview is gone or someone else saved first.
        const stillThere = await client.query('select version from interview where id = $1', [interviewId]);
        if (stillThere.rowCount === 0) throw new NotFoundError('Interview no longer exists.');
        throw new ConflictError(
          `This interview was changed elsewhere (server version ${stillThere.rows[0].version}, your version ${payload.expectedVersion}). Reopen it to continue without overwriting newer work.`
        );
      }
      newVersion = upd.rows[0].version;
    }

    // ---- Evidence snapshot (server-authoritative, 1:1, upsert) ----
    const ev = payload.evidence;
    if (ev) {
      await client.query(
        `insert into evidence_snapshot
           (interview_id, repository, commit_sha, source, retrieved_at, files, unread, excluded_entries)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (interview_id) do update set
           repository = excluded.repository,
           commit_sha = excluded.commit_sha,
           source = excluded.source,
           retrieved_at = excluded.retrieved_at,
           files = excluded.files,
           unread = excluded.unread,
           excluded_entries = excluded.excluded_entries`,
        [interviewId, ev.repository, ev.commitSha, ev.source, ev.retrievedAt,
         JSON.stringify(ev.files), JSON.stringify(ev.unread ?? []), ev.excludedEntries ?? 0]
      );
    }

    // ---- Analysis run ----
    let runId = payload.runId ?? null;
    if (payload.run) {
      // A new analysis always creates a new run; prior runs are preserved.
      const next = await client.query(
        'select coalesce(max(run_number),0) + 1 as n from analysis_run where interview_id = $1',
        [interviewId]
      );
      const runNumber = next.rows[0].n;
      const runIns = await client.query(
        `insert into analysis_run (interview_id, run_number, analysis, run_inputs, model)
         values ($1,$2,$3,$4,$5) returning id`,
        [interviewId, runNumber,
         JSON.stringify(payload.run.analysis),
         JSON.stringify(payload.run.runInputs),
         JSON.stringify(payload.run.model)]
      );
      runId = runIns.rows[0].id;
    }

    // ---- Responses for the target run (teacher-editable, upsert by question) ----
    if (runId && Array.isArray(payload.responses)) {
      // Confirm the run belongs to this interview before writing responses.
      const owns = await client.query(
        'select 1 from analysis_run where id = $1 and interview_id = $2',
        [runId, interviewId]
      );
      if (owns.rowCount === 0) throw new NotFoundError('Run does not belong to this interview.');
      for (const r of payload.responses) {
        await client.query(
          `insert into interview_response
             (analysis_run_id, question_id, original_question, edited_question, student_self_report, teacher_verification)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (analysis_run_id, question_id) do update set
             edited_question = excluded.edited_question,
             student_self_report = excluded.student_self_report,
             teacher_verification = excluded.teacher_verification`,
          [runId, r.questionId, r.originalQuestion, r.editedQuestion ?? '',
           r.studentSelfReport ?? '', r.teacherVerification ?? '']
        );
      }
    }

    await client.query('commit');
    return await openInterview(interviewId, runId);
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

// Open a saved interview, optionally focused on a specific run (defaults to the
// latest run). Returns everything needed to continue editing and to export.
export async function openInterview(interviewId, runId = null) {
  const pool = getPool();
  const iRes = await pool.query('select * from interview where id = $1', [interviewId]);
  if (iRes.rowCount === 0) throw new NotFoundError('Interview not found.');
  const interview = mapInterviewRow(iRes.rows[0]);

  const eRes = await pool.query('select * from evidence_snapshot where interview_id = $1', [interviewId]);
  const evidence = eRes.rowCount
    ? {
        repository: eRes.rows[0].repository,
        commitSha: eRes.rows[0].commit_sha,
        source: eRes.rows[0].source,
        retrievedAt: eRes.rows[0].retrieved_at,
        files: eRes.rows[0].files,
        unread: eRes.rows[0].unread,
        excludedEntries: eRes.rows[0].excluded_entries
      }
    : null;

  const runsRes = await pool.query(
    'select id, run_number, model, run_inputs, created_at from analysis_run where interview_id = $1 order by run_number',
    [interviewId]
  );
  const runs = runsRes.rows.map(r => ({
    id: r.id,
    runNumber: r.run_number,
    model: r.model,
    runInputs: r.run_inputs,
    createdAt: r.created_at
  }));

  // Resolve which run to load in full.
  let selectedRunId = runId;
  if (selectedRunId && !runs.some(r => r.id === selectedRunId)) {
    throw new NotFoundError('Requested run not found for this interview.');
  }
  if (!selectedRunId && runs.length) selectedRunId = runs[runs.length - 1].id;

  let selectedRun = null;
  if (selectedRunId) {
    const full = await pool.query('select * from analysis_run where id = $1', [selectedRunId]);
    const resp = await pool.query(
      'select * from interview_response where analysis_run_id = $1 order by question_id',
      [selectedRunId]
    );
    selectedRun = {
      id: full.rows[0].id,
      runNumber: full.rows[0].run_number,
      analysis: full.rows[0].analysis,
      runInputs: full.rows[0].run_inputs,
      model: full.rows[0].model,
      createdAt: full.rows[0].created_at,
      responses: resp.rows.map(r => ({
        questionId: r.question_id,
        originalQuestion: r.original_question,
        editedQuestion: r.edited_question,
        studentSelfReport: r.student_self_report,
        teacherVerification: r.teacher_verification
      }))
    };
  }

  return { interview, evidence, runs, selectedRun };
}
