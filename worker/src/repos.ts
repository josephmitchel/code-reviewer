/**
 * The repos the Worker starts a sweep for, each at its own minute. Adding a project is one line here
 * (and, if its cron is new, one entry in wrangler.toml), then a deploy. Crons are UTC, five fields,
 * exactly as wrangler.toml spells them — the Worker matches the string the trigger hands it.
 */
export interface SweptRepo {
  /** owner/name, where the reviewer's GitHub App is installed and nightly-sweep.yml exists. */
  slug: string;
  /** The wrangler.toml cron this repo runs on. */
  cron: string;
  /** Branch to dispatch the workflow on; the workflow file must exist there. */
  ref?: string;
}

export const REPOS: SweptRepo[] = [
  { slug: 'josephmitchel/vices', cron: '17 7 * * *' },
  { slug: 'josephmitchel/spendright', cron: '17 8 * * *' },
];
