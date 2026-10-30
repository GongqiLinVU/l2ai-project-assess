# L2AI Project Assess

A local teacher workspace for one public GitHub repository and one assessment interview. Start from selected project materials, prepare evidence-linked questions, record student answers, and export a reviewable interview record. No automatic grading or authorship determination.

## Repository inspection and implementation choice

On 31 October 2026 (Melbourne), the GitHub plugin reported `GongqiLinVU/l2ai-project-assess` as public, empty, size 0, default branch `main`. The contents endpoint explicitly returned “This repository is empty.” There was no README or repository AGENTS.md to retain. No applicable AGENTS.md was found in the workspace ancestors. A new project AGENTS.md records the boundaries for future work. The initial local prototype was subsequently authorized for publication to this repository.

Node.js 22.9+ (tested on 24.22.1), native HTTP/fetch, and plain HTML/CSS/JavaScript keep this first experiment small: no application dependencies, database, framework build, or installation required. The server binds only to IPv4 loopback. This is a local prototype, not an Internet-facing service.

## Run locally

```bash
git clone https://github.com/GongqiLinVU/l2ai-project-assess.git
cd l2ai-project-assess
cp .env.example .env
npm start
```

Open **http://127.0.0.1:3400** (use this address, not `localhost`). Default mode is `mock`. `npm install` is unnecessary. Nothing connects to Intake, Supabase, or any production database.

1. Enter `https://github.com/owner/repository` and click **Load live repository**. The server resolves the default branch once to a commit SHA and lists eligible files at that SHA. No GitHub login or token is used; only public repositories work.
2. Select 1–5 small text files. Set an assessment focus or short rubrics. Optionally paste previous session text.
3. Click **Prepare interview**. Review the provisional understanding, typed observations and exact source quotes, questions, reasons, desired understanding and limitations.
4. Edit questions, enter student answers, and add teacher verification or unresolved points. Question references identify the basis of a question; they do not corroborate its answer.
5. Export JSON and/or Markdown. JSON includes complete selected source text, Git blob SHA and SHA-256 digests, original and edited questions, answers, teacher notes, history, unread eligible files, provenance and model metadata. Markdown contains cited excerpts and interview details. Keep JSON for a self-contained source record.

Changing source selection, repository URL, focus or history invalidates the displayed analysis. Snapshot handles expire after 30 minutes (20 snapshots maximum); reload to continue. The record and answers are held only in this browser tab until exported. Reloading loses them; a browser exit warning is provided after analysis. There is no saved interview database or resume/import feature yet.

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
npm test
```

Uses Node's built-in test runner and no network/paid calls: URL/path/content limits, real pinned fixture and mock flow, citation rejection, paid-call gating, synthetic provider validation, pinned GitHub blob transport, API origin checks and HTTP workflow.

For the browser test only, install Playwright and its Chromium (do not install anything from the assessed repository):

```bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:ui
```

Alternatively set `PLAYWRIGHT_MODULE` to an existing Playwright module entry point and optionally `CHROMIUM_EXECUTABLE` to a compatible local Chromium executable. The UI test starts its own local server, exercises desktop and 390px mobile, edits a question, records a synthetic answer and teacher notes, downloads both formats, checks source/version metadata and tests stale-analysis invalidation and safe text rendering. It writes screenshots and synthetic exports under ignored `exports/`. Set `LIVE_GITHUB=1` to additionally exercise live public GitHub selection and mock analysis. The application itself has no Playwright dependency.

See [validation notes](docs/VALIDATION.md) for actual checks, limitations and next work.

## Product relationship and next steps

Engineering Studio Class Intake stays independent. Intake may later provide continuous process evidence, but this app works without it. Assessment Assistant prepares evidence-grounded teacher interviews; future Smart Assessment may organize evidence by rubrics. Neither automatic scoring nor author/contribution identification belongs to this version.

Next: authorize a small real-provider trial after reviewing estimates, assess question usefulness with teacher feedback, improve answer-to-evidence review, and only then consider persistent interviews, formal cross-session comparisons and explicitly authorized Intake integration. Private GitHub, student accounts, voice, deployment and production database changes are out of scope.
