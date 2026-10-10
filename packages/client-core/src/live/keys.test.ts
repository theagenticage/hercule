import { assert, describe, it } from "vitest";
import { MUTABLE_LIVE_TOPICS } from "@hercule/contract";
import { buildQueryKeys, queryKeys, type LiveQueryKey } from "./keys";

describe("workspace pushes", () => {
  it("invalidates the list and the changed records", () => {
    assert.deepStrictEqual(buildQueryKeys("workspace", ["first", "second"]), [
      queryKeys.workspaces(),
      queryKeys.workspace("first"),
      queryKeys.workspace("second"),
    ]);
  });

  it("invalidates every workspace after reconnect", () => {
    assert.deepStrictEqual(buildQueryKeys("workspace", []), [
      queryKeys.workspaces(),
      queryKeys.workspace(),
    ]);
  });
});

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

/** Checks whether `prefix` matches `key` as TanStack Query matches a prefix: element by element. */
const isPrefixOf = (prefix: LiveQueryKey, key: LiveQueryKey): boolean =>
  prefix.length <= key.length && prefix.every((part, index) => part === key[index]);

describe("the running turn's key", () => {
  it("is never invalidated by a push on any topic, with or without ids", () => {
    // The running turn is kept current by the session's `:stream` topic, so
    // an invalidation would only read it again for nothing.
    const runningTurn = queryKeys.runningTurn("s1");
    for (const topic of MUTABLE_LIVE_TOPICS) {
      for (const ids of [[], ["s1"]]) {
        const reached = buildQueryKeys(topic, ids, { s1: "c1" }).filter((key) =>
          isPrefixOf(key, runningTurn),
        );
        assert.deepStrictEqual(reached, [], `a ${topic} push naming ${ids.join() || "no ids"}`);
      }
    }
  });

  it("is apart from the session's transcript, so neither entry overwrites the other", () => {
    assert.isFalse(isPrefixOf(queryKeys.transcript("s1"), queryKeys.runningTurn("s1")));
    assert.isFalse(isPrefixOf(queryKeys.runningTurn("s1"), queryKeys.transcript("s1")));
  });
});

describe("a sender's key", () => {
  it("is never invalidated by a push on any topic, with or without ids", () => {
    // A sender is named from fields of its session that never change, so a
    // push about it, such as a busy sender's usage, must not read it again.
    const sender = queryKeys.sender("s1");
    for (const topic of MUTABLE_LIVE_TOPICS) {
      for (const ids of [[], ["s1"]]) {
        const reached = buildQueryKeys(topic, ids, { s1: "c1" }).filter((key) =>
          isPrefixOf(key, sender),
        );
        assert.deepStrictEqual(reached, [], `a ${topic} push naming ${ids.join() || "no ids"}`);
      }
    }
  });
});
