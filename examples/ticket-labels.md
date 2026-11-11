<!--
Put this in a repo's docs/agents/ticket-labels.md (it replaces triage-labels.md) and point the
repo's CLAUDE.md at it. It is the one label scheme every agent follows; the nightly sweep and the
`landed` job enforce the colours and rename the labels the scheme retired.
-->

# Ticket labels

Colour says which group a label belongs to, so names carry no prefix. Every ticket carries
**exactly one kind**. Every open ticket carries **exactly one status**. When you set a status,
remove the one that was there.

## Kind: what the ticket is (dark, white text)

| Label     | Meaning                                              | Who applies it                    |
| --------- | ---------------------------------------------------- | --------------------------------- |
| `spec`    | A specified piece of work to build                   | Whoever files the spec            |
| `bug`     | Something is not working                             | Whoever files or triages the bug  |
| `concern` | Raised by the nightly code reviewer sweep            | The sweep only                    |

Where a skill says "enhancement", use `spec`.

## Status: who has to act next (bright, dark text)

| Label             | Colour | Meaning                                                             |
| ----------------- | ------ | ------------------------------------------------------------------- |
| `needs-triage`    | yellow | The owner has not yet decided what happens to this                  |
| `needs-info`      | yellow | Waiting on whoever raised it for more detail                        |
| `needs-answer`    | yellow | The code reviewer has a question only the owner can answer          |
| `ready-for-human` | yellow | Needs a person to implement it                                      |
| `ready-for-agent` | green  | Fully specified; an agent can pick it up                            |
| `needs-work`      | orange | The judge found it not finished; its last comment is the brief      |
| `needs-judging`   | blue   | Its PR has landed; the nightly judge decides whether it is solved   |
| `wontfix`         | white  | Dismissed by the owner; the nightly sweep closes it as not planned  |

Yellow waits on the owner, green and orange on an agent, blue on the nightly judge.

- The five triage roles the skills name (`needs-triage`, `needs-info`, `ready-for-agent`,
  `ready-for-human`, `wontfix`) are these labels, spelled the same.
- A new concern starts as `ready-for-agent`, or `needs-answer` while it has an open question.
- `needs-judging` and `needs-work` are set by the merge job and the judge. Do not set them by hand
  unless the merge job failed. See `issue-tracker.md`, "Closing work through PRs".
- Only the owner adds `wontfix`.
- A closed ticket has no status, except `wontfix`, which stays as the record of the dismissal.
- The "Code reviewer: minor findings" digest is not a ticket: no PR addresses it. It carries
  `concern` and no status.

## Level and quality: concerns only

- **Level** (neutral, darker is heavier): `major`, `moderate`.
- **Quality** (pale grey), the ISO/IEC 25010 characteristic: `functional-suitability`,
  `performance-efficiency`, `compatibility`, `interaction-capability`, `reliability`, `security`,
  `maintainability`, `flexibility`, `safety`, `testing`.

Only the sweep applies these.

## Outside the scheme

`accessibility` stays as a topic label. `review-now` goes on a pull request, not a ticket: it asks
for the full per-PR review.
