/**
 * Small list helpers that more than one file of the tasks domain, and the
 * controller daemon beside it, use.
 */

/** Returns the values without repeats, in the order they first appear. */
export const removeDuplicates = <A>(values: Iterable<A>): ReadonlyArray<A> => [...new Set(values)];

/** Groups the items by their Task id, keeping their order within each group. */
export const groupByTask = <Item extends { readonly taskId: string }>(
  items: ReadonlyArray<Item>,
): ReadonlyMap<string, ReadonlyArray<Item>> => {
  const byTask = new Map<string, Array<Item>>();
  for (const item of items) {
    const group = byTask.get(item.taskId);
    if (group === undefined) byTask.set(item.taskId, [item]);
    else group.push(item);
  }
  return byTask;
};
