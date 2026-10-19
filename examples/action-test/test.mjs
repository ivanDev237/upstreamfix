import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
if (!source.includes('initializeApp') || !source.includes('firestore')) throw new Error('Firebase initialization is missing.');
if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.UPSTREAMFIX_TRAP_SECRET) {
  throw new Error('A workflow token or trap variable reached client tests.');
}
execFileSync(process.execPath, ['--check', new URL('./index.js', import.meta.url).pathname]);
