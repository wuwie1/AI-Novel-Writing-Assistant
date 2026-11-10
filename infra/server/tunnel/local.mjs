import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { readProcessArgv } from '../../../desktop_mac/infrastructure/processes/argv.mjs';
import { tunnelMatches } from '../../../desktop_mac/infrastructure/transport/ssh-identity.mjs';

const exec = promisify(execFile);

/** A responding port alone cannot tell whether quitting the desktop will close it. */
export async function webHealthy(url, request = fetch) {
  const options = { signal: AbortSignal.timeout(3000), redirect: 'error' };
  try {
    const [page, api] = await Promise.all([request(url, options), request(new URL('/api/health', url), options)]);
    const [html, health] = await Promise.all([page.text(), api.json()]);
    return page.status === 200 && /^text\/html\b/i.test(page.headers.get('content-type') ?? '')
      && /<html[\s>]/i.test(html) && api.status === 200 && health?.success === true && health.data?.status === 'ok';
  } catch { return false; }
}

export function localTunnel(config) {
  const root = config.repoRealPath;
  const script = path.join(root, 'infra/server/tunnel.sh');
  const supervisor = path.join(root, 'desktop_mac/infrastructure/processes/launchers/supervisor.mjs');

  function control(action, port) {
    return exec('bash', [script, action], {
      cwd: root,
      env: { ...process.env, AI_NOVEL_SSH_TARGET: config.sshTarget, AI_NOVEL_LOCAL_PORT: String(port), AI_NOVEL_REMOTE_PORT: String(config.remoteWebPort) },
    });
  }

  async function managerPid(port) {
    try {
      const { stdout } = await control('pid', port);
      return Number(stdout.trim());
    } catch (error) {
      if (error.code === 1) return null;
      throw error;
    }
  }

  async function listeners(port) {
    try {
      const { stdout } = await exec('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
      return [...new Set(stdout.trim().split(/\s+/).map(Number))];
    } catch (error) {
      if (error.code === 1 && !error.stderr?.trim()) return [];
      throw error;
    }
  }

  async function inspect(port, retry = true) {
    const [manager, pids] = await Promise.all([managerPid(port), listeners(port)]);
    if (!pids.length) return { owner: 'free', manager };
    if (pids.length === 1) {
      const [pid] = pids;
      let parent;
      try { parent = Number((await exec('ps', ['-p', String(pid), '-o', 'ppid='])).stdout.trim()); }
      catch (error) {
        if (error.code === 1 && retry) return inspect(port, false);
        throw error;
      }
      const matches = await tunnelMatches({ pid, sshTarget: config.sshTarget, localPort: port, remotePort: config.remoteWebPort });
      if (manager && parent === manager) return { owner: matches ? 'web' : 'stale', manager };
      if (matches) {
        const argv = await readProcessArgv(parent);
        if (argv?.[1] === supervisor && argv[2] === 'tunnel') return { owner: 'desktop' };
      }
    }
    return { owner: 'other' };
  }

  return { inspect, control, healthy: webHealthy };
}
