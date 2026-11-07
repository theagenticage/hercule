import { queryKeys, type LiveQueryKey } from "../live/keys";

/**
 * Returns the query key of the Work board's read. It sits under the Tasks'
 * key, so every `task` push reads the board again (see `buildQueryKeys`) and
 * the board needs no live topic of its own. The controller announces a change
 * to what a card shows, such as a question opening or a run failing, as a
 * `task` change as well, so the board does not follow the `session` topic,
 * which would read it about once a second for every busy agent.
 */
export const buildWorkBoardKey = (): LiveQueryKey => [...queryKeys.tasks(), "board"];
