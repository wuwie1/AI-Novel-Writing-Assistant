import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProxyServer } from '../server.mjs';
import { loadProxyConfig, validateConfig, PROXY_BASE_URL } from '../infrastructure/config.mjs';
import { forwardedHeaders, upstreamTarget } from '../infrastructure/forward.mjs';
import { ownedProcess, isolatedSshProfile } from '../application/lifecycle.mjs';
import { LOCAL_PROXY_BASE_URL, selectLocalProxy, usesLocalProxy } from '../../client/src/pages/settings/models/localProxy.ts';

async function serve(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function proxy(t, handler) {
  const upstream = await serve(t, http.createServer(handler));
  const local = await serve(t, createProxyServer({ upstream: `${upstream}/gateway/v1`, owner: 'test-owner' }));
  return local;
}

test('forwards model paths, query, credentials and exact multipart bytes to the configured base', async t => {
  const payload = Buffer.from('--boundary\r\nimage\u0000\u00ff\r\n--boundary--\r\n');
  let received;
  const local = await proxy(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) };
    res.writeHead(201, { 'content-type': 'application/json', 'x-request-id': 'upstream-request' });
    res.end('{"data":[{"url":"image"}]}');
  });
  const response = await fetch(`${local}/v1/images/edits?size=small`, { method: 'POST',
    headers: { authorization: 'Bearer test-only', 'x-api-key': 'test-only', 'content-type': 'multipart/form-data; boundary=boundary' }, body: payload });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-request-id'), 'upstream-request');
  assert.deepEqual(await response.json(), { data: [{ url: 'image' }] });
  assert.equal(received.url, '/gateway/v1/images/edits?size=small');
  assert.equal(received.method, 'POST');
  assert.equal(received.headers.authorization, 'Bearer test-only');
  assert.equal(received.headers['x-api-key'], 'test-only');
  assert.deepEqual(received.body, payload);
});

test('streams the first SSE event before the upstream finishes', async t => {
  let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  const local = await proxy(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"text":"first"}\n\n');
    await complete;
    res.end('data: [DONE]\n\n');
  });
  const response = await fetch(`${local}/v1/chat/completions`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) });
  const reader = response.body.getReader();
  try { assert.match(new TextDecoder().decode((await reader.read()).value), /first/); }
  finally { finish(); }
  let tail = ''; for (;;) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
  assert.match(tail, /DONE/);
});

test('preserves upstream errors and does not retry or follow redirects', async t => {
  let calls = 0;
  const local = await proxy(t, (_req, res) => { calls++; res.writeHead(429, { 'retry-after': '7' }); res.end('{"error":"quota"}'); });
  const response = await fetch(`${local}/v1/embeddings`);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '7');
  assert.equal(await response.text(), '{"error":"quota"}');
  assert.equal(calls, 1);
  const redirect = await proxy(t, (_req, res) => res.writeHead(307, { location: 'https://example.com' }).end());
  assert.equal((await fetch(`${redirect}/v1/responses`, { redirect: 'manual' })).status, 307);
});

test('downstream disconnect cancels the upstream request', async t => {
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const local = await proxy(t, (_req, res) => {
    res.on('close', disconnected);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  });
  const controller = new AbortController();
  const response = await fetch(`${local}/v1/chat/completions`, { signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  let timer;
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('upstream not cancelled')), 2000); })]); }
  finally { clearTimeout(timer); }
});

test('health is local; unsupported paths never reach the upstream', async t => {
  let calls = 0;
  const local = await proxy(t, (_req, res) => { calls++; res.end(); });
  assert.deepEqual(await (await fetch(`${local}/health`)).json(), { service: 'ai-novel-local-proxy', owner: 'test-owner' });
  assert.equal((await fetch(`${local}/admin`)).status, 404);
  assert.equal(calls, 0);
  for (const suffix of ['/v1/../secret', '/v1/%2e%2e/secret', 'https://evil.test/v1/chat', '//evil.test/v1/models', '/v1/%5csecret']) {
    assert.equal(upstreamTarget('https://api.example.com/v1', suffix), null);
  }
  assert.deepEqual(forwardedHeaders({ connection: 'x-private, upgrade', 'x-private': 'omit', host: 'wrong', authorization: 'keep', 'content-length': '2' }),
    { authorization: 'keep', 'content-length': '2' });
});

test('network failures return a generic error without upstream address or credentials', async t => {
  const closed = http.createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const port = closed.address().port; await new Promise(resolve => closed.close(resolve));
  const local = await serve(t, createProxyServer({ upstream: `http://127.0.0.1:${port}/private-upstream` }));
  const response = await fetch(`${local}/v1/models`);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /could not reach upstream/);
  assert.doesNotMatch(body, /private-upstream|127\.0\.0\.1/);
});

test('TOML accepts comments and dotted keys, rejects bad settings without exposing content', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'local-proxy-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.toml');
  await writeFile(file, 'openai.url = "https://example.com/custom/v1/" # comment\n');
  assert.deepEqual(await loadProxyConfig(file), { upstream: 'https://example.com/custom/v1' });
  await writeFile(file, 'openai.url = PRIVATE_BROKEN_CONFIG');
  await assert.rejects(loadProxyConfig(file), error => !error.message.includes('PRIVATE_BROKEN_CONFIG'));
  for (const url of ['file:///etc/passwd', 'http://secret@example.com/v1', 'http://127.0.0.1:14000/v1', 'https://example.com/v1?key=secret']) {
    assert.throws(() => validateConfig({ openai: { url } }));
  }
});

test('UI saves the actual proxy endpoint and safely restores direct URL choices', () => {
  assert.equal(LOCAL_PROXY_BASE_URL, PROXY_BASE_URL);
  const form = { baseURL: 'https://example.com/v1', key: 'unchanged', model: 'model' };
  assert.equal(usesLocalProxy(form.baseURL), false);
  const selected = selectLocalProxy(form, true);
  assert.equal(selected.baseURL, PROXY_BASE_URL);
  assert.equal(selected.key, form.key);
  assert.equal(usesLocalProxy(`${selected.baseURL}/`), true);
  assert.equal(selectLocalProxy(selectLocalProxy(selected, true), false).baseURL, form.baseURL);
  assert.equal(selectLocalProxy({ baseURL: PROXY_BASE_URL }, false, PROXY_BASE_URL).baseURL, '');
  assert.equal(selectLocalProxy({ baseURL: PROXY_BASE_URL }, false, 'https://example.com/v1').baseURL, form.baseURL);
});

test('process ownership requires complete argv; isolated SSH profiles do not repeat other forwards', () => {
  const record = { executable: 'node', args: ['/project/proxy/server.mjs', 'unique-owner'] };
  assert.equal(ownedProcess(record, ['/usr/bin/node', ...record.args]), true);
  assert.equal(ownedProcess(record, ['/usr/bin/node', '/another/proxy/server.mjs', 'unique-owner']), false);
  assert.equal(ownedProcess(record, ['/usr/bin/node', ...record.args, 'extra']), false);
  assert.equal(ownedProcess(record, null), false);
  const profile = isolatedSshProfile('host server\nhostname server\nlocalforward 80 localhost:80\nremoteforward 90 localhost:90\ndynamicforward 8080\nidentityfile ~/.ssh/key\n', 'user@server');
  assert.doesNotMatch(profile, /^(localforward|remoteforward|dynamicforward)/m);
  assert.match(profile, /identityfile ~\/.ssh\/key/);
  assert.match(profile, /Host \* !server/);
});
