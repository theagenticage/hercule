/**
 * The words of the details pane's "where it stands": the summary's text and
 * the quiet line under it that says how old it is, or why there is none.
 */
import type { TaskSummary, TextGenerationStatus } from "@hercule/contract";
import { describeAge } from "../threads/age";

/** What the pane shows for where a Task stands. */
export interface SummaryStanding {
  /** The text of "where it stands", or `null` when there is none to show. */
  readonly standing: string | null;
  /** The quiet line under it. */
  readonly note: string;
  /** True when the note is about Text Generation, so the pane links it to that setting. */
  readonly linksToTextGeneration: boolean;
}

/**
 * Describes where a Task stands from its `summary`, as of `now`.
 *
 * - A summary: its standing text, and the note "Written 12 minutes ago", with
 *   " · newer work since" when the summary is stale.
 * - No summary, and Text Generation can run: the note "Writing a summary".
 * - No summary, and Text Generation is off or cannot run
 *   (`textGeneration.unavailableReason` is set): the note "Summaries are
 *   off", linked to the setting.
 * - A stale summary while Text Generation is off or cannot run: the note
 *   gains " · summaries are off", linked to the setting, because it will not
 *   catch up until the user turns Text Generation on.
 *
 * The note is never an error: a stale or missing summary is quiet.
 */
export const describeSummaryStanding = (
  summary: TaskSummary | undefined,
  now: Date,
  textGeneration: Pick<TextGenerationStatus, "unavailableReason">,
): SummaryStanding => {
  const off = textGeneration.unavailableReason !== null;
  if (summary === undefined) {
    return {
      standing: null,
      note: off ? "Summaries are off" : "Writing a summary",
      linksToTextGeneration: off,
    };
  }
  const written = `Written ${describeAge(summary.generatedAt, now)}`;
  const standing = summary.standing.trim() === "" ? null : summary.standing;
  if (!summary.stale) return { standing, note: written, linksToTextGeneration: false };
  return {
    standing,
    note: `${written} · newer work since${off ? " · summaries are off" : ""}`,
    linksToTextGeneration: off,
  };
};
