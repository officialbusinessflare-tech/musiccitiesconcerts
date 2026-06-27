/**
 * netlify/functions/nightly-rebuild.mjs
 *
 * Netlify scheduled function. Runs at 07:00 UTC every day (~03:00 ET in
 * summer, ~02:00 ET in winter — see netlify.toml for the cron line).
 *
 * Process:
 *   1. Pull tasks from ClickUp via the shared _clickup-core helper.
 *   2. Build a fresh concerts.json payload.
 *   3. Commit it to the GitHub repo via the Contents API, which triggers a
 *      Netlify build automatically.
 *
 * Required env vars (set in Netlify -> Site -> Environment):
 *   CLICKUP_TOKEN     -- ClickUp personal token
 *   CLICKUP_LIST_ID   -- (optional) defaults to 901413842804
 *   GITHUB_TOKEN      -- PAT with contents:write on the repo
 *   GITHUB_REPO       -- e.g. "officialbusinessflare-tech/music-cities-concerts"
 *   GITHUB_BRANCH     -- (optional) defaults to "main"
 */

import {
  buildConcertEntries,
  fetchClickUpTasks,
  summarize,
} from './_clickup-core.mjs';

// Buckets config loaded at module init. Netlify's esbuild bundler will inline
// this at deploy time. We use a fs read instead of an import-assertion so it
// works in both Node 20+ and Netlify's runtime without flags.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUCKETS_PATH = resolve(__dirname, '../../buckets.config.json');
let bucketsConfig;
try {
  bucketsConfig = JSON.parse(readFileSync(BUCKETS_PATH, 'utf8'));
} catch (err) {
  console.warn('[nightly-rebuild] could not read buckets.config.json:', err.message);
  bucketsConfig = { buckets: [] };
}

const DEFAULT_LIST_ID = '901413842804';
const DEFAULT_BRANCH = 'main';
const FILE_PATH = 'concerts.json';

/* ---------- GitHub Contents API helpers ---------- */

async function ghGetFileSha({ token, repo, branch, path }) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'music-cities-concerts/nightly',
    },
  });

  if (res.status === 404) return null; // File doesn't exist yet -- first run.
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub GET ${path} -> ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.sha;
}

async function ghPutFile({ token, repo, branch, path, contentBase64, sha, message }) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: contentBase64,
    branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'music-cities-concerts/nightly',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub PUT ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/* ---------- The handler ---------- */

export default async (req) => {
  const startedAt = new Date();
  const log = (msg) => console.log(`[nightly-rebuild] ${msg}`);

  try {
    const token = process.env.CLICKUP_TOKEN;
    const listId = process.env.CLICKUP_LIST_ID || DEFAULT_LIST_ID;
    const ghToken = process.env.GITHUB_TOKEN;
    const ghRepo = process.env.GITHUB_REPO;
    const ghBranch = process.env.GITHUB_BRANCH || DEFAULT_BRANCH;

    const missing = [];
    if (!token) missing.push('CLICKUP_TOKEN');
    if (!ghToken) missing.push('GITHUB_TOKEN');
    if (!ghRepo) missing.push('GITHUB_REPO');
    if (missing.length) {
      throw new Error(`Missing env vars: ${missing.join(', ')}`);
    }

    log(`Fetching ClickUp list ${listId}`);
    const rawTasks = await fetchClickUpTasks({ token, listId });
    log(`  ${rawTasks.length} raw tasks`);

    const buckets = bucketsConfig.buckets ?? [];
    const entries = buildConcertEntries(rawTasks, buckets);
    log(`  ${entries.length} entries after filtering`);

    const payload = {
      generatedAt: startedAt.toISOString(),
      entries,
    };
    const json = JSON.stringify(payload, null, 2) + '\n';
    const contentBase64 = Buffer.from(json, 'utf8').toString('base64');

    log(`Looking up current sha of ${FILE_PATH} on ${ghRepo}@${ghBranch}`);
    const sha = await ghGetFileSha({ token: ghToken, repo: ghRepo, branch: ghBranch, path: FILE_PATH });
    log(`  sha=${sha ?? '<none -- will create>'}`);

    const dateLabel = startedAt.toISOString().slice(0, 10);
    const commitMessage = `nightly rebuild ${dateLabel}`;

    log(`Committing ${FILE_PATH}...`);
    await ghPutFile({
      token: ghToken,
      repo: ghRepo,
      branch: ghBranch,
      path: FILE_PATH,
      contentBase64,
      sha: sha ?? undefined,
      message: commitMessage,
    });

    const counts = summarize(entries, buckets);
    log(`Done. Counts: ${JSON.stringify(counts)}`);

    return new Response(
      JSON.stringify({
        ok: true,
        generatedAt: payload.generatedAt,
        totalEntries: entries.length,
        counts,
        commitMessage,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[nightly-rebuild] FAILED:', err?.stack || err?.message || err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err?.message || err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

// Netlify scheduled-functions metadata. The cron in netlify.toml is the source
// of truth, but this export lets some tooling pick it up too.
export const config = {
  schedule: '0 7 * * *',
};
