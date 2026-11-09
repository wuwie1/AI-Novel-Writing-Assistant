import type { KeyboardEvent } from "react";

/** Arrow keys move between view links; Enter opens the focused route. */
export function moveWorkspaceFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
  if (!(event.target instanceof HTMLElement) || !event.target.matches('a[href],button[role="tab"]')) return;
  const group = event.target.closest('nav.mac-view-links,nav[data-workspace-navigation],[role="tablist"]');
  if (!group) return;
  const items = Array.from(group.querySelectorAll<HTMLElement>('a[href],button[role="tab"]:not(:disabled)'));
  const index = items.indexOf(event.target);
  if (index < 0) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next].focus();
  if (items[next].getAttribute("role") === "tab") items[next].click();
}
