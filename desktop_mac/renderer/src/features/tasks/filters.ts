import type { TaskStatus } from "@ai-novel/shared/types/task";

export const taskStatusOptions: Array<[TaskStatus | "", string]> = [["", "全部状态"], ["running", "进行中"], ["queued", "排队中"], ["waiting_approval", "待确认"], ["succeeded", "已完成"], ["failed", "未完成"], ["cancelled", "已取消"]];

export function readTaskStatus(params: URLSearchParams): TaskStatus | "" {
  return taskStatusOptions.find(([value]) => value === params.get("status"))?.[0] ?? "";
}
