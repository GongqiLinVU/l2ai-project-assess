-- L2AI Project Assess — payload-consistent idempotency (first-save retry fix)
--
-- The first save stores the interview under a client idempotency_key so a lost
-- response can be retried without creating a duplicate. But an idempotency key
-- must identify a SPECIFIC request, not just "any save with this key". Without a
-- stored request identity, a retry that carries CHANGED teacher-editable content
-- (e.g. the teacher edited an answer after the lost response) was being treated
-- as an identical retry: the old record was returned and the edits silently
-- discarded while the UI reported "Saved".
--
-- This migration persists a fingerprint of the teacher-editable content captured
-- at first-save time, so retries can be compared AFTER a server restart:
--   * identical retry  (fingerprint matches) -> return the committed record;
--   * changed retry    (fingerprint differs) -> the server returns a conflict
--     instead of silently discarding the edits.
--
-- The fingerprint is derived server-side from title, focus, history,
-- teacher_review and the normalised responses. It is content for comparison only
-- (not a secret) and carries no source text.

begin;

alter table interview
  add column if not exists request_fingerprint text;

comment on column interview.request_fingerprint is
  'SHA-256 of the teacher-editable payload (title, focus, history, teacher_review, normalised responses) captured at first save under this idempotency_key. Used to make first-save retries payload-consistent: an identical retry returns the committed record; a changed retry is rejected with a conflict rather than discarding edits.';

commit;
