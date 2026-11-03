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
//   * Evidence is bound 1:1 to an analysis_run and is immutable per run: adding a
//     new run never mutates an earlier run's evidence (Finding 1).
//   * Prepared drafts are persisted (analysis_draft) so the first save survives
//     token expiry / an application restart (Finding 4).
//   * Response question ids are validated against the target run's authoritative
//     analysis; unknown/duplicate ids are rejected and original_question is
//     derived from the authoritative analysis, not the client (Finding 5).
//   * Multi-record writes run inside a single transaction (atomic): a failure
//     leaves no partial interview.
//   * First create is idempotent on a client save key (dedupes double-clicks).
//   * Updates use optimistic concurrency on interview.version; a stale version is
//     rejected with a typed ConflictError instead of overwriting newer work.
//   * A new analysis inserts a new analysis_run; prior runs and their responses
//     are preserved.

import pg from 'pg';
import { createHash } from 'node:crypto';

export class ConflictError extends Error {
  constructor(message) { super(message); this.name = 'ConflictError'; }
}
export class NotFoundError extends Error {
  constructor(message) { super(message); this.name = 'NotFoundError'; }
}
export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
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
    pool.on('error', (err) => { console.error('pg pool error:', err.message); });
  }
  return pool;
}

export async function closePool() {
  if (pool) { const p = pool; pool = null; await p.end(); }
}

export async function ping() {
  const { rows } = await getPool().query('select 1 as ok');
  return rows[0].ok === 1;
}

// Payload-consistent idempotency ---------------------------------------------
//
// Fingerprint the TEACHER-EDITABLE content of a save request so a first-save
// retry can tell an identical retry (same content) from a changed retry (the
// teacher edited something after a lost response). Normalisation is stable and
// order-independent for responses; it excludes server-authoritative fields
// (evidence/analysis/provenance) and any source text.
export function requestFingerprint({ title, focus, history, teacherReview, responses }) {
  const normResponses = (Array.isArray(responses) ? responses : [])
    .map(r => ({
      questionId: String(r.questionId ?? ''),
      editedQuestion: String(r.editedQuestion ?? ''),
      studentSelfReport: String(r.studentSelfReport ?? ''),
      teacherVerification: String(r.teacherVerification ?? '')
    }))
    .sort((a, b) => a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0);
  const canonical = JSON.stringify({
    title: String(title ?? ''),
    focus: String(focus ?? ''),
    history: String(history ?? ''),
    teacherReview: String(teacherReview ?? ''),
    responses: normResponses
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// Durable prepared drafts -----------------------------------------------------

// Persist a server-authoritative prepared analysis so the first save can proceed
// after the in-memory token expires or the process restarts.
export async function createDraft({ evidence, analysis, runInputs, model }) {
  const { rows } = await getPool().query(
    `insert into analysis_draft (evidence, analysis, run_inputs, model)
     values ($1,$2,$3,$4) returning id`,
    [JSON.stringify(evidence), JSON.stringify(analysis), JSON.stringify(runInputs), JSON.stringify(model)]
  );
  return rows[0].id;
}

export async function getDraft(id) {
  const { rows } = await getPool().query('select * from analysis_draft where id = $1', [id]);
  if (!rows.length) return null;
  return { id: rows[0].id, evidence: rows[0].evidence, analysis: rows[0].analysis, runInputs: rows[0].run_inputs, model: rows[0].model };
}

// Prune drafts older than the given age (default 24h) to keep the table small.
export async function pruneDrafts(maxAgeMs = 86400000) {
  await getPool().query(
    `delete from analysis_draft where created_at < now() - ($1::bigint * interval '1 millisecond')`,
    [maxAgeMs]
  );
}

// Resolve an interview already created under a given idempotency key, if any.
// Used to make a FIRST-SAVE retry succeed after the draft was consumed (promoted)
// and the in-memory token is gone — e.g. the original response was lost and the
// client retries after an actual server restart. Returns { record, fingerprint }
// where `record` has the same shape as openInterview (latest run selected) and
// `fingerprint` is the teacher-editable payload fingerprint captured at first
// save (null for rows created before this column existed). Returns null if the
// key was never committed.
export async function findInterviewByIdempotencyKey(idempotencyKey) {
  if (!idempotencyKey) return null;
  const { rows } = await getPool().query(
    'select id, request_fingerprint from interview where idempotency_key = $1',
    [idempotencyKey]
  );
  if (!rows.length) return null;
  const record = await openInterview(rows[0].id, null);
  return { record, fingerprint: rows[0].request_fingerprint ?? null };
}

// Shape helpers ---------------------------------------------------------------

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

function mapEvidenceRow(r) {
  return {
    repository: r.repository,
    commitSha: r.commit_sha,
    source: r.source,
    retrievedAt: r.retrieved_at,
    files: r.files,
    unread: r.unread,
    excludedEntries: r.excluded_entries
  };
}

// List saved interviews with enough information to identify them, newest first.
// Repository/commit come from the LATEST run's evidence (library display only).
export async function listInterviews() {
  const { rows } = await getPool().query(
    `select i.id, i.title, i.focus, i.version, i.updated_at,
            (select count(*) from analysis_run r where r.interview_id = i.id) as run_count,
            le.repository, le.commit_sha
       from interview i
       left join lateral (
         select e.repository, e.commit_sha
           from analysis_run r
           join evidence_snapshot e on e.analysis_run_id = r.id
          where r.interview_id = i.id
          order by r.run_number desc
          limit 1
       ) le on true
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

// Validate teacher responses against the authoritative question ids for the run.
// Returns normalised rows with original_question taken from the authoritative
// analysis (not the client). Throws ValidationError on unknown/duplicate ids.
function reconcileResponses(responses, authoritativeQuestions) {
  if (responses === undefined || responses === null) return [];
  if (!Array.isArray(responses)) throw new ValidationError('Responses must be an array.');
  const byId = new Map();
  for (const q of authoritativeQuestions) byId.set(q.qid, q);
  const seen = new Set();
  const out = [];
  for (const r of responses) {
    const qid = r && r.questionId;
    if (typeof qid !== 'string' || !byId.has(qid)) {
      throw new ValidationError('Response references an unknown question id for this run: ' + qid);
    }
    if (seen.has(qid)) {
      throw new ValidationError('Duplicate response for question id: ' + qid);
    }
    seen.add(qid);
    out.push({
      questionId: qid,
      // Derived from the authoritative analysis, never from the client.
      originalQuestion: byId.get(qid).text,
      editedQuestion: r.editedQuestion ?? '',
      studentSelfReport: r.studentSelfReport ?? '',
      teacherVerification: r.teacherVerification ?? ''
    });
  }
  return out;
}

// Save an interview.
//
// payload = {
//   interviewId?, expectedVersion?, idempotencyKey?,
//   title, focus, history, teacherReview,               // teacher-editable
//   evidence, run: { analysis, runInputs, model } | null,// server-authoritative
//   runId?,                                              // target run for responses
//   responses: [{ questionId, editedQuestion, studentSelfReport, teacherVerification }]
// }
//
// When `run`/`evidence` are present a NEW run is created with its own immutable
// evidence. Responses are validated against the authoritative analysis of the
// target run (the new run, or `runId` for an edits-only save).
export async function saveInterview(payload) {
  const client = await getPool().connect();
  try {
    await client.query('begin');

    let interviewId = payload.interviewId;
    let newVersion;
    let idempotentReplay = false;

    if (!interviewId) {
      if (payload.idempotencyKey) {
        const existing = await client.query(
          'select id, version, request_fingerprint from interview where idempotency_key = $1',
          [payload.idempotencyKey]
        );
        if (existing.rowCount > 0) {
          // Payload-consistent idempotency: an identical retry replays the
          // committed record; a retry carrying CHANGED teacher-editable content
          // (a non-null incoming fingerprint that differs from the stored one)
          // must NOT silently replace or discard those edits — raise a conflict.
          // This is the transactional guard; the HTTP handler also checks earlier.
          const stored = existing.rows[0].request_fingerprint;
          const incoming = payload.requestFingerprint ?? null;
          if (incoming !== null && stored !== null && incoming !== stored) {
            throw new ConflictError(
              'This save was already committed with different content under the same request. Your current edits were NOT saved. Reopen the saved interview to merge, or save again as an explicit update.'
            );
          }
          interviewId = existing.rows[0].id;
          newVersion = existing.rows[0].version;
          idempotentReplay = true;
        }
      }
      if (!interviewId) {
        const ins = await client.query(
          `insert into interview (title, focus, history, teacher_review, idempotency_key, request_fingerprint, version)
           values ($1,$2,$3,$4,$5,$6,1) returning id, version`,
          [payload.title, payload.focus, payload.history ?? '', payload.teacherReview ?? '', payload.idempotencyKey ?? null, payload.requestFingerprint ?? null]
        );
        interviewId = ins.rows[0].id;
        newVersion = ins.rows[0].version;
      }
    }

    if (idempotentReplay) {
      await client.query('commit');
      return await openInterview(interviewId, null);
    }

    if (interviewId && newVersion === undefined) {
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
        const stillThere = await client.query('select version from interview where id = $1', [interviewId]);
        if (stillThere.rowCount === 0) throw new NotFoundError('Interview no longer exists.');
        throw new ConflictError(
          `This interview was changed elsewhere (server version ${stillThere.rows[0].version}, your version ${payload.expectedVersion}). Reopen it to continue without overwriting newer work.`
        );
      }
      newVersion = upd.rows[0].version;
    }

    // ---- New analysis run + its immutable evidence ----
    let runId = payload.runId ?? null;
    let authoritativeQuestions;
    if (payload.run) {
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
      authoritativeQuestions = payload.run.analysis.questions;

      // Evidence is written once, bound to this run, and never updated afterwards.
      const ev = payload.evidence;
      if (!ev) throw new ValidationError('A new run requires its evidence snapshot.');
      await client.query(
        `insert into evidence_snapshot
           (analysis_run_id, repository, commit_sha, source, retrieved_at, files, unread, excluded_entries)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [runId, ev.repository, ev.commitSha, ev.source, ev.retrievedAt,
         JSON.stringify(ev.files), JSON.stringify(ev.unread ?? []), ev.excludedEntries ?? 0]
      );
    } else if (runId) {
      // Edits-only save: load the target run's authoritative questions.
      const owns = await client.query(
        'select analysis from analysis_run where id = $1 and interview_id = $2',
        [runId, interviewId]
      );
      if (owns.rowCount === 0) throw new NotFoundError('Run does not belong to this interview.');
      authoritativeQuestions = owns.rows[0].analysis.questions;
    }

    // ---- Responses (validated against the authoritative question ids) ----
    if (runId && payload.responses !== undefined) {
      const rows = reconcileResponses(payload.responses, authoritativeQuestions || []);
      for (const r of rows) {
        await client.query(
          `insert into interview_response
             (analysis_run_id, question_id, original_question, edited_question, student_self_report, teacher_verification)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (analysis_run_id, question_id) do update set
             edited_question = excluded.edited_question,
             student_self_report = excluded.student_self_report,
             teacher_verification = excluded.teacher_verification`,
          [runId, r.questionId, r.originalQuestion, r.editedQuestion,
           r.studentSelfReport, r.teacherVerification]
        );
      }
    }

    // ---- Consume the durable draft once promoted to a run ----
    if (payload.run && payload.draftId) {
      await client.query('delete from analysis_draft where id = $1', [payload.draftId]);
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
// latest run). Returns the SELECTED run's own evidence and inputs so opening or
// exporting an older run reflects exactly what it was generated from.
export async function openInterview(interviewId, runId = null) {
  const pool = getPool();
  const iRes = await pool.query('select * from interview where id = $1', [interviewId]);
  if (iRes.rowCount === 0) throw new NotFoundError('Interview not found.');
  const interview = mapInterviewRow(iRes.rows[0]);

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

  let selectedRunId = runId;
  if (selectedRunId && !runs.some(r => r.id === selectedRunId)) {
    throw new NotFoundError('Requested run not found for this interview.');
  }
  if (!selectedRunId && runs.length) selectedRunId = runs[runs.length - 1].id;

  let selectedRun = null;
  let evidence = null;
  if (selectedRunId) {
    const full = await pool.query('select * from analysis_run where id = $1', [selectedRunId]);
    const resp = await pool.query(
      'select * from interview_response where analysis_run_id = $1 order by question_id',
      [selectedRunId]
    );
    const evRes = await pool.query('select * from evidence_snapshot where analysis_run_id = $1', [selectedRunId]);
    evidence = evRes.rowCount ? mapEvidenceRow(evRes.rows[0]) : null;
    selectedRun = {
      id: full.rows[0].id,
      runNumber: full.rows[0].run_number,
      analysis: full.rows[0].analysis,
      runInputs: full.rows[0].run_inputs,
      model: full.rows[0].model,
      createdAt: full.rows[0].created_at,
      evidence,
      responses: resp.rows.map(r => ({
        questionId: r.question_id,
        originalQuestion: r.original_question,
        editedQuestion: r.edited_question,
        studentSelfReport: r.student_self_report,
        teacherVerification: r.teacher_verification
      }))
    };
  }

  // `evidence` at the top level is the SELECTED run's evidence (back-compat for
  // callers/UI); null when the interview has no run yet.
  return { interview, evidence, runs, selectedRun };
}
