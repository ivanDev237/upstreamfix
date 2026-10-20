import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('release metadata', () => {
  it('keeps the 0.3.0 package and lockfile aligned and preserves the 0.1.2 CLI history', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    expect(manifest.version).toBe('0.3.0');
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages['']?.version).toBe(manifest.version);
    expect(changelog).toMatch(/## 0\.1\.3[\s\S]*0\.1\.2[\s\S]*(?:npx|global)/);
  });
});
