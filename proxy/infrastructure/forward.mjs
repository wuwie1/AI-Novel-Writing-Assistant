import http from 'node:http';
import https from 'node:https';

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'expect'];

export function forwardedHeaders(headers) {
  const omit = new Set([...HOP_HEADERS, ...String(headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !omit.has(key.toLowerCase())));
}

export function upstreamTarget(upstream, requestPath) {
  // Only the configured origin is reachable. Preserve the raw API suffix and query.
  const pathname = requestPath.split('?')[0];
  if (!pathname.startsWith('/v1/') || /[\\#\r\n]/.test(requestPath)) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.split('/').some(segment => segment === '.' || segment === '..') || decoded.includes('\\')) return null;
  const base = new URL(upstream);
  return { protocol: base.protocol, hostname: base.hostname, port: base.port,
    path: `${base.pathname.replace(/\/+$/, '')}${requestPath.slice(3)}` };
}

export function forwardRequest(req, res, upstream) {
  const target = upstreamTarget(upstream, req.url ?? '');
  if (!target) { res.writeHead(404).end(); req.resume(); return; }
  const transport = target.protocol === 'https:' ? https : http;
  const outgoing = transport.request({ ...target, method: req.method, headers: forwardedHeaders(req.headers) });
  const fail = () => {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":{"message":"Local model proxy could not reach upstream."}}');
  };
  // Stop only failed connection establishment; generation has no artificial total timeout.
  const connecting = setTimeout(() => outgoing.destroy(), 30_000);
  outgoing.on('socket', socket => {
    if (!socket.connecting) clearTimeout(connecting);
    else socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connecting));
  });
  outgoing.on('error', fail);
  outgoing.on('close', () => clearTimeout(connecting));
  outgoing.on('response', response => {
    res.writeHead(response.statusCode, forwardedHeaders(response.headers));
    res.flushHeaders();
    response.on('error', () => res.destroy());
    response.pipe(res); // Backpressure and streaming; no body accumulation or logging.
    res.once('close', () => response.destroy());
  });
  req.on('error', () => outgoing.destroy());
  req.once('aborted', () => outgoing.destroy());
  res.once('close', () => outgoing.destroy());
  req.pipe(outgoing);
}
