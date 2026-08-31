// scripts/fetch-pinterest.mjs
// Pulls the TMC Pinterest boards (+ sections) via the v5 API at build time and
// writes photos.json. photos.astro reads it to surface new boards automatically.
// Safe no-op if PINTEREST_ACCESS_TOKEN is missing or the API errors.
import { writeFile } from 'node:fs/promises';

const TOKEN = process.env.PINTEREST_ACCESS_TOKEN || process.env.Pinterest_Access_Token || (Object.entries(process.env).find(([k]) => /pinterest.*token/i.test(k)) || [])[1];
const USER = 'TheMusicCitiesPodcast';
const BASE = 'https://api.pinterest.com/v5';

const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function api(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function allBoards() {
  let items = [], bookmark = null, guard = 0;
  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (bookmark) qs.set('bookmark', bookmark);
    const data = await api(`/boards?${qs}`);
    items = items.concat(data.items || []);
    bookmark = data.bookmark || null;
  } while (bookmark && ++guard < 25);
  return items;
}

async function run() {
  if (!TOKEN) { console.log('[pinterest] no token; photos.astro uses its curated fallback.'); return; }
  try {
    const boards = await allBoards();
    const albums = [];
    for (const b of boards) {
      const url = `https://www.pinterest.com/${USER}/${slug(b.name)}/`;
      let sections = [];
      try {
        const s = await api(`/boards/${b.id}/sections?page_size=100`);
        sections = (s.items || []).map((x) => ({ title: x.name, url: `${url}${slug(x.name)}/` }));
      } catch { /* sections optional */ }
      const n = b.pin_count ?? (b.counts && b.counts.pins) ?? null;
      albums.push({ id: b.id, title: b.name, pins: n != null ? `${n} pins` : '', url, sections });
    }
    await writeFile('photos.json', JSON.stringify({ generatedAt: new Date().toISOString(), source: 'pinterest-v5', count: albums.length, albums, _sample: boards[0] ?? null }, null, 2));
    console.log(`[pinterest] wrote photos.json with ${albums.length} boards.`);
  } catch (err) {
    console.error('[pinterest] fetch failed, keeping previous photos.json:', err.message);
  }
}
run();
