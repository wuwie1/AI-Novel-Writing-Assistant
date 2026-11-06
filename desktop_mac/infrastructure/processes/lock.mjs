import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

export async function acquireLock(lockPath, { repoRealPath, operation, pid = process.pid, now = () => new Date().toISOString() }) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')); }
    catch { throw Object.assign(new Error(`Lifecycle lock is unreadable; inspect ${lockPath} and recover it manually`), { exitCode: 4 }); }
    const live = owner.hostname === hostname() && pidAlive(owner.pid);
    throw Object.assign(new Error(`Lifecycle is locked by ${owner.operation} (pid ${owner.pid}, ${live ? 'running' : 'owner status unknown'}); inspect ${lockPath} before recovery`), { exitCode: 4, owner });
  }
  const owner = { schemaVersion: 1, repoRealPath, operation, pid, hostname: hostname(), acquiredAt: now() };
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
