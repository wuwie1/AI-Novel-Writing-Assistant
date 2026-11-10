import {withExecutionSignal} from "./ExecutionScope";

// A lease may still be executing a model request when its database row disappears.
const active = new Map<string, Set<() => void>>();

export function registerTaskCancellation(key: string, cancel: () => void): () => void {
  const group = active.get(key) ?? new Set();
  group.add(cancel);
  active.set(key, group);
  return () => {
    group.delete(cancel);
    if (!group.size) active.delete(key);
  };
}

export function cancelTaskExecutions(key: string): void {
  for (const cancel of active.get(key) ?? []) cancel();
}

export function withNovelExecution<T>(novelId: string, work: () => Promise<T>) {
  return withTaskExecution(`novel:${novelId}`, work);
}

export async function withTaskExecution<T>(key: string, work: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const release = registerTaskCancellation(key, () => controller.abort());
  try {
    return await withExecutionSignal(controller.signal, work);
  } finally {
    release();
  }
}
