// scripts/fetch-youtube-stats.mjs
// Fetches YouTube channel stats from Data API v3 and writes them to public/youtube-stats.json.
// Designed to run during build AND inside the nightly-rebuild Netlify function.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HANDLE = 'themusiccitiespodcast';
const API_KEY = process.env.YOUTUBE_API_KEY;
const OUTPUT_PATH = path.resolve(__dirname, '..', 'public', 'youtube-stats.json');

export async function fetchYoutubeStats() {
  if (!API_KEY) {
    console.warn('[youtube-stats] YOUTUBE_API_KEY not set; skipping fetch');
    return null;
  }

  try {
    // Step 1: Resolve @handle to channel ID and pull statistics in one call.
    const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&forHandle=${HANDLE}&key=${API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`YouTube API ${res.status}: ${body.substring(0, 300)}`);
    }
    const data = await res.json();
    if (!data.items || !data.items.length) {
      throw new Error('YouTube API returned no channel for handle ' + HANDLE);
    }
    const channel = data.items[0];
    const stats = {
      handle: '@' + HANDLE,
      channelId: channel.id,
      channelTitle: channel.snippet?.title,
      subscriberCount: Number(channel.statistics.subscriberCount),
      videoCount: Number(channel.statistics.videoCount),
      viewCount: Number(channel.statistics.viewCount),
      fetchedAt: new Date().toISOString(),
    };
    return stats;
  } catch (err) {
    console.error('[youtube-stats] fetch failed:', err.message);
    return null;
  }
}

export async function writeYoutubeStats(stats) {
  if (!stats) return false;
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(stats, null, 2));
  return true;
}

// Run directly when invoked as a script
if (import.meta.url === `file://${process.argv[1]}`) {
  const stats = await fetchYoutubeStats();
  if (stats) {
    await writeYoutubeStats(stats);
    console.log('[youtube-stats] wrote', OUTPUT_PATH);
    console.log('[youtube-stats] subscribers:', stats.subscriberCount);
  } else {
    console.warn('[youtube-stats] no stats fetched; existing file (if any) preserved');
    process.exit(0); // don't fail the build
  }
}
