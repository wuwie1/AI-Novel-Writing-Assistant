import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveGeneratedImagesRoot } from "../../../../runtime/appPaths";

/** Deployment controls observers only. This must never cancel a model call or mutate a task. */
export async function isObservationDraining(
  file = path.join(path.dirname(resolveGeneratedImagesRoot()), ".llm-live-drain.json"),
  now = Date.now(),
): Promise<boolean> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const lease = JSON.parse(raw) as { version?: unknown; expiresAt?: unknown };
    return lease.version === 1 && typeof lease.expiresAt === "number"
      && Number.isFinite(lease.expiresAt) && lease.expiresAt > now;
  } catch { return false; }
}
