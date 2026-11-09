import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
import { APP_VERSION } from "@/lib/constants";
import { CURRENT_DESKTOP_RELEASE_NOTES } from "@/components/layout/desktopReleaseNotes";

const SEEN_PREFIX = "ai-novel.mac.release-notes.seen.";

function versionLabel(version: string): string {
  const trimmed = version.trim() || "0.0.0";
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export function MacVersionBadge({ onOpenNotes }: { onOpenNotes: () => void }) {
  const label = versionLabel(APP_VERSION === "0.0.0" ? CURRENT_DESKTOP_RELEASE_NOTES.version : APP_VERSION);
  return (
    <button
      type="button"
      className="mac-version-link"
      title="查看本次更新说明"
      aria-label={`当前版本 ${label}，查看更新说明`}
      onClick={onOpenNotes}
    >
      {label}
    </button>
  );
}

export function MacReleaseNotesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useEffect(() => {
    if (CURRENT_DESKTOP_RELEASE_NOTES.version === "0.0.0") return;
    const key = `${SEEN_PREFIX}${CURRENT_DESKTOP_RELEASE_NOTES.version}`;
    if (window.localStorage.getItem(key) === "true") return;
    window.localStorage.setItem(key, "true");
    onOpenChange(true);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AppDialogContent
        className="max-w-xl"
        title={CURRENT_DESKTOP_RELEASE_NOTES.title}
        description={`桌面版 ${versionLabel(CURRENT_DESKTOP_RELEASE_NOTES.version)} 已准备完成。`}
      >
        <div className="space-y-5">
          <div className="flex items-start gap-3 rounded-xl border border-primary/25 bg-primary/10 p-4">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p className="text-sm leading-6 text-foreground">{CURRENT_DESKTOP_RELEASE_NOTES.summary}</p>
          </div>
          <ul className="space-y-3 text-sm leading-6 text-muted-foreground">
            {CURRENT_DESKTOP_RELEASE_NOTES.items.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </AppDialogContent>
    </Dialog>
  );
}
