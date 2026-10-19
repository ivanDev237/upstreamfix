import type { MigrationInfo } from './types.js';
import type { RunOutcome } from './runner.js';
import type { VerificationResult } from './verify.js';

export function renderMarkdownReport(
  migration: MigrationInfo,
  outcome: RunOutcome,
  dryRun: boolean,
  verification?: VerificationResult,
): string {
  const lines: string[] = [];
  const total = outcome.changes.length + outcome.manual.length;

  lines.push(`# Migration report: ${migration.title}`);
  lines.push('');
  if (dryRun) lines.push('> Dry run: no file was written.\n');
  lines.push(`- Findings: **${total}**`);
  lines.push(`- ${dryRun ? 'Proposed transformations' : 'Applied transformations'}: **${outcome.changes.length}**`);
  lines.push(`- Need your attention: **${outcome.manual.length}**`);
  lines.push(`- ${dryRun ? 'Files with proposed changes' : 'Files changed'}: **${outcome.filesChanged.length}**`);
  lines.push(`- Official guide: ${migration.guideUrl}`);
  lines.push('');

  if (total === 0) {
    lines.push('No supported Firebase Admin namespace usages were found in the scanned files.');
    lines.push('');
  }

  if (outcome.manual.length > 0) {
    lines.push('## Needs your attention');
    lines.push('');
    for (const item of outcome.manual) {
      lines.push(`- ${inlineCode(`${item.file}:${item.line}`)} ${escapeMarkdownText(item.reason).replace(/\r?\n/g, ' ')}`);
      lines.push(`  ${inlineCode(item.snippet)}`);
    }
    lines.push('');
  }

  if (outcome.manifestNotes.length > 0) {
    lines.push('## package.json');
    lines.push('');
    for (const note of outcome.manifestNotes) lines.push(`- ${escapeMarkdownText(note).replace(/\r?\n/g, ' ')}`);
    lines.push('');
  }

  if (verification) {
    lines.push('## Verification');
    lines.push('');
    lines.push(`- Result: **${verification.status}**`);
    lines.push('- Scope: temporary project copy; the original project was not changed.');
    lines.push('- Verification commands run on this machine with a restricted environment, without copied credentials or package install scripts; project test code is still executable code and is not network-isolated.');
    if (verification.note) lines.push(`- Note: ${verification.note}`);
    if (verification.checks.length > 0) {
      lines.push('');
      lines.push('| Check | Command | Result | Duration | Output |');
      lines.push('|---|---|---|---:|---|');
      for (const check of verification.checks) {
        lines.push(`| ${markdownCell(check.name)} | ${inlineCode(check.command)} | ${check.status} | ${(check.durationMs / 1000).toFixed(2)}s | ${markdownCell(check.output || '—')} |`);
      }
    }
    lines.push('');
  }

  if (outcome.changes.length > 0) {
    lines.push(dryRun ? '## Proposed transformations' : '## Applied transformations');
    lines.push('');
    lines.push('| Location | Rule | Before | After |');
    lines.push('|---|---|---|---|');
    for (const c of outcome.changes) {
      lines.push(`| ${inlineCode(`${c.file}:${c.line}`)} | ${markdownCell(c.rule)} | ${markdownCell(c.before)} | ${markdownCell(c.after)} |`);
    }
    lines.push('');
  }

  if (outcome.proposedDiff.length > 0) {
    lines.push(dryRun ? '## Proposed diff (not applied)' : '## Applied diff');
    lines.push('');
    for (const diff of outcome.proposedDiff) {
      const longestBacktickRun = Math.max(0, ...[...diff.matchAll(/`+/g)].map(([run]) => run.length));
      const fence = '`'.repeat(Math.max(4, longestBacktickRun + 1));
      lines.push(`${fence}diff`);
      lines.push(diff);
      lines.push(fence);
      lines.push('');
    }
  }

  lines.push('## Next steps');
  lines.push('');
  if (dryRun) {
    lines.push('1. Review the preview and the official migration guide before applying changes to a repository.');
    lines.push('2. After review, use --write to verify and commit supported changes on a new Git branch. The command refuses manual findings and failed or missing checks.');
    lines.push('3. Use the official migration guide and handle the items listed under "Needs your attention" manually.');
  } else {
    lines.push('1. Review the applied changes (`git diff`).');
    lines.push('2. Reinstall dependencies and run your type checker and tests.');
    lines.push('3. Handle the items listed under "Needs your attention".');
  }
  lines.push('');
  const raw = lines.join('\n');
  const sanitized = maskSecrets(raw);
  return sanitized === raw ? raw : `${sanitized}\n> Warning: possible credentials were detected in the report and redacted. Review the source before sharing this report.`;
}

/** Redact common provider credentials and private-key material from every report field. */
export function maskSecrets(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
    .replace(/((?:"|\b)private_key(?:"|\b)\s*:\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^,\r\n}]+)/gi, '$1"[REDACTED]"')
    .replace(/\b(?:sk|rk|pk)\\?_(?:live|test)\\?_(?:[A-Za-z0-9-]|\\?_){8,}\b/gi, '[API key redacted]')
    .replace(/\bwhsec\\?_(?:[A-Za-z0-9-]|\\?_){8,}\b/gi, '[webhook secret redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[API key redacted]');
}

/** Escape third-party command output before placing it in a public Markdown table. */
export function escapeUntrustedMarkdownCell(value: string): string {
  return maskSecrets(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;')
    .replaceAll('|', '&#124;').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

/** Keep the Markdown artifact intact while making prose readable in a terminal. */
export function renderTerminalReport(markdown: string): string {
  let inFence = false;
  const readable = markdown.split('\n').map((line) => {
    if (/^`{4,}/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || !line.startsWith('- ')) return line;
    return line
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\\([\\`*_{}\[\]()#+.!])/g, '$1');
  }).join('\n');
  return maskSecrets(readable);
}

function markdownCell(value: string): string {
  return escapeMarkdownText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function escapeMarkdownText(value: string): string {
  return maskSecrets(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!])/g, '\\$1');
}

function inlineCode(value: string): string {
  const normalized = maskSecrets(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  const runs = [...normalized.matchAll(/`+/g)].map(([run]) => run.length);
  const delimiter = '`'.repeat(Math.max(1, ...runs) + 1);
  const needsPadding = normalized.startsWith('`') || normalized.endsWith('`') || /^\s|\s$/.test(normalized);
  return `${delimiter}${needsPadding ? ' ' : ''}${normalized}${needsPadding ? ' ' : ''}${delimiter}`;
}
