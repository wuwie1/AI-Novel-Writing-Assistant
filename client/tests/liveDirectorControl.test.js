import test from "node:test";
import assert from "node:assert/strict";
import { currentDirectorAction, legacyDirectorAction } from "../src/components/liveExecution/director/control.ts";

test("the live window follows the saved run across pause, reopen and explicit resume", () => {
  const run = {mode: "running"};
  const paused = {mode: "paused", sourceTrace: {userPaused: true, pauseKind: "manual_recovery"}, availableActions: [{command: "resume"}]};
  assert.equal(currentDirectorAction(run), "pause");
  assert.equal(currentDirectorAction(structuredClone(paused)), "resume");
  for (const patch of [{mode: "waiting_gate"}, {mode: "completed"}, {chapterBudget: {}}, {unknownClaims: {}},
    {availableActions: []}, {sourceTrace: {pauseKind: "replan"}}, {sourceTrace: {pauseKind: "manual_recovery"}}]) {
    assert.equal(currentDirectorAction({...paused, ...patch}), null);
  }
});

test("legacy resume requires the recovery lock and the projected continuation for the same task", () => {
  const task = {id: "director", status: "running", pendingManualRecovery: false};
  assert.equal(legacyDirectorAction({latestTask: task, dashboardView: {mode: "running"}}), "pause");
  const paused = {status: "waiting_recovery", latestTask: {...task, status: "queued", pendingManualRecovery: true},
    primaryAction: {type: "continue", commandPayload: {taskId: "director", continuationMode: "resume"}}};
  assert.equal(legacyDirectorAction(paused), "resume");
  for (const action of [null, {type: "auto_execute_range"}, {type: "continue", commandPayload: {taskId: "other", continuationMode: "resume"}}]) {
    assert.equal(legacyDirectorAction({...paused, primaryAction: action}), null);
  }
  assert.equal(legacyDirectorAction({latestTask: null, dashboardView: {mode: "running"}}), null);
});
