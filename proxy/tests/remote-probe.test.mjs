import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectRemoteProxy } from '../infrastructure/remote-probe.mjs';

const listener = address => `LISTEN 0 128 ${address}:14000 0.0.0.0:*\n`;
const health = owner => JSON.stringify({ service: 'ai-novel-local-proxy', owner });
const response = (listeners = '', body = '') => `${listeners}\n__AI_NOVEL_PROXY_HEALTH__\n${body}`;

test('remote probe separates a free port, verified proxy, foreign owner and unexpected HTTP service', async () => {
  for (const [stdout, expected] of [
    [response(), 'free'],
    [response(listener('127.0.0.1'), health('mine')), 'ready'],
    [response(listener('127.0.0.1') + listener('[::1]'), health('mine')), 'ready'],
    [response(listener('127.0.0.1'), health('another-workspace')), 'foreign_proxy'],
    [response(listener('127.0.0.1'), '{"service":"other"}'), 'unresponsive'],
    [response(listener('127.0.0.1'), 'not JSON'), 'unresponsive'],
    [response(listener('127.0.0.1'), 'null'), 'unresponsive'],
    [response('unexpected ss output', health('mine')), 'probe_failed'],
    ['no probe marker', 'probe_failed'],
  ]) {
    assert.equal(await inspectRemoteProxy('server', 'mine', async () => ({ stdout })), expected);
  }
});

test('public or mixed bindings are rejected even when the proxy responds with the right identity', async () => {
  for (const addresses of [['0.0.0.0'], ['[::]'], ['*'], ['127.0.0.1', '0.0.0.0']]) {
    const stdout = response(addresses.map(listener).join(''), health('mine'));
    assert.equal(await inspectRemoteProxy('server', 'mine', async () => ({ stdout })), 'unsafe');
  }
});

test('failed curl still checks listener safety; SSH and missing inspection tools remain distinct', async () => {
  for (const [code, stdout, expected] of [
    [71, response(listener('127.0.0.1')), 'unresponsive'],
    [71, response(listener('0.0.0.0')), 'unsafe'],
    [70, '', 'probe_failed'],
    [255, '', 'ssh_failed'],
    ['ETIMEDOUT', '', 'probe_failed'],
  ]) {
    assert.equal(await inspectRemoteProxy('server', 'mine', async () => {
      throw Object.assign(new Error('private remote output'), { code, stdout });
    }), expected);
  }
});
