import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTunnelArgv, resolveSshEndpoint, tunnelMatches } from '../infrastructure/transport/ssh-identity.mjs';

const endpoint = { hostname: '152.136.155.200', user: 'root', port: 22, proxyjump: 'none', proxycommand: 'none', hostkeyalias: '152.136.155.200' };
const argv = ['/usr/bin/ssh', '-N', '-T', '-L', '127.0.0.1:15173:127.0.0.1:18080', '-E', '/repo with spaces/tunnel.log', '-o', 'BatchMode=yes', '-o', 'ControlPath=none', 'my-server'];
const target = { pid: 123, sshTarget: 'root@152.136.155.200', localPort: 15173, remotePort: 18080 };

test('an existing SSH alias is borrowed when its resolved destination and forwarding match', async () => {
  const calls = [];
  assert.equal(await tunnelMatches(target, { readArgv: async () => argv, resolveEndpoint: async (name) => { calls.push(name); return endpoint; } }), true);
  assert.deepEqual(calls, ['my-server', 'root@152.136.155.200']);
  assert.equal(parseTunnelArgv(['/usr/bin/ssh', '-NT', '-L127.0.0.1:15173:127.0.0.1:18080', 'my-server']).target, 'my-server');
});

test('a different server, user, SSH port or forward is never accepted based on matching text', async () => {
  for (const differing of [{hostname:'different-server'}, {user:'another-user'}, {port:2222}]) {
    assert.equal(await tunnelMatches(target, { readArgv: async () => argv, resolveEndpoint: async (name) => name === 'my-server' ? {...endpoint,...differing} : endpoint }), false);
  }
  assert.equal(await tunnelMatches(target, { readArgv: async () => argv.map((arg) => arg.replace(':18080', ':9999')), resolveEndpoint: async () => endpoint }), false);
  assert.equal(parseTunnelArgv(['/bin/echo', ...argv.slice(1)]), null);
  assert.equal(parseTunnelArgv([...argv, 'remote-command']), null);
  assert.equal(parseTunnelArgv(['/usr/bin/ssh','-o','ProxyCommand=untrusted-command','my-server']), null);
});

test('SSH connection overrides are preserved while resolving aliases; unreadable process identity fails closed', async () => {
  assert.deepEqual(parseTunnelArgv(['/usr/bin/ssh','-p2222','-l','writer','-F','/path with spaces/config','my-server']).identityArgs, ['-p','2222','-l','writer','-F','/path with spaces/config']);
  let invoked;
  const value = await resolveSshEndpoint('my-server', ['-p','2222'], {exec: async (command,args) => {invoked={command,args}; return {stdout:'hostname 152.136.155.200\nuser root\nport 2222\n'};} });
  assert.deepEqual(invoked,{command:'/usr/bin/ssh',args:['-G','-p','2222','my-server']});
  assert.equal(value.port,2222);
  assert.equal(await tunnelMatches(target,{readArgv: async () => null}),false);
});
