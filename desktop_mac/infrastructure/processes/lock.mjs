import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

let cachedMachineId;
/** macOS changes os.hostname() with the network (for example "bogon"); the platform UUID is stable. */
export function machineId() {
  if (cachedMachineId !== undefined) return cachedMachineId;
  try {
    const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000 });
    cachedMachineId = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
  } catch { cachedMachineId = null; }
  return cachedMachineId;
}

const sameMachine = (owner, currentMachineId) => owner.machineId && currentMachineId
  ? owner.machineId === currentMachineId
  : owner.hostname === hostname();

export async function acquireLock(lockPath, { repoRealPath, operation, pid = process.pid, now = () => new Date().toISOString(), isPidAlive = pidAlive, currentMachineId = machineId() }) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt += 1) {
    try { await mkdir(lockPath, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')); }
      catch { throw Object.assign(new Error(`Lifecycle lock is unreadable; inspect ${lockPath} and recover it manually`), { exitCode: 4, lockBusy: true }); }
      const sameHost = sameMachine(owner, currentMachineId);
      const live = sameHost && isPidAlive(owner.pid);
      // An interrupted command (for example Ctrl-C) cannot release its lock. Only a lock from this
      // machine and repository whose owner PID no longer exists is provably stale and reclaimable.
      if (attempt === 0 && sameHost && !live && owner.repoRealPath === repoRealPath) {
        const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
        try { await rename(lockPath, stalePath); await rm(stalePath, { recursive: true, force: true }); continue; }
        catch (renameError) { if (renameError.code !== 'ENOENT') throw renameError; continue; }
      }
      throw Object.assign(new Error(`Lifecycle is locked by ${owner.operation} (pid ${owner.pid}, ${live ? 'running' : 'owner status unknown'}); inspect ${lockPath} before recovery`), { exitCode: 4, owner, lockBusy: true });
    }
  }
  const owner = { schemaVersion: 1, repoRealPath, operation, pid, hostname: hostname(), machineId: currentMachineId, acquiredAt: now() };
  try { await open(path.join(lockPath, 'owner.json'), 'wx', 0o600).then(async (file) => { await file.writeFile(`${JSON.stringify(owner, null, 2)}\n`); await file.close(); }); }
  catch (error) { await rm(lockPath, { recursive: true, force: true }); throw error; }
  let released = false;
  return {
    owner,
    async release() {
      if (released) return;
      const current = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
      if (current.pid !== owner.pid || current.acquiredAt !== owner.acquiredAt || current.repoRealPath !== owner.repoRealPath) {
        throw Object.assign(new Error('Lifecycle lock ownership changed; refusing to remove it'), { exitCode: 4 });
      }
      await rm(lockPath, { recursive: true });
      released = true;
    },
  };
}

export async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(state, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, statePath);
}

export async function readState(statePath, expectedRepoRealPath) {
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Object.assign(new Error(`Desktop state is damaged; no process will be signalled. Inspect ${statePath} and restore a known-good state file`), { exitCode: 4, cause: error });
  }
  const required = ['schemaVersion', 'repoRealPath', 'requestedMode', 'runningMode', 'backendIdentity', 'buildFingerprint', 'previousSuccessfulBuild', 'processes'];
  if (!state || required.some((key) => !Object.hasOwn(state, key)) || state.schemaVersion !== 1 || state.repoRealPath !== expectedRepoRealPath || !['local', 'remote', null].includes(state.requestedMode) || !['local', 'remote', null].includes(state.runningMode) || !state.processes || typeof state.processes !== 'object' || Array.isArray(state.processes) || Object.values(state.processes).some((record) => !record || !['owned', 'borrowed'].includes(record.ownership))) {
    throw Object.assign(new Error(`Desktop state does not match this repository; no process will be signalled. Inspect ${statePath}`), { exitCode: 4 });
  }
  return state;
}

export async function ensurePrivateDirectory(dir) { await mkdir(dir, { recursive: true, mode: 0o700 }); await (await stat(dir)).isDirectory(); }
