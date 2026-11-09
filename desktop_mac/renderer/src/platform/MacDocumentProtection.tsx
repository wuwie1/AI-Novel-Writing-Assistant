import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ClientPlatformProvider, type ClientPlatform, type DocumentGuard } from "@/platform";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { macEnvironment, postNative, type MacMessage } from "./native";

/** Explicit document contracts; never inspect DOM text to infer saved state. */
export function MacDocumentProtection({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const guards = useRef(new Map<string, () => DocumentGuard>());
  const answer = useRef<((allowed: boolean) => void) | null>(null);
  const [prompt, setPrompt] = useState<DocumentGuard[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const active = useCallback(() => [...guards.current.values()].map((read) => read()).filter((item) => item.dirty || item.busy), []);
  const platform = useMemo<ClientPlatform>(() => {
    const prefix = `mac:${macEnvironment()?.backendIdentity ?? macEnvironment()?.mode ?? "unknown"}:`;
    return {
      editorTypography: { storageKey: "ai-novel.mac.editor.typography", fontSize: 20, lineHeight: 1.6, fontSizes: [16,18,20,22,24], lineHeights: [1.4,1.6,1.8,2] },
      draftStorage: {
        getItem: (key) => localStorage.getItem(prefix + key),
        setItem: (key, value) => localStorage.setItem(prefix + key, value),
        removeItem: (key) => localStorage.removeItem(prefix + key),
      },
      registerDocument: (id, read) => {
        guards.current.set(id, read);
        return () => { guards.current.delete(id); };
      },
    };
  }, []);
  const finish = useCallback((allowed: boolean) => {
    const resolve = answer.current;
    answer.current = null;
    setPrompt(null);
    setError("");
    resolve?.(allowed);
  }, []);
  const confirmLeave = useCallback(async () => {
    // Let a successful mutation publish its saved state before judging its navigation.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const documents = active();
    if (!documents.length) return true;
    if (documents.some((item) => item.busy)) {
      toast.info("请等待当前保存或生成操作完成，再离开页面。");
      return false;
    }
    if (answer.current) return false;
    setPrompt(documents);
    setError("");
    return new Promise<boolean>((resolve) => { answer.current = resolve; });
  }, [active]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search) && active().length > 0,
  );
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useEffect(() => {
    const current = blockerRef.current;
    if (current.state !== "blocked") return;
    let live = true;
    void confirmLeave().then((allowed) => {
      if (live) { if (allowed) current.proceed(); else current.reset(); }
    });
    return () => { live = false; };
  }, [blocker.state, confirmLeave]);
  useEffect(() => {
    const onNative = (event: Event) => {
      const message = (event as CustomEvent<MacMessage>).detail;
      if (message?.protocolVersion !== 1) return;
      if (message.type === "requestClose") {
        void confirmLeave().then((allowed) => postNative({ type: "closeDecision", requestId: message.requestId, decision: allowed ? "allow" : "cancel" }));
      } else if (message.type === "windowActivated") {
        // Pull changes made on another device, but never refresh under unsaved local edits.
        if (active().length === 0) void queryClient.refetchQueries({ type: "active", stale: true });
      } else if (message.type === "requestSave") {
        void (async () => {
          const items = active();
          if (items.some((item) => item.busy)) throw new Error("请等待当前操作完成。");
          for (const item of items) if (item.dirty && item.save) await item.save();
        })().catch((failure: unknown) => toast.error(failure instanceof Error ? failure.message : "保存失败，请重试。"));
      }
    };
    window.addEventListener("ai-novel-mac", onNative);
    return () => {
      window.removeEventListener("ai-novel-mac", onNative);
      answer.current?.(false);
      answer.current = null;
    };
  }, [active, confirmLeave, queryClient]);

  async function saveAndLeave() {
    setSaving(true);
    try {
      for (const document of active()) {
        if (!document.save) throw new Error(`请先回到「${document.label}」完成保存。`);
        await document.save();
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (active().length) throw new Error("还有未保存的修改，请检查后再退出。");
      finish(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败，修改仍保留在页面中。");
    } finally { setSaving(false); }
  }

  return <ClientPlatformProvider value={platform}>
    {children}
    <Dialog open={prompt !== null} onOpenChange={(open) => { if (!open && !saving) finish(false); }}>
      <DialogContent aria-describedby="mac-close-description">
        <DialogTitle>保存修改后离开？</DialogTitle>
        <DialogDescription id="mac-close-description">{prompt?.map((item) => item.label).join("、")}有未保存的修改。</DialogDescription>
        {error ? <p role="alert">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={saving} onClick={() => finish(false)}>取消</Button>
          <Button variant="outline" disabled={saving || prompt?.some((item) => !item.discard)} onClick={() => { for (const item of active()) item.discard?.(); finish(true); }}>放弃未保存修改</Button>
          <Button disabled={saving || prompt?.some((item) => !item.save)} onClick={() => void saveAndLeave()}>{saving ? "保存中…" : "保存并离开"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </ClientPlatformProvider>;
}
