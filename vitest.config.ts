import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `workspaces/` holds full checkouts of the repos under review — 41 test files today.
    // Without this they are collected as if they were ours, and they cannot pass here:
    // they resolve `@/…` against the reviewed repo and expect its database.
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'workspaces/**', 'drizzle/**'],
  },
});
