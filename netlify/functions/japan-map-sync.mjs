/**
 * netlify/functions/japan-map-sync.mjs
 *
 * Netlify scheduled function. Runs every 3 hours (8x/day). Lets Kevin add
 * trip spots to the Japan map from his phone:
 *   1. Read open tasks from the ClickUp "Japan Map — Add from Phone" list.
 *   2. Geocode each new place name (OpenStreetMap Nominatim, Japan-biased).
 *   3. Append a pin to japan-map-adds.json and commit it via the GitHub
 *      Contents API (which triggers a Netlify rebuild -> pin appears on the map).
 *   4. Comment on the ClickUp task and mark it "complete" so it drops off.
 *
 * Dedup is by ClickUp task id stored on each pin (clickupId), so a task is
 * never added twice even if the status update fails.
 *
 * Required env vars (already set for nightly-rebuild):
 *   CLICKUP_TOKEN, GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH (optional)
 * Optional: JAPAN_MAP_LIST_ID (defaults to the phone-add list)
 */

import { fetchClickUpTasks } from './_clickup-core.mjs';

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const LIST_ID = process.env.JAPAN_MAP_LIST_ID || '901422919471';
const COMPLETE_STATUS = 'complete';
const ADDS_PATH = 'japan-map-adds.json';
const DEFAULT_BRANCH = 'main';

const CITIES = [
  { en: 'Tokyo', lat: 35.685, lon: 139.76 }, { en: 'Yokohama', lat: 35.466, lon: 139.622 },
  { en: 'Kawasaki', lat: 35.5316, lon: 139.7003 }, { en: 'Nagoya', lat: 35.1709, lon: 136.8815 },
  { en: 'Kyoto', lat: 34.9858, lon: 135.7588 }, { en: 'Osaka', lat: 34.7003, lon: 135.4943 },
  { en: 'Hiroshima', lat: 34.3955, lon: 132.4596 }, { en: 'Miyajima', lat: 34.298, lon: 132.3198 },
];
function nearestCity(lat, lon) {
  let best = CITIES[0], bd = Infinity;
  for (const c of CITIES) { const d = (c.lat - lat) ** 2 + (c.lon - lon) ** 2; if (d < bd) { bd = d; best = c; } }
  return best.en;
}
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'pin';
}

async function geocode(q) {
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q, format: 'json', limit: '1', countrycodes: 'jp', 'accept-language': 'en',
  });
  const res = await fetch(url, { headers: { 'User-Agent': 'music-cities-concerts/japan-map-sync (kevin@businessflare.net)' } });
  if (!res.ok) return null;
  const arr = await res.json().catch(() => null);
  if (!Array.isArray(arr) || !arr.length) return null;
  const lat = parseFloat(arr[0].lat), lon = parseFloat(arr[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

async function ghGetFile({ token, repo, branch, path }) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'music-cities-concerts/japan-map-sync' } });
  if (res.status === 404) return { sha: null, content: null };
  if (!res.ok) throw new Error(`GitHub GET ${path} -> ${res.status}`);
  const json = await res.json();
  const content = Buffer.from(json.content || '', 'base64').toString('utf8');
  return { sha: json.sha, content };
}
async function ghPutFile({ token, repo, branch, path, contentBase64, sha, message }) {
  const body = { message, content: contentBase64, branch };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'music-cities-concerts/japan-map-sync', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`GitHub PUT ${path} -> ${res.status}: ${t.slice(0, 200)}`); }
  return res.json();
}
async function cuComment({ token, taskId, text }) {
  await fetch(`${CLICKUP_API}/task/${taskId}/comment`, { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ comment_text: text, notify_all: false }) });
}
async function cuComplete({ token, taskId }) {
  await fetch(`${CLICKUP_API}/task/${taskId}`, { method: 'PUT', headers: { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ status: COMPLETE_STATUS }) });
}

export default async () => {
  const log = (m) => console.log(`[japan-map-sync] ${m}`);
  try {
    const token = process.env.CLICKUP_TOKEN;
    const ghToken = process.env.GITHUB_TOKEN;
    const ghRepo = process.env.GITHUB_REPO;
    const ghBranch = process.env.GITHUB_BRANCH || DEFAULT_BRANCH;
    const missing = [];
    if (!token) missing.push('CLICKUP_TOKEN');
    if (!ghToken) missing.push('GITHUB_TOKEN');
    if (!ghRepo) missing.push('GITHUB_REPO');
    if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);

    const tasks = await fetchClickUpTasks({ token, listId: LIST_ID });
    log(`${tasks.length} open task(s) in the phone-add list`);

    const { sha, content } = await ghGetFile({ token: ghToken, repo: ghRepo, branch: ghBranch, path: ADDS_PATH });
    let adds = [];
    try { adds = content ? JSON.parse(content) : []; } catch { adds = []; }
    if (!Array.isArray(adds)) adds = [];
    const seen = new Set(adds.map((a) => a && a.clickupId).filter(Boolean));

    const added = []; const failed = [];
    for (const t of tasks) {
      const name = (t.name || '').trim();
      if (!name || seen.has(String(t.id))) continue;
      const g = await geocode(`${name} Japan`);
      await new Promise((r) => setTimeout(r, 1100)); // Nominatim: <=1 req/sec
      if (!g) { failed.push(name); log(`geocode failed: ${name}`); continue; }
      const desc = (t.markdown_description || t.description || '').trim();
      const pin = {
        id: `add-${slugify(name)}-${String(t.id).slice(-4)}`,
        clickupId: String(t.id), name, ja: '', cat: 'poi',
        lat: Number(g.lat.toFixed(5)), lon: Number(g.lon.toFixed(5)),
        city: nearestCity(g.lat, g.lon), status: 'sight', dates: '',
        note: desc || 'Added from phone.',
      };
      adds.push(pin); seen.add(String(t.id)); added.push(pin);
      try { await cuComment({ token, taskId: t.id, text: `✓ Added to the Japan map as “${name}” (${pin.city}).` }); } catch (e) { log(`comment failed ${t.id}`); }
      try { await cuComplete({ token, taskId: t.id }); } catch (e) { log(`complete failed ${t.id}`); }
    }

    if (added.length) {
      const json = JSON.stringify(adds, null, 2) + '\n';
      await ghPutFile({ token: ghToken, repo: ghRepo, branch: ghBranch, path: ADDS_PATH, contentBase64: Buffer.from(json, 'utf8').toString('base64'), sha: sha ?? undefined, message: `map sync: +${added.length} phone pin(s)` });
      log(`committed ${added.length} new pin(s)`);
    } else {
      log('nothing new to add');
    }
    return new Response(JSON.stringify({ ok: true, added: added.map((p) => p.name), failed }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[japan-map-sync] FAILED:', err?.stack || err?.message || err);
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { schedule: '0 */3 * * *' };
