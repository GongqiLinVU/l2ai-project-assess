# Local validation and review — 31 October 2026 (Melbourne)

## What was checked

| Check | Result / boundary |
| --- | --- |
| New repository inspection | GitHub plugin metadata and contents confirmed public empty repository, default `main`; no remote README or AGENTS.md existed. No pre-existing local code or applicable ancestor AGENTS.md. |
| Evidence acquisition | GitHub plugin resolved milestoneproject main to `b098b353492c273004ca496cdbf7c0f1e1855dd7`, read the recursive tree and three complete files. No writes or assessed-code execution. |
| Snapshot integrity | Independently recomputed Git blob SHA-1 for all three cached files (Git `blob <bytes>\0<content>` format); all matched the pinned tree. SHA-256 recorded in interview exports. |
| Core tests | `npm test`: 5 test cases passed. Covers source/URL boundaries, mock workflow, invented/mismatched evidence rejection, paid gate and synthetic provider responses, pinned live transport with synthetic HTTP responses, and API validation. No paid requests. |
| Live GitHub API | Actual public API resolved the same SHA, listed eligible text files and fetched `src/intakeStart.ts` by blob SHA. No token used. |
| Offline browser flow | Passed desktop 1440×1000 and mobile 390×844. Three actual cached files, synthetic history, four mock questions, teacher edit, synthetic student answer, teacher verification, JSON and Markdown downloads. Export assertions checked original/edited question, self-report, review, complete sources and fixed SHA. |
| Live browser flow | Passed with `LIVE_GITHUB=1`: live resolve → select README, implementation and test file → retrieve all three blobs → validated mock interview. Model mode remained mock. |
| UI checks | No browser page errors or mobile horizontal overflow. Inspected desktop/mobile screenshots. Untrusted HTML displayed as text. Changing focus invalidated the previous interview. Source controls are disabled during requests to prevent a stale result being presented for newer inputs. |
| Application startup | Own app started successfully through the local HTTP server in the API and browser tests; `npm start` also smoke-tested. |
| Model compatibility | DeepSeek-compatible request formatting, disabled-paid gate and output schema validated against synthetic HTTP responses only. No real provider request, price verification or model-quality evaluation. |

Browser validation used the installed Playwright module and an official Chrome for Testing headless-shell 145.0.7632.6 executable. The standard Playwright browser download returned a 195-byte HTML response, so an official Google storage download was used instead. That browser installation is an environment test tool, not an application dependency.

Reproduce in a machine with Playwright/Chromium installed:

```bash
npm test
npm run test:ui
# Optional: makes public GitHub reads, still uses mock analysis by default.
LIVE_GITHUB=1 npm run test:ui
```

Optional environment overrides: `PLAYWRIGHT_MODULE` (module entry path), `CHROMIUM_EXECUTABLE` (browser executable). No assessed-repository dependencies are installed.

## Actual rehearsal content

- Fixed repository: `GongqiLinVU/milestoneproject`
- Fixed SHA: `b098b353492c273004ca496cdbf7c0f1e1855dd7`
- Selected complete files: `README.md`, `src/intakeStart.ts`, `tests/ai-session-intake/adaptive/intake-start.test.mjs`
- Source byte sizes: 7,197; 8,145; 4,733 respectively. No tests from this repository were executed.
- The source declares session-specific opening helpers; the test file defines checks. This inspection does not establish runtime integration, successful execution, deployment state or who contributed the code.
- History and student response entered in the browser test were explicitly synthetic. No real student records were used.
- Generated `exports/demo-interview.json`, `exports/demo-interview.md`, `exports/interview-desktop.png`, `exports/interview-mobile.png` are local review examples, ignored by Git.

With the default focus and these three files, the current estimator reports roughly **7,222–30,886 input tokens**, maximum **2,500 output tokens**, one request and no retries. This intentionally broad heuristic includes numbered source text, not a verified model tokenizer count. Prices are unconfigured, so estimated USD cost is **unknown**. No paid call is authorized or made. Re-estimate with the actual intended focus/history, verified model context limits and rates before requesting authorization.

## Initial implementation change summary

At the first local delivery, the remote was empty and all application files were new and untracked. The user subsequently authorized publishing the source to this repository for local cloning. Interview exports and environment secrets are excluded. No deployment, production database operations or modifications to milestoneproject were performed.

| Files | Review purpose |
| --- | --- |
| `server.mjs` | Loopback HTTP service; ephemeral snapshot IDs; API request/origin/body validation; source loading and analysis orchestration |
| `lib/github.mjs` | Public repository parsing/resolution, pinned tree/blob retrieval, offline fixture loading |
| `lib/evidence.mjs` | File limits, exclusion and credential heuristics, text digests, strict source citation checks, labelled mock template |
| `lib/model.mjs` | Configurable server-only provider adapter, paid gate, estimate and actual usage metadata |
| `public/` | File selection, focus/history entry, interview edits and student answers, teacher notes, browser exports |
| `fixtures/milestoneproject.json` | Actual public source snapshot, GitHub plugin provenance and complete tree metadata |
| `tests/` | Core/API tests and reproducible real-browser rehearsal |
| `README.md`, `.env.example`, `.gitignore`, `package.json`, `AGENTS.md`, `docs/VALIDATION.md` | Setup, boundaries, configuration and review instructions |

## Remaining work

1. Review estimated usage and explicitly authorize a small real-model trial. Verify provider API/model settings and prices first. Measure question usefulness and citation relevance, not just JSON validity.
2. Answer-to-evidence handling currently links answers to their question's original source basis and provides teacher verification fields. It does not ask a model to corroborate answers or automatically classify their truth. Edited questions retain original rationale/references with a review notice.
3. All summaries are provisional; exact source quotations do not prove semantic support. Teacher review is required for model inferences, outdated documentation and test/runtime claims. Secret scanning and prompt-injection mitigation are best effort.
4. There is no durable interview storage, resume import, formal session model or automatic historical comparison. Export before leaving the tab. Pasted previous-session text preserves the later-validation entry point.
5. Private repos, student accounts, multi-tenancy, speech, scores, author/contribution checks and production integrations remain outside scope. Do not deploy this loopback prototype as a public service.

---

## Persistence iteration — local validation (31 October 2026, Melbourne)

### Environment verified before changes

| Check | Result |
| --- | --- |
| Starting point | Branch `main`, HEAD `8645654` ("Implement local evidence-based assessment interview prototype"). Working tree clean apart from an untracked `.claude/` tooling directory (left untouched). |
| Prior persistence | Confirmed by reading the code: `server.mjs` kept repository snapshots in an in-memory `Map`; the interview record and answers lived only in the browser until exported. No database existed. |
| Docker / isolation | Docker started. A full **Class Intake** Supabase stack (`supabase_*_milestoneproject`, DB on 54322, API 54321, Studio 54323, analytics 54327) and `l2ai-leads-db` (54328) were already running. This iteration created a **separate** project (`project_id = l2ai_project_assess`) on the free 54341–54343 block. Both stacks run simultaneously; the 11 milestoneproject containers were never stopped, reset, or modified. |

### Persistence checks

| # | Check | Result |
| --- | --- | --- |
| 1 | Migration applies to a clean, isolated database | **Passed.** `supabase start` applied `20261031000001_init_persistence.sql` cleanly; independently re-applied to two throwaway databases (`l2ai_assess_test`, `l2ai_migcheck`) with `ON_ERROR_STOP=1`. Result: 4 tables, all 4 with RLS enabled. |
| 2 | Save and reopen a prepared mock interview | **Passed.** `npm run test:db` + the HTTP walkthrough save a demo-fixture mock interview and reopen it from a fresh read. |
| 3 | Reload/restart preserves saved content | **Passed.** Browser walkthrough reloads the page (clearing in-memory state) and reopens from the saved list; title, answers and notes return. The HTTP walkthrough reopens via a fresh `/api/open` with no in-memory handle. |
| 4 | Selected source contents and hashes survive the round trip | **Passed.** `test:db` asserts file `content` and `sha256` are byte-identical after save → reopen. |
| 5 | Edited questions, answers and teacher notes survive | **Passed.** `test:db` round-trips edited question, student self-report and teacher verification by stable question id. |
| 6 | Repeated/retried creation does not duplicate | **Passed.** `test:db` saves twice with one `idempotency_key`; one interview, one run. |
| 7 | Stale updates rejected without overwriting | **Passed.** `test:db` and the HTTP walkthrough: an update on an old `version` throws `ConflictError` / returns HTTP `409`; newer work is intact. |
| 8 | Failed multi-record save leaves no partial state | **Passed.** `test:db` forces the `evidence_snapshot` CHECK to fail after the interview insert; the transaction rolls back and no interview row remains (the idempotency key is reusable). |
| 9 | Re-analysis preserves the previous run and its answers | **Passed.** `test:db` and the HTTP/browser walkthroughs: a new analysis inserts a new run; the earlier run and its recorded answer remain selectable. |
| 10 | Reopened interviews export equivalent substantive content | **Passed.** The browser walkthrough exports JSON from a reopened record and asserts `interviewId`, `analysisRunId` and the `unsavedEdits` label; evidence (repository, full SHA, source files, hashes) comes from the stored snapshot. |
| 11 | Database unavailability produces an accurate error | **Passed.** `/api/db/health` reports `{enabled, ok}`; the UI banner shows "Database unreachable" and disables/fails saving. `test:db` asserts a pool pointed at a closed port rejects. No silent memory fallback. |
| 12 | Existing mock / evidence / paid-call gating tests still pass | **Passed.** `npm test` = 5/5 after the `server.mjs` rewrite. |

### Commands used

```bash
npm test                      # 5/5 core tests pass (no DB)
npm run test:db               # 8/8 persistence tests pass (disposable l2ai_assess_test)
npm run test:ui               # core browser walkthrough: PASS
node --env-file-if-exists=.env.test tests/browser-persistence.mjs   # persistence browser walkthrough: PASS
```

Browser runs used Playwright `1.64.1` (installed with `--no-save` outside the project and referenced via a temporary symlink that was removed afterwards) and the cached official **Chrome for Testing** build `chromium-1248`. No assessed-repository code or dependencies were installed or executed.

### Integrity design (server-authoritative save)

`/api/analyse` mints a short-lived `analysisToken` and caches the validated analysis, provenance and server-generated evidence in memory. `/api/save` reads evidence/analysis/provenance from that token, **not** from the browser; the HTTP test proves a forged `files:[{path:'evil.ts'...}]` in the save body is ignored. Only teacher-editable fields (title, focus, history, review, and per-question responses) and optimistic-concurrency/idempotency controls are accepted from the client. Every table enables RLS with no policies, so the Supabase Data API exposes nothing; the server connects directly via `pg`.

### Design decisions needing review

- **Re-analysis as a UI action.** Preparing an interview always creates a new saved interview (run 1). Adding another run to an *existing* interview is implemented and tested at the API/DB layer, but is deliberately **not** a one-click UI control this iteration: generating a run needs the source reloaded after a restart, and a one-click path risks mis-attaching answers to a different run. Run **selection** of multi-run interviews is in the UI.
- **`npm install` now required.** One pinned dependency (`pg@8.23.1`) was added; the app is no longer zero-dependency. No assessed-repo dependency was added.
- **Local credentials.** The local `DATABASE_URL` uses the Supabase CLI default `postgres:postgres` on loopback. Authentication/authorization are not implemented and are required before any non-loopback deployment.

### Not run / out of scope this iteration

- No hosted Supabase link, deployment, remote database, or paid model call was performed.
- `LIVE_GITHUB=1` browser path was not re-run in this iteration (unchanged from the prior validation); the offline pinned fixture was used throughout.
