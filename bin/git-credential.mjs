#!/usr/bin/env node
// Entry point for `git config credential.helper`. Separate from bin/code-reviewer.mjs so that
// answering a credential request does not load the database client, which lets the fixer's
// environment — inherited by the repo's own test suite — omit the reviewer's connection string.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', path.join(root, 'src/git-credential-main.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: root },
);
child.on('exit', (code) => process.exit(code ?? 1));
