import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { acquireLock, readState, writeState } from './lock.mjs';
import { processMatches, stableHash } from './identity.mjs';
import { backendIdentity } from './identity.mjs';
import { inspectSqliteQuiescence } from './quiescence.mjs';
import { launchdLabel, stopAgent } from './launchd.mjs';

const run = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const repoRoot = process.env.MAC_REPO_ROOT;
const mode = process.env.MAC_MODE;
const nativePid = Number(process.env.MAC_NATIVE_PID);
const nativeStartTime = process.env.MAC_NATIVE_START_TIME;
const nativeCommandIdentity = process.env.MAC_NATIVE_COMMAND_ID;
const backendId = process.env.MAC_BACKEND_IDENTITY;
const label = process.env.MAC_WATCHER_LABEL;

if (!repoRoot || !path.isAbsolute(repoRoot) || !['local', 'remote'].includes(mode) || !Number.isInteger(nativePid) || !nativeStartTime || !nativeCommandIdentity || !backendId || !label) {
  process.stderr.write('Native exit watcher configuration is incomplete.\n'); process.exit(2);
}

function parsePid(output) { const match = output.match(/^\s*pid\s*=\s*(\d+)\s*$/m); return match ? Number(match[1]) : null; }

async function nativeIdentity() {
  try {
    const [{ stdout: started }, { stdout: command }] = await Promise.all([
      run('/bin/ps', ['-p', String(nativePid), '-o', 'lstart=']),
      run('/bin/ps', ['-p', String(nativePid), '-o', 'command=']),
    ]);
    return { alive: true, startTime: started.trim(), command: command.trim() };
  }
  catch { return { alive: false }; }
}

async function launcherOwned(record, expectedMode) {
  if (!record.label || record.label !== launchdLabel({ repoRealPath: repoRoot, mode: expectedMode, role: record.role }) || record.ownership !== 'owned' || !await processMatches(record, { repoRealPath: repoRoot, role: record.role, mode: expectedMode })) return false;
  try { const { stdout } = await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${record.label}`]); return parsePid(stdout) === record.pid; }
  catch { return false; }
}

async function cleanup() {
  let guard;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { guard = await acquireLock(path.join(repoRoot, '.runtime/desktop_mac/lifecycle.lock'), { repoRealPath: repoRoot, operation: 'native_exit_cleanup' }); break; }
    catch { await wait(1000); }
  }
  if (!guard) return;
  try {
    const statePath = path.join(repoRoot, '.runtime/desktop_mac/state.json');
    const state = await readState(statePath, repoRoot);
    if (!state || state.processes.app?.pid !== nativePid || state.processes.app?.startTime !== nativeStartTime || state.processes.app?.commandIdentity !== nativeCommandIdentity || state.backendIdentity !== backendId || state.runningMode !== mode) return;
    let canStopLocalApi = false;
    if (state.processes['local-api']?.ownership === 'owned') {
      try { const dbPath = state.processes['local-api'].databasePath; canStopLocalApi = !!dbPath && (await inspectSqliteQuiescence({ dbPath })).safeToStop === true; } catch {}
    }
    const nextProcesses = {};
    for (const [role, record] of Object.entries(state.processes)) {
      if (role === 'app') continue;
      if (role === 'native-watcher') continue;
      if (role === 'local-api' && record.ownership === 'owned' && !canStopLocalApi) { nextProcesses[role] = record; continue; }
      if (record.ownership === 'borrowed') { nextProcesses[role] = record; continue; }
      if (!await launcherOwned(record, record.mode ?? mode)) { nextProcesses[role] = record; continue; }
      try { await stopAgent(record.label); }
      catch { nextProcesses[role] = record; }
    }
    const localApiRetained = Boolean(nextProcesses['local-api']);
    let runningBackendIdentity = null;
    if (localApiRetained) {
      const databasePath = nextProcesses['local-api'].databasePath;
      if (databasePath) runningBackendIdentity = backendIdentity({ mode: 'local', repoRealPath: repoRoot, target: path.relative(repoRoot, databasePath) });
    }
    await writeState(statePath, {
      ...state,
      runningMode: null,
      backendIdentity: runningBackendIdentity,
      processes: nextProcesses,
      retainedReasons: localApiRetained ? { 'local-api': 'active-or-unknown-tasks' } : {},
      updatedAt: new Date().toISOString(),
    });
    if (localApiRetained) process.stdout.write('Native window exited; local API remains running because task activity was active or could not be confirmed idle.\n');
  } finally { await guard.release(); }
}

for (;;) {
  const actual = await nativeIdentity();
  if (!actual.alive) break;
  if (actual.startTime !== nativeStartTime || stableHash(actual.command) !== nativeCommandIdentity) process.exit(0);
  await wait(1000);
}

await cleanup().catch((error) => { process.stderr.write(`Native exit cleanup could not complete: ${error.message}\n`); process.exitCode = 4; });

// Remove this completed launchd registration so a later start can reuse the role.
try {
  const { stdout } = await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]);
  if (parsePid(stdout) === process.pid) await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
} catch {}
