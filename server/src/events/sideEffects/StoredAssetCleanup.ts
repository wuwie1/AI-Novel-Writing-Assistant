import type {Prisma} from "@prisma/client";
import {randomUUID} from "node:crypto";
import type {StoredNovelCover} from "../../services/image/imageAssetStorage";
import {ragConfig} from "../../config/rag";

export type StoredAssetCleanup = {points: string[]; collection?: string} | {cover: StoredNovelCover};
type CleanupStore = Pick<Prisma.TransactionClient, "novelSideEffectJob">;
export const STORED_ASSET_CLEANUP = "novel.removeStoredAsset";

function serializeLocation(item: StoredAssetCleanup): string {
  return JSON.stringify("points" in item ? {...item, collection: item.collection ?? ragConfig.qdrantCollection} : item);
}

export function queueStoredAssetCleanup(db: CleanupStore, items: StoredAssetCleanup[]) {
  return db.novelSideEffectJob.createMany({data: items.map(item => ({
    jobType: STORED_ASSET_CLEANUP, idempotencyKey: randomUUID(), payloadJson: serializeLocation(item),
  }))});
}

// The FK prevents starting a write after deletion. The manifest remains attached
// until the asset's metadata is committed, even if the publisher crashes.
export async function reserveStoredAsset(db: CleanupStore, novelId: string, item: StoredAssetCleanup): Promise<string> {
  const {id} = await db.novelSideEffectJob.create({data: {
    novelId, status: "reserved", jobType: STORED_ASSET_CLEANUP, idempotencyKey: randomUUID(),
    payloadJson: serializeLocation(item),
  }, select: {id: true}});
  return id;
}

export async function publishStoredAssets(db: CleanupStore, reservations: string[]): Promise<void> {
  if (!reservations.length) return;
  const result = await db.novelSideEffectJob.deleteMany({where: {id: {in: reservations}, status: "reserved"}});
  if (result.count !== reservations.length) throw new Error("作品已删除，存储写入已撤销。");
}
