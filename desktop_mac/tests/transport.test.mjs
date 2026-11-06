import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PassThrough, Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createMacProxyHandler } from '../infrastructure/transport/proxy.mjs';

function request(path, { method = 'GET', headers = {}, body = Buffer.alloc(0) } = {}) {
  const req = Readable.from(body.length ? [body] : []);
  req.url = path; req.method = method; req.headers = headers;
  return req;
}
function response() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  res.writeHead = (statusCode, headers = {}) => { res.statusCode = statusCode; res.headers = headers; };
  res.body = () => Buffer.concat(chunks);
  return res;
}

test('proxy streams SSE before completion and preserves upload bytes, binary bodies and status', async () => {
  let uploaded = Buffer.alloc(0);
  const forwardedOptions = [];
  const handler = createMacProxyHandler({
    apiTarget: 'http://127.0.0.1:13000', rendererRoot: '.',
    request: (options, callback) => {
      forwardedOptions.push(options);
      const outgoing = new PassThrough();
      const upstream = new PassThrough(); upstream.headers = {};
      if (options.path === '/api/events') {
        upstream.statusCode = 200; upstream.headers['content-type'] = 'text/event-stream';
        queueMicrotask(() => callback(upstream));
        setTimeout(() => upstream.write('data: 第一段\n\n'), 5);
        setTimeout(() => upstream.end('data: 第二段\n\n'), 100);
      } else {
        upstream.statusCode = options.path === '/api/missing' ? 404 : 201;
        if (options.path === '/api/missing') { queueMicrotask(() => callback(upstream)); upstream.end('missing'); }
        else {
          outgoing.on('data', (chunk) => { uploaded = Buffer.concat([uploaded, chunk]); });
          upstream.headers.connection = 'keep-alive, x-response-hop'; upstream.headers['x-response-hop'] = 'drop';
          outgoing.on('finish', () => { queueMicrotask(() => callback(upstream)); upstream.end(Buffer.from([0, 255, 10])); });
        }
      }
      return outgoing;
    },
  });
  const streamResponse = response();
  await handler(request('/api/events', { headers: { host: '127.0.0.1:15175' } }), streamResponse);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(streamResponse.body().toString(), /第一段/);
  assert.equal(streamResponse.writableEnded, false, 'first event arrives while upstream remains open');
  await once(streamResponse, 'finish');
  assert.match(streamResponse.body().toString(), /第二段/);

  const body = Buffer.from([8, 0, 255, 3]);
  const uploadResponse = response();
  await handler(request('/api/upload', { method: 'POST', headers: { host: '127.0.0.1:15175', origin: 'http://127.0.0.1:15175', referer: 'http://127.0.0.1:15175/editor', connection: 'keep-alive, x-remove-me', 'x-remove-me': 'drop' }, body }), uploadResponse);
  await once(uploadResponse, 'finish');
  assert.equal(uploadResponse.statusCode, 201);
  assert.deepEqual(uploadResponse.body(), Buffer.from([0, 255, 10]));
  assert.deepEqual(uploaded, body);
  assert.equal(forwardedOptions[1].headers.origin, undefined);
  assert.equal(forwardedOptions[1].headers.referer, undefined);
  assert.equal(forwardedOptions[1].headers.connection, undefined);
  assert.equal(forwardedOptions[1].headers['x-remove-me'], undefined);
  assert.equal(uploadResponse.headers['x-response-hop'], undefined);

  const missing = response();
  await handler(request('/api/missing', { headers: { host: '127.0.0.1:15175' } }), missing);
  await once(missing, 'finish');
  assert.equal(missing.statusCode, 404);
});

test('proxy rejects untrusted Host/Origin and path traversal; health/runtime do not forward', async () => {
  let businessRequests = 0;
  const handler = createMacProxyHandler({ apiTarget: 'http://127.0.0.1:13000', mode: 'local', backendIdentity: 'abc123', request: () => { businessRequests += 1; throw Error('should not call API'); } });
  const forbidden = response();
  await handler(request('/api/hello', { headers: { host: '127.0.0.1:15175', origin: 'https://evil.test' } }), forbidden);
  assert.equal(forbidden.statusCode, 403);
  const traversal = response();
  await handler(request('/%2e%2e/api/hello', { headers: { host: '127.0.0.1:15175' } }), traversal);
  assert.equal(traversal.statusCode, 400);
  const health = response();
  await handler(request('/__mac/health', { headers: { host: '127.0.0.1:15175' } }), health);
  await once(health, 'finish');
  assert.deepEqual(JSON.parse(health.body()), { ok: true, mode: 'local', serviceReady: true });
  const runtime = response();
  await handler(request('/runtime.js', { headers: { host: '127.0.0.1:15175' } }), runtime);
  await once(runtime, 'finish');
  assert.match(runtime.body().toString(), /__AI_NOVEL_RUNTIME__/);
  assert.match(runtime.body().toString(), /__AI_NOVEL_MAC_CONFIG__/);
  assert.equal(businessRequests, 0);
  assert.throws(() => createMacProxyHandler({ apiTarget: 'http://example.test:3000' }), /loopback/);
});

test('production static server uses HTML-only SPA fallback and refuses symlinks outside renderer root', async (t) => {
  const renderer = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-spa-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-spa-outside-'));
  t.after(async () => { await fs.rm(renderer, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  await fs.writeFile(path.join(renderer, 'index.html'), '<main>app</main>');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(renderer, 'leak.txt'));
  const handler = createMacProxyHandler({ apiTarget: 'http://127.0.0.1:13000', rendererRoot: renderer, isDevelopment: false, request: () => { throw new Error('non-API static route called upstream'); } });
  const html = response();
  const htmlFinished = once(html, 'finish');
  await handler(request('/novels/book/chapter/one', { headers: { host: '127.0.0.1:15175', accept: 'text/html,application/xhtml+xml' } }), html);
  await htmlFinished;
  assert.equal(html.statusCode, 200);
  assert.equal(html.body().toString(), '<main>app</main>');
  const fetchLike = response();
  await handler(request('/unknown/path', { headers: { host: '127.0.0.1:15175', accept: '*/*' } }), fetchLike);
  assert.equal(fetchLike.statusCode, 404);
  const symlink = response();
  await handler(request('/leak.txt', { headers: { host: '127.0.0.1:15175', accept: 'text/plain' } }), symlink);
  assert.equal(symlink.statusCode, 404);
});
