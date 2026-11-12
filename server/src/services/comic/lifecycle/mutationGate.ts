import { AppError } from "../../../middleware/errorHandler";

// Single API process: keep the gate until the handler settles, even if the client disconnects.
let mutations = 0;
let deleting = false;

export async function withComicMutation<T>(operation: () => Promise<T>): Promise<T> {
  if (deleting) throw new AppError("漫画项目正在删除，请稍后重试。", 409);
  mutations++;
  try { return await operation(); } finally { mutations--; }
}

export async function withComicDeletion<T>(operation: () => Promise<T>): Promise<T> {
  if (deleting || mutations > 0) {
    throw new AppError("漫画工作台有操作正在进行，请等待完成后再删除项目。", 409);
  }
  deleting = true;
  try { return await operation(); } finally { deleting = false; }
}
