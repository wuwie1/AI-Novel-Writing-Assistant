import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface EntityCollection {
  collection: string;
  title: string;
  /** Omit for a directory that opens on demand. Null starts a narrow window in the list. */
  selection?: string | null;
}

interface EntityListHost {
  target: HTMLElement | null;
  narrow: boolean;
  register: (collection: EntityCollection) => () => void;
}

export const EntityListContext = createContext<EntityListHost | null>(null);
export const useEntityListHost = () => useContext(EntityListContext);

/** The page owns queries, selection and commands in both presentations. */
export function EntityList({ collection, title, selection, tools, children, inline }: EntityCollection & {
  tools?: ReactNode;
  children: ReactNode;
  inline?: ReactNode;
}) {
  const host = useEntityListHost();
  const register = host?.register;
  useLayoutEffect(() => register?.({ collection, title, selection }), [register, collection, title, selection]);
  if (!host) return <>{inline === undefined ? <>{tools}{children}</> : inline}</>;
  return host.target ? createPortal(<>
    {tools && <div className="mac-collection-tools">{tools}</div>}
    <div className="mac-context-list" aria-label={title}>{children}</div>
  </>, host.target) : null;
}
