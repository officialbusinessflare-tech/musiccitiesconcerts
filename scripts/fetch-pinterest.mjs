// scripts/fetch-pinterest.mjs
// Pulls the public TMC Pinterest RSS feed at build time (no API, no auth) and
// writes photos.json. photos.astro renders a live thumbnail grid from it.
// Also writes public/pinterest-status.json (diagnostic). Safe no-op on any error.
import { writeFile, mkdir } from 'node:fs/promises';

const USER = 'TheMusicCitiesPodcast';
const FEED = `https://www.pinterest.com/${USER}/feed.rss`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX = 30;

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
    const descRaw = (b.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
    const desc = decode(descRaw);
    let img = (desc.match(/<img[^>]*src="([^"]+)"/) || [])[1] || (b.match(/<img[^>]*src="([^"]+)"/) || [])[1];
    const date = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    if (!link || !img) continue;
    img = img.replace(/\/(60x60_RS|75x75_RS|136x136|170x|236x|474x)\//, '/736x/');
    items.push({ img: img.trim(), link: link.trim(), date: (date || '').trim() });
    if (items.length >= MAX) break;
  }
  return items;
}

async function tryFeed(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
  const xml = await res.text();
  return { status: res.status, ct: res.headers.get('content-type'), xml };
}

async function run() {
  try {
    let r = await tryFeed(FEED);
    let latest = parse(r.xml);
    if (!latest.length) {
      // retry once against the non-www host
      const alt = await tryFeed(`https://pinterest.com/${USER}/feed.rss`);
      const alt2 = parse(alt.xml);
      if (alt2.length) { latest = alt2; r = alt; }
    }
    if (!latest.length) {
      await writeStatus({ ok: false, error: 'no items parsed', httpStatus: r.status, contentType: r.ct, xmlLen: r.xml.length, hasItemTag: r.xml.includes('<item>'), snippet: r.xml.slice(0, 220) });
      console.error('[pinterest] no items parsed; status', r.status, 'len', r.xml.length);
      return;
    }
    await writeFile('photos.json', JSON.stringify({ generatedAt: new Date().toISOString(), source: 'pinterest-rss', count: latest.length, latest }, null, 2));
    await writeStatus({ ok: true, count: latest.length, sample: latest[0] });
    console.log(`[pinterest] wrote photos.json with ${latest.length} pins from RSS.`);
  } catch (err) {
    console.error('[pinterest] RSS fetch failed, keeping previous photos.json:', err.message);
    await writeStatus({ ok: false, error: err.message });
  }
}
run();
