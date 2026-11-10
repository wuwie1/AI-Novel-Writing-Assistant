import {lockNovelRow} from "../../persistence";
import type {Prisma} from "@prisma/client";
import {prisma} from "../../../../db/prisma";
import {cancelTaskExecutions} from "../../../../platform/runtime/execution";
import {detachNovelIndex} from "../../../../services/rag/ownership";
import {locateStoredNovelCover} from "../../../../services/image/imageAssetStorage";
import {queueStoredAssetCleanup, STORED_ASSET_CLEANUP, type StoredAssetCleanup} from "../../../../events/sideEffects/StoredAssetCleanup";

async function removeNovelTasks(tx: Prisma.TransactionClient, novelId: string): Promise<string[]> {
  const where = {novelId};
  const select = {id: true} as const;
  const [workflow, agent, pipeline, image, director, revisions] = await Promise.all([
    tx.novelWorkflowTask.findMany({where, select}), tx.agentRun.findMany({where, select}),
    tx.generationJob.findMany({where, select}), tx.imageGenerationTask.findMany({where, select}),
    tx.directorNextRun.findMany({where, select}), tx.shortStoryRevisionJob.findMany({where, select}),
  ]);
  const ids = (rows: {id: string}[]) => rows.map(row => row.id);
  const directorIds = ids(director);
  const workflowIds = ids(workflow);
  const followUpIds = [...workflowIds, ...directorIds];
  await tx.taskCenterArchive.deleteMany({where: {OR: [
    {taskKind: "novel_workflow", taskId: {in: workflowIds}}, {taskKind: "agent_run", taskId: {in: ids(agent)}},
    {taskKind: "novel_pipeline", taskId: {in: ids(pipeline)}}, {taskKind: "image_generation", taskId: {in: ids(image)}},
  ]}});
  await tx.autoDirectorFollowUpActionLog.deleteMany({where: {taskId: {in: followUpIds}}});
  await tx.autoDirectorFollowUpNotificationLog.deleteMany({where: {taskId: {in: followUpIds}}});
  await tx.directorRuntimeInstance.deleteMany({where});
  await tx.directorRunCommand.deleteMany({where});
  await tx.directorRun.deleteMany({where});
  await tx.directorEvent.deleteMany({where});
  // Removing the run first fences in-flight artifact writers through producedByRunId.
  await tx.directorNextRun.deleteMany({where});
  await tx.directorNextArtifact.deleteMany({where});
  // Intent versions cascade from workflows, but unfinished plans/revisions restrict their deletion.
  await tx.shortStoryRevisionJob.deleteMany({where});
  await tx.shortStoryPlan.deleteMany({where});
  await tx.novelWorkflowTask.deleteMany({where});
  await tx.agentRun.deleteMany({where});
  return [
    ...directorIds.map(id => `director:${id}`), ...workflowIds.map(id => `workflow:${id}`),
    ...agent.map(({id}) => `agent:${id}`), ...revisions.map(({id}) => `revision:${id}`),
  ];
}

export async function deleteNovel(novelId: string): Promise<void> {
  const executionKeys = await prisma.$transaction(async tx => {
    // New director runs and asset publishers acquire the same book row before committing.
    await lockNovelRow(tx, novelId);
    const where = {novelId};
    const executionKeys = await removeNovelTasks(tx, novelId);
    const cleanup: StoredAssetCleanup[] = await detachNovelIndex(tx, novelId);
    const covers = await tx.imageAsset.findMany({
      where: {sceneType: "novel_cover", OR: [{novelId}, {novelId: null, task: {novelId}}]},
      select: {taskId: true, metadata: true, url: true},
    });
    for (const asset of covers) {
      const cover = locateStoredNovelCover(novelId, asset);
      if (cover) cleanup.push({cover});
    }
    await tx.novelSideEffectJob.updateMany({where: {novelId, jobType: STORED_ASSET_CLEANUP, status: "reserved"},
      data: {novelId: null, status: "pending", runAfter: new Date()},
    });
    if (cleanup.length) await queueStoredAssetCleanup(tx, cleanup);
    await tx.novel.delete({where: {id: novelId}});
    await tx.timelineCheckReport.deleteMany({where});
    await tx.timelineConstraint.deleteMany({where});
    await tx.timelineHook.deleteMany({where});
    await tx.chapterTimeAnchor.deleteMany({where});
    await tx.storyTimelineEvent.deleteMany({where});
    return executionKeys;
  }, {timeout: 30_000});
  cancelTaskExecutions(`novel:${novelId}`);
  for (const key of executionKeys) cancelTaskExecutions(key);
}
