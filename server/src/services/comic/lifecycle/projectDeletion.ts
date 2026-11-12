import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../db/prisma";
import { AppError } from "../../../middleware/errorHandler";
import { resolveGeneratedImagesRoot } from "../../../runtime/appPaths";
import { withComicDeletion } from "./mutationGate";

const include = {
  sourceBundle: true, characters: true, characterAssets: true, scenes: true,
  episodes: { include: { panels: true } }, facts: true, uploadAssets: true,
  exportJobs: true, batchJobs: true,
} satisfies Prisma.ComicProjectInclude;
type Snapshot = Prisma.ComicProjectGetPayload<{ include: typeof include }>;

function isGenerating(raw: string | null): boolean {
  if (!raw) return false;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return record.status === "generating" || Object.values(record).some(visit);
  };
  try { return visit(JSON.parse(raw)); } catch {
    throw new AppError("项目图片状态无法确认，请检查项目后再删除。", 409);
  }
}

function assertIdle(project: Snapshot) {
  const active = new Set(["pending", "queued", "running", "processing"]);
  const imageStates = [
    ...project.characters.map(row => row.sheetData),
    ...project.characterAssets.map(row => row.imageData),
    ...project.scenes.map(row => row.sheetData),
    ...project.episodes.flatMap(row => row.panels.flatMap(panel => [panel.imageData, panel.letteredData])),
  ];
  if ([...project.batchJobs, ...project.exportJobs].some(row => active.has(row.status))
      || imageStates.some(isGenerating)) {
    throw new AppError("此漫画项目有生成或导出任务正在进行，请等待完成后再删除。", 409);
  }
}

function ownedDirectories(project: Snapshot): string[] {
  const entries: [string, string][] = [
    ...project.characters.map(row => ["comic-characters", row.id] as [string, string]),
    ...project.characterAssets.map(row => ["comic-character-assets", row.id] as [string, string]),
    ...project.scenes.map(row => ["comic-scenes", row.id] as [string, string]),
    ...project.episodes.flatMap(row => row.panels.flatMap(panel => [
      ["comic-panels", panel.id] as [string, string],
      ["comic-panels-lettered", panel.id] as [string, string],
    ])),
    ...project.exportJobs.map(row => ["comic-exports", row.id] as [string, string]),
  ];
  return entries.map(([directory, id]) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new AppError("项目文件标识无效，无法安全删除。", 409);
    return path.join(directory, id);
  });
}

async function fingerprint(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw new Error("漫画文件中存在符号链接，无法安全删除。");
  if (stat.isDirectory()) {
    const names = (await fs.readdir(file)).sort();
    return JSON.stringify(await Promise.all(names.map(async name => [name, await fingerprint(path.join(file, name))])));
  }
  if (!stat.isFile()) throw new Error("漫画目录中存在不支持的文件类型。");
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function deleteIdleProject(projectId: string): Promise<void> {
  const project = await prisma.comicProject.findUnique({ where: { id: projectId }, include });
  if (!project) return; // A repeated confirmed delete is safe.
  assertIdle(project);
  const root = resolveGeneratedImagesRoot();
  const directories = ownedDirectories(project);
  // Upload records currently have no writer. Never trust an arbitrary stored filePath.
  for (const upload of project.uploadAssets) {
    const file = path.resolve(root, upload.filePath);
    if (!directories.some(directory => file.startsWith(path.join(root, directory) + path.sep))) {
      throw new AppError("项目包含无法确认归属的上传文件，请检查后再删除。", 409);
    }
  }
  const backup = path.join(path.dirname(root), "comic-project-backups", randomUUID());
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  const snapshot = JSON.stringify(project);
  const snapshotFile = path.join(backup, "project.json");
  await fs.writeFile(snapshotFile, snapshot, { mode: 0o600 });
  if (await fs.readFile(snapshotFile, "utf8") !== snapshot) throw new Error("漫画项目备份验证失败。");

  const files: string[] = [];
  for (const directory of directories) {
    const source = path.join(root, directory);
    // Reject symlinks in the collection directory as well as within the asset tree.
    try {
      if ((await fs.lstat(path.dirname(source))).isSymbolicLink()) throw new Error("漫画资产目录不允许符号链接。");
      await fs.lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const before = await fingerprint(source);
    const target = path.join(backup, "files", directory);
    await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
    if (before !== await fingerprint(target)) throw new Error("漫画图片备份验证失败。");
    files.push(directory);
  }
  await fs.writeFile(path.join(backup, "manifest.json"), JSON.stringify({ projectId, files, verified: true }));
  console.info(`[comic.delete] verified backup: ${backup}`);

  try {
    for (const directory of files) await fs.rm(path.join(root, directory), { recursive: true });
    // FK cascades cover all owned rows; sourceRef is deliberately not followed.
    await prisma.comicProject.delete({ where: { id: projectId } });
  } catch (error) {
    // Keep the project usable if cleanup or the database delete fails; preserve the backup too.
    for (const directory of files) {
      await fs.cp(path.join(backup, "files", directory), path.join(root, directory), { recursive: true });
    }
    throw error;
  }
}

export async function deleteComicProjectWithBackup(projectId: string): Promise<void> {
  return withComicDeletion(() => deleteIdleProject(projectId));
}
