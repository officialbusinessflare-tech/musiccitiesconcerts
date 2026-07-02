// scripts/fetch-youtube-content.mjs
// Fetches YouTube channel content (recent videos, shorts, playlists) for
// BOTH @themusiccitiespodcast and @musiccitiesradio via Data API v3 and
// writes them to public/youtube-content.json.
//
// Designed to run during build (via `prebuild` in package.json) AND inside
// the nightly-rebuild Netlify function so the JSON stays fresh.
//
// Graceful failure: if the API/network errors, the previous
// public/youtube-content.json (if any) is left in place. Never throws.
//
// ─── YouTube Shows note ──────────────────────────────────────────────
// A YouTube "Show" is built on top of a regular YouTube playlist — the
// Show is just editorial framing (season/episode UI, "Watch next" logic,
// discoverability); the underlying data is a playlist with a normal
// PL-prefixed ID. So to feed a Show into this dashboard, paste the
// Show's playlist ID into PLAYLIST_MAP below. Format: 'PLxxxxxxxxxxxx...'
// (34 chars starting with PL). Find it in YouTube Studio > Content >
// Playlists, or by opening the Show's page and copying the list= param.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = process.env.YOUTUBE_API_KEY;
const OUTPUT_PATH = path.resolve(__dirname, '..', 'public', 'youtube-content.json');

const CHANNELS = {
  tmc: { handle: '@themusiccitiespodcast' },
  radio: { handle: '@musiccitiesradio' },
};

// Two Shows Kevin will create in YouTube Studio tomorrow.
// Both are non-serial evergreen Shows on The Music Cities channel.
// Paste the playlist ID (which is what a Show uses under the hood) after creating each Show.
// Format: 'PLxxxxxxxxxxxxxxxxxxxxxxxxxx' (34 chars starting with PL).
// null hides the strip (VideoStrip renders nothing for empty arrays).
const PLAYLIST_MAP = {
  'european-metal': null,  // Feeds /wacken. Covers Wacken, Metal London, European scene.
  'japanese-metal': null,  // Feeds /japan. Lovebites, Nemophila, HANABIE., etc.
  // NOTE: Entrepreneurship / Creator Economy Show intentionally NOT here.
  // That Show is standalone and does not feed the concerts dashboard.
};

const SHORT_THRESHOLD_SECONDS = 75;
const RECENT_ITEMS = 24;
const PLAYLIST_ITEMS = 12;

/** Parse an ISO-8601 duration like PT1H2M3S into seconds. */
function parseIsoDurationSeconds(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const h = Number(m[1] || 0);
  const mm = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  return h * 3600 + mm * 60 + s;
}

async function ytFetch(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API ${res.status}: ${body.substring(0, 300)}`);
  }
  return res.json();
}

async function fetchChannelMeta(handle) {
  const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
  const url =
    `https://www.googleapis.com/youtube/v3/channels` +
    `?part=statistics,snippet,contentDetails` +
    `&forHandle=${encodeURIComponent(cleanHandle)}` +
    `&key=${API_KEY}`;
  const data = await ytFetch(url);
  if (!data.items || !data.items.length) {
    throw new Error(`No channel returned for handle ${handle}`);
  }
  const ch = data.items[0];
  return {
    channelId: ch.id,
    title: ch.snippet?.title || '',
    subscriberCount: Number(ch.statistics?.subscriberCount || 0),
    videoCount: Number(ch.statistics?.videoCount || 0),
    viewCount: Number(ch.statistics?.viewCount || 0),
    uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads,
  };
}

async function fetchPlaylistItems(playlistId, max = RECENT_ITEMS) {
  const url =
    `https://www.googleapis.com/youtube/v3/playlistItems` +
    `?part=snippet,contentDetails` +
    `&playlistId=${encodeURIComponent(playlistId)}` +
    `&maxResults=${max}` +
    `&key=${API_KEY}`;
  const data = await ytFetch(url);
  return data.items || [];
}

async function fetchVideoDetails(videoIds) {
  if (!videoIds.length) return [];
  const url =
    `https://www.googleapis.com/youtube/v3/videos` +
    `?part=contentDetails,snippet,statistics` +
    `&id=${videoIds.join(',')}` +
    `&key=${API_KEY}`;
  const data = await ytFetch(url);
  return data.items || [];
}

/** Shape a raw video API object into the trimmed record we ship to the client. */
function shapeVideo(v) {
  const duration = v.contentDetails?.duration || 'PT0S';
  const durationSeconds = parseIsoDurationSeconds(duration);
  return {
    id: v.id,
    title: v.snippet?.title || '',
    publishedAt: v.snippet?.publishedAt || '',
    thumbnails: v.snippet?.thumbnails || {},
    duration,
    durationSeconds,
  };
}

async function hydratePlaylist(playlistId, max) {
  const items = await fetchPlaylistItems(playlistId, max);
  const ids = items
    .map((it) => it.contentDetails?.videoId)
    .filter(Boolean);
  if (!ids.length) return [];
  const details = await fetchVideoDetails(ids);
  const byId = new Map(details.map((d) => [d.id, d]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map(shapeVideo);
}

async function buildChannelSection(handle) {
  const meta = await fetchChannelMeta(handle);
  let recentLongform = [];
  let recentShorts = [];
  if (meta.uploadsPlaylistId) {
    const videos = await hydratePlaylist(meta.uploadsPlaylistId, RECENT_ITEMS);
    recentLongform = videos.filter((v) => v.durationSeconds >= SHORT_THRESHOLD_SECONDS);
    recentShorts = videos.filter((v) => v.durationSeconds < SHORT_THRESHOLD_SECONDS);
  }
  return {
    handle,
    channelId: meta.channelId,
    title: meta.title,
    subscriberCount: meta.subscriberCount,
    videoCount: meta.videoCount,
    recentLongform,
    recentShorts,
  };
}

async function buildPlaylistSection(playlistMap) {
  const out = {};
  for (const [slug, playlistId] of Object.entries(playlistMap)) {
    if (!playlistId) {
      out[slug] = [];
      continue;
    }
    try {
      out[slug] = await hydratePlaylist(playlistId, PLAYLIST_ITEMS);
    } catch (err) {
      console.warn(`[youtube-content] playlist ${slug} failed:`, err.message);
      out[slug] = [];
    }
  }
  return out;
}

export async function fetchYoutubeContent() {
  if (!API_KEY) {
    console.warn('[youtube-content] YOUTUBE_API_KEY not set; skipping fetch');
    return null;
  }

  const result = {
    fetchedAt: new Date().toISOString(),
    channels: {},
    playlists: {},
  };

  for (const [key, cfg] of Object.entries(CHANNELS)) {
    try {
      result.channels[key] = await buildChannelSection(cfg.handle);
    } catch (err) {
      console.warn(`[youtube-content] channel ${key} (${cfg.handle}) failed:`, err.message);
      result.channels[key] = {
        handle: cfg.handle,
        channelId: null,
        title: '',
        subscriberCount: 0,
        videoCount: 0,
        recentLongform: [],
        recentShorts: [],
      };
    }
  }

  try {
    result.playlists = await buildPlaylistSection(PLAYLIST_MAP);
  } catch (err) {
    console.warn('[youtube-content] playlists failed:', err.message);
    result.playlists = Object.fromEntries(Object.keys(PLAYLIST_MAP).map((k) => [k, []]));
  }

  return result;
}

export async function writeYoutubeContent(content) {
  if (!content) return false;
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(content, null, 2));
  return true;
}

// Run directly when invoked as a script
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const content = await fetchYoutubeContent();
    if (content) {
      const tmc = content.channels.tmc || {};
      const radio = content.channels.radio || {};
      const hasAnyChannelData =
        (tmc.channelId && (tmc.recentLongform.length || tmc.recentShorts.length)) ||
        (radio.channelId && (radio.recentLongform.length || radio.recentShorts.length));
      const hasAnyPlaylistData = Object.values(content.playlists || {}).some(
        (arr) => Array.isArray(arr) && arr.length,
      );
      if (hasAnyChannelData || hasAnyPlaylistData) {
        await writeYoutubeContent(content);
        console.log('[youtube-content] wrote', OUTPUT_PATH);
        console.log('[youtube-content] tmc subs:', tmc.subscriberCount, 'videos:', tmc.videoCount);
        console.log('[youtube-content] radio subs:', radio.subscriberCount, 'videos:', radio.videoCount);
      } else {
        console.warn('[youtube-content] no useful data fetched; existing file (if any) preserved');
      }
    } else {
      console.warn('[youtube-content] fetch skipped; existing file (if any) preserved');
    }
    process.exit(0);
  } catch (err) {
    console.error('[youtube-content] unexpected error:', err?.message || err);
    process.exit(0);
  }
}
