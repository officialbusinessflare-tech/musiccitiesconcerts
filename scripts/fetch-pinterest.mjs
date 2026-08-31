// scripts/fetch-pinterest.mjs
// Pulls the public TMC Pinterest board RSS feeds at build time (no API, no auth).
// Takes the top few pins from EACH board and interleaves them for variety, so the
// grid is a mix across events instead of just the most recently uploaded album.
// Writes photos.json + public/pinterest-status.json. Safe no-op on any error.
// To feature a new album, add its board slug to BOARDS (order = grid priority).
import { writeFile, mkdir } from 'node:fs/promises';

const USER = 'TheMusicCitiesPodcast';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PER_BOARD = 3;   // pins pulled from each board
const MAX = 36;        // total pins shown in the grid

// Board slugs, in the order they should lead the grid (metal / J-metal first).
const BOARDS = [
  'lovebites-wacken',
  'nemophila-conduit-orlando',
  'hanabie-orlando-2026',
  'broken-by-the-scream-wacken-2026',
  'lovebites-london-2026',
  'given-by-the-flames-wacken',
  'accept-fort-lauderdale-2025',
  'deep-purple-hard-rock-live-2026',
  'broken-by-the-scream-london',
  'buried-alive-festival-las-rosas-miami',
  'wacken-2026',
  'reo-at-downstairs-at-the-dome-london-822026',
  'wacken-2026-peeps',
  'miami-super-summer-jam',
];

async function writeStatus(obj) {
  try { await mkdir('public', { recursive: true }); await writeFile('public/pinterest-status.json', JSON.stringify({ ...obj, at: new Date().toISOString() }, null, 2)); } catch {}
}

function decode(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parse(xml) {
  const items = [];
  const blocks = xml.split('<item>').slice(1);
  for (const b of blocks) {
    const link = (b.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const desc = decode((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
    let img = (desc.match(/<img[^>]*src="([^"]+)"/) || [])[1] || (b.match(/<img[^>]*src="([^"]+)"/) || [])[1];
    const date = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    if (!link || !img) continue;
    img = img.replace(/\/(60x60_RS|75x75_RS|136x136|170x|236x|474x)\//, '/736x/');
    items.push({ img: img.trim(), link: link.trim(), date: (date || '').trim() });
    if (items.length >= 25) break;
  }
  return items;
}

async function boardPins(slug) {
  try {
    const res = await fetch(`https://www.pinterest.com/${USER}/${slug}.rss`, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' }, redirect: 'follow' });
    const xml = await res.text();
    return parse(xml).slice(0, PER_BOARD).map((p) => ({ ...p, board: slug }));
  } catch { return []; }
}

async function run() {
  try {
    const perBoard = [];
    let okBoards = 0;
    for (const slug of BOARDS) {
      const pins = await boardPins(slug);
      if (pins.length) { perBoard.push(pins); okBoards++; }
    }
    const latest = [];
    const seen = new Set();
    for (let i = 0; i < PER_BOARD && latest.length < MAX; i++) {
      for (const arr of perBoard) {
        const p = arr[i];
        if (p && !seen.has(p.link)) { seen.add(p.link); latest.push(p); if (latest.length >= MAX) break; }
      }
    }
    if (!latest.length) throw new Error('no pins parsed from any board');
    await writeFile('photos.json', JSON.stringify({ generatedAt: new Date().toISOString(), source: 'pinterest-rss-boards', count: latest.length, boards: okBoards, latest }, null, 2));
    await writeStatus({ ok: true, count: latest.length, boards: okBoards, sample: latest[0] });
    console.log(`[pinterest] wrote photos.json with ${latest.length} pins from ${okBoards} boards.`);
  } catch (err) {
    console.error('[pinterest] board fetch failed, keeping previous photos.json:', err.message);
    await writeStatus({ ok: false, error: err.message });
  }
}
run();
