import { describe, expect, it } from "vitest";
import { MAX_PAGE_LIMIT } from "@hercule/contract";
import { readEveryPage } from "./read-every-page";

describe("readEveryPage", () => {
  it("follows each page's cursor to the last page, and returns the items in order", async () => {
    const pages: Record<string, { items: string[]; nextCursor?: string }> = {
      first: { items: ["a", "b"], nextCursor: "c2" },
      c2: { items: ["c"], nextCursor: "c3" },
      c3: { items: ["d"] },
    };
    const asked: Array<{ readonly limit: number; readonly cursor?: string }> = [];
    const items = await readEveryPage((page) => {
      asked.push(page);
      return Promise.resolve(pages[page.cursor ?? "first"]!);
    });
    expect(items).toEqual(["a", "b", "c", "d"]);
    expect(asked).toEqual([
      { limit: MAX_PAGE_LIMIT },
      { limit: MAX_PAGE_LIMIT, cursor: "c2" },
      { limit: MAX_PAGE_LIMIT, cursor: "c3" },
    ]);
  });

  it("fails with the error of the first page that fails", async () => {
    const failure = new Error("the controller is down");
    await expect(
      readEveryPage((page) =>
        page.cursor === undefined
          ? Promise.resolve({ items: [1], nextCursor: "next" })
          : Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
  });
});
