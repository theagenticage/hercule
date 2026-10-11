/**
 * Tests the search for the user's own open pull requests.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { TEST_TOKEN } from "../actions/testing";
import { readStubRequestTarget, runAgainstStub, stubAnswer } from "../testing";
import { fetchOwnOpenPullRequests } from "./own-pulls";

describe("fetchOwnOpenPullRequests", () => {
  it("names the user as @me, so a renamed account still finds its pull requests", async () => {
    const stub = stubAnswer(200, {
      total_count: 1,
      items: [
        {
          number: 87,
          title: "Fix the cart",
          repository_url: "https://api.github.com/repos/Acme/WebShop",
          updated_at: "2026-10-11T09:00:00Z",
        },
      ],
    });

    const result = await runAgainstStub(fetchOwnOpenPullRequests(TEST_TOKEN), stub);

    expect(readStubRequestTarget(stub.requests[0]!).query["q"]).toBe(
      "is:pr is:open archived:false author:@me",
    );
    expect(Result.getOrThrow(result)).toEqual([
      {
        repo: "acme/webshop",
        number: 87,
        title: "Fix the cart",
        updatedAt: "2026-10-11T09:00:00Z",
      },
    ]);
  });
});
