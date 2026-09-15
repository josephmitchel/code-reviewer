#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', path.join(root, 'src/cli.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: root },
);
child.on('exit', (code) => process.exit(code ?? 1));
