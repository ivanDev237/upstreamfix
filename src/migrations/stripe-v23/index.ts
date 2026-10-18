import type { Project } from 'ts-morph';
import type { Migration, MigrationResult, PackageManifest } from '../../core/types.js';
import { migrateStripeV23 } from '../stripe-shared.js';

export const stripeV23: Migration = {
  id: 'stripe@23',
  packageName: 'stripe',
  fromMajor: 22,
  toMajor: 23,
  releasedAt: '2026-10-01',
  title: 'stripe v22 → v23',
  guideUrl: 'https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v23',
  rules: ['error-type-namespace', 'webhook-method-location'],
  transform(project: Project): MigrationResult {
    return migrateStripeV23(project);
  },
  updateManifest(manifest: PackageManifest): string[] {
    const notes: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const current = manifest[field]?.stripe;
      if (!current) continue;
      const match = /^\s*[~^]?([0-9]+)(?:\.(?:[0-9]+|x|\*)){0,2}\s*$/i.exec(current);
      if (!match) {
        notes.push('Could not safely interpret `' + field + '.stripe` range `' + current + '`; update it to `^23.0.0` manually if appropriate.');
      } else if (Number(match[1]) === 22) {
        notes.push('`' + field + '.stripe`: `' + current + '` → `^23.0.0`');
        manifest[field]!.stripe = '^23.0.0';
      } else if (Number(match[1]) < 22) {
        notes.push('`' + field + '.stripe` is on major ' + match[1] + '; this migration targets v22 → v23. Upgrade to v22 first and review its migration guide.');
      } else if (Number(match[1]) > 23) {
        notes.push('`' + field + '.stripe` is already on major ' + match[1] + '; it was left unchanged to avoid downgrading it to v23.');
      }
    }
    const nodeRange = manifest.engines?.node;
    if (!nodeRange) {
      notes.push('stripe v23 requires Node.js 20 or later; package.json does not declare an engines.node range, so confirm the deployment runtime before upgrading.');
    } else if (!supportsNode20(nodeRange)) {
      notes.push(`stripe v23 requires Node.js 20 or later; review engines.node (${nodeRange}) before upgrading.`);
    }
    return notes;
  },
  inspectManifest(manifest: PackageManifest): string[] {
    const nodeRange = manifest.engines?.node;
    if (!nodeRange) return ['stripe v23 requires Node.js 20 or later; confirm the deployment runtime before upgrading.'];
    if (!supportsNode20(nodeRange)) return [`stripe v23 requires Node.js 20 or later; review engines.node (${nodeRange}) before upgrading.`];
    return [];
  },
};

function supportsNode20(range: string): boolean {
  return /^(?:>=\s*20(?:\.\d+){0,2}|(?:\^|~)\s*(?:20|2[1-9]|[3-9]\d)(?:\.\d+){0,2}|(?:20|2[1-9]|[3-9]\d)(?:\.\d+){0,2})$/.test(range.trim());
}
