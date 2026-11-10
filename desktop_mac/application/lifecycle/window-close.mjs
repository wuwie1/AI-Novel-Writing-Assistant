const reasons = {
  cancelled: ['已取消退出', '已取消退出，窗口和服务仍在运行。'],
  document_busy: ['正在保存或生成', '请等窗口里的保存或生成操作结束，再运行原命令。'],
  close_pending: ['已有确认待处理', '请回到 AI Novel 处理窗口中已有的确认，再运行原命令。'],
  close_timeout: ['等待确认超时', '请从 Dock 打开 AI Novel，检查当前页面的保存状态，再运行原命令。'],
  renderer_unavailable: ['页面未就绪', '请回到 AI Novel 检查页面或恢复提示，再运行原命令。'],
  legacy_renderer_unavailable: ['旧版窗口的页面未就绪', '请从 Dock 打开 AI Novel，保存或复制仍可见的草稿，按 ⌘Q 退出旧窗口，再运行原命令。'],
  unknown: ['未获退出确认', '窗口未能确认退出，请回到 AI Novel 检查页面后重试。'],
};

function closeReason(result) {
  if (result?.error && Object.hasOwn(reasons, result.error)) return result.error;
  return result?.cancelled === true && !result.error ? 'cancelled' : 'unknown';
}

export function describeWindowClose(result) {
  return result?.ok === true ? '完成' : reasons[closeReason(result)][0];
}

export function requireWindowClose(result) {
  if (result?.ok === true) return;
  const reason = closeReason(result);
  const [message, userHint] = reasons[reason];
  throw Object.assign(new Error(message), {
    exitCode: reason === 'cancelled' ? 3 : 5,
    cancelled: reason === 'cancelled', userHint, stage: '等待窗口确认退出',
  });
}
