/** Tests the notifications feed against a stub GitHub. */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  buildIngestHarness,
  readStubRequestTarget,
  stubGithub,
  type IngestHarness,
  type StubResponse,
} from "../testing";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { pollNotifications } from "./notifications";

const LAST_MODIFIED = "Thu, 01 Oct 2026 10:00:00 GMT";

/** Builds a notification thread about `subjectUrl`, updated at `updatedAt`. */
const buildThread = (id: string, updatedAt: string, subjectUrl: string | null, type = "Issue") => ({
  id,
  reason: "mention",
  updated_at: updatedAt,
  subject: { title: `Thread ${id}`, url: subjectUrl, type },
  repository: { full_name: "Octocat/Hello-World" },
});

/** Polls the feed once against a stub that answers with `route`, and returns the requests it received. */
const poll = async (
  harness: IngestHarness,
  route: (request: HttpClientRequest.HttpClientRequest) => StubResponse,
) => {
  const stub = stubGithub(route);
  const result = await Effect.runPromise(
    pollNotifications("token", harness.context).pipe(Effect.provide(stub.layer)),
  );
  return { result, requests: stub.requests };
};

/** Polls once with GitHub's first answer, so the feed has a baseline. */
const baseline = async (harness: IngestHarness) =>
  poll(harness, () => ({
    status: 200,
    body: [buildThread("1", "2026-10-01T09:00:00Z", null)],
    headers: { "last-modified": LAST_MODIFIED, "x-poll-interval": "60" },
  }));

describe("the notifications feed", () => {
  it("emits nothing on its first poll, and records where the feed stands", async () => {
    const harness = buildIngestHarness();

    const { result, requests } = await baseline(harness);

    expect(harness.events).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(readStubRequestTarget(requests[0]!).query).toEqual({ per_page: "1" });
    expect(result).toEqual({ nextAfterSeconds: 60 });
    expect(harness.state.get("notifications")).toEqual({
      lastModified: LAST_MODIFIED,
      since: "2026-10-01T10:00:00.000Z",
    });
  });

  it("asks only for what changed since, and a 304 emits nothing", async () => {
    const harness = buildIngestHarness();
    await baseline(harness);

    const { result, requests } = await poll(harness, () => ({
      status: 304,
      headers: { "x-poll-interval": "120" },
    }));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers["if-modified-since"]).toBe(LAST_MODIFIED);
    expect(readStubRequestTarget(requests[0]!).query["since"]).toBe("2026-10-01T10:00:00.000Z");
    expect(harness.events).toEqual([]);
    expect(result).toEqual({ nextAfterSeconds: 120 });
  });

  it("emits one event per changed thread, oldest first, with the item's subject and refs", async () => {
    const harness = buildIngestHarness();
    await baseline(harness);

    await poll(harness, () => ({
      status: 200,
      // GitHub lists the newest thread first.
      body: [
        buildThread(
          "12",
          "2026-10-01T10:05:00Z",
          "https://api.github.com/repos/octocat/hello-world/pulls/87",
          "PullRequest",
        ),
        buildThread(
          "11",
          "2026-10-01T10:04:00Z",
          "https://api.github.com/repos/octocat/hello-world/issues/42",
        ),
        buildThread("10", "2026-10-01T10:03:00Z", null, "Discussion"),
      ],
      headers: { "last-modified": "Thu, 01 Oct 2026 10:05:00 GMT" },
    }));

    expect(harness.events.map((event) => event.dedupKey)).toEqual([
      "notification:10:2026-10-01T10:03:00Z",
      "notification:11:2026-10-01T10:04:00Z",
      "notification:12:2026-10-01T10:05:00Z",
    ]);
    const [discussion, issue, pull] = harness.events;
    expect(discussion!.refs).toEqual(["github:repo:octocat/hello-world"]);
    expect(discussion!.url).toBe("https://github.com/octocat/hello-world");
    expect(issue!.refs[0]).toBe("github:issue:octocat/hello-world#42");
    expect(issue!.url).toBe("https://github.com/octocat/hello-world/issues/42");
    expect(pull!.refs[0]).toBe("github:pr:octocat/hello-world#87");
    expect(pull!.occurredAt).toBe("2026-10-01T10:05:00Z");
    expect(pull!.payload).toEqual({
      subject: {
        repo: "octocat/hello-world",
        number: 87,
        title: "Thread 12",
        url: "https://github.com/octocat/hello-world/pull/87",
      },
      reason: "mention",
    });
    expect(harness.state.get("notifications")).toEqual({
      lastModified: "Thu, 01 Oct 2026 10:05:00 GMT",
      since: "2026-10-01T10:05:00Z",
    });
  });

  it("follows every page of the listing", async () => {
    const harness = buildIngestHarness();
    await baseline(harness);

    const { requests } = await poll(harness, (request) =>
      readStubRequestTarget(request).query["page"] === "2"
        ? { status: 200, body: [buildThread("20", "2026-10-01T10:01:00Z", null)] }
        : {
            status: 200,
            body: [buildThread("21", "2026-10-01T10:02:00Z", null)],
            headers: { link: '<https://api.github.com/notifications?page=2>; rel="next"' },
          },
    );

    expect(requests).toHaveLength(2);
    // Only the first page is conditional: a 304 on a later page would lose it.
    expect(requests[1]!.headers["if-modified-since"]).toBeUndefined();
    expect(harness.events.map((event) => event.dedupKey)).toEqual([
      "notification:20:2026-10-01T10:01:00Z",
      "notification:21:2026-10-01T10:02:00Z",
    ]);
  });
});
