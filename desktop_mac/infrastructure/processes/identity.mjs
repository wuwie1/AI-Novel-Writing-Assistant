import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export const stableHash = (value, length = 16) => createHash('sha256').update(value).digest('hex').slice(0, length);
export const backendIdentity = ({ mode, repoRealPath, target }) => createHash('sha256').update([mode, repoRealPath, target].join('\0')).digest('hex');

export async function inspectProcess(pid, { exec = execFileAsync } = {}) {
  try {
    const [{ stdout: started }, { stdout: command }] = await Promise.all([
      exec('/bin/ps', ['-p', String(pid), '-o', 'lstart=']),
      exec('/bin/ps', ['-p', String(pid), '-o', 'command=']),
    ]);
    return { pid: Number(pid), startTime: started.trim(), command: command.trim() };
  } catch { return null; }
}

export async function processMatches(record, expected, adapters = {}) {
  if (!record || record.ownership !== 'owned' || !Number.isInteger(record.pid) || !record.startTime || !record.commandIdentity) return false;
  if (record.repoRealPath !== expected.repoRealPath || record.role !== expected.role || expected.mode && record.mode !== expected.mode) return false;
  const inspect = adapters.inspectProcess ?? inspectProcess;
  const actual = await inspect(record.pid, adapters);
  if (!actual || actual.startTime !== record.startTime) return false;
  if (actual.commandIdentity) return actual.commandIdentity === record.commandIdentity;
  return stableHash(actual.command) === record.commandIdentity;
}

export async function signalOwnedProcess(record, signal, expected, adapters = {}) {
  if (!await processMatches(record, expected, adapters)) throw Object.assign(new Error(`Refusing to signal process ${record?.pid ?? 'unknown'}: process ownership could not be verified`), { exitCode: 4 });
  const sendSignal = adapters.kill ?? process.kill.bind(process);
  sendSignal(record.pid, signal);
}
