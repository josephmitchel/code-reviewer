# Code Reviewer

A standalone, repo-agnostic multi-agent code review service with two modes. The **PR loop** audits a pull request's diff (plus blast radius) against the nine ISO/IEC 25010:2023 quality characteristics plus test quality, posts a report with questions to the PR, plans and pushes fixes after the owner replies, verifies them with judge agents, and gates the PR with a `code-reviewer/gate` commit status on the exact verified head SHA. The **nightly sweep** runs the same audit over what landed on the default branch each day and files the concerns as GitHub issues, and judges every ticket whose PR has merged, its own issues included — advisory, never blocking.

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

The App needs these repository permissions: Contents, Issues, Pull requests, Commit statuses and
Actions (all read and write), Metadata (read), and **Workflows (read and write)** — without the last
one, GitHub rejects any fix that touches a file under `.github/workflows/`, and the push fails with
nothing else in the system able to explain why.

Everything that accumulates is scoped per repo: the review slot (one active review per project,
so projects never queue behind each other), concerns, and the policies built from your answers.
One database serves every project. A `CODING_STANDARDS.md` at the repo root is read from the head
commit on every round and put in front of the auditors, the synthesis and the fix planner beside
those policies, so written rules and answered questions bind the same way.

## The nightly sweep (advisory mode)

The PR loop above gates every PR on a full review, fix cycle and verification — tens of minutes
to hours on the critical path of a merge. The sweep keeps the scrutiny and drops the blocking:
once a night it audits what landed on the default branch and files what it finds as GitHub
issues. It never pushes a fix and never sets a commit status.

```
settle owner decisions → read answers → audit base...head → synthesis → judge `needs-judging` tickets → issues / digest / status
```

- **Scope:** the default branch's diff since the previous sweep (the first sweep audits nothing
  and only sets up the issues). An empty diff still settles, judges, reads answers and republishes.
- **Issues:** every major or moderate concern becomes an issue labelled `code-reviewer`,
  `level: …` and `quality: …`, with locations linked at the commit the sweep saw. Minor
  concerns go in one rolling "Code reviewer: minor findings" issue; tick a box there to dismiss one.
- **One rule for every ticket:** a ticket is any issue a PR can address, and a concern the sweep
  raised is a ticket labelled `code-reviewer`. The PR says `Addresses #N` (never `Fixes` / `Closes` /
  `Resolves`); on merge the `landed` job labels the ticket `needs-judging` and lifts its blocking
  edges; the next sweep's judge closes it or labels it `needs-work` with a file-by-file brief. A
  concern is never closed-then-reopened: it stays open until a judge says it is solved.
- **Dismissing:** add the `wontfix` label, with a comment if the reason should be kept. The next
  sweep closes the ticket as not planned, drops `needs-judging` / `needs-work` / `needs-answer`,
  lifts its blocking edges (commenting on each dependent), and saves the comment as a repo policy
  so the auditors never raise the point again. No comment, no policy.
- **Closing by hand** is final for every ticket and never judged — the way to close a ticket with no
  code behind it. For a concern it is neither a fix claim nor a dismissal.
- **Questions:** a concern whose fix needs a product decision gets the question in its issue and
  the `needs-answer` label. Reply in the thread (`1. <answer>` lines, or free text); the answer
  becomes policy. Everything with a technical default is shown as the suggested direction instead.
- **The judge:** reads the ticket as the spec and the merged PR as the delivery, with the concerns
  tonight's audit raised inside that PR's files in front of it. A `needs-work` verdict does not
  re-block the tickets the merge unblocked. `examples/issue-tracker-closing.md` is the section to
  put in a repo's `docs/agents/issue-tracker.md` so the Matt Pocock skills follow the rule.
- **Morning check:** one pinned "Code reviewer status" issue per repo, rewritten every night:
  what landed, what was opened, dismissed or closed by hand, which tickets were judged, and what
  is waiting on you.

Run it with `node bin/code-reviewer.mjs sweep owner/name`, or on Actions with
`examples/workflows/nightly-sweep.yml` (`command: sweep`). That workflow also carries a
`review-now` job: label a PR `review-now` to get the full PR review on demand. The two modes share
the database, the concerns and the policies, so an answer given on a PR binds the sweep and vice
versa; running both on the same repo at the same moment is not supported.

## The PR loop

```
intake → audit (scout + 10 auditors) → synthesis ──┬─ clean → gate (commit status) → passed
                                                   └─ concerns → report comment → your reply
                                                        → fix plan → fix pushed → judges → re-audit
```

- The report ends with numbered questions; reply on the PR with `1. <answer>` lines (or `proceed` when there are none). Fixes never start without a reply.
- Answers are saved as per-repo policy and never asked again.
- The gate only ever follows a clean audit of the current head — fix commits are always re-audited.
- Until then `code-reviewer/gate` sits at pending with the current stage (`Round 2: making fixes`), and turns red if the review stops.
- Once a fix cycle starts ("Got it" after your answers), one progress comment is edited as it moves, up to the next report. A stopped review posts a comment saying where and why.
- A passed PR whose head later moves to already-reviewed code (merging a PR stacked on it leaves such a merge commit) gets its gate carried to the new head, on the push or on any comment. Only identical code qualifies, and only when the reviews cover everything since the PR's own gated commit.

## Layout

- `src/review-loop.ts` — PR state machine driver; `src/stages/*` — one module per stage (audit and synthesis are shared)
- `src/sweep/*` — the nightly sweep: `loop.ts` driver, `judge.ts` (owner decisions: `wontfix`, hand closes, ticked minors), `tickets.ts` (`needs-judging` tickets, concerns included), `answers.ts`, `publish.ts`, `render.ts` (issue/digest/status text)
- `src/agents/run-agent.ts` — Agent SDK wrapper (structured output, session recording, resume)
- `prompts/` — auditor definitions (ISO 25010 verbatim) and pipeline role prompts; `prompts/sweep/` — the sweep's framing of scout, auditor, synthesis and the ticket judge
- `src/db/schema.ts` — repos, reviews, sweeps, rounds, concerns, findings, questions, policies, agent_sessions, github_artifacts
