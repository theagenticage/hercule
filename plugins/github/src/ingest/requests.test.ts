/**
 * Tests `fetchNewestItems`, which reads a listing GitHub sorts oldest first
 * from its last page backwards, and `truncateRaw`, which keeps an event's
 * `raw` within what the host accepts.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { TEST_TOKEN } from "../actions/testing";
import { readStubRequestTarget, runAgainstStub, stubGithub, type StubResponse } from "../testing";
import { MAX_EMITTED_FIELD_BYTES } from "@hercule/plugin-host";
import { countJsonBytes } from "../text";
import { fetchNewestItems, truncateRaw } from "./requests";

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

describe("truncateRaw", () => {
  it("cuts a string longer than 2,000 characters and leaves shorter values alone", () => {
    const raw = truncateRaw({ body: "a".repeat(5000), title: "short", count: 3, merged: false });

    expect(raw).toEqual({ body: "a".repeat(2000), title: "short", count: 3, merged: false });
  });

  it("keeps the first 20 items of a list, at any depth, and a shorter list whole", () => {
    const numbers = (count: number) => Array.from({ length: count }, (_, index) => index);

    const raw = truncateRaw({
      top: numbers(50),
      nested: { inner: [numbers(30)] },
      few: numbers(5),
    });

    expect(raw).toEqual({ top: numbers(20), nested: { inner: [numbers(20)] }, few: numbers(5) });
  });

  it("replaces a value that is still too large with a note that it was left out", () => {
    // 40 lists of 20 strings of 2,000 characters: 1.6 MB after every cut above.
    const wide = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `list${String(index)}`,
        Array(20).fill("a".repeat(2000)),
      ]),
    );

    const raw = truncateRaw(wide);

    expect(countJsonBytes(raw)).toBeLessThanOrEqual(MAX_EMITTED_FIELD_BYTES);
    expect(Object.keys(raw)).toEqual(["omitted"]);
  });
});
