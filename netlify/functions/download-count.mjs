import { getStore } from '@netlify/blobs';

/**
 * Returns the running app-download total as JSON.
 * Routed at /download-count (Functions v2 in-source routing).
 * { count: number, updated: string|null }
 */
export default async () => {
  let count = 0;
  let updated = null;

  try {
    const store = getStore('app-downloads');
    const data = await store.get('apk', { type: 'json', consistency: 'strong' });
    if (data) {
      count = data.count || 0;
      updated = data.updated || null;
    }
  } catch (err) {
    console.error('download count read error:', err);
  }

  return new Response(JSON.stringify({ count, updated }), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
};

export const config = { path: '/download-count' };
