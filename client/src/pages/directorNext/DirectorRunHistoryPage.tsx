import { EntityDirectory, useEntityListHost, useRouteFields } from "@/platform";
import {InvocationUsageList} from "@/components/directorNext/usage";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listDirectorRuns, listLegacyDirectorRuns } from "@/api/directorNext";
import { queryKeys } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";
import {directorPollInterval} from "./polling";

export default function DirectorRunHistoryPage() {
  const host = useEntityListHost();
  const [params, update] = useRouteFields();
  const [webAttention, setWebAttention] = useState(false);
  const needsAttention = host ? params.get("attention") === "1" : webAttention;
  const setNeedsAttention = (value:boolean) => host ? update({ attention:value ? "1" : null }, true) : setWebAttention(value);
  const query = useQuery({ queryKey: queryKeys.directorNext.runs(needsAttention,50), queryFn: () => listDirectorRuns({ needsAttention, limit: 50 }), retry: false, refetchInterval: state => directorPollInterval(state.state.error,state.state.errorUpdateCount) });
  const legacy = useQuery({queryKey:["legacyDirectorHistory"],queryFn:listLegacyDirectorRuns,retry:false});
  const current = query.data?.data ?? [];
  const previous = legacy.data?.data ?? [];
  const rows = [...current.map(r => ({ id:"v2:"+r.runId, label:r.headline, description:r.progressLabel, group:"导演运行" })),
    ...(needsAttention ? [] : previous.map(r => ({ id:"v1:"+r.runId, label:r.headline, description:r.statusLabel, group:"历史创作" })))];
  const run = params.get("runId");
  const old = params.get("version") === "v1";
  const controls = <><label><input type="checkbox" checked={needsAttention} onChange={e => setNeedsAttention(e.target.checked)}/> 只看需要处理</label>
    <Button variant="ghost" disabled={query.isFetching} onClick={() => {void query.refetch();void legacy.refetch();}}>刷新记录</Button></>;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap justify-between gap-4 border-b border-border/60 pb-5">
        <div><h1 className="text-2xl font-semibold">导演运行记录</h1><p className="mt-2 text-sm text-muted-foreground">查看创作进度和异常，打开对应小说导演台处理下一步。</p></div>
        <Button asChild variant="outline"><Link to="/lab/director/preview">查看状态预览</Link></Button>
      </header>
      <EntityDirectory collection="director-runs" title="导演运行记录" selection={run ? (old ? "v1:" : "v2:")+run : null}
        rows={rows} tools={controls} pending={query.isPending} error={query.isError && !rows.length} retry={() => void query.refetch()}
        onSelect={id => update({runId:id.slice(3),version:id.startsWith("v1:") ? "v1" : null})} inline={<div>{controls}</div>}/>
      {host && !run && <p>选择一次导演运行查看详情。</p>}
      {legacy.isError && !needsAttention && <p role="alert">历史创作读取失败。<button onClick={() => void legacy.refetch()}>重新读取</button></p>}
      {host && run && !(old ? previous : current).some(r=>r.runId===run) && !query.isFetching && !legacy.isFetching && <p>当前记录未在已读取范围内。<button onClick={() => update({ runId:null,version:null,attention:null },true)}>查看全部记录</button></p>}
      {query.data?.warnings?.length ? <p role="status" className="text-sm text-muted-foreground">有 {query.data.warnings.length} 条创作记录暂时无法读取，其他记录仍可查看。</p> : null}
      {query.isLoading ? <p className="text-sm text-muted-foreground">正在读取运行记录…</p> : query.isError ? <p role="alert" className="text-sm text-destructive">{query.error instanceof Error ? query.error.message : "读取失败，请重新读取。"}</p> : !query.data?.data?.length ? <p className="py-8 text-sm text-muted-foreground">没有符合条件的创作记录。</p> : (
        <ul className="divide-y divide-border/60">{current.filter(r => !host || (!old && r.runId === run)).map((record) => <li key={record.runId} className="flex flex-wrap items-start justify-between gap-4 py-5"><div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">{record.statusLabel} · {record.progressLabel}</p><p className="mt-1 text-sm font-medium">{record.headline}</p>{record.detail ? <p className="mt-2 text-sm text-muted-foreground">{record.detail}</p> : null}<InvocationUsageList runId={record.runId}/></div><Button asChild variant="ghost" size="sm"><Link to={record.directorRoute}>打开小说导演台</Link></Button></li>)}</ul>
      )}
      {(!needsAttention || (host && old)) && previous.some(r => !host || (old && r.runId === run)) ? <section className="border-t border-border/60 pt-5"><h2 className="text-sm font-semibold">历史创作</h2><ul className="divide-y divide-border/50">{previous.filter(r => !host || old && r.runId === run).map(record=><li key={record.runId} className="flex items-center justify-between gap-3 py-4"><div><p className="text-xs text-muted-foreground">{record.statusLabel} · {record.progressLabel}</p><p className="mt-1 text-sm">{record.headline}</p></div><Button asChild variant="ghost" size="sm"><Link to={record.sourceRoute}>打开小说</Link></Button></li>)}</ul></section>:null}
    </div>
  );
}
