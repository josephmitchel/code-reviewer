<!--
Replace the "Closing work through PRs" section of a repo's docs/agents/issue-tracker.md (the file
the Matt Pocock skills read to learn how the tracker works) with the section below. Every skill
that ships work then hands the ticket to the nightly sweep's judge instead of closing it.
-->

## Closing work through PRs

Work does **not** close through its PR. The nightly code reviewer closes tickets, after a judge
has checked the landed code against the ticket and the repo's standards.

- The PR body carries one `Addresses #N` line per implementation ticket behind it (the spec and each
  slice). Never `Closes #N` / `Fixes #N` / `Resolves #N`: GitHub would close the ticket on merge and
  the judge would never see it.
- Once the PR is **merged**, label every ticket it addresses `needs-judging`:
  `gh issue edit <N> --add-label needs-judging`. Do this after the merge, not when the PR opens.
- The judge runs overnight. It either closes the ticket as completed with a comment saying what it
  checked, or replaces the label with `needs-work` and a comment listing what is missing, file by
  file, in order. A `needs-work` ticket is picked up like any other open ticket; when the follow-up
  lands, label it `needs-judging` again.
- Tickets with no code behind them — decisions, research, a spec parent whose slices are all
  closed — are closed directly, as before. Closing a ticket by hand is final; the judge never
  reopens it.
- Issues the code reviewer itself opened (label `code-reviewer`) are the exception: close those
  normally (`Fixes #N` is fine); closing is what asks for their judge.
