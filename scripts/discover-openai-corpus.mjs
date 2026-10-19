import { writeFile } from 'node:fs/promises';

// Discovery only: every result must be reviewed and pinned before it enters benchmark/openai-5-repos.json.
const queries = ["files.del(", "vectorStores.files.del(", "openai/error", "runFunctions("];
const candidates = [];
const seen = new Set();
// Sourcegraph's public streaming search does not require a token. It provides
// another source when grep.app rate-limits GitHub-hosted runners.
async function sourcegraphHits(query) {
  const params = new URLSearchParams({
    q: `${query} patternType:keyword count:30 repo:^github\\.com/`,
    v: 'V3',
  });
  const response = await fetch(`https://sourcegraph.com/.api/search/stream?${params}`, {
    headers: { Accept: 'text/event-stream' }, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Sourcegraph HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error('Sourcegraph response exceeds discovery limit');
  const hits = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    if (!/^event: matches\r?$/m.test(event)) continue;
    const data = event.split(/\r?\n/).find((line) => line.startsWith('data: '));
    if (!data) continue;
    for (const match of JSON.parse(data.slice(6))) {
      if (match.type !== 'content' || typeof match.repository !== 'string') continue;
      hits.push({ repo: match.repository.replace(/^github\.com\//, ''), path: match.path });
    }
  }
  return hits;
}

for (const query of queries) {
  try {
    let hits;
    try {
      const search = await fetch(`https://grep.app/api/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(15000) });
      if (!search.ok) throw new Error(`grep.app HTTP ${search.status}`);
      const payload = await search.json();
      hits = payload.hits?.hits ?? [];
    } catch (error) {
      console.warn(`${String(error)}; trying Sourcegraph for ${query}.`);
      hits = await sourcegraphHits(query);
    }
    for (const hit of hits) {
      if (!/\.(?:[cm]?[jt]sx?)$/i.test(hit.path ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(hit.repo ?? '')) continue;
      const key = `${hit.repo}:${hit.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const repo = await fetch(`https://api.github.com/repos/${hit.repo}`, { signal: AbortSignal.timeout(10000) });
        if (!repo.ok) continue;
        const metadata = await repo.json();
        if (metadata.private || !metadata.default_branch) continue;
        const ref = await fetch(`https://api.github.com/repos/${hit.repo}/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`, { signal: AbortSignal.timeout(10000) });
        if (!ref.ok) continue;
        const sha = (await ref.json()).object?.sha;
        if (!/^[0-9a-f]{40}$/.test(sha ?? '')) continue;
        const manifest = await fetch(`https://raw.githubusercontent.com/${hit.repo}/${sha}/package.json`, { signal: AbortSignal.timeout(10000) });
        if (!manifest.ok) continue;
        const pkg = await manifest.json();
        const range = pkg.dependencies?.openai ?? pkg.devDependencies?.openai;
        if (!/^\s*[~^]?4(?:\.|$)/.test(range ?? '')) continue;
        const source = await fetch(`https://raw.githubusercontent.com/${hit.repo}/${sha}/${hit.path}`, { signal: AbortSignal.timeout(10000) });
        if (!source.ok) continue;
        const body = await source.text();
        if (!body.includes(query)) continue;
        candidates.push({ repository: hit.repo, commit: sha, branch: metadata.default_branch, path: hit.path,
          sdkRange: range, matched: query, url: `https://github.com/${hit.repo}/blob/${sha}/${hit.path}` });
      } catch (error) { console.warn(`Skipped ${key}: ${String(error)}`); }
      if (candidates.length >= 20) break;
    }
  } catch (error) { console.warn(`Discovery query ${query} unavailable: ${String(error)}`); }
}
const target = process.env.UPSTREAMFIX_CORPUS_CANDIDATES ?? 'openai-corpus-candidates.json';
await writeFile(target, JSON.stringify({ generatedAt: new Date().toISOString(), reviewed: false, candidates }, null, 2));
console.log(`${candidates.length} OpenAI v4 candidate source files found; none were added to the reviewed corpus.`);
