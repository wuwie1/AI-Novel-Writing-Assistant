import {lockNovelRow} from "../../../modules/novel/persistence";
import type {Prisma, RagOwnerType} from "@prisma/client";
import {groupStoredPoints} from "./storedPoints";

// Jobs are keyed by source, including jobs that have not produced a chunk yet.
// Chapter summary jobs use the chapter ID for their owner, not the summary ID.
export async function detachNovelIndex(tx: Prisma.TransactionClient, novelId: string) {
  const select = {id: true} as const;
  const where = {novelId};
  const [chapters, characters, facts, timelines, chunks] = await Promise.all([
    tx.chapter.findMany({where, select}), tx.character.findMany({where, select}),
    tx.consistencyFact.findMany({where, select}), tx.characterTimeline.findMany({where, select}),
    tx.knowledgeChunk.findMany({where, select: {id: true, metadataJson: true, ownerType: true, ownerId: true}}),
  ]);
  const owners = new Map<RagOwnerType, Set<string>>();
  function add(type: RagOwnerType, id: string) {
    const group = owners.get(type) ?? new Set<string>();
    group.add(id);
    owners.set(type, group);
  }
  add("novel", novelId);
  add("bible", novelId);
  for (const {id} of chapters) { add("chapter", id); add("chapter_summary", id); }
  for (const {id} of characters) add("character", id);
  for (const {id} of facts) add("consistency_fact", id);
  for (const {id} of timelines) add("character_timeline", id);
  // Only book-owned kinds may expand the deletion scope to other rows for that owner.
  const bookSources: RagOwnerType[] = ["novel", "bible", "chapter", "chapter_summary", "character", "consistency_fact", "character_timeline"];
  for (const chunk of chunks) {
    if (bookSources.includes(chunk.ownerType)) add(chunk.ownerType, chunk.ownerId);
  }

  const storedChunks = new Map<string, {id: string; metadataJson: string | null}>(chunks.map(chunk => [chunk.id, chunk]));
  for (const [ownerType, ids] of owners) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 400) {
      const source = {ownerType, ownerId: {in: list.slice(i, i + 400)}};
      // Include previously queued, running and historical indexing jobs for this source.
      await tx.ragIndexJob.deleteMany({where: source});
      const legacy = await tx.knowledgeChunk.findMany({where: source, select: {id: true, metadataJson: true}});
      for (const chunk of legacy) storedChunks.set(chunk.id, chunk);
      await tx.knowledgeChunk.deleteMany({where: source});
    }
  }
  await tx.knowledgeChunk.deleteMany({where});
  await tx.ragRetrievalTrace.deleteMany({where});
  await tx.knowledgeBinding.deleteMany({where: {targetType: "novel", targetId: novelId}});
  return groupStoredPoints(storedChunks.values());
}

// A source event can arrive after the user deletes its book. Serialize the enqueue
// with deletion; explicit owner-delete jobs may still clean up a vanished source.
export async function lockIndexSource(tx: Prisma.TransactionClient, type: RagOwnerType, ownerId: string) {
  const where = {id: ownerId};
  const select = {novelId: true} as const;
  let owner: {novelId: string} | null;
  switch (type) {
    case "novel": case "bible": owner = {novelId: ownerId}; break;
    case "chapter": case "chapter_summary": owner = await tx.chapter.findUnique({where, select}); break;
    case "character": owner = await tx.character.findUnique({where, select}); break;
    case "consistency_fact": owner = await tx.consistencyFact.findUnique({where, select}); break;
    case "character_timeline": owner = await tx.characterTimeline.findUnique({where, select}); break;
    default: return;
  }
  if (!owner) throw new Error("索引来源已删除。");
  await lockNovelRow(tx, owner.novelId);
}
