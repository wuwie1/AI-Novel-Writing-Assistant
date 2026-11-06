import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

import { readProcessArgv } from '../processes/argv.mjs';

/** Parse only audited SSH switches. Unknown/remote commands fail closed. */
export function parseTunnelArgv(argv) {
  if (!Array.isArray(argv) || argv[0] !== '/usr/bin/ssh') return null;
  const result = { target: null, forwards: [], identityArgs: [] };
  const flagOnly = new Set('46AaCfGgKkMNnqstTVvXxYy');
  const withValue = new Set('BbcDEeFIiJLlmOopQRSWw');
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      if (i !== argv.length - 1 || !/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/.test(arg)) return null;
      result.target = arg;
      break;
    }
    if (arg === '--' || arg.length < 2) return null;
    for (let j = 1; j < arg.length; j += 1) {
      const flag = arg[j];
      if (flagOnly.has(flag)) continue;
      if (!withValue.has(flag)) return null;
      const value = arg.slice(j + 1) || argv[++i];
      if (!value) return null;
      if (flag === 'L') result.forwards.push(value);
      // Preserve connection identity overrides; do not replay log/forward options.
      if ('FJlp'.includes(flag)) result.identityArgs.push(`-${flag}`, value);
      if (flag === 'o') {
        const key = value.split(/[=\s]/, 1)[0].toLowerCase();
        if (['hostname', 'user', 'port', 'proxyjump', 'hostkeyalias', 'canonicalizehostname'].includes(key)) result.identityArgs.push('-o', value);
        if (['proxycommand', 'localcommand', 'permitlocalcommand'].includes(key)) return null;
      }
      break;
    }
  }
  return result.target ? result : null;
}

export async function resolveSshEndpoint(target, identityArgs = [], { exec = execute } = {}) {
  const { stdout } = await exec('/usr/bin/ssh', ['-G', ...identityArgs, target], { timeout: 5000, maxBuffer: 128_000 });
  const fields = Object.fromEntries(stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const split = line.indexOf(' '); return [line.slice(0, split), line.slice(split + 1).trim()];
  }));
  if (!fields.hostname || !fields.user || !/^\d+$/.test(fields.port ?? '')) throw new Error('SSH endpoint cannot be resolved');
  return { hostname: fields.hostname.toLowerCase(), user: fields.user, port: Number(fields.port), proxyjump: fields.proxyjump ?? 'none', proxycommand: fields.proxycommand ?? 'none', hostkeyalias: fields.hostkeyalias ?? fields.hostname.toLowerCase() };
}

export async function tunnelMatches({ pid, sshTarget, localPort, remotePort }, { readArgv = readProcessArgv, resolveEndpoint = resolveSshEndpoint } = {}) {
  const parsed = parseTunnelArgv(await readArgv(pid));
  if (!parsed || !parsed.forwards.includes(`127.0.0.1:${localPort}:127.0.0.1:${remotePort}`)) return false;
  try {
    const [actual, expected] = await Promise.all([resolveEndpoint(parsed.target, parsed.identityArgs), resolveEndpoint(sshTarget)]);
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch { return false; }
}
