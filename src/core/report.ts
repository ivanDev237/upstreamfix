import type { MigrationInfo } from './types.js';
import type { RunOutcome } from './runner.js';
import type { VerificationResult } from './verify.js';

export function renderMarkdownReport(
  migration: MigrationInfo,
  outcome: RunOutcome,
  dryRun: boolean,
  verification?: VerificationResult,
  verificationEnvironment: 'restricted-host' | 'network-isolated-container' = 'restricted-host',
): string {
  const lines: string[] = [];
  const total = outcome.changes.length + outcome.manual.length;

  lines.push(`# Migration report: ${migration.title}`);
  lines.push('');
  if (migration.experimental) lines.push('> **Experimental migration:** real-project validation is incomplete. Review every proposed edit and verification failure before using it.\n');
  if (dryRun) lines.push('> Dry run: no file was written.\n');
  lines.push(`- Findings: **${total}**`);
  lines.push(`- ${dryRun ? 'Proposed transformations' : 'Applied transformations'}: **${outcome.changes.length}**`);
  lines.push(`- Need your attention: **${outcome.manual.length}**`);
  lines.push(`- ${dryRun ? 'Files with proposed changes' : 'Files changed'}: **${outcome.filesChanged.length}**`);
  lines.push(`- Official guide: ${escapeMarkdownText(migration.guideUrl)}`);
  lines.push('');

  if (total === 0) {
    lines.push(`No supported ${escapeMarkdownText(migration.title)} usages were found in the scanned files.`);
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
    lines.push(verificationEnvironment === 'network-isolated-container'
      ? '- Verification commands run in a network-isolated Docker container with restricted privileges and without copied credentials or package install scripts.'
      : '- Verification commands run on this machine with a restricted environment, without copied credentials or package install scripts; project test code is still executable code and is not network-isolated.');
    if (verification.note) lines.push(`- Note: ${escapeMarkdownText(verification.note)}`);
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
  const raw = stripTerminalControls(lines.join('\n'));
  const sanitized = maskSecrets(raw);
  return sanitized === raw ? raw : `${sanitized}\n> Warning: possible credentials were detected in the report and redacted. Review the source before sharing this report.`;
}

/** Redact common provider credentials and private-key material from every report field. */
export function maskSecrets(value: string): string {
  return redactPrivateKeys(value)
    .replace(/((?:\\?"private_key\\?"|private_key|privateKey)\s*:\s*)\\?"[^"\r\n]*\\?"/gi, '$1"[REDACTED]"')
    .replace(/((?:"|\b)private\\?_key(?:"|\b)\s*:\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^,\r\n}]+)/gi, '$1"[REDACTED]"')
    .replace(/\b(?:sk|rk|pk)\\?_(?:live|test)\\?_(?:[A-Za-z0-9-]|\\?_){8,}\b/gi, '[API key redacted]')
    .replace(/\bsk_org_[A-Za-z0-9_-]{8,}\b/g, '[API key redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[GitHub token redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[GitHub token redacted]')
    .replace(/\bxox[bp]-[A-Za-z0-9-]{20,}\b/g, '[Slack token redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[AWS key redacted]')
    .replace(/\bwhsec\\?_(?:[A-Za-z0-9-]|\\?_){8,}\b/gi, '[webhook secret redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[API key redacted]');
}

function redactPrivateKeys(value: string): string {
  const begin = /-----BEGIN ((?:(?:[A-Z0-9]+ )*PRIVATE KEY|PGP PRIVATE KEY BLOCK))-----/g;
  let result = '';
  let cursor = 0;
  for (let match = begin.exec(value); match; match = begin.exec(value)) {
    result += value.slice(cursor, match.index) + '[PRIVATE KEY REDACTED]';
    const endMarker = `-----END ${match[1]}-----`;
    const end = value.indexOf(endMarker, begin.lastIndex);
    if (end < 0) return result;
    cursor = end + endMarker.length;
    begin.lastIndex = cursor;
  }
  return result + value.slice(cursor);
}

/** Escape third-party command output before placing it in a public Markdown table. */
export function escapeUntrustedMarkdownCell(value: string): string {
  return maskSecrets(stripTerminalControls(value))
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
    if (!inFence && line.startsWith('|')) return line.replaceAll('<br>', '\n    ');
    if (inFence || !line.startsWith('- ')) return line;
    return line
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\\([\\`*_{}\[\]()#+.!])/g, '$1');
  }).join('\n');
  return sanitizeTerminalText(readable);
}

export function sanitizeTerminalText(value: string): string {
  return maskSecrets(stripTerminalControls(value));
}

function stripTerminalControls(value: string): string {
  let clean = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x1b) {
      const kind = value[i + 1];
      if (kind === '[') {
        i += 2;
        while (i < value.length && !(value.charCodeAt(i) >= 0x40 && value.charCodeAt(i) <= 0x7e)) i++;
      } else if (kind === ']' || kind === 'P' || kind === 'X' || kind === '^' || kind === '_') {
        i += 2;
        while (i < value.length && value.charCodeAt(i) !== 0x07 && !(value[i] === '\x1b' && value[i + 1] === '\\')) i++;
        if (value[i] === '\x1b') i++;
      } else i++;
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) continue;
    clean += value[i];
  }
  return clean;
}

function markdownCell(value: string): string {
  return escapeMarkdownText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function escapeMarkdownText(value: string): string {
  return sanitizeTerminalText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!])/g, '\\$1')
    .replaceAll('\\[API key redacted\\]', '[API key redacted]');
}

function inlineCode(value: string): string {
  const normalized = sanitizeTerminalText(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  const runs = [...normalized.matchAll(/`+/g)].map(([run]) => run.length);
  const delimiter = '`'.repeat(Math.max(1, ...runs) + 1);
  const needsPadding = normalized.startsWith('`') || normalized.endsWith('`') || /^\s|\s$/.test(normalized);
  return `${delimiter}${needsPadding ? ' ' : ''}${normalized}${needsPadding ? ' ' : ''}${delimiter}`;
}
