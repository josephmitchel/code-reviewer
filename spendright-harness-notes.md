The suite runs on Vitest with three separate configs:

- `vitest.config.mts` — `npm test` (`vitest run`), unit tests colocated in `src/` as `src/**/*.test.ts`, node environment, `server-only` stubbed via `test/server-only-stub.ts`. This is the only suite gating `prebuild`.
- `vitest.config.db.mts` — `npm run test:db`, integration tests colocated as `src/**/*.dbtest.ts` against real Postgres, harness in `test/` (`db-global-setup.ts`, `db-setup.ts`, `db-fixtures.ts`), `fileParallelism: false`.
- `vitest.config.supervisor.mts` — `npm run test:supervisor`, only `test/start-supervisor.test.ts`, spawns real node processes.

A behavior needing a real database belongs in a `.dbtest.ts`; pure logic belongs in a `.test.ts`; `test/` holds harness files, not new suites.
