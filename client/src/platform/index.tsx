import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface DocumentGuard {
  label: string;
  dirty: boolean;
  busy?: boolean;
  /** Host explicitly asks the user to verify forms without a complete dirty contract. */
  manualReview?: boolean;
  save?: () => Promise<unknown>;
  discard?: () => void;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ClientPlatform {
  draftStorage?: DraftStorage;
  registerDocument?: (id: string, read: () => DocumentGuard) => () => void;
  editorTypography?: { storageKey: string; fontSize: number; lineHeight: number; fontSizes: number[]; lineHeights: number[] };
}

const Context = createContext<ClientPlatform>({});

/** Optional host capabilities. The web host keeps its existing behavior. */
export function ClientPlatformProvider({ value, children }: { value: ClientPlatform; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useClientPlatform(): ClientPlatform {
  return useContext(Context);
}

export function useDocumentGuard(guard: DocumentGuard): void {
  const platform = useClientPlatform();
  const id = useId();
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(() => platform.registerDocument?.(id, () => latest.current), [platform, id]);
}

/** Only alternate hosts persist scratch forms; Web retains ordinary local React state. */
export function useHostDraftState<T>(key: string, initial: T | (() => T)) {
  const { draftStorage } = useClientPlatform();
  const [fallback] = useState(initial);
  const [value, setValue] = useState<T>(() => {
    if (draftStorage) {
      try { const raw = draftStorage.getItem(key); if (raw) return JSON.parse(raw) as T; } catch { /* Use a new scratch draft if storage is unavailable. */ }
    }
    return fallback;
  });
  const [baseline, setBaseline] = useState(() => JSON.stringify(value));
  const clear = () => { draftStorage?.removeItem(key); setBaseline(JSON.stringify(value)); };
  return [value, setValue, {
    dirty: !!draftStorage && baseline !== JSON.stringify(value),
    save: async () => { draftStorage?.setItem(key, JSON.stringify(value)); setBaseline(JSON.stringify(value)); },
    discard: () => { draftStorage?.removeItem(key); setValue(fallback); setBaseline(JSON.stringify(fallback)); },
    clear,
  }] as const;
}
