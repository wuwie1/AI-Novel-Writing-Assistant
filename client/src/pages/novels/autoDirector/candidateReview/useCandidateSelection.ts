import { useRef, useState } from "react";
import type { DirectorCandidateBatch } from "@ai-novel/shared/types/novelDirector";
import { candidateAnchor } from "./candidateScope";

export function useCandidateSelection(batches: DirectorCandidateBatch[], route?: { id: string | null; select: (id: string) => void }) {
  const [selectedKey, setSelectedKey] = useState("");
  const pendingAnchor = useRef("");
  const options = batches.flatMap(batch => batch.candidates.map((candidate, index) => ({
    id: JSON.stringify([batch.id, candidate.id]),
    key: candidateAnchor(batch.id, candidate.id),
    batch,
    candidate,
    number: index + 1,
  })));
  const active = options.find(option => route ? option.id === route.id : option.key === selectedKey) ?? options[0];
  function select(key: string) {
    pendingAnchor.current = key;
    const option = options.find(item => item.key === key);
    if (route && option) route.select(option.id);
    else setSelectedKey(key);
  }
  return { options, active, select, pendingAnchor };
}

export type CandidateSelection = ReturnType<typeof useCandidateSelection>;
