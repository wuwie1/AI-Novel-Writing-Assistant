import { EntityList, DirectoryRows, useRouteFields, useDirectorySelection } from "@/platform";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Trash2 } from "lucide-react";
import { type TitleLibraryListParams, buildTitleLibraryListKey, deleteTitleLibraryEntry, listTitleLibrary, markTitleLibraryUsed } from "@/api/title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { queryKeys } from "@/api/queryKeys";
import { toast } from "@/components/ui/toast";
import { truncateText } from "../titleStudio.shared";
import SelectControl from "@/components/common/SelectControl";

interface TitleLibraryPanelProps {
  genreOptions: Array<{ id: string; label: string; path: string }>;
}

const controlClassName = "h-11 rounded-lg border-0 bg-muted/35 ring-1 ring-transparent transition hover:bg-muted/50 focus-visible:ring-primary/25";
const selectClassName = "w-full rounded-lg border-0 bg-muted/35 px-3 py-2.5 text-sm outline-none ring-1 ring-transparent transition hover:bg-muted/50 focus:bg-background focus:ring-2 focus:ring-primary/25";

export default function TitleLibraryPanel({ genreOptions }: TitleLibraryPanelProps) {
  const queryClient = useQueryClient();
  const [route, update] = useRouteFields();
  const search = route.get("q") ?? "";
  const genreId = route.get("genreId") ?? "";
  const order = route.get("sort");
  const sort = order === "hot" || order === "clickRate" ? order : "newest";
  const page = Math.max(1, Number.parseInt(route.get("page") ?? "1", 10) || 1);
  const filter = (field: string, value: string) => update({[field]: value, page: null}, true);
  const listParams = useMemo<TitleLibraryListParams>(
    () => ({
      page,
      pageSize: 18,
      search,
      genreId,
      sort,
    }),
    [genreId, page, search, sort],
  );
  const listKey = useMemo(() => buildTitleLibraryListKey(listParams), [listParams]);

  const libraryQuery = useQuery({
    queryKey: queryKeys.titles.list(listKey),
    queryFn: () => listTitleLibrary(listParams),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTitleLibraryEntry(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.titles.all });
      toast.success("标题已删除。");
    },
  });

  const markUsedMutation = useMutation({
    mutationFn: (id: string) => markTitleLibraryUsed(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.titles.all });
      toast.success("标题使用次数已更新。");
    },
  });

  const handleCopy = async (title: string) => {
    await navigator.clipboard.writeText(title);
    toast.success("标题已复制到剪贴板。");
  };

  const rows = libraryQuery.data?.data?.items ?? [];
  const pagination = libraryQuery.data?.data;

  const directory = useDirectorySelection("titleId", rows);
  const tools = (
      <div className="grid gap-3 rounded-2xl bg-muted/20 p-4 md:grid-cols-[minmax(0,1fr)_220px_180px]">
        <label className="space-y-2 text-sm">
          <span className="font-medium text-foreground">搜索</span>
          <Input
            value={search}
            onChange={(event) => filter("q", event.target.value)}
            placeholder="匹配标题、说明或关键词"
            className={controlClassName}
          />
        </label>
        <label className="space-y-2 text-sm">
          <span className="font-medium text-foreground">类型</span>
          <SelectControl
            className={selectClassName}
            value={genreId}
            onChange={(event) => filter("genreId", event.target.value)}
          >
            <option value="">全部类型</option>
            {genreOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.path}
              </option>
            ))}
          </SelectControl>
        </label>
        <label className="space-y-2 text-sm">
          <span className="font-medium text-foreground">排序</span>
          <SelectControl
            className={selectClassName}
            value={sort}
            onChange={(event) => filter("sort", event.target.value)}
          >
            <option value="newest">最新加入</option>
            <option value="hot">使用次数</option>
            <option value="clickRate">点击潜力</option>
          </SelectControl>
        </label>
      </div>
  );
  const pager = <>      {pagination && pagination.totalPages > 1 ? (
        <div className="flex items-center justify-between border-t border-border/60 pt-4 text-sm">
          <div className="text-muted-foreground">
            第 {pagination.page} / {pagination.totalPages} 页，共 {pagination.total} 条
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => update({page: String(page - 1)})}>
              上一页
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= pagination.totalPages}
              onClick={() => update({page: String(page + 1)})}
            >
              下一页
            </Button>
          </div>
        </div>
      ) : null}</>;
  return (
    <div className="space-y-5">
      <EntityList collection="title-library" title="标题库" selection={directory.selection} inline={tools} tools={tools}>
        {libraryQuery.isLoading ? <p>正在读取标题…</p> : libraryQuery.isError ? <button onClick={() => void libraryQuery.refetch()}>重新读取标题</button>
          : rows.length ? <DirectoryRows {...directory} rows={rows.map(row => ({id: row.id, label: row.title, description: row.genre?.name}))}/> : <p>当前筛选下没有标题。</p>}
        {pager}
      </EntityList>
      {directory.host && directory.selection && !libraryQuery.isFetching && !rows.some(row => row.id === directory.selection) && <p>当前页没有这个标题。 <button onClick={directory.onClear}>返回列表</button></p>}


      {libraryQuery.isLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          正在加载标题库...
        </div>
      ) : null}

      {!libraryQuery.isLoading && rows.length === 0 ? (
        <div className="py-10 text-center">
          <div className="text-sm font-medium text-foreground">标题库还是空的</div>
          <div className="mt-1 text-sm text-muted-foreground">
            先去标题工坊生成一批候选，再把值得复用的标题沉淀进来。
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        {rows.filter(row => directory.includes(row.id)).map((entry) => (
          <article key={entry.id} className="flex min-h-56 flex-col rounded-2xl border border-border/35 bg-card/70 p-5 transition-all hover:border-border/65 hover:shadow-[0_12px_32px_rgba(15,23,42,0.035)]">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <div className="flex flex-wrap gap-x-2 gap-y-1">
                  {entry.genre?.name ? <span>{entry.genre.name}</span> : null}
                  <span>使用 {entry.usedCount}</span>
                  <span>{new Date(entry.createdAt).toLocaleDateString("zh-CN")}</span>
                  </div>
                  <span className="rounded-full bg-muted/60 px-2.5 py-1 font-medium tabular-nums text-foreground">
                    潜力 {typeof entry.clickRate === "number" ? entry.clickRate : "-"}
                  </span>
                </div>
                <div className="pt-2 text-xl font-semibold leading-8 tracking-normal text-foreground">{entry.title}</div>
                {entry.description ? (
                  <div className="line-clamp-3 text-sm leading-6 text-muted-foreground">
                    {truncateText(entry.description, 180)}
                  </div>
                ) : null}
                {entry.keywords ? (
                  <div className="line-clamp-2 text-xs leading-5 text-muted-foreground">{truncateText(entry.keywords, 140)}</div>
                ) : null}
              </div>

              <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
                <Button type="button" size="sm" className="gap-1.5 rounded-full" onClick={() => void handleCopy(entry.title)}>
                  <Copy className="h-3.5 w-3.5" />
                  复制
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="gap-1.5 rounded-full"
                  disabled={markUsedMutation.isPending && markUsedMutation.variables === entry.id}
                  onClick={() => markUsedMutation.mutate(entry.id)}
                >
                  <Check className="h-3.5 w-3.5" />
                  {markUsedMutation.isPending && markUsedMutation.variables === entry.id ? "更新中" : "采用"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="gap-1.5 rounded-full text-muted-foreground hover:text-destructive"
                  disabled={deleteMutation.isPending && deleteMutation.variables === entry.id}
                  onClick={() => {
                    const confirmed = window.confirm(`确认删除标题「${entry.title}」？`);
                    if (confirmed) {
                      deleteMutation.mutate(entry.id);
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {deleteMutation.isPending && deleteMutation.variables === entry.id ? "删除中" : "删除"}
                </Button>
              </div>
          </article>
        ))}
      </div>

      {!directory.host && pager}
    </div>
  );
}
