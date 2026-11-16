import {registerTaskCancellation, withExecutionSignal} from "../../../../platform/runtime/execution";

/** Application receives a cancellation port; only this adapter knows AsyncLocalStorage. */
export function withDirectorExecution<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return withExecutionSignal(signal, work);
}

export function registerDirectorCancellation(runId: string, cancel: () => void): () => void {
  return registerTaskCancellation(`director:${runId}`, cancel);
}
