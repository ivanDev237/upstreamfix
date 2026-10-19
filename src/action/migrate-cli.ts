#!/usr/bin/env node
import { prepareProposals } from './migrate.js';

const project = process.env.UPSTREAMFIX_CLIENT_ROOT;
const output = process.env.UPSTREAMFIX_OUTPUT_ROOT;
const base = process.env.UPSTREAMFIX_BASE_SHA;
if (!project || !output || !base) throw new Error('Missing action migration paths or base SHA.');
await prepareProposals(project, output, base, process.env.GITHUB_EVENT_NAME ?? '');
