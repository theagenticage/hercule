/**
 * How a screen shows a reference to a runner, such as the controller's
 * default runner. The reference is an id, and a screen shows the runner's
 * name instead. The rule lives here with a test rather than inside the
 * component that shows it.
 */
import type { Runner } from "@hercule/contract";
import { toIdTail } from "./id-tail";

/**
 * Returns the label for the runner `id`:
 *
 * - its name, when a runner in `runners` has that id;
 * - the tail of the id, when none does, because the list may not hold every
 *   runner and the tail can still be typed at the command line;
 * - "None", when `id` is `null`, because no runner is set.
 */
export const formatRunnerLabel = (
  id: string | null,
  runners: ReadonlyArray<Pick<Runner, "id" | "name">>,
): string =>
  id === null ? "None" : (runners.find((runner) => runner.id === id)?.name ?? toIdTail(id));
