import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brevoV6 } from '../src/migrations/brevo-v6/index.js';
import { runMigration } from '../src/core/runner.js';
import { findApplicableMigrations } from '../src/migrations/index.js';

function migrate(source: string, extension: 'ts' | 'mjs' | 'cjs' = 'ts') {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  project.createSourceFile(`/project/example.${extension}`, source);
  const result = brevoV6.transform(project);
  return { result, output: result.fileUpdates?.[0]?.contents ?? source, reasons: result.manual.map((item) => item.reason).join('\n') };
}

const bindings = {
  ts: "import { BrevoClient } from '@getbrevo/brevo'; const client = new BrevoClient({ apiKey: key });",
  mjs: "import { BrevoClient } from '@getbrevo/brevo'; const client = new BrevoClient({ apiKey: key });",
  cjs: "const { BrevoClient } = require('@getbrevo/brevo'); const client = new BrevoClient({ apiKey: key });",
} as const;

describe.each(['ts', 'mjs', 'cjs'] as const)('Brevo v6 %s', (extension) => {
  const run = (body: string) => migrate(`${bindings[extension]}\n${body}`, extension);

  it('wraps direct batch event arrays', () => {
    const { output, reasons } = run('client.event.createBatchEvents([{ event_name: "x" }]);');
    expect(output).toContain('createBatchEvents({ events: [{ event_name: "x" }] })');
    expect(reasons).toBe('');
  });

  it('renames direct active balance request keys and accepts only literal createdAt', () => {
    const { output, reasons } = run('client.balance.getActiveBalancesApi({ contact_id: 1, balance_definition_id: "b", sort_field: "createdAt" });');
    expect(output).toContain('contactId: 1');
    expect(output).toContain('balanceDefinitionId: "b"');
    expect(output).toContain('sortField: "createdAt"');
    expect(reasons).toBe('');
  });

  it('renames shorthand legacy balance keys without changing their values', () => {
    const { output, reasons } = run('client.balance.getActiveBalancesApi({ contact_id, balance_definition_id });');
    expect(output).toContain('contactId: contact_id');
    expect(output).toContain('balanceDefinitionId: balance_definition_id');
    expect(reasons).toBe('');
  });

  it('rewrites only a provably equivalent company filter', () => {
    const { output, reasons } = run('client.companies.getAllCompanies({ filters: JSON.stringify({ "attributes.name": companyName }) });');
    expect(output).toContain('"filters[attributes.name]": companyName');
    expect(reasons).toBe('');
  });

  it('rewrites an exact JSON string name filter', () => {
    const { output, reasons } = run('client.companies.getAllCompanies({ filters: \'{"attributes.name":"Acme"}\' });');
    expect(output).toContain('"filters[attributes.name]": "Acme"');
    expect(reasons).toBe('');
  });

  it('blocks opaque and owner company filters because v6 silently ignores them', () => {
    for (const value of ['filters', 'JSON.stringify({ "attributes.owner": owner })', "'{\"attributes.owner\":\"a\"}'"]) {
      const { output, reasons } = run(`client.companies.getAllCompanies({ filters: ${value} });`);
      expect(reasons).toContain('list returns unfiltered without an error');
      expect(output).not.toContain('filters[attributes.name]');
    }
  });

  it('reports removed transaction filters and newly required balance definition', () => {
    const { reasons } = run('client.balance.getTransactionHistoryApi({ pid, filters: "x" }); client.balance.getContactBalances({ contactId: 1 });');
    expect(reasons).toContain('transaction history filters');
    expect(reasons).toContain('balanceDefinitionId');
  });

  it('reports changed result types when results are consumed', () => {
    const { reasons } = run('const a = await client.balance.getActiveBalancesApi({ contactId: 1, balanceDefinitionId: "x" }); const b = await client.tasks.getAllTaskTypes(); return client.balance.getBalanceDefinitionList();');
    expect(reasons).toContain('getActiveBalancesApi');
    expect(reasons).toContain('getAllTaskTypes');
    expect(reasons).toContain('getBalanceDefinitionList');
  });

  it('reports required preview input and string webhook message IDs', () => {
    const { reasons } = run('client.transactionalEmails.postPreviewSmtpEmailTemplates(); client.webhooks.exportWebhooksHistory({ messageId: 123 });');
    expect(reasons).toContain('postPreviewSmtpEmailTemplates');
    expect(reasons).toContain('messageId');
  });

  it('reports nonliteral enum inputs and required conversation text', () => {
    const { reasons } = run('client.balance.getActiveBalancesApi({ sort: order }); client.program.getLpList({ sort: order }); client.balance.createBalanceOrder({ source: source }); client.conversations.sendAMessageAsAnAgent({ visitorId: "v" }); client.conversations.sendAnAutomatedMessageToAVisitor({ visitorId: "v" });');
    expect(reasons).toContain('sort');
    expect(reasons).toContain('source');
    expect(reasons).toContain('text');
  });

  it('does not rewrite a consumed changed result or an unsupported sort field', () => {
    const consumed = run('const result = client.balance.getActiveBalancesApi({ contact_id: 1, balance_definition_id: "b" });');
    expect(consumed.reasons).toContain('result');
    expect(consumed.output).toContain('contact_id: 1');
    const sort = run('client.balance.getActiveBalancesApi({ sort_field: sortField });');
    expect(sort.reasons).toContain('sortField');
    expect(sort.output).toContain('sort_field: sortField');
  });

  it('blocks escaped clients, subclasses, and dynamic resources', () => {
    const escaped = run('use(client); client.event.createBatchEvents([]);');
    expect(escaped.reasons).toContain('escapes');
    expect(escaped.output).toContain('createBatchEvents([])');
    // A subclass without any breaking call must not block a version-only upgrade.
    expect(run('class Child extends BrevoClient {}').reasons).toBe('');
    expect(run('class Child extends BrevoClient {} const child = new Child(); child.event.createBatchEvents([]);').reasons).toContain('subclass');
    expect(run('client[resource].createBatchEvents([]);').reasons).toContain('dynamic');
  });
});

describe('Brevo v6 manifest and legacy versions', () => {
  it('tracks a client assigned after a null declaration in JavaScript', () => {
    const source = "const { BrevoClient } = require('@getbrevo/brevo'); let client = null; client = new BrevoClient({ apiKey: key }); client.event.createBatchEvents([]);";
    const { output, reasons } = migrate(source, 'cjs');
    expect(reasons).toBe('');
    expect(output).toContain('createBatchEvents({ events: [] })');
  });

  it('tracks a NestJS constructor field in TypeScript and JavaScript', () => {
    for (const extension of ['ts', 'mjs'] as const) {
      const source = `${extension === 'ts' ? "import { BrevoClient } from '@getbrevo/brevo';" : "import { BrevoClient } from '@getbrevo/brevo';"}
class EmailService {
  ${extension === 'ts' ? 'private brevoClient: BrevoClient;' : ''}
  constructor() { this.brevoClient = new BrevoClient({ apiKey: key }); }
  async send() { return this.brevoClient.event.createBatchEvents([]); }
}`;
      const { output, reasons } = migrate(source, extension);
      expect(reasons).toBe('');
      expect(output).toContain('createBatchEvents({ events: [] })');
    }
  });

  it('keeps a breaking call on an untracked client manual', () => {
    const source = "import { BrevoClient } from '@getbrevo/brevo'; const client = getClient(); client.event.createBatchEvents([]);";
    const { output, reasons } = migrate(source);
    expect(reasons).toContain('could not be tied');
    expect(output).toBe(source);
  });

  it('does not report an escaped client when only unchanged methods are called', () => {
    const source = "import { BrevoClient } from '@getbrevo/brevo'; const client = new BrevoClient({ apiKey: key }); export { client }; client.contacts.createContact({ email: 'a@b.test' });";
    expect(migrate(source).reasons).toBe('');
  });

  it('proposes a version-only upgrade and explains that no v6 breaking API is used', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upstreamfix-brevo-version-only-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@getbrevo/brevo': '^5.0.4' } }, null, 2) + '\n');
      writeFileSync(path.join(root, 'index.ts'), "import { BrevoClient } from '@getbrevo/brevo';\nconst client = getClient();\nclient.contacts.createContact({ email: 'a@b.test' });\n");
      const result = await runMigration(brevoV6, { cwd: root, dryRun: true });
      expect(result.manual).toEqual([]);
      expect(result.proposedFiles.find((item) => item.relativePath === 'package.json')?.after).toContain('^6.2.0');
      expect(result.manifestNotes.join(' ')).toContain('no v6 breaking API is used');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('proposes a version-only upgrade with no SDK import when no breaking call exists', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upstreamfix-brevo-version-only-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@getbrevo/brevo': '^4.0.1' } }, null, 2) + '\n');
      writeFileSync(path.join(root, 'index.ts'), 'export const ok = true;\n');
      const result = await runMigration(brevoV6, { cwd: root, dryRun: true });
      expect(result.manual).toEqual([]);
      expect(result.proposedFiles.find((item) => item.relativePath === 'package.json')?.after).toContain('^6.2.0');
      expect(result.manifestNotes.join(' ')).toContain('no v6 breaking API is used');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('withholds a version-only upgrade when a breaking property is called without an SDK import', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upstreamfix-brevo-breaking-probe-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@getbrevo/brevo': '^5.0.4' } }, null, 2) + '\n');
      writeFileSync(path.join(root, 'index.ts'), 'client.event.createBatchEvents([]);\n');
      const result = await runMigration(brevoV6, { cwd: root, dryRun: true });
      expect(result.manual.map((item) => item.reason).join(' ')).toContain('could not be tied');
      expect(result.proposedFiles).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not claim no breaking API when a nested package calls one', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upstreamfix-brevo-monorepo-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@getbrevo/brevo': '^5.0.4' } }));
      mkdirSync(path.join(root, 'child'));
      writeFileSync(path.join(root, 'child', 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
      writeFileSync(path.join(root, 'child', 'index.ts'), 'client.event.createBatchEvents([]);\n');
      const result = await runMigration(brevoV6, { cwd: root, dryRun: true });
      expect(result.proposedFiles).toEqual([]);
      expect(result.manifestNotes.join(' ')).not.toContain('no v6 breaking API is used');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('updates only v4 and v5 ranges and stays experimental', () => {
    expect(brevoV6.experimental).toBe(true);
    const manifest = { dependencies: { '@getbrevo/brevo': '^4.0.0' }, devDependencies: { '@getbrevo/brevo': '~5.0.4' } };
    brevoV6.updateManifest?.(manifest);
    expect(manifest.dependencies['@getbrevo/brevo']).toBe('^6.2.0');
    expect(manifest.devDependencies['@getbrevo/brevo']).toBe('^6.2.0');
  });

  it('reports v3 API classes and legacy package without rewriting', () => {
    for (const source of ["import { TransactionalEmailsApi, SendSmtpEmail } from '@getbrevo/brevo';", "const sib = require('sib-api-v3-sdk');"]) {
      const { output, reasons } = migrate(source);
      expect(reasons).toContain('v3 → v6');
      expect(output).toBe(source);
    }
  });

  it('reports consumed v4 tier deletion results', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upstreamfix-brevo-v4-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@getbrevo/brevo': '^4.0.0' } }));
      const project = new Project({ compilerOptions: { allowJs: true }, skipAddingFilesFromTsConfig: true });
      project.createSourceFile(path.join(root, 'example.ts'), `${bindings.ts}\nconst result = await client.tier.deleteTierGroup({ pid: 'x' });\nconst other = await client.tier.deleteTier({ pid: 'x' });`);
      const reasons = brevoV6.transform(project).manual.map((item) => item.reason).join('\n');
      expect(reasons).toContain('deleteTierGroup');
      expect(reasons).toContain('deleteTier');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['^4.0.0', '^5.0.4'])('discovers %s and proposes its manifest upgrade', async (range) => {
    const root = mkdtempSync(path.join(tmpdir(), 'upstreamfix-brevo-runner-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@getbrevo/brevo': range } }, null, 2) + '\n');
      writeFileSync(path.join(root, 'example.ts'), `${bindings.ts}\nclient.contacts.createContact({ email: 'x@example.test' });`);
      expect((await findApplicableMigrations(root, { includeExperimental: true })).map((item) => item.id)).toContain('@getbrevo/brevo@6');
      const result = await runMigration(brevoV6, { cwd: root, dryRun: true });
      expect(result.manual).toEqual([]);
      expect(result.proposedFiles.find((item) => item.relativePath === 'package.json')?.after).toContain('^6.2.0');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a standalone sib-api-v3-sdk import without a misleading missing-manifest finding', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upstreamfix-brevo-v3-'));
    try {
      writeFileSync(path.join(root, 'package.json'), '{}\n');
      writeFileSync(path.join(root, 'example.cjs'), "const sib = require('sib-api-v3-sdk');\n");
      const result = await runMigration(brevoV6, { cwd: root, dryRun: true });
      expect(result.manual.map((item) => item.reason).join('\n')).toContain('v3 → v6');
      expect(result.manual.map((item) => item.reason).join('\n')).not.toContain('No containing package.json');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a v3 API class from a v3 manifest as an unsupported migration', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upstreamfix-brevo-v3-major-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@getbrevo/brevo': '^3.0.4' } }));
      writeFileSync(path.join(root, 'example.ts'), "import { TransactionalEmailsApi } from '@getbrevo/brevo';\nnew TransactionalEmailsApi();\n");
      const result = await runMigration(brevoV6, { cwd: root, dryRun: true });
      expect(result.manual.map((item) => item.reason).join('\n')).toContain('v3 → v6');
      expect(result.proposedFiles).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a CommonJS v3 API class import', () => {
    const source = "const { TransactionalEmailsApi } = require('@getbrevo/brevo'); new TransactionalEmailsApi();";
    const { output, reasons } = migrate(source, 'cjs');
    expect(reasons).toContain('v3 → v6');
    expect(output).toBe(source);
  });

  it('does not confuse a shadowed local constructor with the imported BrevoClient', () => {
    const source = "import { BrevoClient } from '@getbrevo/brevo'; function demo() { const BrevoClient = Fake; const client = new BrevoClient(); client.event.createBatchEvents([]); }";
    const { output, reasons } = migrate(source);
    expect(reasons).toContain('could not be tied');
    expect(output).toBe(source);
  });

  it('blocks request spreads that can hide an old company filter', () => {
    const { reasons } = migrate(`${bindings.ts}\nclient.companies.getAllCompanies({ ...query });`);
    expect(reasons).toContain('unfiltered');
  });
});
