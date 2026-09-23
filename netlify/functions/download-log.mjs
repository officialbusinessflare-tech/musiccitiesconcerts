import { getStore } from '@netlify/blobs';

/**
 * Returns every logged app download with its timestamp.
 * Routed at /download-log.
 *   /download-log             JSON
 *   /download-log?format=csv  CSV (opens in Excel)
 *
 * Downloads counted before logging began have no timestamp; they are
 * reported as untimed_before_logging.
 */
export default async (req) => {
  const format = new URL(req.url).searchParams.get('format');
  let total = 0;
  const rows = [];

  try {
    const store = getStore('app-downloads');
    const head = await store.get('apk', { type: 'json', consistency: 'strong' });
    total = (head && head.count) || 0;

    const { blobs } = await store.list({ prefix: 'log/' });
    const items = await Promise.all(
      blobs.map((b) => store.get(b.key, { type: 'json', consistency: 'strong' }))
    );
    for (const it of items) if (it && it.t) rows.push(it);
    rows.sort((a, b) => a.t.localeCompare(b.t));
  } catch (err) {
    console.error('download log read error:', err);
  }

  const untimed = Math.max(total - rows.length, 0);

  if (format === 'csv') {
    const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const lines = ['timestamp_utc,src,referrer'];
    for (const r of rows) lines.push([esc(r.t), esc(r.src), esc(r.ref)].join(','));
    return new Response(lines.join('\n') + '\n', {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="app-downloads.csv"',
        'cache-control': 'no-store',
      },
    });
  }

  return new Response(
    JSON.stringify({ total, logged: rows.length, untimed_before_logging: untimed, downloads: rows }, null, 2),
    { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
};

export const config = { path: '/download-log' };
