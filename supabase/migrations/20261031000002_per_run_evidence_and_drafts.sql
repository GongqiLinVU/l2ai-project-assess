-- L2AI Project Assess — persistence schema revision (iteration 1, review fixes)
--
-- Addresses two review findings:
--
--   Finding 1 (per-run immutable evidence): evidence_snapshot was 1:1 with the
--   interview and upserted on every save, so adding a new analysis run OVERWROTE
--   the evidence that older runs were generated from. Evidence is now bound 1:1 to
--   an analysis_run and never mutated after the run is written. Opening or
--   exporting any run uses that run's own repository, commit, files, focus and
--   history (focus/history already live in analysis_run.run_inputs).
--
--   Finding 4 (durable prepared drafts): a freshly prepared analysis previously
--   lived only in an in-memory cache keyed by a token, so the first save was
--   impossible after token expiry or an application restart. A durable
--   analysis_draft table now persists the server-authoritative evidence, validated
--   analysis, provenance and inputs so the first save survives a restart without
--   regenerating questions. Drafts are deleted once promoted to a saved run.
--
-- This branch has no deployed data, so the migration rebuilds evidence_snapshot
-- rather than performing a data-preserving backfill.

-- ---------------------------------------------------------------------------
-- 1. Rebind evidence to the analysis_run (immutable per run).
-- ---------------------------------------------------------------------------
drop table if exists evidence_snapshot;

create table evidence_snapshot (
  -- 1:1 with a run. Deleting a run deletes its evidence; runs are never updated,
  -- so a run's evidence is effectively immutable once written.
  analysis_run_id  uuid primary key references analysis_run(id) on delete cascade,
  repository       text not null,
  commit_sha       text not null check (commit_sha ~ '^[a-f0-9]{40}$'),
  source           text not null,
  retrieved_at     timestamptz not null,
  files            jsonb not null,
  unread           jsonb not null default '[]'::jsonb,
  excluded_entries integer not null default 0,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Durable prepared drafts (restart-safe first save).
-- ---------------------------------------------------------------------------
create table analysis_draft (
  id          uuid primary key default gen_random_uuid(),
  -- Server-authoritative evidence for the prepared run (same shape as the run's
  -- evidence_snapshot): {repository, commitSha, source, retrievedAt, files,
  -- unread, excludedEntries}.
  evidence    jsonb not null,
  -- Validated analysis with stable question ids.
  analysis    jsonb not null,
  -- Inputs used to generate the draft: {focus, history, paths}.
  run_inputs  jsonb not null,
  -- Provenance (mock vs real, model, usage/cost, timings).
  model       jsonb not null,
  created_at  timestamptz not null default now()
);

-- Housekeeping index for pruning old drafts by age.
create index analysis_draft_created_idx on analysis_draft (created_at);

-- ---------------------------------------------------------------------------
-- RLS lockdown for the new/rebuilt tables (no policies; server uses postgres).
-- ---------------------------------------------------------------------------
alter table evidence_snapshot enable row level security;
alter table evidence_snapshot force row level security;
alter table analysis_draft    enable row level security;
alter table analysis_draft    force row level security;

revoke all on evidence_snapshot from anon, authenticated;
revoke all on analysis_draft    from anon, authenticated;
