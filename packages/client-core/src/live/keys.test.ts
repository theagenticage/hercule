import { assert, describe, it } from "vitest";
import { buildQueryKeys, queryKeys } from "./keys";

/**
 * Returns only the keys of conversations' current sessions among the keys a
 * `session` push invalidates.
 */
const listConversationSessionKeys = (
  ids: ReadonlyArray<string>,
  conversationIds?: Readonly<Record<string, string | null>>,
) =>
  buildQueryKeys("session", ids, conversationIds).filter(
    (key) => key[0] === queryKeys.conversationSession()[0],
  );

describe("the current sessions a session push makes stale", () => {
  it("is none for a push that names only sessions in no conversation, such as threads and workflow runs' sessions", () => {
    assert.deepStrictEqual(
      listConversationSessionKeys(["thread-1", "run-session"], {
        "thread-1": null,
        "run-session": null,
      }),
      [],
    );
  });

  it("is the conversation of each session the push names, once each", () => {
    assert.deepStrictEqual(
      listConversationSessionKeys(["ada-old", "thread-1", "milo-current", "ada-new"], {
        "ada-old": "ada-conversation",
        "thread-1": null,
        "milo-current": "milo-conversation",
        "ada-new": "ada-conversation",
      }),
      [
        queryKeys.conversationSession("ada-conversation"),
        queryKeys.conversationSession("milo-conversation"),
      ],
    );
  });

  it("is every conversation's for a push that does not name a session's conversation", () => {
    // A controller that predates `conversationIds` sends none, and then the
    // session may be a new one in any conversation.
    assert.deepStrictEqual(listConversationSessionKeys(["s1"]), [queryKeys.conversationSession()]);
    assert.deepStrictEqual(listConversationSessionKeys(["s1", "s2"], { s1: null }), [
      queryKeys.conversationSession(),
    ]);
  });

  it("is every conversation's for a push that names no ids", () => {
    assert.deepStrictEqual(listConversationSessionKeys([]), [queryKeys.conversationSession()]);
  });

  it("keeps the keys out of the `sessions` prefix, so a session push reaches them only through this rule", () => {
    assert.notStrictEqual(queryKeys.conversationSession("c1")[0], queryKeys.sessions()[0]);
  });
});
