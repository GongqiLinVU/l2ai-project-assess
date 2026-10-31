# L2AI Project Assess

A local teacher workspace for one public GitHub repository and one assessment interview. Start from selected project materials, prepare evidence-linked questions, record student answers, and export a reviewable interview record. No automatic grading or authorship determination.

## Repository inspection and implementation choice

On 31 October 2026 (Melbourne), the GitHub plugin reported `GongqiLinVU/l2ai-project-assess` as public, empty, size 0, default branch `main`. The contents endpoint explicitly returned “This repository is empty.” There was no README or repository AGENTS.md to retain. No applicable AGENTS.md was found in the workspace ancestors. A new project AGENTS.md records the boundaries for future work. The initial local prototype was subsequently authorized for publication to this repository.

Node.js 22.9+ (tested on 24.22.1), native HTTP/fetch, and plain HTML/CSS/JavaScript keep this experiment small. This persistence iteration adds one application dependency (`pg`) and a local database: a project-specific [Supabase](https://supabase.com/docs/guides/local-development) stack running through Docker, isolated from Engineering Studio / Class Intake. The server binds only to IPv4 loopback. This is a local prototype, not an Internet-facing service.

## Run locally

Prerequisites: Docker running, and the [Supabase CLI](https://supabase.com/docs/guides/cli) installed.

```bash
git clone https://github.com/GongqiLinVU/l2ai-project-assess.git
cd l2ai-project-assess
cp .env.example .env
npm install          # installs pg (pinned); still no assessed-repo dependencies
npm run db:start     # starts the isolated local Supabase stack + applies migrations
npm start
```

Open **http://127.0.0.1:3400** (use this address, not `localhost`). Default mode is `mock`. Nothing connects to Intake, its Supabase project, or any production database.

Local database lifecycle:

| Command | Action |
| --- | --- |
| `npm run db:start` | Start the isolated Supabase stack (project `l2ai_project_assess`, ports 54341–54343) and apply migrations. |
| `npm run db:migrate` | Apply new migrations to the running local database. |
| `npm run db:stop` | Stop this project's stack only. It does not touch the Class Intake stack. |
| `npm run db:reset` | Drop and recreate the **local dev** database from migrations. Destructive to local dev data only; never run against shared data. |

The stack is deliberately isolated: a distinct `project_id` and the 54341–54343 port block avoid the Class Intake stack (`milestoneproject`, ports 54321–54327) and `l2ai-leads-db` (54328), so both can run at once. `DATABASE_URL` in `.env` points the server at the local database via a direct Postgres connection. If `DATABASE_URL` is blank the app still runs, but saving is disabled and interviews stay in the browser tab only.

If you prefer to run without a database (original behaviour), leave `DATABASE_URL` blank; `npm install` is then only needed if you want the `pg` module present.

1. Enter `https://github.com/owner/repository` and click **Load live repository**. The server resolves the default branch once to a commit SHA and lists eligible files at that SHA. No GitHub login or token is used; only public repositories work.
2. Select 1–5 small text files. Set an assessment focus or short rubrics. Optionally paste previous session text.
3. Click **Prepare interview**. Review the provisional understanding, typed observations and exact source quotes, questions, reasons, desired understanding and limitations.
4. Edit questions, enter student answers, and add teacher verification or unresolved points. Question references identify the basis of a question; they do not corroborate its answer.
5. Give the interview a **title** and click **Save interview** to store it in the local database. The save-state indicator shows *Unsaved → Saving… → Saved*, or *Conflict* / *Save failed*. Saving never reports success before persistence completes.
6. Close the tab or restart the app, then reopen the interview from **Saved interviews (00)** and continue editing. Use the **Analysis run** selector to inspect earlier runs; each run keeps its own answers. **New interview** clears the workspace.
7. Export JSON and/or Markdown. JSON includes complete selected source text, Git blob SHA and SHA-256 digests, original and edited questions, answers, teacher notes, history, unread eligible files, provenance and model metadata, plus the interview and analysis-run identifiers. If the current edits are unsaved, the export is explicitly labelled as including unsaved edits. Export does not save to the database.

Changing source selection, repository URL, focus or history invalidates the displayed analysis and (with unsaved edits) prompts before discarding. Snapshot handles expire after 30 minutes (20 snapshots maximum); reload to continue. A browser exit warning is shown only when there are unsaved edits.

## Local persistence

Saving stores the interview in the isolated local database so it survives tab reloads and application restarts. The schema is four small tables (version-controlled migrations are the source of truth):

- **interview** — title, assessment focus, pasted history, overall teacher review, timestamps, a `version` column for optimistic concurrency, and a unique `idempotency_key` that deduplicates a first save from double-clicks or retries.
- **evidence_snapshot** (1:1) — repository, full pinned commit SHA, source/retrieval metadata, and the actual selected file contents with Git blob SHAs and SHA-256 digests (JSONB), plus unread/excluded metadata. Reopening and exporting use this snapshot; GitHub is not re-fetched.
- **analysis_run** (many per interview) — the validated original analysis and questions with their source references (JSONB), the inputs used for that run, mock-vs-real provenance, model identifier, analysis time and any usage/cost. A new analysis inserts a new run; earlier runs and their answers are never overwritten.
- **interview_response** — teacher-editable answers tied to a specific run and a stable question id (not array position): original question, edited question, student self-report and teacher verification.

Integrity: server-generated evidence and validated analysis are authoritative. `/api/save` reads them from a server-side handle minted by `/api/analyse`, never from browser-submitted source text or provenance; only teacher-editable fields and responses are accepted from the client. Related records are written in a single transaction (a failed save leaves no partial interview). A stale browser tab receives a `409` conflict instead of overwriting newer work. There is no silent fall-back to memory-only storage.

Every application table has row-level security enabled with no policies, so the Supabase Data API (anon/service roles) exposes nothing; the server uses a direct Postgres connection. **Authentication and authorization are not implemented and are required before any external (non-loopback) deployment.** This remains single-teacher local scope: no accounts, multi-tenancy or production hardening.

Adding a new analysis run to an **existing** saved interview is supported by the server and covered by tests, but is not a one-click UI action in this iteration: generating a run needs the source reloaded after a restart, and a one-click path risks mis-attaching answers. Preparing an interview always starts a new saved interview (run 1). Earlier runs of interviews that already have several are selectable in the UI.

## Offline mock rehearsal with real public material

Click **Use offline demo** with the prefilled milestoneproject URL. Three complete files are selected automatically:

- `README.md`
- `src/intakeStart.ts`
- `tests/ai-session-intake/adaptive/intake-start.test.mjs`

These are actual files read using the GitHub plugin, pinned to **b098b353492c273004ca496cdbf7c0f1e1855dd7**. `fixtures/milestoneproject.json` stores the file text, tree and source blob SHAs with retrieval metadata. Only those three files have cached content; other eligible tree entries are shown as unavailable offline. No code from milestoneproject was executed or modified. Its instructions are source data, not development instructions for this project.

Mock output is a deterministic, explicitly labelled template. It extracts exact lines and offers four generic prompts tied to those lines and the teacher's focus. It does **not** perform project understanding, assess a student's answer, or provide validated AI reasoning. Enter a synthetic answer and teacher note, then export to rehearse the whole workflow without any paid calls.

## DeepSeek adapter and paid-call boundary

The implementation supports a configurable OpenAI-compatible `/chat/completions` endpoint. No current DeepSeek model name, API URL, context limit or price is assumed. Verify these with the provider before configuring a real trial. Production provider compatibility and real model output quality remain unverified.

Server-only `.env` settings:

| Setting | Purpose |
| --- | --- |
| `MODEL_MODE` | `mock` (default) or `deepseek` |
| `MODEL_BASE_URL` | Verified HTTPS API base, including version path if required; omit `/chat/completions` |
| `MODEL_NAME` | Verified model identifier |
| `MODEL_API_KEY` | Server-only key; never sent to the browser or exports |
| `ENABLE_PAID_CALLS` | Must explicitly be `true` after authorization; default `false` |
| `MODEL_MAX_OUTPUT_TOKENS` | 500–8,000, default 2,500 |
| `MODEL_INPUT_USD_PER_MILLION` | Optional verified input rate; blank means unknown |
| `MODEL_OUTPUT_USD_PER_MILLION` | Optional verified output rate; blank means unknown |
| `PORT` | Local port, default 3400 |

Before any real trial, use **Estimate model usage** for the actual selected files/focus/history. The estimate reports a heuristic input range, maximum output and a cost estimate only if both rates were supplied. It is not a tokenizer guarantee or a spending cap. With unknown prices, cost remains unknown; zero is reserved for mock. Report this estimate to the user and wait for explicit authorization before enabling paid calls.

After authorization, configure the provider and opt in on the server, restart, calculate an estimate, and check the one-request authorization checkbox in the UI. A changed selection/focus/history clears that authorization. One analysis makes one provider request, without retries. Failed validation may still incur provider charges. The API adapter was tested with synthetic HTTP responses only. Actual token usage and configured-rate cost are recorded when available, otherwise `null`.

Selected materials and pasted history are sent to the configured provider in real mode. They remain local during mock analysis, except public GitHub fetches for live source selection. The offline demo makes no GitHub or model request.

## Evidence and input boundaries

- Maximum 5 files, 30,000 UTF-8 bytes per file, 90,000 bytes combined; 6,000 characters each for focus and history. Whole-repository analysis is unsupported.
- Text allowlist: Markdown/text, common source code, JSON, SQL, HTML/CSS, YAML, XML and CSV. PDF, Word, images and other binaries are unsupported.
- Exclude hidden paths, common credential filenames, dependencies, lockfiles, build output, symlinks and common credential patterns. This is a best-effort filter, not comprehensive secret detection. Review public material before selection.
- GitHub API only, HTTPS public repository URL only; no user-supplied fetch hosts, redirects, private credentials, cloning, shell execution or repository writes. Live GitHub API uses unauthenticated rate limits and times out at 15 seconds per request.
- Reject truncated trees, trees over 10,000 entries and oversized API responses. Git blob reads use SHAs from the pinned tree rather than moving branch URLs.
- Every observation and question must cite a selected file with line range and an exact matching quote. Reject invented paths, invalid line ranges, mismatched quotes, incomplete responses and malformed output.
- Observation types distinguish `document-description`, `code-observation`, `test-description` and `inference`. Summary is explicitly provisional. A test definition does not prove it passed; code does not prove deployed behaviour; documents can be stale.
- Exact citation validation verifies source location and text, **not semantic entailment**. Model drafts still need teacher review. Prompt injection defences consist of treating all source/history/focus as untrusted data, constrained output and validation; they do not guarantee model compliance. The model has no tools or code-execution capability.
- Pasted history is unverified context. Student answers are recorded as self-reports with the question's material basis alongside teacher review. No automatic answer corroboration or formal longitudinal comparison is claimed.
- Local same-origin JSON POSTs, loopback Host validation and browser content security policy reduce accidental cross-site access. No student accounts, authentication, multi-user security or production hardening is provided.

## Tests and validation

```bash
npm test          # core suite: no network, no paid calls, no database required
```

Uses Node's built-in test runner: URL/path/content limits, real pinned fixture and mock flow, citation rejection, paid-call gating, synthetic provider validation, pinned GitHub blob transport, API origin checks and HTTP workflow.

Persistence tests run against an **isolated, disposable** local database (never the dev database or Class Intake):

```bash
npm run db:start                      # if not already running
# one-time disposable test database on the same isolated container:
docker exec supabase_db_l2ai_project_assess \
  psql -U postgres -d postgres -c "create database l2ai_assess_test;"
docker exec -i supabase_db_l2ai_project_assess \
  psql -U postgres -d l2ai_assess_test < supabase/migrations/20261031000001_init_persistence.sql
cp .env.example .env.test             # then edit DATABASE_URL to .../l2ai_assess_test
npm run test:db                       # truncates tables between tests
```

`npm run test:db` covers save/reopen, source-and-hash round trip, edited-question/answer/note round trip, idempotent create, stale-update conflict, atomic-rollback of a failed multi-record save, re-analysis preserving prior runs and answers, server-authoritative save (forged browser source ignored, `409` on stale), and a database-unavailable error path.

For the browser tests, install Playwright and its Chromium (do not install anything from the assessed repository):

```bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:ui                       # core desktop/mobile walkthrough (no database)
# persistence walkthrough (needs the local database + DATABASE_URL):
node --env-file-if-exists=.env.test tests/browser-persistence.mjs
```

Alternatively set `PLAYWRIGHT_MODULE` to an existing Playwright module entry point and optionally `CHROMIUM_EXECUTABLE` to a compatible local Chromium executable. The core UI test starts its own local server, exercises desktop and 390px mobile, edits a question, records a synthetic answer and teacher notes, downloads both formats, checks source/version metadata, and tests stale-analysis invalidation and safe text rendering. The persistence walkthrough additionally covers save, the saved-interviews list, reopen after a page reload, continued editing and re-save, two analysis runs with run selection, the unsaved-edit export label, and the New interview reset. Both write screenshots and synthetic exports under ignored `exports/`. Set `LIVE_GITHUB=1` to additionally exercise live public GitHub selection. The application itself has no Playwright dependency.

See [validation notes](docs/VALIDATION.md) for actual checks, limitations and next work.

## Product relationship and next steps

Engineering Studio Class Intake stays independent. Intake may later provide continuous process evidence, but this app works without it. Assessment Assistant prepares evidence-grounded teacher interviews; future Smart Assessment may organize evidence by rubrics. Neither automatic scoring nor author/contribution identification belongs to this version.

Next: authorize a small real-provider trial after reviewing estimates, assess question usefulness with teacher feedback, improve answer-to-evidence review, and — building on this local persistence iteration — add a one-click re-analysis path, formal cross-session comparisons, and a hosted deployment (Vercel + hosted Supabase) only after authentication, authorization and data hardening are in place. Private GitHub, student accounts, voice, and Intake integration remain out of scope for now.
