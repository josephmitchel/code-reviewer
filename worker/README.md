# Sweep trigger (Cloudflare Worker)

Starts each repo's `nightly-sweep.yml` on the minute. GitHub's own `schedule` trigger is
best-effort — on vices it ran the sweep 7 to 10 hours late three nights running — so the
schedule lives here and GitHub only runs what it is told to.

The Worker authenticates as the reviewer's GitHub App: it signs a JWT with the App's private
key, mints an installation token scoped to the one repository and `actions: write`, and POSTs
to the workflow's dispatch endpoint. Nothing expires. The App's installation already holds
`actions: write` (every sweep's log prints the token's permissions), so no new approval is needed.

## One-time setup (the owner's accounts; nothing here is delegated)

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up.
2. From the code-reviewer checkout, log in and deploy. Wrangler is pinned, not installed:
   ```
   npx --yes wrangler@4.153.0 login
   npx --yes wrangler@4.153.0 deploy --config worker/wrangler.toml
   ```
3. Give it the App's credentials. Each prompt reads the value from the terminal and sends it
   straight to Cloudflare; nothing is written to the repo.
   ```
   npx --yes wrangler@4.153.0 secret put GITHUB_APP_CLIENT_ID --config worker/wrangler.toml
   npx --yes wrangler@4.153.0 secret put GITHUB_APP_PRIVATE_KEY --config worker/wrangler.toml
   ```
   The client id is on the App's settings page (`Iv1.…` / `Iv23…`). The private key is the `.pem`
   downloaded from the same page; paste it whole, `BEGIN RSA PRIVATE KEY` to `END`, no
   conversion needed. On macOS `pbcopy < path/to/key.pem` then paste at the prompt.
4. Prove it without waiting for the night: the dashboard's Worker page has a **Trigger** button
   under Settings → Triggers → Cron Triggers, or run
   `npx --yes wrangler@4.153.0 dev --config worker/wrangler.toml --test-scheduled` and open
   `http://localhost:8787/__scheduled?cron=17+7+*+*+*`. Either way a run appears within a
   minute at `gh run list -R <owner/repo> --workflow nightly-sweep.yml`, event `workflow_dispatch`.

## Add a repo

1. Install the App on the repo (GitHub → the App's settings → Install App), as the reviewer
   itself needs anyway.
2. Add `.github/workflows/nightly-sweep.yml` to the repo from `examples/workflows/`, with
   `workflow_dispatch` in its `on:` block and **without** a `schedule` entry — the Worker is
   the schedule.
3. Add one line to `worker/src/repos.ts` with the repo and its slot. Slots are an hour apart
   so two sweeps never share the Claude subscription; if the slot is new, add it to `crons` in
   `worker/wrangler.toml` too (a test fails if a repo names a cron the file does not list).
4. Deploy: `npx --yes wrangler@4.153.0 deploy --config worker/wrangler.toml`.

Times are UTC: `17 7 * * *` is 2:17 am Eastern in winter and 3:17 in summer.

## Rollout order

vices first, keeping GitHub's `schedule` on its workflow for one night as a backstop. When the
Worker's dispatched run shows up at 07:17 UTC, delete the `schedule` block from the workflow
(two sweeps that one night is fine: the second finds nothing new and only republishes). Then
the next repo.

## When it fails

A dispatch that fails — key revoked, App uninstalled from the repo, workflow file renamed,
permission removed — throws, and Cloudflare records the cron invocation as failed with the
GitHub status and body in the Worker's logs (dashboard → the Worker → Logs, or
`npx --yes wrangler@4.153.0 tail --config worker/wrangler.toml`). A cron that no repo is
scheduled on fails the same way, so a stale `wrangler.toml` is noticed, not ignored.

The morning check does not depend on any of this: the pinned "Code reviewer status" issue's
"Last sweep" line is the date the sweep actually ran. If it is yesterday's, something upstream
did not fire.
