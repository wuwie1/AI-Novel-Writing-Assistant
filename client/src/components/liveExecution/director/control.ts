import type { DashboardView } from "@/api/directorNext";
import type { DirectorBookAutomationProjection } from "@ai-novel/shared/types/directorRuntime";

export function currentDirectorAction(view: DashboardView) {
  if (view.mode === "running") return "pause";
  if (view.mode === "paused" && view.sourceTrace.userPaused && view.sourceTrace.pauseKind === "manual_recovery"
    && !view.chapterBudget && !view.unknownClaims && view.availableActions.some(action => action.command === "resume")) {
    return "resume";
  }
  return null;
}

export function legacyDirectorAction(projection: DirectorBookAutomationProjection) {
  const task = projection.latestTask;
  if (!task) return null;
  if (task.pendingManualRecovery) {
    const action = projection.primaryAction;
    return projection.status === "waiting_recovery" && action?.type === "continue"
      && action.commandPayload?.taskId === task.id && action.commandPayload.continuationMode === "resume"
      ? "resume" : null;
  }
  const mode = projection.dashboardView?.mode;
  return (mode === "running" || mode === "queued") && (task.status === "running" || task.status === "queued")
    ? "pause" : null;
}
