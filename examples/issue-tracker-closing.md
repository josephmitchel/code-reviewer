<!--
Replace the "Closing work through PRs" section of a repo's docs/agents/issue-tracker.md (the file
the Matt Pocock skills read to learn how the tracker works) with the section below. Every skill
that ships work then hands the ticket to the nightly sweep's judge instead of closing it, and
lifts the ticket's blocking edges the moment its PR lands so dependent tickets can start.
-->

## Closing work through PRs

Work does **not** close through its PR. The nightly code reviewer closes tickets, after a judge
has checked the landed code against the ticket and the repo's standards.

- The PR body carries one `Addresses #N` line per implementation ticket behind it (the spec and each
  slice). Never `Closes #N` / `Fixes #N` / `Resolves #N`: GitHub would close the ticket on merge. (The
  merge automation reopens a ticket closed that way and labels it anyway, but do not rely on it.)
- Once the PR is **merged**, two things happen to every ticket it addresses, automatically (the
  `landed` job in `.github/workflows/nightly-sweep.yml` runs on the merge): the ticket is labelled
  `needs-judging`, and its blocking edges are lifted — each "blocked by" edge on the tickets it
  blocks becomes "relates to", so they can start today rather than after the judge runs. Check the
  ticket's thread for the "PR #N landed" comment; if it is missing (the workflow failed, or the PR
  body named the ticket some other way), do both by hand:
  ```
  gh issue edit <N> --add-label needs-judging
  # the tickets #N blocks, and the node ids the mutations need
  gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){
    issue(number:$n){ id blocking(first:50){ nodes { id number } } } } }' \
    -f o=<owner> -f r=<repo> -F n=<N> --jq '.data.repository.issue | "\(.id)", (.blocking.nodes[] | "\(.number) \(.id)")'
  # for each dependent: remove the blocker and add the relation in one request
  gh api graphql -f query='mutation($dep:ID!,$blocker:ID!){
    removeBlockedBy(input:{issueId:$dep, blockingIssueId:$blocker}){ clientMutationId }
    addRelatesTo(input:{issueId:$dep, relatedIssueId:$blocker}){ clientMutationId } }' \
    -f dep=<dependent node id> -f blocker=<node id of #N>
  ```
- The judge runs overnight. It either closes the ticket as completed with a comment saying what it
  checked, or replaces the label with `needs-work` and a comment listing what is missing, file by
  file, in order. A `needs-work` ticket is picked up like any other open ticket; when the follow-up
  lands, label it `needs-judging` again. A `needs-work` verdict does not re-block the tickets that
  were lifted: they build on what is on main either way.
- Tickets with no code behind them — decisions, research, a spec parent whose slices are all
  closed — are closed directly, as before. Closing a ticket by hand is final; the judge never
  reopens it.
- Issues the code reviewer itself opened (label `code-reviewer`) are the exception: close those
  normally (`Fixes #N` is fine); closing is what asks for their judge.
