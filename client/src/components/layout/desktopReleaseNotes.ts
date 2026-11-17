import { APP_VERSION } from "@/lib/constants";
import releaseNotes from "../../../../docs/releases/release-notes.md?raw";

export interface DesktopReleaseNotes {
  version: string;
  title: string;
  summary: string;
  items: string[];
}

/**
 * In-app desktop update popup. Bound to the current package version via APP_VERSION
 * (from desktop/package.json at build time) and the matching
 * date block in docs/releases/release-notes.md. Dates remain the primary update
 * identifier; upstream desktop versions may appear in the block's description.
 */
function currentRelease(markdown: string): DesktopReleaseNotes {
  const version = APP_VERSION;
  const blocks = markdown.split(/^###\s+\d{4}-\d{2}-\d{2}[^\n]*\n/gm).slice(1);
  const versionPattern = new RegExp(`(^|[^\\d])v?${version.replaceAll(".", "\\.")}([^\\d]|$)`);
  const block = blocks.find(item => versionPattern.test(item)) ?? blocks[0];
  if (!block) return { version, title: "本次更新介绍", summary: "查看完整更新说明。", items: [] };
  const content = block.split(/\r?\n/).map(line => line.trim());
  const summary = content.find(line => line && !line.startsWith("#") && !line.startsWith("-")) ?? "查看完整更新说明。";
  const items = content.filter(line => line.startsWith("- ")).map(line => line.slice(2));
  return { version, title: "本次更新介绍", summary, items };
}

export const CURRENT_DESKTOP_RELEASE_NOTES: DesktopReleaseNotes = currentRelease(releaseNotes);
