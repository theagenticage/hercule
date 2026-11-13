/** Tests the reply drafts through their interface. */
import { describe, expect, it, vi } from "vitest";
import { createAccountScopes } from "./account-scope";
import { createReplyDrafts } from "./reply-drafts";

describe("reply drafts", () => {
  it("gives back what was written, per signal and per answer", () => {
    const drafts = createReplyDrafts();
    drafts.write("s1", "reply", "On it");
    drafts.write("s1", "comment", "Other words");

    expect(drafts.read("s1", "reply")).toBe("On it");
    expect(drafts.read("s1", "comment")).toBe("Other words");
    expect(drafts.read("s2", "reply")).toBe("");
  });

  it("removes a draft when empty text is written", () => {
    const drafts = createReplyDrafts();
    drafts.write("s1", "reply", "On it");
    drafts.write("s1", "reply", "");

    expect(drafts.read("s1", "reply")).toBe("");
  });

  it("keeps the drafts of one account apart from another's and drops them when the scope closes", () => {
    const scopes = createAccountScopes({
      controllerUrl: "http://127.0.0.1:4937",
      client: { getToken: () => "token" } as never,
      queryClient: { invalidateQueries: vi.fn() } as never,
      storage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    });
    const ada = scopes.open("ada");
    ada.replyDrafts.write("s1", "reply", "Ada's words");

    const bob = scopes.open("bob");
    expect(bob.replyDrafts.read("s1", "reply")).toBe("");
    expect(ada.replyDrafts.read("s1", "reply")).toBe("");
  });
});
