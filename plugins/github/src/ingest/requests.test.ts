/**
 * Tests `fetchNewestItems`, which reads a listing GitHub sorts oldest first
 * from its last page backwards.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { TEST_TOKEN } from "../actions/testing";
import { readStubRequestTarget, runAgainstStub, stubGithub, type StubResponse } from "../testing";
import { fetchNewestItems } from "./requests";

const PATH = "/repos/acme/webshop/issues/7/events";

/** Returns the `Link` header GitHub sends with page `page` of `pages`. */
const buildLinkHeader = (page: number, pages: number): string => {
  const url = (target: number) =>
    `<https://api.github.com${PATH}?per_page=2&page=${String(target)}>`;
  return [
    ...(page < pages ? [`${url(page + 1)}; rel="next"`, `${url(pages)}; rel="last"`] : []),
    ...(page > 1 ? [`${url(page - 1)}; rel="prev"`, `${url(1)}; rel="first"`] : []),
  ].join(", ");
};

/**
 * Answers a listing of `count` items with ids 1 to `count`, two a page,
 * oldest first, with GitHub's `Link` header.
 */
const answerListing =
  (count: number) =>
  (request: HttpClientRequest.HttpClientRequest): StubResponse => {
    const page = Number(readStubRequestTarget(request).query["page"] ?? "1");
    const pages = Math.max(1, Math.ceil(count / 2));
    const ids = [page * 2 - 1, page * 2].filter((id) => id <= count);
    const link = buildLinkHeader(page, pages);
    return {
      status: 200,
      body: ids.map((id) => ({ id })),
      ...(link === "" ? {} : { headers: { link } }),
    };
  };

/** Reads the newest items of a listing of `count` items, wanting every item with an id of at least `oldestWanted`. */
const readNewest = async (count: number, maxPages: number, oldestWanted: number) => {
  const stub = stubGithub(answerListing(count));
  const result = await runAgainstStub(
    fetchNewestItems(
      { method: "GET", path: PATH, token: TEST_TOKEN, query: { per_page: "2" } },
      maxPages,
      (items) => Number(items[0]?.["id"] ?? 0) >= oldestWanted,
    ),
    stub,
  );
  const pages = stub.requests.map((request) =>
    Number(readStubRequestTarget(request).query["page"] ?? "1"),
  );
  return { result, pages };
};

describe("fetchNewestItems", () => {
  it("returns a listing of one page as it is", async () => {
    const { result, pages } = await readNewest(2, 3, 1);

    expect(Result.getOrThrow(result)).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      truncated: false,
      itemsBefore: 0,
    });
    expect(pages).toEqual([1]);
  });

  it("reads back from the last page until the oldest item wanted is read", async () => {
    const { result, pages } = await readNewest(9, 5, 6);

    // Pages 5 (item 9), 4 (items 7 and 8) and 3 (items 5 and 6) after the first.
    expect(Result.getOrThrow(result)).toEqual({
      items: [5, 6, 7, 8, 9].map((id) => ({ id })),
      truncated: false,
      itemsBefore: 4,
    });
    expect(pages).toEqual([1, 5, 4, 3]);
  });

  it("stops at the page limit and says older items were left unread", async () => {
    const { result, pages } = await readNewest(9, 3, 1);

    expect(Result.getOrThrow(result)).toEqual({
      items: [7, 8, 9].map((id) => ({ id })),
      truncated: true,
      itemsBefore: 6,
    });
    expect(pages).toEqual([1, 5, 4]);
  });

  it("ends with the first page, already read, when every item is wanted", async () => {
    const { result, pages } = await readNewest(5, 5, 1);

    expect(Result.getOrThrow(result)).toEqual({
      items: [1, 2, 3, 4, 5].map((id) => ({ id })),
      truncated: false,
      itemsBefore: 0,
    });
    expect(pages).toEqual([1, 3, 2]);
  });

  it("fails when a listing with more pages has no link to its last page", async () => {
    const stub = stubGithub(() => ({
      status: 200,
      body: [{ id: 1 }],
      headers: { link: `<https://api.github.com${PATH}?after=abc>; rel="next"` },
    }));

    const result = await runAgainstStub(
      fetchNewestItems({ method: "GET", path: PATH, token: TEST_TOKEN }, 3, () => true),
      stub,
    );

    expect(Result.isFailure(result) && result.failure.message).toContain(
      `GitHub sent no link to the last page of GET ${PATH}`,
    );
  });
});
