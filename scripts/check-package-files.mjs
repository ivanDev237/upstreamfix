import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function inspectPackageContents(pack) {
  const files = pack?.[0]?.files?.map(({ path: filePath }) => filePath) ?? [];
  const allowed = (file) => file === 'package.json'
    || file === 'README.md'
    || file === 'LICENSE'
    || file.startsWith('dist/');
  const unexpected = files.filter((file) => !allowed(file));
  const required = ['package.json', 'README.md', 'LICENSE'];
  const missing = required.filter((file) => !files.includes(file));
  return { unexpected, missing, hasDist: files.some((file) => file.startsWith('dist/')) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let pack;
  try {
    pack = JSON.parse(input);
  } catch {
    console.error('Could not parse npm pack --dry-run output.');
    process.exit(1);
  }
  const result = inspectPackageContents(pack);
  if (result.unexpected.length || result.missing.length || !result.hasDist) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(`Package contents verified (${pack[0].files.length} files).`);
}
