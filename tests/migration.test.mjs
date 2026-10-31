// Migration upgrade tests — populated-database (v0.2) → per-run evidence.
//
//   npm run test:migrate   (loads .env.test for the isolated loopback target)
//
// Verifies the DATA-PRESERVING upgrade (20261031000002) against a POPULATED v0.2
// database, not only a clean one:
//   * an UNAMBIGUOUS interview (exactly one run) keeps its interview, run,
//     responses and legacy evidence, with the evidence re-bound to that run;
//   * an AMBIGUOUS interview (legacy evidence + >1 run) causes the migration to
//     RAISE and ROLL BACK, preserving the original schema and all data, rather
//     than guessing which run the evidence belonged to.
//
// Uses throwaway `l2ai_migtest_*` databases on the isolated loopback host/port
// (never the dev DB or the Class Intake stack); assertThrowawayDbName guards every
// CREATE/DROP.

import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {maintenanceUrlForTests,assertThrowawayDbName,THROWAWAY_PREFIX} from './helpers/test-db-guard.mjs';

const MIG1 = new URL('../supabase/migrations/20261031000001_init_persistence.sql', import.meta.url);
const MIG2 = new URL('../supabase/migrations/20261031000002_per_run_evidence_and_drafts.sql', import.meta.url);

let maint;            // { url, host, port }
let adminPool;        // pool on the maintenance `postgres` database

before(async () => {
  maint = maintenanceUrlForTests();
  adminPool = new pg.Pool({ connectionString: maint.url, max: 2 });
});
after(async () => { if (adminPool) await adminPool.end(); });

// Create a fresh throwaway database and return a connection string to it.
async function freshDb(suffix) {
  const name = assertThrowawayDbName(THROWAWAY_PREFIX + suffix);
  await adminPool.query(`drop database if exists ${name}`);
  await adminPool.query(`create database ${name}`);
  const url = new URL(maint.url); url.pathname = '/' + name;
  return { name, url: url.href };
}
async function dropDb(name) {
  assertThrowawayDbName(name);
  await adminPool.query(`drop database if exists ${name}`);
}
async function runSqlFile(connStr, fileUrl) {
  const sql = await readFile(fileUrl, 'utf8');
  const c = new pg.Client({ connectionString: connStr });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}
async function withClient(connStr, fn) {
  const c = new pg.Client({ connectionString: connStr });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

test('populated v0.2 UNAMBIGUOUS upgrade preserves interview, run, answers and legacy evidence', async () => {
  const db = await freshDb('unambiguous');
  try {
    await runSqlFile(db.url, MIG1);
    // Seed a v0.2 interview with exactly ONE run + a response + interview-keyed
    // (legacy) evidence.
    await withClient(db.url, async c => {
      await c.query(`insert into interview (id,title,focus,history,teacher_review,version)
        values ('11111111-1111-1111-1111-111111111111','Legacy','focus L','hist L','review L',4)`);
      await c.query(`insert into analysis_run (id,interview_id,run_number,analysis,run_inputs,model)
        values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',1,
        '{"summary":"s","observations":[],"questions":[{"qid":"q1","text":"Q one","why":"w","intent":"i","evidence":[]}],"limitations":[]}',
        '{"focus":"focus L","history":"hist L","paths":["README.md"]}','{"mode":"mock","name":"deterministic-template-v1"}')`);
      await c.query(`insert into interview_response (analysis_run_id,question_id,original_question,edited_question,student_self_report,teacher_verification)
        values ('aaaaaaaa-0000-0000-0000-000000000001','q1','Q one','Q one edited','legacy answer','legacy verif')`);
      await c.query(`insert into evidence_snapshot (interview_id,repository,commit_sha,source,retrieved_at,files,unread,excluded_entries)
        values ('11111111-1111-1111-1111-111111111111','GongqiLinVU/milestoneproject','b098b353492c273004ca496cdbf7c0f1e1855dd7','offline',now(),
        '[{"path":"README.md","content":"legacy content","blobSha":"abc","sha256":"deadbeef","lines":1}]','["other.ts"]',5)`);
    });

    await runSqlFile(db.url, MIG2);   // the data-preserving upgrade

    await withClient(db.url, async c => {
      assert.equal((await c.query('select count(*) from interview')).rows[0].count, '1', 'interview preserved');
      assert.equal((await c.query('select count(*) from analysis_run')).rows[0].count, '1', 'run preserved');
      const resp = (await c.query('select * from interview_response')).rows[0];
      assert.equal(resp.student_self_report, 'legacy answer', 'answer preserved');
      assert.equal(resp.teacher_verification, 'legacy verif');
      // Evidence is now keyed on analysis_run_id and bound to the single run.
      const cols = (await c.query(`select column_name from information_schema.columns where table_name='evidence_snapshot'`)).rows.map(r => r.column_name);
      assert.ok(cols.includes('analysis_run_id') && !cols.includes('interview_id'), 'evidence re-keyed to run');
      const ev = (await c.query('select * from evidence_snapshot')).rows;
      assert.equal(ev.length, 1, 'evidence row preserved');
      assert.equal(ev[0].analysis_run_id, 'aaaaaaaa-0000-0000-0000-000000000001', 'bound to the correct run');
      assert.equal(ev[0].repository, 'GongqiLinVU/milestoneproject');
      assert.equal(ev[0].files[0].content, 'legacy content', 'source text preserved');
      // Verbatim archive retained for recovery.
      assert.equal((await c.query('select count(*) from evidence_snapshot_legacy')).rows[0].count, '1', 'legacy archive kept');
      // New draft table present.
      assert.equal((await c.query(`select count(*) from information_schema.tables where table_name='analysis_draft'`)).rows[0].count, '1');
    });
  } finally { await dropDb(db.name); }
});

test('populated v0.2 AMBIGUOUS upgrade (legacy evidence + >1 run) raises and rolls back without data loss', async () => {
  const db = await freshDb('ambiguous');
  try {
    await runSqlFile(db.url, MIG1);
    await withClient(db.url, async c => {
      await c.query(`insert into interview (id,title,focus,history,version)
        values ('22222222-2222-2222-2222-222222222222','Ambiguous','focus A','',1)`);
      await c.query(`insert into analysis_run (id,interview_id,run_number,analysis,run_inputs,model)
        values ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',1,
        '{"questions":[{"qid":"q1","text":"B1"}]}','{"focus":"focus A","history":"","paths":[]}','{"mode":"mock"}')`);
      await c.query(`insert into analysis_run (id,interview_id,run_number,analysis,run_inputs,model)
        values ('bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222',2,
        '{"questions":[{"qid":"q1","text":"B2"}]}','{"focus":"focus A","history":"","paths":[]}','{"mode":"mock"}')`);
      await c.query(`insert into evidence_snapshot (interview_id,repository,commit_sha,source,retrieved_at,files)
        values ('22222222-2222-2222-2222-222222222222','GongqiLinVU/milestoneproject','b098b353492c273004ca496cdbf7c0f1e1855dd7','offline',now(),
        '[{"path":"README.md","content":"ambiguous"}]')`);
    });

    // Migration must RAISE (ambiguous) and the whole transaction rolls back.
    await assert.rejects(() => runSqlFile(db.url, MIG2), /Ambiguous legacy evidence mapping/);

    await withClient(db.url, async c => {
      // Original schema intact: evidence still interview-keyed; no new tables.
      const cols = (await c.query(`select column_name from information_schema.columns where table_name='evidence_snapshot'`)).rows.map(r => r.column_name);
      assert.ok(cols.includes('interview_id') && !cols.includes('analysis_run_id'), 'old schema preserved after rollback');
      assert.equal((await c.query(`select count(*) from information_schema.tables where table_name='analysis_draft'`)).rows[0].count, '0', 'no analysis_draft created');
      assert.equal((await c.query(`select count(*) from information_schema.tables where table_name='evidence_snapshot_legacy'`)).rows[0].count, '0', 'no archive created (rolled back)');
      // All data preserved.
      assert.equal((await c.query('select count(*) from analysis_run')).rows[0].count, '2', 'both runs preserved');
      assert.equal((await c.query('select count(*) from evidence_snapshot')).rows[0].count, '1', 'legacy evidence preserved');
    });
  } finally { await dropDb(db.name); }
});
