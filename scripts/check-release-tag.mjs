import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseTagError(tag, version) {
  if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    return `Expected a semantic version tag such as v1.2.3; received ${tag ?? '(missing)'}.`;
  }
  if (tag !== `v${version}`) return `Git tag ${tag} does not match package.json version v${version}.`;
  return undefined;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const tag = process.argv[2];
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const error = releaseTagError(tag, pkg.version);
  if (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
