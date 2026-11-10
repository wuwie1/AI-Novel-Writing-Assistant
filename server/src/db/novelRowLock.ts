import type {Prisma} from "@prisma/client";
import {AppError} from "../middleware/errorHandler";

/** Serialize book deletion and publishers on SQLite/Postgres without touching the editor timestamp. */
export async function lockNovelRow(tx: Prisma.TransactionClient, novelId: string): Promise<void> {
  // Updating the referenced key takes a PostgreSQL lock that also excludes new FK references.
  const matched = await tx.$executeRaw`UPDATE "Novel" SET "id" = "id" WHERE "id" = ${novelId}`;
  if (matched !== 1) throw new AppError("找不到这本小说。", 404);
}
