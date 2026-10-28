// Stream package requests through workers.dev when the site's anycast route is slow.
// The origin and browser allowlist are deployment bindings, never caller input.
const routes = [
  [/^\/api\/apkg\/limits$/, ['GET']],
  [/^\/api\/apkg\/uploads$/, ['POST']],
  [/^\/api\/apkg\/uploads\/[a-f0-9]{32}$/, ['GET', 'PUT', 'DELETE']],
  [/^\/api\/apkg\/uploads\/[a-f0-9]{32}\/finish$/, ['POST']],
  [/^\/api\/apkg\/jobs$/, ['GET']],
  [/^\/api\/apkg\/jobs\/[a-f0-9]{32}$/, ['GET']],
  [/^\/api\/apkg\/jobs\/[a-f0-9]{32}\/(confirm|cancel)$/, ['POST']],
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (origin && origin !== env.ALLOWED_ORIGIN) {
      return new Response('Origin not allowed', { status: 403 });
    }
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Expose-Headers': 'Retry-After, X-Import-Error, X-Anki-Upload-Relay',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'private, no-store',
      'Vary': 'Origin',
      'X-Anki-Upload-Relay': '1',
    };
    const reply = (detail, status) => Response.json({ detail }, { status, headers: cors });
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok' }, { headers: cors });
    }
    const methods = routes.find(([pattern]) => pattern.test(url.pathname))?.[1];
    if (!methods) return reply('Not found', 404);
    if (request.method === 'OPTIONS') {
      const requestedMethod = request.headers.get('Access-Control-Request-Method');
      const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '')
        .toLowerCase().split(',').map(header => header.trim()).filter(Boolean);
      if (!origin || !methods.includes(requestedMethod) ||
          requestedHeaders.some(header => !['authorization', 'content-type'].includes(header))) {
        return reply('Preflight not allowed', 403);
      }
      return new Response(null, { status: 204, headers: cors });
    }
    if (!methods.includes(request.method)) return reply('Method not allowed', 405);
    const authorization = request.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) return reply('Authentication required', 401);
    // A chunk is at most 8 MiB; the backend enforces the exact budget while reading.
    const length = request.headers.get('Content-Length');
    if (length && Number(length) > 8 * 1024 ** 2) return reply('Request too large', 413);
    const upstream = new URL(env.ORIGIN_URL);
    upstream.pathname = url.pathname;
    upstream.search = url.search;
    const headers = new Headers({ Authorization: authorization });
    const contentType = request.headers.get('Content-Type');
    if (contentType) headers.set('Content-Type', contentType);
    if (length) headers.set('Content-Length', length);
    try {
      const response = await fetch(upstream, {
        method: request.method, headers, body: request.body,
        redirect: 'manual', cache: 'no-store',
      });
      // Credentials must never follow an unexpected origin redirect.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return reply('Unexpected upstream redirect', 502);
      }
      const resultHeaders = new Headers(response.headers);
      resultHeaders.delete('Set-Cookie');
      resultHeaders.delete('Access-Control-Allow-Credentials');
      for (const [name, value] of Object.entries(cors)) resultHeaders.set(name, value);
      return new Response(response.body, { status: response.status, headers: resultHeaders });
    } catch {
      console.error(JSON.stringify({ event: 'upload_relay_origin_unavailable', method: request.method }));
      return reply('Upload connection interrupted; resume from the saved part.', 502);
    }
  },
};
