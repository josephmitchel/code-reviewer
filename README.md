# Code Reviewer

A standalone, repo-agnostic multi-agent PR review service. It audits a pull request's diff (plus blast radius) against the nine ISO/IEC 25010:2023 quality characteristics plus test quality, posts a report with questions to the PR, plans and pushes fixes after the owner replies, verifies them with judge agents, and gates the PR with a `code-reviewer/gate` commit status on the exact verified head SHA.

Extracted from SpendRight's in-repo audit system. State lives in Postgres (`code_reviewer` database); the process is stateless — kill it anywhere and re-run the same command to resume.

## Requirements

- Node 24, local Postgres 16 (`createdb code_reviewer`, then `npx drizzle-kit migrate`)
- `gh` authenticated with push access to the target repo
- Claude Code logged in (agents run on the Claude subscription via the Agent SDK)

## Usage

```sh
# one-time repo registration
node bin/code-reviewer.mjs repo add owner/name \
  --setup "npm ci" \
  --tests "unit=npm test" --tests "db=npm run test:db" \
  --harness-notes-file ./notes.md

# run (or resume) the review loop for a PR
node bin/code-reviewer.mjs run owner/name 42

node bin/code-reviewer.mjs status            # all reviews and concern counts
node bin/code-reviewer.mjs reset owner/name 42   # forget a review (keeps concerns/policies)
```

## On GitHub Actions

`action.yml` runs one slice of the loop on a GitHub runner, so reviews happen on GitHub rather
than on your machine. State lives in Postgres and nothing blocks: a review that needs an answer
exits, and your reply on the PR starts the run that continues it.

Adding a project takes three steps, none of which touch this repo:

1. Register it, which is the only project-specific configuration there is:
   ```
   node bin/code-reviewer.mjs repo add owner/name \
     --setup "npm ci" --tests "unit=npm test" --harness-notes-file harness-notes/name.md
   ```
2. Copy `examples/workflows/code-review.yml` into the project's `.github/workflows/`.
3. Set four secrets on it: `DATABASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`,
   `REVIEWER_APP_CLIENT_ID`, `REVIEWER_APP_PRIVATE_KEY` — and install the GitHub App on it.

Everything that accumulates is scoped per repo: the review slot (one active review per project,
so projects never queue behind each other), concerns, and the policies built from your answers.
One database serves every project.

## The loop

```
intake → audit (scout + 10 auditors) → synthesis ──┬─ clean → gate (commit status) → passed
                                                   └─ concerns → report comment → your reply
                                                        → fix plan → fix pushed → judges → re-audit
```

- The report ends with numbered questions; reply on the PR with `1. <answer>` lines (or `proceed` when there are none). Fixes never start without a reply.
- Answers are saved as per-repo policy and never asked again.
- The gate only ever follows a clean audit of the current head — fix commits are always re-audited.

## Layout

- `src/review-loop.ts` — state machine driver; `src/stages/*` — one module per stage
- `src/agents/run-agent.ts` — Agent SDK wrapper (structured output, session recording, resume)
- `prompts/` — auditor definitions (ISO 25010 verbatim) and pipeline role prompts
- `src/db/schema.ts` — repos, reviews, rounds, concerns, findings, questions, policies, agent_sessions, github_artifacts
