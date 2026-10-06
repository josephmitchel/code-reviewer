import { gitCredential } from './git-credential.js';

// An interactive invocation has no input to read, and would otherwise hang on stdin.
const answer = process.stdin.isTTY ? null : await gitCredential(process.argv[2] ?? '', process.stdin);
if (answer) process.stdout.write(answer);
