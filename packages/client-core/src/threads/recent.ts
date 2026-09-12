/**
 * The last three (instance, model) pairs the user picked, newest first. Held
 * by the client: nothing on the API carries it, and the model menu only needs
 * to know what was reached for last.
 */
export interface RecentModel {
  readonly instanceId: string;
  readonly model: string;
}

const LIMIT = 3;

export const pushRecent = (
  recent: readonly RecentModel[],
  pair: RecentModel,
): readonly RecentModel[] =>
  [
    pair,
    ...recent.filter((each) => each.instanceId !== pair.instanceId || each.model !== pair.model),
  ].slice(0, LIMIT);
