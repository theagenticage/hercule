import type { SignalAnswer } from "@hercule/client-core";

/**
 * Returns the key Intake's pane shows beside an answer: `↩` for the suggested
 * answer, `R` for one that opens a reply, `E` for Done, and `null` for the
 * rest.
 */
export const readAnswerKey = (answer: SignalAnswer): string | null => {
  if (answer.suggested) return "↩";
  if (answer.style === "reply") return "R";
  return answer.style === "done" ? "E" : null;
};
