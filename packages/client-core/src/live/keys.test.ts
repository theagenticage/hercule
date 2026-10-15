import { assert, describe, it } from "vitest";
import { LIVE_SESSION_STATUSES, MUTABLE_LIVE_TOPICS } from "@hercule/contract";
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

describe("signal pushes", () => {
  it("invalidates every list and the changed signals", () => {
    assert.deepStrictEqual(buildQueryKeys("signal", ["first", "second"]), [
      queryKeys.signals(),
      queryKeys.signal("first"),
      queryKeys.signal("second"),
    ]);
  });

  it("invalidates every signal on a workflow, Connection or plugin push, whose names its describe lines show", () => {
    for (const topic of ["workflow", "connection", "plugin"] as const) {
      const keys = buildQueryKeys(topic, ["changed"]);
      assert.isTrue(keys.some((key) => isPrefixOf(key, queryKeys.signals({ view: "to-do" }))));
      assert.isTrue(keys.some((key) => isPrefixOf(key, queryKeys.signal("any"))));
    }
  });

  it("invalidates every Connection's own page on a plugin push, which resolves the plugin's Intake settings", () => {
    const keys = buildQueryKeys("plugin", ["github"]);
    assert.isTrue(keys.some((key) => isPrefixOf(key, queryKeys.connection("any"))));
  });

  it("invalidates every signal after reconnect", () => {
    assert.deepStrictEqual(buildQueryKeys("signal", []), [queryKeys.signals(), queryKeys.signal()]);
  });

  it("reaches a filtered list through the list prefix", () => {
    const toDo = queryKeys.signals({ view: "to-do" });
    assert.isTrue(buildQueryKeys("signal", ["first"]).some((key) => isPrefixOf(key, toDo)));
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

describe("the desktop workflow list's keys", () => {
  it("reaches every trigger, the list of all of them too, on a workflow push", () => {
    const keys = buildQueryKeys("workflow", ["w1"]);
    assert.isTrue(keys.some((key) => isPrefixOf(key, queryKeys.triggers())));
    assert.isTrue(keys.some((key) => isPrefixOf(key, queryKeys.triggers("w2"))));
  });

  it("reaches the strips' one read, every workflow's newest runs, on a run push", () => {
    const strips = queryKeys.runs({ newestPerWorkflow: 20 });
    assert.isTrue(buildQueryKeys("run", ["r1"]).some((key) => isPrefixOf(key, strips)));
  });

  it("reaches the live sessions of runs on a session push", () => {
    const live = queryKeys.sessions({ thread: false, status: LIVE_SESSION_STATUSES });
    assert.isTrue(buildQueryKeys("session", ["s1"]).some((key) => isPrefixOf(key, live)));
  });
});

describe("discussion pushes", () => {
  it("invalidates the listing and the changed Discussions", () => {
    assert.deepStrictEqual(buildQueryKeys("discussion", ["first", "second"]), [
      queryKeys.discussions(),
      queryKeys.discussion("first"),
      queryKeys.discussion("second"),
    ]);
  });

  it("invalidates every Discussion after reconnect", () => {
    assert.deepStrictEqual(buildQueryKeys("discussion", []), [
      queryKeys.discussions(),
      queryKeys.discussion(),
    ]);
  });
});

describe("wiki page pushes", () => {
  it("invalidates the listing and the changed pages", () => {
    assert.deepStrictEqual(buildQueryKeys("wikiPage", ["first", "second"]), [
      queryKeys.wikiPages(),
      queryKeys.wikiPage("first"),
      queryKeys.wikiPage("second"),
    ]);
  });

  it("invalidates every page after reconnect", () => {
    assert.deepStrictEqual(buildQueryKeys("wikiPage", []), [
      queryKeys.wikiPages(),
      queryKeys.wikiPage(),
    ]);
  });

  it("reaches a changed page's older revisions through the page's key", () => {
    const [, page] = buildQueryKeys("wikiPage", ["p1"]);
    assert.isTrue(isPrefixOf(page!, queryKeys.wikiPage("p1", 3)));
    assert.isFalse(isPrefixOf(page!, queryKeys.wikiPage("p2", 3)));
  });

  it("keeps a page, a Discussion and their listings under different prefixes", () => {
    const keys = [
      queryKeys.discussions(),
      queryKeys.discussion("a"),
      queryKeys.wikiPages(),
      queryKeys.wikiPage("a"),
    ];
    assert.strictEqual(new Set(keys.map((key) => key[0])).size, 4);
  });
});
