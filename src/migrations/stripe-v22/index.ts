import type { Project } from 'ts-morph';
import type { Migration, MigrationResult, PackageManifest } from '../../core/types.js';
import { migrateStripeV22 } from '../stripe-shared.js';

export const stripeV22: Migration = {
  id: 'stripe@22',
  packageName: 'stripe',
  fromMajor: 21,
  toMajor: 22,
  releasedAt: '2026-04-03',
  title: 'stripe v21 → v22',
  guideUrl: 'https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22',
  rules: [
    'stripe-constructor',
    'cjs-default-export',
    'stripe-context-type',
    'stripe-error-type',
    'remove-obsolete-type-reference',
    'request-options-position',
  ],
  transform(project: Project): MigrationResult {
    return migrateStripeV22(project);
  },
  updateManifest(manifest: PackageManifest): string[] {
    return updateStripeMajor(manifest, 21, 22);
  },
};

function updateStripeMajor(manifest: PackageManifest, from: number, to: number): string[] {
  const notes: string[] = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const current = manifest[field]?.stripe;
    if (!current) continue;
    const match = /^\s*[~^]?([0-9]+)(?:\.(?:[0-9]+|x|\*)){0,2}\s*$/i.exec(current);
    if (!match) {
      notes.push('Could not safely interpret `' + field + '.stripe` range `' + current + '`; update it to `^' + to + '.0.0` manually if appropriate.');
    } else if (Number(match[1]) === from) {
      notes.push('`' + field + '.stripe`: `' + current + '` → `^' + to + '.0.0`');
      manifest[field]!.stripe = `^${to}.0.0`;
    } else if (Number(match[1]) < from) {
      notes.push('`' + field + '.stripe` is on major ' + match[1] + '; this migration targets v' + from + ' → v' + to + '. Upgrade to v' + from + ' first and review its migration guide.');
    } else if (Number(match[1]) > to) {
      notes.push('`' + field + '.stripe` is already on major ' + match[1] + '; it was left unchanged to avoid downgrading it to v' + to + '.');
    }
  }
  return notes;
}
