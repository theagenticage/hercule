import { MAX_PAGE_LIMIT } from "@hercule/contract";

/** One page of a list, as every list operation returns it. */
interface Page<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly nextCursor?: string;
}

/**
 * Reads a list page by page, passing each page's cursor to the next read,
 * and returns every item in the order the pages hold them. Each read asks for
 * the largest page the controller allows, so a list takes as few requests as
 * it can. Fails when any page's read fails.
 */
export const readEveryPage = async <Item>(
  readPage: (page: { readonly limit: number; readonly cursor?: string }) => Promise<Page<Item>>,
): Promise<ReadonlyArray<Item>> => {
  const items: Item[] = [];
  let cursor: string | undefined;
  do {
    const page = await readPage(
      cursor === undefined ? { limit: MAX_PAGE_LIMIT } : { limit: MAX_PAGE_LIMIT, cursor },
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
};
