import { writeFile } from 'node:fs/promises';

// Discovery only: every result must be reviewed and pinned before it enters benchmark/openai-5-repos.json.
const queries = ["files.del(", "vectorStores.files.del(", "openai/error", "runFunctions("];
const candidates = [];
const seen = new Set();
for (const query of queries) {
  try {
    const search = await fetch(`https://grep.app/api/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(15000) });
    if (!search.ok) throw new Error(`search HTTP ${search.status}`);
    const payload = await search.json();
    for (const hit of payload.hits?.hits ?? []) {
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
