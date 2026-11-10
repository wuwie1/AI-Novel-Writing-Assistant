import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stableHash } from './identity.mjs';

export function nativeSocketPath(repoRealPath, uid = process.getuid?.() ?? 0) {
  const directory = path.join('/tmp', `ai-novel-mac-${uid}`);
  return path.join(directory, `${stableHash(repoRealPath)}.sock`);
}

export function sendNativeCommand(socketPath, command, { timeoutMs = 2_000, requestId = randomUUID(), connect = net.createConnection } = {}) {
  if (!['status', 'focus', 'close'].includes(command)) return Promise.reject(new Error('Unsupported native command'));
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error(`Native ${command} request timed out`), { code: 'ETIMEDOUT' })); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ protocolVersion: 1, command, requestId })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 8192) { clearTimeout(timer); socket.destroy(); reject(new Error('Native response exceeded limit')); return; }
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd < 0) return;
      clearTimeout(timer); socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, lineEnd));
        if (response.requestId && response.requestId !== requestId) throw new Error('Native response requestId mismatch');
        resolve(response);
      } catch (error) { reject(error); }
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

export async function getNativeStatus(repoRealPath, options) { return sendNativeCommand(nativeSocketPath(repoRealPath), 'status', options); }

export async function requestOwnedWindowClose(repoRoot, current, send = sendNativeCommand) {
  const socket = nativeSocketPath(repoRoot);
  const status = await send(socket, 'status');
  const pid = current.processes?.app?.pid;
  if (status.ok !== true || status.repo !== repoRoot || status.mode !== current.runningMode ||
      status.backendIdentity !== current.backendIdentity || (pid != null && status.pid !== pid)) {
    throw Object.assign(new Error('Native window identity does not match the saved state'), {exitCode: 4});
  }
  let result;
  try { result = await send(socket, 'close', {timeoutMs: 60_000}); }
  catch (error) {
    if (error.code === 'ETIMEDOUT') return {ok: false, error: 'close_timeout'};
    throw error;
  }
  // The original binary returned the same cancellation for an unready page and a user decision.
  if (!status.rendererState && status.rendererReady === false && result.ok === false && result.cancelled === true && !result.error) {
    return {...result, cancelled: false, error: 'legacy_renderer_unavailable'};
  }
  return result;
}
