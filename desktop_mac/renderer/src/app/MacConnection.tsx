import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { macEnvironment } from "../platform/native";

export function MacConnection({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const lifetime = new AbortController();
    async function probe() {
      const request = new AbortController();
      const abort = () => request.abort();
      lifetime.signal.addEventListener("abort", abort, {once: true});
      const timeout = setTimeout(abort, 5000);
      try {
        if (window.__AI_NOVEL_RUNTIME__?.apiBaseUrl !== "/api" || !macEnvironment()) throw new Error("桌面连接配置缺失，请用 make dev_app 或 make app 启动。");
        const response = await fetch("/api/health", { cache: "no-store", signal: request.signal });
        const body = await response.json();
        if (!response.ok || body?.success !== true || body?.data?.status !== "ok") throw new Error("创作服务暂时无法连接。");
        if (alive) { setReady(true); setDisconnected(false); setError(""); }
      } catch (failure) {
        if (alive) { setDisconnected(true); setError(failure instanceof Error ? failure.message : "连接失败，请重试。"); }
      } finally { clearTimeout(timeout); lifetime.signal.removeEventListener("abort", abort); }
    }
    void probe();
    const timer = setInterval(() => void probe(), 10_000);
    return () => { alive = false; lifetime.abort(); clearInterval(timer); };
  }, [attempt]);
  const mode = macEnvironment()?.mode === "local" ? "本地测试服务" : "服务器";
  if (!ready) return <div className="mac-connection-screen"><h1>连接{mode}</h1><p role="status">{error || "正在准备创作工作台…"}</p><Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>重新检查</Button></div>;
  return <>{children}{disconnected ? <div role="status" className="mac-connection-banner">连接中断，页面内容仍保留。恢复连接后会重新读取状态。</div> : null}</>;
}
