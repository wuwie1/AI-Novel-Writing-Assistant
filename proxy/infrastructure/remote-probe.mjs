import { PROXY_PORT } from './config.mjs';

const marker = '__AI_NOVEL_PROXY_HEALTH__';
const command = `listeners=$(ss -H -ltn 'sport = :${PROXY_PORT}') || exit 70
printf '%s\n${marker}\n' "$listeners"
if [ -n "$listeners" ]; then
  curl --noproxy '*' -fsS --max-time 3 http://127.0.0.1:${PROXY_PORT}/health || exit 71
fi`;

/** Return only probe classifications; SSH output and remote response bodies stay private. */
export async function inspectRemoteProxy(target, owner, execute) {
  let stdout;
  try {
    ({ stdout } = await execute('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes',
      '-o', 'ConnectTimeout=5', target, command], { timeout: 10_000 }));
  } catch (error) {
    if (error.code !== 71) return error.code === 255 ? 'ssh_failed' : 'probe_failed';
    // curl can fail after ss succeeded. Still inspect the listener's binding.
    stdout = error.stdout;
  }
  const parts = stdout?.trim().split(marker);
  if (parts?.length !== 2) return 'probe_failed';
  const listeners = parts[0].trim().split('\n').filter(Boolean);
  if (!listeners.length) return 'free';
  const addresses = listeners.map(line => line.trim().split(/\s+/));
  if (addresses.some(fields => fields.length < 5 || fields[0] !== 'LISTEN')) return 'probe_failed';
  // GatewayPorts=yes may override the client's requested loopback binding.
  if (addresses.some(fields => ![`127.0.0.1:${PROXY_PORT}`, `[::1]:${PROXY_PORT}`].includes(fields[3]))) return 'unsafe';
  let value;
  try { value = JSON.parse(parts[1]); } catch { return 'unresponsive'; }
  if (value?.service !== 'ai-novel-local-proxy' || !value.owner) return 'unresponsive';
  return value.owner === owner ? 'ready' : 'foreign_proxy';
}
