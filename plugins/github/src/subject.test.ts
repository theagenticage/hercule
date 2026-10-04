/** Tests the subject block, refs and web URLs every GitHub event carries. */
import { describe, expect, it } from "vitest";
import { buildItemEvent, buildRepoRef, buildRepoSubject } from "./subject";

describe("the subject, refs and url of an event", () => {
  it("point an issue event at the issue, and its repository", () => {
    const event = buildItemEvent(
      { repo: "Octocat/Hello-World", kind: "issue", number: 42, title: "Bug", author: "mona" },
      { kind: "github.issue.opened", dedupKey: "k", occurredAt: "2026-10-01T00:00:00Z", raw: null },
    );

    expect(event.refs).toEqual([
      "github:issue:octocat/hello-world#42",
      "github:repo:octocat/hello-world",
    ]);
    expect(event.url).toBe("https://github.com/octocat/hello-world/issues/42");
    expect(event.payload).toEqual({
      subject: {
        repo: "octocat/hello-world",
        number: 42,
        title: "Bug",
        author: "mona",
        url: "https://github.com/octocat/hello-world/issues/42",
      },
    });
  });

  it("use `pull`, singular, in a pull request's URL, and add the kind's own fields", () => {
    const event = buildItemEvent(
      { repo: "octocat/hello-world", kind: "pr", number: 87 },
      {
        kind: "github.pr.labeled",
        dedupKey: "k",
        occurredAt: "2026-10-01T00:00:00Z",
        fields: { added: ["bug"], removed: [] },
        raw: null,
      },
    );

    expect(event.refs[0]).toBe("github:pr:octocat/hello-world#87");
    expect(event.url).toBe("https://github.com/octocat/hello-world/pull/87");
    expect(event.payload).toMatchObject({ added: ["bug"], removed: [] });
  });

  it("point a repository event at the repository", () => {
    expect(buildRepoRef("Octocat/Hello-World")).toBe("github:repo:octocat/hello-world");
    expect(buildRepoSubject("Octocat/Hello-World", "v1.0")).toEqual({
      repo: "octocat/hello-world",
      title: "v1.0",
      url: "https://github.com/octocat/hello-world",
    });
  });
});
