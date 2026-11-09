import { appendRoleLog } from '../../infrastructure/processes/logging.mjs';

export const runUntimed = (_stage, operation) => operation();

export function createStageTimer(command, logDir) {
  let warned = false;
  async function emit(stage, detail) {
    const line = `[${command} pid=${process.pid}] ${stage} ${detail}`;
    process.stdout.write(`${line}\n`);
    try { await appendRoleLog(logDir, 'lifecycle', line); }
    catch (error) {
      if (!warned) process.stderr.write(`写入生命周期日志失败（${error.code ?? 'I/O'}），耗时可在终端查看。\n`);
      warned = true;
    }
  }
  return async function measure(stage, operation, describe = () => '完成') {
    await emit(stage, '开始');
    const started = performance.now();
    try {
      const result = await operation();
      await emit(stage, `${describe(result)} ${Math.round(performance.now() - started)}ms`);
      return result;
    } catch (error) {
      await emit(stage, `失败 ${Math.round(performance.now() - started)}ms`);
      error.stage ??= stage;
      throw error;
    }
  };
}

/** Instrument the same operations on the normal, cleanup and rollback paths. */
export function timeLifecycleAdapters(adapters, measure) {
  const stages = {
    ensureRendererDependencies: '检查桌面依赖', nativeStatus: '检查已有窗口', focus: '聚焦已有窗口',
    requestNativeClose: '等待窗口确认退出', waitAppExited: '等待窗口进程退出',
    cleanupOrphanAgents: '核对遗留服务', startHelpers: '启动界面服务',
    waitHealthy: '检查界面与 API', openNative: '打开原生窗口',
    waitRendererReady: '等待页面就绪', watchNativeExit: '启动窗口监视',
    localApiIdle: '检查本机创作任务', restorePrevious: '恢复上次成功的窗口',
    cleanupFailedStart: '清理本次启动',
  };
  const timed = { ...adapters };
  for (const [method, stage] of Object.entries(stages)) {
    if (!adapters[method]) continue;
    timed[method] = (...args) => measure(stage, () => adapters[method].apply(timed, args), (result) => {
      if (method === 'nativeStatus' && !result) return '未发现可响应的窗口';
      if (method === 'requestNativeClose' && !result?.ok) return '未获退出确认';
      if (method === 'localApiIdle' && result !== true) return '保留本机服务';
      return '完成';
    });
  }
  timed.ensureConnection = (options) => measure(options.mode === 'local' ? '连接本机服务' : '连接服务器隧道',
    () => adapters.ensureConnection.call(timed, options));
  return timed;
}
