import { getStore } from '@netlify/blobs';

/**
 * Counts an app download, logs when it happened, then hands the visitor the APK.
 * Routed at /download-app (Functions v2 in-source routing).
 *
 * Each download is stored as its own record under log/ with:
 *   t    ISO timestamp (UTC)
 *   src  optional ?src= tag from the link (e.g. ?src=instagram)
 *   ref  referring page, if the browser sent one
 *
 * The counter never blocks the download: any Blobs error is swallowed
 * and the redirect still fires.
 */
export default async (req) => {
  try {
    const store = getStore('app-downloads');
    const now = new Date().toISOString();
    const url = new URL(req.url);
    const src = (url.searchParams.get('src') || '').slice(0, 60) || null;
    const ref = (req.headers.get('referer') || '').slice(0, 300) || null;

    const cur = await store.get('apk', { type: 'json', consistency: 'strong' });
    const count = ((cur && cur.count) || 0) + 1;
    await store.setJSON('apk', { count, updated: now });

    const id = Math.random().toString(36).slice(2, 8);
    await store.setJSON(`log/${now}-${id}`, { t: now, src, ref });
  } catch (err) {
    console.error('download counter error:', err);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/downloads/The%20Music%20Cities.apk',
      'cache-control': 'no-store',
    },
  });
};

export const config = { path: '/download-app' };
