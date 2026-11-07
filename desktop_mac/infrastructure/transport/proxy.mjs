import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream as streamFile } from 'node:fs';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
const pipe = promisify(pipeline);

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
const safeError = (res, status, message) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: message })); } else res.destroy(); };

function isLoopbackHost(hostname) { return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'; }
function validateLoopbackTarget(target) {
  let url;
  try { url = new URL(target); } catch { throw new Error('API upstream must be a configured loopback URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHost(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('API upstream must be a loopback origin without credentials or path');
  return url;
}
function validateRequest(req) {
  const host = req.headers.host;
  if (!host || /[\r\n\s/@]/.test(host)) return false;
  let parsed;
  try { parsed = new URL(`http://${host}`); } catch { return false; }
  if (!isLoopbackHost(parsed.hostname)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { const source = new URL(origin); if (!['http:', 'https:'].includes(source.protocol) || source.host.toLowerCase() !== host.toLowerCase() || !isLoopbackHost(source.hostname)) return false; }
    catch { return false; }
  }
  return true;
}
function normalizedRequestPath(rawUrl) {
  const rawPath = String(rawUrl).split(/[?#]/, 1)[0];
  let rawDecoded;
  try { rawDecoded = decodeURIComponent(rawPath); } catch { return null; }
  if (rawDecoded.includes('\\') || rawDecoded.split('/').some((part) => part === '..' || part === '.')) return null;
  let parsed;
  try { parsed = new URL(rawUrl, 'http://127.0.0.1'); } catch { return null; }
  return { pathname: parsed.pathname, search: parsed.search };
}

function proxyApi(req, res, target, timeoutMs, requester) {
  const nominated = new Set(String(req.headers.connection ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const outgoing = requester({
    protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
    method: req.method, path: req.url, headers: Object.fromEntries(Object.entries(req.headers).filter(([key]) => {
      const normalized = key.toLowerCase();
      return !HOP_HEADERS.has(normalized) && !nominated.has(normalized) && !['host', 'origin', 'referer'].includes(normalized);
    })),
    timeout: timeoutMs,
  }, (upstream) => {
    const responseNominated = new Set(String(upstream.headers.connection ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
    const headers = Object.fromEntries(Object.entries(upstream.headers).filter(([key]) => !HOP_HEADERS.has(key.toLowerCase()) && !responseNominated.has(key.toLowerCase())));
    upstream.on('error', () => res.destroy());
    upstream.on('aborted', () => res.destroy());
    res.writeHead(upstream.statusCode ?? 502, headers);
    upstream.pipe(res);
  });
  outgoing.on('timeout', () => outgoing.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
  outgoing.on('error', (error) => safeError(res, 502, `API connection failed${error.code ? ` (${error.code})` : ''}`));
  req.on('aborted', () => outgoing.destroy());
  req.on('error', () => outgoing.destroy());
  res.on('close', () => { if (!res.writableEnded) outgoing.destroy(); });
  req.pipe(outgoing);
}

async function serveAsset(req, res, rendererRoot, pathname) {
  const decoded = decodeURIComponent(pathname);
  const filePath = path.resolve(rendererRoot, `.${decoded}`);
  const base = path.resolve(rendererRoot);
  if (filePath !== base && !filePath.startsWith(`${base}${path.sep}`)) return safeError(res, 400, 'Invalid asset path');
  try {
    const [realRoot, realFilePath] = await Promise.all([realpath(base), realpath(filePath)]);
    if (realFilePath !== realRoot && !realFilePath.startsWith(`${realRoot}${path.sep}`)) return safeError(res, 404, 'Asset not found');
    const info = await stat(realFilePath);
    if (!info.isFile()) return safeError(res, 404, 'Asset not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(realFilePath).toLowerCase()] ?? 'application/octet-stream', 'content-length': info.size, 'cache-control': path.basename(realFilePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
    if (req.method === 'HEAD') return res.end();
    await pipe(streamFile(realFilePath), res);
  } catch { safeError(res, 404, 'Asset not found'); }
}

/** Creates an HTTP handler for Vite's configureServer hook or a loopback static server. */
export function createMacProxyHandler({ apiTarget, rendererRoot = '.', appVersion = '0.0.0', mode = 'remote', backendIdentity = null, serviceReady = () => true, timeoutMs = 3_600_000, isDevelopment = false, request = (options, callback) => (options.protocol === 'https:' ? https : http).request(options, callback) }) {
  const target = validateLoopbackTarget(apiTarget);
  const root = path.resolve(rendererRoot);
  return async function macProxyHandler(req, res, next) {
    if (!validateRequest(req)) return safeError(res, 403, 'Loopback Host or Origin required');
    const parsed = normalizedRequestPath(req.url ?? '/');
    if (!parsed) return safeError(res, 400, 'Invalid request path');
    if (parsed.pathname === '/__mac/health') {
      if (!['GET', 'HEAD'].includes(req.method)) return safeError(res, 405, 'Method not allowed');
      const body = JSON.stringify({ ok: true, mode, serviceReady: Boolean(await serviceReady()) });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      return req.method === 'HEAD' ? res.end() : res.end(body);
    }
    if (parsed.pathname === '/runtime.js' || parsed.pathname === '/__mac/runtime.js') {
      if (!['GET', 'HEAD'].includes(req.method)) return safeError(res, 405, 'Method not allowed');
      const body = `window.__AI_NOVEL_RUNTIME__=${JSON.stringify({ mode: 'web', apiBaseUrl: '/api', appVersion })};window.__AI_NOVEL_MAC_CONFIG__=${JSON.stringify({ mode, backendIdentity, appVersion })};`;
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      return req.method === 'HEAD' ? res.end() : res.end(body);
    }
    if (parsed.pathname === '/api' || parsed.pathname.startsWith('/api/')) return proxyApi(req, res, target, timeoutMs, request);
    if (isDevelopment) return typeof next === 'function' ? next() : safeError(res, 404, 'Not found');
    if (parsed.pathname.startsWith('/assets/') || parsed.pathname.startsWith('/fonts/') || parsed.pathname.startsWith('/images/') || /\.[a-z0-9]{1,10}$/i.test(parsed.pathname)) {
      if (!['GET', 'HEAD'].includes(req.method)) return safeError(res, 404, 'Asset not found');
      return serveAsset(req, res, root, parsed.pathname);
    }
    const acceptsHtml = String(req.headers.accept ?? '').split(',').some((part) => part.split(';', 1)[0].trim().toLowerCase() === 'text/html');
    if (!['GET', 'HEAD'].includes(req.method) || !acceptsHtml) return safeError(res, 404, 'Not found');
    return serveAsset(req, res, root, '/index.html');
  };
}

export function attachMacProxy(server, options) {
  const handler = createMacProxyHandler(options);
  server.middlewares.use(handler);
  return handler;
}

export function createMacHttpServer(options) { return http.createServer(createMacProxyHandler(options)); }
