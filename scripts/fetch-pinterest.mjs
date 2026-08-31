// scripts/fetch-pinterest.mjs
// Pulls the TMC Pinterest boards (+ sections) via the v5 API at build time and
// writes photos.json. photos.astro reads it to surface new boards automatically.
// Also writes public/pinterest-status.json (diagnostic; never contains the token).
// Safe no-op if the token is missing or the API errors.
import { writeFile, mkdir } from 'node:fs/promises';

const TOKEN = process.env.PINTEREST_ACCESS_TOKEN || process.env.Pinterest_Access_Token || (Object.entries(process.env).find(([k]) => /pinterest.*token/i.test(k)) || [])[1];
const USER = 'TheMusicCitiesPodcast';
const BASE = 'https://api.pinterest.com/v5';

const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function writeStatus(obj) {
  try { await mkdir('public', { recursive: true }); await writeFile('public/pinterest-status.json', JSON.stringify({ ...obj, at: new Date().toISOString() }, null, 2)); } catch {}
}

async function api(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await res.text();
  if (!res.ok) { const e = new Error(`${res.status}`); e.status = res.status; e.body = body.slice(0, 300); throw e; }
  return JSON.parse(body);
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
  if (!TOKEN) { console.log('[pinterest] no token found in env; keeping curated fallback.'); await writeStatus({ ok: false, tokenPresent: false, reason: 'no token in env' }); return; }
  try {
    const boards = await allBoards();
    const albums = [];
    for (const b of boards) {
      const url = `https://www.pinterest.com/${USER}/${slug(b.name)}/`;
      let sections = [];
      try {
        const s = await api(`/boards/${b.id}/sections?page_size=100`);
        sections = (s.items || []).map((x) => ({ title: x.name, url: `${url}${slug(x.name)}/` }));
      } catch {}
      const n = b.pin_count ?? (b.counts && b.counts.pins) ?? null;
      albums.push({ id: b.id, title: b.name, pins: n != null ? `${n} pins` : '', url, sections });
    }
    await writeFile('photos.json', JSON.stringify({ generatedAt: new Date().toISOString(), source: 'pinterest-v5', count: albums.length, albums }, null, 2));
    await writeStatus({ ok: true, tokenPresent: true, boardCount: albums.length, sampleKeys: boards[0] ? Object.keys(boards[0]) : [], sampleName: boards[0] ? boards[0].name : null, sampleUrl: albums[0] ? albums[0].url : null });
    console.log(`[pinterest] wrote photos.json with ${albums.length} boards.`);
  } catch (err) {
    console.error('[pinterest] fetch failed, keeping previous photos.json:', err.status || '', err.message, err.body || '');
    await writeStatus({ ok: false, tokenPresent: true, httpStatus: err.status || null, error: err.message, body: err.body || null });
  }
}
run();
