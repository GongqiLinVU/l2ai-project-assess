-- L2AI Project Assess — persistence schema (iteration 1)
--
-- Design goals (see README / docs/VALIDATION.md):
--   * Keep the schema small but preserve four distinct responsibilities.
--   * Server-generated evidence and validated analysis are authoritative; the
--     browser may only edit teacher-editable fields.
--   * New analysis creates a NEW analysis_run; it never overwrites an earlier run
--     or its responses.
--   * Responses are tied to a specific run and a stable question id, never matched
--     to new questions by array position.
--   * Optimistic concurrency via interview.version; idempotency via a save key.
--
-- Security: every application table enables RLS with NO policies. The Node server
-- connects directly as the postgres role (which bypasses RLS) through `pg`. The
-- anon / service_role PostgREST Data API therefore exposes nothing. Authentication
-- and authorization MUST be added before any external (non-loopback) deployment.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- interview: the editable container. One row per saved interview.
-- ---------------------------------------------------------------------------
create table interview (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (char_length(title) between 1 and 200),
  focus           text not null check (char_length(focus) between 1 and 6000),
  history         text not null default '' check (char_length(history) <= 6000),
  -- Stable client-supplied save identity used to deduplicate the first create
  -- from double-clicks / retries. Unique when present.
  idempotency_key text unique,
  -- Optimistic concurrency token. Incremented on every successful save. A stale
  -- browser tab submitting an old version is rejected with a conflict.
  version         integer not null default 1 check (version >= 1),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- evidence_snapshot: server-authoritative pinned evidence. 1:1 with interview.
-- Holds everything needed to reopen and export WITHOUT re-fetching GitHub.
-- ---------------------------------------------------------------------------
create table evidence_snapshot (
  interview_id   uuid primary key references interview(id) on delete cascade,
  repository     text not null,
  -- Full 40-char pinned commit SHA.
  commit_sha     text not null check (commit_sha ~ '^[a-f0-9]{40}$'),
  source         text not null,
  retrieved_at   timestamptz not null,
  -- Selected files: [{path, content, blobSha, sha256, lines}]. Actual source text
  -- is preserved so exports survive the round trip unchanged.
  files          jsonb not null,
  -- Unread eligible file paths (string[]) and the excluded tree-entry count that
  -- existing exports require.
  unread          jsonb not null default '[]'::jsonb,
  excluded_entries integer not null default 0,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- analysis_run: an immutable validated analysis. Many per interview.
-- A re-analysis inserts a new row; existing rows and their responses are kept.
-- ---------------------------------------------------------------------------
create table analysis_run (
  id             uuid primary key default gen_random_uuid(),
  interview_id   uuid not null references interview(id) on delete cascade,
  -- Monotonic per-interview label for the UI ("Run 1", "Run 2", ...).
  run_number     integer not null,
  -- Validated analysis: {summary, observations[], questions[], limitations[]}.
  -- Questions carry server-assigned stable ids (qid) used by interview_response.
  analysis       jsonb not null,
  -- Inputs used for THIS run, snapshotted so later focus/history edits cannot
  -- retroactively change a run: {focus, history, paths}.
  run_inputs     jsonb not null,
  -- Provenance: {mode:'mock'|'deepseek', name, returnedModel, usage, costUsd,
  -- estimate, analysedAt, durationMs}. mock vs real is explicit here.
  model          jsonb not null,
  created_at     timestamptz not null default now(),
  unique (interview_id, run_number)
);

create index analysis_run_interview_idx on analysis_run (interview_id, run_number);

-- ---------------------------------------------------------------------------
-- interview_response: teacher-editable answers, tied to a run + stable question.
-- ---------------------------------------------------------------------------
create table interview_response (
  id                   uuid primary key default gen_random_uuid(),
  analysis_run_id      uuid not null references analysis_run(id) on delete cascade,
  -- Stable question identifier (matches analysis.questions[].qid for this run).
  question_id          text not null,
  original_question    text not null,
  edited_question      text not null default '',
  student_self_report  text not null default '',
  teacher_verification text not null default '',
  created_at           timestamptz not null default now(),
  unique (analysis_run_id, question_id)
);

-- Overall per-interview teacher review (distinct from per-question verification).
-- Stored on the interview via a separate column to keep the model small.
alter table interview add column teacher_review text not null default '';

-- updated_at maintenance for interview.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger interview_set_updated_at
  before update on interview
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS lockdown: enable RLS with no policies on every application table so the
-- PostgREST Data API (anon/service_role) cannot read or write anything. The Node
-- server uses a direct postgres connection and bypasses RLS.
-- ---------------------------------------------------------------------------
alter table interview            enable row level security;
alter table evidence_snapshot    enable row level security;
alter table analysis_run         enable row level security;
alter table interview_response   enable row level security;

alter table interview            force row level security;
alter table evidence_snapshot    force row level security;
alter table analysis_run         force row level security;
alter table interview_response   force row level security;

-- Defence in depth: revoke Data API role grants on this schema's objects.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
