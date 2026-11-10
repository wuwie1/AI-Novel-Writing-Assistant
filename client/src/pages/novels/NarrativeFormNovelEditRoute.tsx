import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router-dom";
import { getNovelDetail } from "@/api/novel";
import { queryKeys } from "@/api/queryKeys";
import NovelEdit from "./NovelEdit";

export default function NarrativeFormNovelEditRoute() {
  const novelId = useParams<{ id: string }>().id ?? "";
  const query = useQuery({
    queryKey: queryKeys.novels.detail(novelId),
    queryFn: () => getNovelDetail(novelId),
    enabled: Boolean(novelId),
  });
  if (query.isLoading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">正在打开作品…</div>;
  }
  if (query.data?.data?.narrativeForm === "short_story") {
    return <Navigate to={`/novels/${novelId}/story`} replace />;
  }
  return <NovelEdit key={novelId}/>;
}
