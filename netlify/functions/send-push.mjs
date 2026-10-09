import { getStore } from '@netlify/blobs';
import http2 from 'node:http2';
import crypto from 'node:crypto';

/**
 * Sends an APNs push to every registered iOS device.
 * Routed at /send-push. Protect with the PUSH_ADMIN_TOKEN secret.
 *
 *   POST /send-push?key=<PUSH_ADMIN_TOKEN>
 *   body JSON (all optional): { title, body, url }
 *   or query: ?key=...&title=...&body=...
 *
 * Required environment variables (set in Netlify):
 *   PUSH_ADMIN_TOKEN  - shared secret gating this endpoint
 *   APNS_KEY_ID       - APNs Auth Key ID (e.g. LUHTKBCF46)
 *   APNS_TEAM_ID      - Apple Team ID (e.g. RZWPKWRA78)
 *   APNS_P8           - contents of the AuthKey_*.p8 file (newlines or \n-escaped)
 *   APNS_TOPIC        - bundle id (default com.themusiccities.app)
 *   APNS_PRODUCTION   - "false" to use the sandbox host (default production)
 */

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeApnsJwt(keyId, teamId, p8) {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
  const signingInput = `${header}.${payload}`;
  const key = crypto.createPrivateKey(p8.replace(/\\n/g, '\n'));
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  const sigB64 = sig.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${signingInput}.${sigB64}`;
}

function sendOne(client, token, topic, jwt, payloadStr) {
  return new Promise((resolve) => {
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'authorization': `bearer ${jwt}`,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    let status = 0;
    let data = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve({ token, status, data }));
    req.on('error', (err) => resolve({ token, status: 0, error: String(err) }));
    req.write(payloadStr);
    req.end();
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!process.env.PUSH_ADMIN_TOKEN || key !== process.env.PUSH_ADMIN_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }

  const { APNS_KEY_ID, APNS_TEAM_ID, APNS_P8 } = process.env;
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_P8) {
    return new Response(JSON.stringify({ ok: false, error: 'APNs env vars not set' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }
  const topic = process.env.APNS_TOPIC || 'com.themusiccities.app';
  const host = (process.env.APNS_PRODUCTION === 'false')
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';

  let msg = {};
  try { msg = await req.json(); } catch { /* fall back to query */ }
  const title = (msg.title || url.searchParams.get('title') || 'The Music Cities').toString();
  const bodyText = (msg.body || url.searchParams.get('body') || '').toString();
  const link = (msg.url || url.searchParams.get('url') || '').toString();

  const aps = { aps: { alert: { title, body: bodyText }, sound: 'default' } };
  if (link) aps.url = link;
  const payloadStr = JSON.stringify(aps);

  // Gather iOS tokens.
  let tokens = [];
  try {
    const store = getStore('push-devices');
    const { blobs } = await store.list({ prefix: 'ios/' });
    tokens = blobs.map((b) => b.key.slice('ios/'.length)).filter(Boolean);
  } catch (err) {
    console.error('send-push list error:', err);
    return new Response(JSON.stringify({ ok: false, error: 'store error' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }

  if (tokens.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0, note: 'no devices registered' }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  let jwt;
  try {
    jwt = makeApnsJwt(APNS_KEY_ID, APNS_TEAM_ID, APNS_P8);
  } catch (err) {
    console.error('APNs JWT error:', err);
    return new Response(JSON.stringify({ ok: false, error: 'bad APNs key' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }

  const client = http2.connect(host);
  const results = [];
  const store = getStore('push-devices');
  try {
    for (const token of tokens) {
      const r = await sendOne(client, token, topic, jwt, payloadStr);
      results.push(r);
      // Prune tokens APNs says are gone.
      if (r.status === 410 || (r.status === 400 && /BadDeviceToken/.test(r.data || ''))) {
        try { await store.delete(`ios/${token}`); } catch {}
      }
    }
  } finally {
    client.close();
  }

  const sent = results.filter((r) => r.status === 200).length;
  return new Response(JSON.stringify({ ok: true, devices: tokens.length, sent, results }, null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};

export const config = { path: '/send-push' };
