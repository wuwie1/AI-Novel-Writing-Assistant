import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { getTaskDetail, listTasks } from "@/api/tasks";
import { ACTIVE_STATUSES } from "@/pages/tasks";
import { EntityList, useRouteFields } from "@/platform";
import { readTaskStatus } from "./filters";
import { readKind, RecordList, RecordTools } from "./RecordList";
import { RecordDetail } from "./RecordDetail";

export default function MacTaskRecords() {
  const [params, update] = useRouteFields();
  const status = readTaskStatus(params);
  const keyword = params.get("q") || "";
  const cursor = params.get("cursor") || undefined;
  const filterKind = readKind(params.get("filterKind"));
  const kind = readKind(params.get("kind"));
  const id = params.get("id");
  const selection = kind && id ? kind + ":" + id : null;
  useEffect(() => {
    if (!selection && (params.has("kind") || params.has("id"))) update({ kind: null, id: null }, true);
  }, [params, selection, update]);
  const list = useQuery({
    queryKey: ["mac-records", status, filterKind, keyword, cursor],
    queryFn: () => listTasks({ status: status || undefined, kind: filterKind, keyword: keyword || undefined, cursor, limit: 60 }),
    refetchInterval: (q) => q.state.data?.data?.items.some((row) => ACTIVE_STATUSES.has(row.status)) ? 4000 : false,
  });
  const detail = useQuery({
    queryKey: ["mac-record", kind, id], enabled: !!selection,
    queryFn: () => getTaskDetail(kind!, id!),
    refetchInterval: (q) => q.state.data?.data && ACTIVE_STATUSES.has(q.state.data.data.status) ? 4000 : false,
  });
  const items = list.data?.data?.items ?? [];
  return <div className="mac-page mac-records">
    <header className="mac-page-heading"><h1>运行记录</h1><button className="mac-icon-button" aria-label="刷新记录" onClick={() => { void list.refetch(); if (selection) void detail.refetch(); }}><RefreshCw size={15}/></button></header>
    <EntityList collection="tasks" title="运行记录" selection={selection} tools={<RecordTools keyword={keyword} kind={filterKind} status={status} change={(key, value) => update({ [key]: value, cursor: null }, true)}/>}>
      {list.isPending ? <p role="status">正在读取运行记录…</p> : list.isError ? <p role="alert">记录读取失败。<button onClick={() => void list.refetch()}>重新读取</button></p> : !items.length ? <p>{keyword || status || filterKind ? "没有符合筛选条件的记录。" : "还没有运行记录。"}</p> : <RecordList rows={items} selection={selection} select={(row) => update({ kind: row.kind, id: row.id })}/>}
      <div className="mac-record-paging">{cursor && <button onClick={() => update({ cursor: null })}>回到最新</button>}{list.data?.data?.nextCursor && <button onClick={() => update({ cursor: list.data.data!.nextCursor! })}>更早记录</button>}</div>
    </EntityList>
    <section className="mac-record-detail" aria-label="记录详情">{!selection ? <p>选择一条记录查看详情。</p> : detail.isPending ? <p role="status">正在读取详情…</p> : detail.isError ? <p role="alert">详情读取失败。<button onClick={() => void detail.refetch()}>重新读取</button></p> : detail.data?.data ? <RecordDetail item={detail.data.data}/> : <p>找不到这条记录。<button onClick={() => update({ kind: null, id: null }, true)}>返回列表</button></p>}</section>
  </div>;
}
