import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/** Change only fields owned by the current view. Selections can be revisited with Back. */
export function useRouteFields() {
  const [params, setParams] = useSearchParams();
  const update = useCallback((fields: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(fields)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (next.toString() !== params.toString()) setParams(next, { replace, preventScrollReset: true });
  }, [params, setParams]);
  return [params, update] as const;
}
