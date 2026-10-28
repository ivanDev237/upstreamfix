import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/client-migrations.yml', 'utf8');
const caller = readFileSync('examples/action-test/.github/workflows/upstreamfix.yml', 'utf8');

describe('bot PR follow-up workflow boundaries', () => {
  it('accepts the dispatch type in the client caller', () => {
    expect(caller).toContain('bot-pr-followup');
  });
  it('has a read-only validation and checkout job before the write-token publisher', () => {
    const migrate = workflow.split('  bot_followup_migrate:')[1]?.split('  bot_followup_publish:')[0] ?? '';
    const publish = workflow.split('  bot_followup_publish:')[1] ?? '';
    expect(migrate).toContain('pull-requests: read');
    expect(migrate).not.toContain('contents: write');
    expect(migrate.indexOf('bot-followup-migrate-cli.js validate')).toBeLessThan(migrate.indexOf('Checkout validated dependency bot head'));
    expect(migrate).toContain('persist-credentials: false');
    expect(publish).toContain('pull-requests: write');
    expect(publish).toContain('bot-followup-publish-cli.js');
  });
  it('does not mix ordinary migrations with bot-pr-followup payloads', () => {
    expect(workflow).toContain("github.event.client_payload.head_sha == github.sha");
    expect(workflow).toContain("github.event.action == 'bot-pr-followup'");
  });
});
