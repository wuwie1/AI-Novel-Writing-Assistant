import { acquireLock, readState, writeState } from '../../infrastructure/processes/lock.mjs';
import { getRepoPaths } from '../../infrastructure/processes/config.mjs';

const emptyState = (repoRealPath) => ({ schemaVersion: 1, repoRealPath, requestedMode: null, runningMode: null, backendIdentity: null, buildFingerprint: null, previousSuccessfulBuild: null, processes: {} });
const validMode = (mode) => mode === 'local' || mode === 'remote';

/** Lifecycle decisions are isolated from OS effects so tests can use safe adapters. */
export function createLifecycle({ config, adapters, clock = () => new Date().toISOString() }) {
  const paths = getRepoPaths(config.repoRealPath);
  const state = async () => (await readState(paths.stateFile, config.repoRealPath)) ?? emptyState(config.repoRealPath);
  const save = (value) => writeState(paths.stateFile, { ...value, updatedAt: clock() });

  async function checkStartDependencies(mode, current) {
    if (mode !== 'remote') return;
    try { await adapters.ensureRendererDependencies(); }
    catch (error) {
      await save({ ...current, requestedMode: mode });
      throw error;
    }
  }

  async function start(mode, { development = false, preparedBuild, heldLock } = {}) {
    if (!validMode(mode)) throw Object.assign(new Error('Mode must be local or remote'), { exitCode: 2 });
    const guard = heldLock ?? await acquireLock(paths.lifecycleLock, { repoRealPath: config.repoRealPath, operation: development ? 'dev_app' : 'app', now: clock });
    try {
      await adapters.beginStart?.();
      const current = await state();
      const status = await adapters.nativeStatus?.(current).catch(() => null);
      if (status && (!current.runningMode || status.repo !== config.repoRealPath || status.mode !== current.runningMode || status.backendIdentity !== current.backendIdentity)) {
        throw Object.assign(new Error('Native socket identity does not match the saved application state'), { exitCode: 4 });
      }
      if (!preparedBuild) await checkStartDependencies(mode, current);
      if (current.runningMode === mode && status?.rendererReady) {
        await adapters.focus?.(current);
        return { status: 'focused', mode };
      }
      const snapshot = structuredClone(current);
      let build = preparedBuild;
      let previousWindowClosed = false;
      if (current.runningMode === mode && status && !status.rendererReady) {
        await adapters.waitRendererReady({ pid: status.pid }, 30_000);
        const retriedStatus = await adapters.nativeStatus?.(current).catch(() => null);
        if (retriedStatus?.rendererReady) { await adapters.focus?.(current); return { status: 'focused', mode }; }
        throw Object.assign(new Error('The existing window did not become ready; no second window was launched'), { exitCode: 5 });
      }
      if (!current.runningMode && status) throw Object.assign(new Error('A native window is present but is not represented by this repository state; inspect it before starting another window'), { exitCode: 4 });
      if (current.runningMode === mode && !status) {
        if (await adapters.nativeProcessAlive?.(current)) throw Object.assign(new Error('The native process is still running but its control socket is unavailable; no second window was launched'), { exitCode: 4 });
        previousWindowClosed = true;
        await adapters.cleanupWindowHelpers?.(current);
      }
      if (current.runningMode && current.runningMode !== mode) {
        try { build ??= await adapters.prepare({ mode, development, config, paths }); }
        catch (error) { await save({ ...snapshot, requestedMode: mode }); throw Object.assign(error, { exitCode: error.exitCode ?? 5 }); }
        const closed = await adapters.requestNativeClose?.(current);
        if (!closed?.ok) throw Object.assign(new Error('Application close was cancelled; the current mode remains available'), { exitCode: 3, cancelled: true });
        await adapters.waitAppExited?.(current, 60_000);
        previousWindowClosed = true;
        await adapters.cleanupWindowHelpers?.(current);
      }
      const requested = { ...current, requestedMode: mode };
      await save(requested);
      await adapters.cleanupOrphanAgents?.(requested);
      try {
        build ??= await adapters.prepare({ mode, development, config, paths });
        const connection = await adapters.ensureConnection({ mode, config, current: snapshot });
        const helpers = await adapters.startHelpers({ mode, development, config, paths, build, connection });
        // A running launchd wrapper does not mean Vite/the proxy is listening yet.
        await adapters.waitHealthy({ mode, development, config, timeoutMs: 120_000 });
        const windowInfo = await adapters.openNative({ mode, config, paths, build, connection, helpers });
        await adapters.waitRendererReady(windowInfo, 30_000);
        const priorProcesses = await adapters.cleanupPreviousHelpers?.({ current: snapshot, nextProcesses: { ...connection.processes, ...helpers.processes, app: windowInfo.process } }) ?? {};
        const next = {
          ...snapshot,
          requestedMode: mode,
          runningMode: mode,
          backendIdentity: connection.backendIdentity,
          buildFingerprint: build.fingerprint,
          previousSuccessfulBuild: build,
          processes: { ...priorProcesses, ...connection.processes, ...helpers.processes, app: windowInfo.process },
        };
        const watcher = await adapters.watchNativeExit?.(windowInfo, { mode, backendIdentity: connection.backendIdentity });
        if (watcher) next.processes['native-watcher'] = watcher;
        await save(next);
        await adapters.commitStart?.(next);
        return { status: 'started', mode, buildFingerprint: build.fingerprint };
      } catch (error) {
        let retainedHelpers = {};
        try { retainedHelpers = await adapters.cleanupFailedStart?.({ mode, config, paths, current: snapshot, error }) ?? {}; } catch {}
        if (retainedHelpers.app) {
          await save({ ...snapshot, requestedMode: mode, runningMode: mode, backendIdentity: retainedHelpers.app.backendIdentity, processes: { ...snapshot.processes, ...retainedHelpers } });
          throw Object.assign(error, { exitCode: error.exitCode ?? 5 });
        }
        const recoveryBase = { ...snapshot, processes: { ...snapshot.processes, ...retainedHelpers } };
        let restored = null;
        if (snapshot.runningMode && previousWindowClosed) {
          try { restored = await adapters.restorePrevious?.({ current: recoveryBase, requestedMode: mode }); }
          catch { Object.assign(retainedHelpers, await adapters.cleanupFailedStart?.() ?? {}); }
        }
        if (!restored && retainedHelpers.app) {
          await save({ ...snapshot, requestedMode: mode, runningMode: retainedHelpers.app.mode, backendIdentity: retainedHelpers.app.backendIdentity, processes: { ...recoveryBase.processes, ...retainedHelpers } });
          throw Object.assign(error, { exitCode: error.exitCode ?? 5 });
        }
        if (restored) { await save({ ...restored, requestedMode: mode }); await adapters.commitStart?.(restored); }
        else {
          if (snapshot.runningMode && previousWindowClosed) await adapters.cleanupWindowHelpers?.(recoveryBase).catch?.(() => {});
          const remaining = snapshot.runningMode && previousWindowClosed
            ? Object.fromEntries(Object.entries(recoveryBase.processes).filter(([role, record]) => role === 'local-api' && record?.ownership === 'owned' || role === 'tunnel' && record?.ownership === 'owned' || record?.ownership === 'borrowed' || Object.hasOwn(retainedHelpers, role)))
            : recoveryBase.processes;
          await save({ ...recoveryBase, runningMode: snapshot.runningMode && previousWindowClosed ? null : snapshot.runningMode, requestedMode: mode, processes: remaining, backendIdentity: remaining['local-api']?.databaseIdentity ?? (remaining['local-api'] ? snapshot.backendIdentity : null) });
        }
        throw Object.assign(error, { exitCode: error.exitCode ?? 5 });
      }
    } finally { if (!heldLock) await guard.release(); }
  }

  async function stop() {
    const guard = await acquireLock(paths.lifecycleLock, { repoRealPath: config.repoRealPath, operation: 'stop_app', now: clock });
    try {
      const current = await state();
      if (!current.runningMode && !Object.values(current.processes).some((record) => record?.ownership === 'owned')) return { status: 'stopped' };
      if (current.runningMode || current.processes.app) {
        const status = await adapters.nativeStatus?.(current).catch(() => null);
        if (status) {
          if (status.repo !== config.repoRealPath || status.mode !== current.runningMode || status.backendIdentity !== current.backendIdentity) throw Object.assign(new Error('Native window identity does not match the saved state'), { exitCode: 4 });
          const close = await adapters.requestNativeClose?.(current);
          if (!close?.ok) throw Object.assign(new Error('Application close was cancelled; services remain running'), { exitCode: 3, cancelled: true });
          await adapters.waitAppExited?.(current, 60_000);
        } else if (current.processes.app && await adapters.nativeProcessAlive?.(current)) {
          throw Object.assign(new Error('Native process is still running but its control socket is unavailable; services were left running'), { exitCode: 4 });
        }
      }
      const retained = [];
      for (const [role, record] of Object.entries(current.processes)) {
        if (role === 'app' || record?.ownership !== 'owned') continue;
        if (role === 'local-api') {
          const idle = await adapters.localApiIdle?.(record);
          if (idle !== true) { retained.push(role); continue; }
        }
        await adapters.stopOwned?.(role, record, { repoRealPath: config.repoRealPath, mode: record.mode ?? current.runningMode });
      }
      const processes = Object.fromEntries(Object.entries(current.processes).filter(([role, record]) => role === 'app' ? false : retained.includes(role) || record?.ownership === 'borrowed'));
      const next = { ...current, runningMode: null, backendIdentity: retained.includes('local-api') ? current.backendIdentity : null, processes, retainedReasons: retained.length ? { 'local-api': 'active-or-unknown-tasks' } : {} };
      await save(next);
      await adapters.cleanupOrphanAgents?.(next);
      if (retained.length) await adapters.report?.('桌面已关闭。本机创作服务仍在运行，因为还不能确认所有创作任务都已空闲；任务结束后再运行一次 make stop_app 即可关闭。');
      return { status: 'stopped', retained };
    } finally { await guard.release(); }
  }

  async function restart(mode) {
    const guard = await acquireLock(paths.lifecycleLock, { repoRealPath: config.repoRealPath, operation: 'restart_app', now: clock });
    try {
      const current = await state();
      const selectedMode = mode ?? current.requestedMode ?? current.runningMode ?? 'remote';
      if (!mode && !current.requestedMode && !current.runningMode) await adapters.report?.('No previous mode is recorded; restarting in remote mode.');
      let build;
      await checkStartDependencies(selectedMode, current);
      try { build = await adapters.prepare({ mode: selectedMode, development: false, config, paths }); }
      catch (error) { await save({ ...current, requestedMode: selectedMode }); throw Object.assign(error, { exitCode: error.exitCode ?? 5 }); }
      const closed = current.runningMode ? await adapters.requestNativeClose?.(current) : { ok: true };
      if (!closed?.ok) throw Object.assign(new Error('Application close was cancelled; current services remain running'), { exitCode: 3, cancelled: true });
      await adapters.waitAppExited?.(current, 60_000);
      try {
        await adapters.cleanupWindowHelpers?.(current);
        const preserved = Object.fromEntries(Object.entries(current.processes ?? {}).filter(([role, record]) => role === 'local-api' || role === 'tunnel' || record?.ownership === 'borrowed'));
        await save({ ...current, requestedMode: selectedMode, runningMode: null, processes: preserved });
        return await start(selectedMode, { preparedBuild: build, heldLock: guard });
      } catch (error) {
        const latest = await state();
        // A failed new window may have refused to close. Do not replace it with the old build.
        if (latest.runningMode && latest.processes.app) throw error;
        const recoveryBase = { ...current, processes: { ...current.processes, ...latest.processes } };
        let restored = null;
        try { restored = current.runningMode ? await adapters.restorePrevious?.({ current: recoveryBase, requestedMode: selectedMode }) : null; }
        catch {
          const retained = await adapters.cleanupFailedStart?.() ?? {};
          Object.assign(recoveryBase.processes, retained);
          if (retained.app) {
            await save({ ...recoveryBase, requestedMode: selectedMode, runningMode: retained.app.mode, backendIdentity: retained.app.backendIdentity });
            throw error;
          }
        }
        if (restored) { await save({ ...restored, requestedMode: selectedMode }); await adapters.commitStart?.(restored); }
        else await save({ ...recoveryBase, runningMode: null, requestedMode: selectedMode, processes: Object.fromEntries(Object.entries(recoveryBase.processes ?? {}).filter(([role, record]) => role === 'local-api' || role === 'tunnel' || record?.ownership === 'borrowed' || role === 'mac-proxy' || role === 'vite' || role === 'native-watcher')) });
        throw Object.assign(error, { exitCode: error.exitCode ?? 5 });
      }
    } finally { await guard.release(); }
  }

  return Object.freeze({ startLocal: () => start('local', { development: true }), startRemote: () => start('remote'), stop, restart, getState: state });
}
