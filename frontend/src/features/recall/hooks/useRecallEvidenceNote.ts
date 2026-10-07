import { createContext, useContext } from "react";

/**
 * Text shown before the selected day's coverage summary (null for none). The app root provides
 * one when the recordings are synthetic (the demo build).
 */
export const RecallEvidenceNoteContext = createContext<string | null>(null);

export function useRecallEvidenceNote(): string | null {
  return useContext(RecallEvidenceNoteContext);
}
