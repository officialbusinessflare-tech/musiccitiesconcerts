import { getStore } from '@netlify/blobs';

/**
 * Counts an app download, then hands the visitor the real APK.
 * Routed at /download-app (Functions v2 in-source routing).
 * The counter never blocks the download: any Blobs error is swallowed
 * and the redirect still fires.
 */
export default async (req) => {
  try {
    const store = getStore('app-downloads');
    const cur = await store.get('apk', { type: 'json' });
    const count = ((cur && cur.count) || 0) + 1;
    await store.setJSON('apk', { count, updated: new Date().toISOString() });
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
