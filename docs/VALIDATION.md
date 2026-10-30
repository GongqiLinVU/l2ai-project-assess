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
