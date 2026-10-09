import { getStore } from '@netlify/blobs';

/**
 * Stores an APNs/FCM device token so the app can receive push notifications.
 * Called by the Capacitor app (BaseLayout push script) after the OS issues a
 * token. Routed at /register-device.
 *
 * POST JSON: { token: "<hex-or-string>", platform: "ios" | "android" }
 * Tokens are keyed by platform so sends can target one platform.
 */
export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid json' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const token = (body && typeof body.token === 'string' && body.token.trim()) || '';
  const platform = (body && body.platform === 'android') ? 'android' : 'ios';

  if (!token || token.length < 16 || token.length > 400) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid token' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    const store = getStore('push-devices');
    await store.setJSON(`${platform}/${token}`, {
      token,
      platform,
      t: new Date().toISOString(),
    });
  } catch (err) {
    console.error('register-device write error:', err);
    return new Response(JSON.stringify({ ok: false, error: 'store error' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};

export const config = { path: '/register-device' };
