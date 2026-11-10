import {ragConfig} from "../../../config/rag";

export interface StoredPointBatch {
  collection: string;
  points: string[];
}

export function groupStoredPoints(chunks: Iterable<{id: string; metadataJson: string | null}>): StoredPointBatch[] {
  const groups = new Map<string, Set<string>>();
  for (const chunk of chunks) {
    let collection = ragConfig.qdrantCollection;
    try {
      const saved = JSON.parse(chunk.metadataJson ?? "{}")?.vectorCollection;
      if (typeof saved === "string" && saved) collection = saved;
    } catch {
      // Older chunks may have no readable storage metadata.
    }
    const ids = groups.get(collection) ?? new Set<string>();
    ids.add(chunk.id);
    groups.set(collection, ids);
  }
  const batches: StoredPointBatch[] = [];
  for (const [collection, ids] of groups) {
    const points = [...ids];
    for (let i = 0; i < points.length; i += 400) {
      batches.push({collection, points: points.slice(i, i + 400)});
    }
  }
  return batches;
}
