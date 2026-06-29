/**
 * netlify/functions/nightly-rebuild.mjs
 *
 * Netlify scheduled function. Runs at 07:00 UTC every day (~03:00 ET in
 * summer, ~02:00 ET in winter — see netlify.toml for the cron line).
 *
 * Process:
 *   1. Pull tasks from ClickUp via the shared _clickup-core helper.
 *   2. Build a fresh concerts.json payload.
 *   3. Pull birthday tasks from the Artist Birthdays list, parse, build
 *      birthdays.json payload.
 *   4. Fetch YouTube channel stats for @themusiccitiespodcast and build
 *      youtube-stats.json payload.
 *   5. Commit all three files to the GitHub repo via the Contents API,
 *      which triggers a Netlify build automatically.
 *
 * Required env vars (set in Netlify -> Site -> Environment):
 *   CLICKUP_TOKEN       -- ClickUp personal token
 *   CLICKUP_LIST_ID     -- (optional) defaults to 901413842804
 *   BIRTHDAYS_LIST_ID   -- (optional) defaults to 901417078439
 *   YOUTUBE_API_KEY     -- (optional) YouTube Data API v3 key; if absent the
 *                          YouTube refresh step is skipped (existing
 *                          youtube-stats.json is preserved)
 *   GITHUB_TOKEN        -- PAT with contents:write on the repo
 *   GITHUB_REPO         -- e.g. "officialbusinessflare-tech/musiccitiesconcerts"
 *   GITHUB_BRANCH       -- (optional) defaults to "main"
 */

import {
    buildConcertEntries,
    fetchClickUpTasks,
    summarize,
} from './_clickup-core.mjs';

// Buckets config inlined at build time. Importing JSON directly avoids the
// need for fs/path tricks that conflict with esbuild's bundler shims (in
// particular, esbuild already injects its own __dirname into the bundle, so
// declaring our own here causes a duplicate-identifier SyntaxError at runtime).
import bucketsConfig from '../../buckets.config.json' with { type: 'json' };

const DEFAULT_LIST_ID = '901413842804';
const DEFAULT_BIRTHDAYS_LIST_ID = '901417078439';
const DEFAULT_BRANCH = 'main';
const FILE_PATH = 'concerts.json';
const BIRTHDAYS_FILE_PATH = 'birthdays.json';
const YOUTUBE_FILE_PATH = 'public/youtube-stats.json';
const YOUTUBE_HANDLE = 'themusiccitiespodcast';

/* ---------- Birthday parser (JS-only mirror of src/lib/parse-birthday.ts) ---------- */

function decodeBirthdayEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
}

function extractBirthdayStatus(s) {
    const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (!m) return { core: s.trim() };
    return { core: m[1].trim(), status: m[2].trim() };
}

function parseBirthdayName(rawName) {
    if (!rawName) return { person: '' };
    const decoded = decodeBirthdayEntities(rawName.trim());
    const { core, status } = extractBirthdayStatus(decoded);
    const m = core.match(/^(.+?)\s+Birthday\s+(.+)$/i);
    if (!m) return { person: core, status };
    const person = m[1].trim();
    const affRaw = m[2].trim();
    const affiliation = affRaw && affRaw.toLowerCase() !== 'solo' ? affRaw : undefined;
    return { person, affiliation, status };
}

function tsToYMD(ts) {
    if (ts == null) return null;
    const n = typeof ts === 'string' ? Number(ts) : ts;
    if (!Number.isFinite(n)) return null;
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

function taskToBirthday(task) {
    if (!task) return null;
    const name = (task.name || '').trim();
    if (!name) return null;
    const { person, affiliation, status } = parseBirthdayName(name);
    if (!person) return null;
    const rawDate = tsToYMD(task.due_date) ?? undefined;
    let month;
    let day;
    if (rawDate) {
          const parts = rawDate.split('-').map(Number);
          const mo = parts[1];
          const da = parts[2];
          if (mo && da) {
                  month = mo;
                  day = da;
          }
    }
    const clickupUrl = task.url || `https://app.clickup.com/t/${task.id}`;
    const desc = (task.markdown_description || task.description || '').trim();
    return {
        id: String(task.id),
        name,
        person,
        affiliation,
        rawDate,
        month,
        day,
        description: desc || undefined,
        status,
        clickupUrl,
    };
}

function buildBirthdayEntries(rawTasks) {
    const entries = [];
    for (const t of rawTasks) {
          try {
                  const e = taskToBirthday(t);
                  if (e) entries.push(e);
          } catch (err) {
                  console.warn(`[birthdays] Skipping ${t?.id ?? '<unknown>'}: ${err?.message ?? err}`);
          }
    }
    const now = new Date();
    const todayKey = now.getMonth() * 100 + now.getDate();
    function upcomingKey(e) {
          if (e.month == null || e.day == null) return Number.MAX_SAFE_INTEGER;
          const key = (e.month - 1) * 100 + e.day;
          return key < todayKey ? key + 1300 : key;
    }
    entries.sort((a, b) => upcomingKey(a) - upcomingKey(b));
    return entries;
}

/* ---------- YouTube stats fetcher (mirror of scripts/fetch-youtube-stats.mjs) ---------- */

async function fetchYoutubeStats(apiKey) {
    if (!apiKey) {
        console.warn('[youtube-stats] YOUTUBE_API_KEY not set; skipping fetch');
        return null;
    }
    try {
        const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&forHandle=${YOUTUBE_HANDLE}&key=${apiKey}`;
        const res = await fetch(url);
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`YouTube API ${res.status}: ${body.substring(0, 300)}`);
        }
        const data = await res.json();
        if (!data.items || !data.items.length) {
            throw new Error('YouTube API returned no channel for handle ' + YOUTUBE_HANDLE);
        }
        const channel = data.items[0];
        return {
            handle: '@' + YOUTUBE_HANDLE,
            channelId: channel.id,
            channelTitle: channel.snippet?.title,
            subscriberCount: Number(channel.statistics.subscriberCount),
            videoCount: Number(channel.statistics.videoCount),
            viewCount: Number(channel.statistics.viewCount),
            fetchedAt: new Date().toISOString(),
        };
    } catch (err) {
        console.error('[youtube-stats] fetch failed:', err?.message ?? err);
        return null;
    }
}

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

  if (res.status === 404) return null;
    if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`GitHub GET ${path} -> ${res.status}: ${body.slice(0, 200)}`);
    }

  const json = await res.json();
    return json.sha;
}

async function ghPutFile({ token, repo, branch, path, contentBase64, sha, message }) {
    const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
    const body = { message, content: contentBase64, branch };
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
          const birthdaysListId = process.env.BIRTHDAYS_LIST_ID || DEFAULT_BIRTHDAYS_LIST_ID;
          const ghToken = process.env.GITHUB_TOKEN;
          const ghRepo = process.env.GITHUB_REPO;
          const ghBranch = process.env.GITHUB_BRANCH || DEFAULT_BRANCH;
          const youtubeApiKey = process.env.YOUTUBE_API_KEY;

      const missing = [];
          if (!token) missing.push('CLICKUP_TOKEN');
          if (!ghToken) missing.push('GITHUB_TOKEN');
          if (!ghRepo) missing.push('GITHUB_REPO');
          if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);

      log(`Fetching ClickUp list ${listId}`);
          const rawTasks = await fetchClickUpTasks({ token, listId });
          log(`  ${rawTasks.length} raw tasks`);

      const buckets = bucketsConfig?.buckets ?? [];
          const entries = buildConcertEntries(rawTasks, buckets);
          log(`  ${entries.length} entries after filtering`);

      const payload = { generatedAt: startedAt.toISOString(), entries };
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
          log(`concerts.json done. Counts: ${JSON.stringify(counts)}`);

      /* ---- Birthdays ---- */
          let birthdayCount = 0;
          let birthdayError = null;
          try {
                  log(`Fetching ClickUp list ${birthdaysListId} (birthdays)`);
                  const rawBirthdayTasks = await fetchClickUpTasks({ token, listId: birthdaysListId });
                  log(`  ${rawBirthdayTasks.length} raw birthday tasks`);

          const birthdayEntries = buildBirthdayEntries(rawBirthdayTasks);
                  birthdayCount = birthdayEntries.length;
                  log(`  ${birthdayCount} birthday entries after parsing`);

          const birthdayPayload = { generatedAt: startedAt.toISOString(), entries: birthdayEntries };
                  const birthdayJson = JSON.stringify(birthdayPayload, null, 2) + '\n';
                  const birthdayBase64 = Buffer.from(birthdayJson, 'utf8').toString('base64');

          log(`Looking up current sha of ${BIRTHDAYS_FILE_PATH} on ${ghRepo}@${ghBranch}`);
                  const birthdaySha = await ghGetFileSha({ token: ghToken, repo: ghRepo, branch: ghBranch, path: BIRTHDAYS_FILE_PATH });
                  log(`  sha=${birthdaySha ?? '<none -- will create>'}`);

          log(`Committing ${BIRTHDAYS_FILE_PATH}...`);
                  await ghPutFile({
                              token: ghToken,
                              repo: ghRepo,
                              branch: ghBranch,
                              path: BIRTHDAYS_FILE_PATH,
                              contentBase64: birthdayBase64,
                              sha: birthdaySha ?? undefined,
                              message: `nightly birthdays rebuild ${dateLabel}`,
                  });
                  log('birthdays.json done.');
          } catch (err) {
                  birthdayError = String(err?.message || err);
                  console.error('[nightly-rebuild] birthdays step failed:', err?.stack || err?.message || err);
          }

      /* ---- YouTube stats ---- */
          let youtubeSubscribers = null;
          let youtubeError = null;
          try {
                  log('Fetching YouTube channel stats');
                  const stats = await fetchYoutubeStats(youtubeApiKey);
                  if (!stats) {
                          if (!youtubeApiKey) {
                                  log('  skipped (YOUTUBE_API_KEY not set)');
                          } else {
                                  log('  no stats returned; skipping commit (existing youtube-stats.json preserved)');
                          }
                  } else {
                          youtubeSubscribers = stats.subscriberCount;
                          log(`  subscribers=${youtubeSubscribers} videos=${stats.videoCount} views=${stats.viewCount}`);

              const ytJson = JSON.stringify(stats, null, 2) + '\n';
                          const ytBase64 = Buffer.from(ytJson, 'utf8').toString('base64');

              log(`Looking up current sha of ${YOUTUBE_FILE_PATH} on ${ghRepo}@${ghBranch}`);
                          const ytSha = await ghGetFileSha({ token: ghToken, repo: ghRepo, branch: ghBranch, path: YOUTUBE_FILE_PATH });
                          log(`  sha=${ytSha ?? '<none -- will create>'}`);

              log(`Committing ${YOUTUBE_FILE_PATH}...`);
                          await ghPutFile({
                                          token: ghToken,
                                          repo: ghRepo,
                                          branch: ghBranch,
                                          path: YOUTUBE_FILE_PATH,
                                          contentBase64: ytBase64,
                                          sha: ytSha ?? undefined,
                                          message: `nightly youtube-stats rebuild ${dateLabel}`,
                          });
                          log('youtube-stats.json done.');
                  }
          } catch (err) {
                  youtubeError = String(err?.message || err);
                  console.error('[nightly-rebuild] youtube step failed:', err?.stack || err?.message || err);
          }

      return new Response(
              JSON.stringify({
                        ok: true,
                        generatedAt: payload.generatedAt,
                        totalEntries: entries.length,
                        counts,
                        commitMessage,
                        birthdayCount,
                        birthdayError,
                        youtubeSubscribers,
                        youtubeError,
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

export const config = {
    schedule: '0 7 * * *',
};
