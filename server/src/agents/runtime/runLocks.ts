import {withTaskExecution} from "../../platform/runtime/execution";

const runLocks = new Map<string, Promise<void>>();

export async function withSharedRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const previous = runLocks.get(runId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  runLocks.set(runId, chained);
  await previous;
  try {
    return await withTaskExecution(`agent:${runId}`, fn);
  } finally {
    release();
    if (runLocks.get(runId) === chained) {
      runLocks.delete(runId);
    }
  }
}
