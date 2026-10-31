-- L2AI Project Assess — persistence schema revision (iteration 1, review fixes)
--
-- Addresses two review findings, DATA-PRESERVINGLY (replaces the earlier
-- destructive drop-and-recreate; see docs/VALIDATION.md "Recovery notes"):
--
--   Finding 1 (per-run immutable evidence): evidence_snapshot was 1:1 with the
--   interview (keyed on interview_id) and upserted on every save, so adding a new
--   analysis run OVERWROTE the evidence older runs were generated from. Evidence
--   is now bound 1:1 to an analysis_run and never mutated after the run is
--   written. Opening/exporting any run uses that run's own repository, commit,
--   files, focus and history (focus/history already live in run_inputs).
--
--   Finding 4 (durable prepared drafts): a freshly prepared analysis previously
--   lived only in an in-memory cache keyed by a token, so the first save was
--   impossible after token expiry or an application restart. A durable
--   analysis_draft table now persists the server-authoritative evidence, validated
--   analysis, provenance and inputs so the first save survives a restart.
--
-- UPGRADE SAFETY
-- --------------
-- This migration UPGRADES a populated v0.2 database in place. It preserves
-- interviews, analysis runs, responses and legacy evidence. Legacy evidence is
-- attached to a historical run ONLY when the mapping is UNAMBIGUOUS — i.e. the
-- interview has exactly one run, so there is a single, provenance-sound target.
--
-- It refuses to guess. If any interview that carries legacy evidence has more
-- than one run (ambiguous: we cannot know which run the single legacy snapshot
-- belonged to), the migration RAISES and rolls back, naming the offending
-- interviews, rather than silently assigning evidence to the wrong run. Resolve
-- such cases explicitly (see docs/VALIDATION.md) before re-running.
--
-- Legacy evidence that cannot be attached without guessing is NOT discarded: it
-- is copied verbatim into evidence_snapshot_legacy for manual review/recovery.

begin;

-- ---------------------------------------------------------------------------
-- 0. Preserve a verbatim copy of ALL legacy (interview-keyed) evidence first.
--    This is the recovery source of truth; nothing below deletes from it.
-- ---------------------------------------------------------------------------
create table evidence_snapshot_legacy as
  select *, now() as archived_at from evidence_snapshot;

comment on table evidence_snapshot_legacy is
  'Verbatim archive of the v0.2 interview-keyed evidence_snapshot, captured during the per-run evidence upgrade. Retained for manual review/recovery of any evidence that was not unambiguously attachable to a single run.';

-- ---------------------------------------------------------------------------
-- 1. Refuse to proceed on AMBIGUOUS mappings (legacy evidence + >1 run).
--    Stop loudly instead of assigning evidence to the wrong historical run.
-- ---------------------------------------------------------------------------
do $$
declare
  ambiguous text;
begin
  select string_agg(e.interview_id::text, ', ')
    into ambiguous
    from evidence_snapshot e
    join (
      select interview_id, count(*) as n
        from analysis_run
       group by interview_id
    ) rc on rc.interview_id = e.interview_id
   where rc.n > 1;

  if ambiguous is not null then
    raise exception
      'Ambiguous legacy evidence mapping: interview(s) % have multiple runs but only one legacy evidence snapshot. Refusing to guess which run it belonged to. Resolve explicitly (see docs/VALIDATION.md) then re-run. A verbatim copy is preserved in evidence_snapshot_legacy.',
      ambiguous;
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 2. Build the new per-run evidence_snapshot and backfill the UNAMBIGUOUS rows
--    (interview has exactly one run => single sound target).
-- ---------------------------------------------------------------------------
alter table evidence_snapshot rename to evidence_snapshot_v0;

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

-- Backfill: each legacy snapshot whose interview has exactly one run is attached
-- to that run. (Interviews with >1 run were already rejected above; interviews
-- with 0 runs have no target and remain only in the archive.)
insert into evidence_snapshot
  (analysis_run_id, repository, commit_sha, source, retrieved_at, files, unread, excluded_entries, created_at)
select r.id, e.repository, e.commit_sha, e.source, e.retrieved_at, e.files, e.unread, e.excluded_entries, e.created_at
  from evidence_snapshot_v0 e
  join analysis_run r on r.interview_id = e.interview_id
 where (select count(*) from analysis_run ar where ar.interview_id = e.interview_id) = 1;

-- Record any legacy evidence that had NO run to attach to (orphan) for review.
-- It is already in evidence_snapshot_legacy; this is just an explicit flag.
do $$
declare
  orphans integer;
begin
  select count(*) into orphans
    from evidence_snapshot_v0 e
   where not exists (select 1 from analysis_run r where r.interview_id = e.interview_id);
  if orphans > 0 then
    raise notice
      '% legacy evidence snapshot(s) had no analysis_run to attach to and were left only in evidence_snapshot_legacy for manual review.',
      orphans;
  end if;
end$$;

-- The transitional copy is no longer needed; the verbatim archive remains.
drop table evidence_snapshot_v0;

-- ---------------------------------------------------------------------------
-- 3. Durable prepared drafts (restart-safe first save).
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

create index analysis_draft_created_idx on analysis_draft (created_at);

-- ---------------------------------------------------------------------------
-- RLS lockdown for the new/rebuilt/archived tables (no policies; server uses
-- the postgres role which bypasses RLS).
-- ---------------------------------------------------------------------------
alter table evidence_snapshot        enable row level security;
alter table evidence_snapshot        force row level security;
alter table evidence_snapshot_legacy enable row level security;
alter table evidence_snapshot_legacy force row level security;
alter table analysis_draft           enable row level security;
alter table analysis_draft           force row level security;

revoke all on evidence_snapshot        from anon, authenticated;
revoke all on evidence_snapshot_legacy from anon, authenticated;
revoke all on analysis_draft           from anon, authenticated;

commit;
