import { assert, describe, it } from "vitest";
import { LIVE_SESSION_STATUSES, MUTABLE_LIVE_TOPICS } from "@hercule/contract";
import { buildMachineFiveMinuteScope, FLEET_HOUR_METRICS_SCOPE } from "../fleet/metrics-history";
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

describe("Tracking's key", () => {
  it("is read again on every task push, with or without ids", () => {
    for (const ids of [[], ["t1"]]) {
      assert.isTrue(
        buildQueryKeys("task", ids).some((key) => isPrefixOf(key, queryKeys.tracking())),
      );
    }
  });

  it("is left to the run push's own rule, so no key maps it for a run push", () => {
    for (const ids of [[], ["r1"]]) {
      assert.isFalse(
        buildQueryKeys("run", ids).some((key) => isPrefixOf(key, queryKeys.tracking())),
      );
    }
  });

  it("is apart from the task and run lists, so no filtered read shares it", () => {
    assert.isFalse(isPrefixOf(queryKeys.tracking(), queryKeys.tasks()));
    assert.isFalse(isPrefixOf(queryKeys.tracking(), queryKeys.runs()));
  });
});

describe("a Task's Tracking detail key", () => {
  it("is read again for the Tasks a task push names", () => {
    const keys = buildQueryKeys("task", ["t1", "t2"]);
    assert.isTrue(keys.some((key) => isPrefixOf(key, queryKeys.trackingDetail("t1"))));
    assert.isTrue(keys.some((key) => isPrefixOf(key, queryKeys.trackingDetail("t2"))));
  });

  it("is not read again for a Task the push does not name", () => {
    assert.isFalse(
      buildQueryKeys("task", ["t1"]).some((key) => isPrefixOf(key, queryKeys.trackingDetail("t2"))),
    );
  });

  it("is read again for every Task when a task push names no ids", () => {
    assert.isTrue(
      buildQueryKeys("task", []).some((key) => isPrefixOf(key, queryKeys.trackingDetail("t1"))),
    );
  });

  it("is left to the run push's own rule, so no key maps it for a run push", () => {
    for (const ids of [[], ["r1"]]) {
      assert.isFalse(
        buildQueryKeys("run", ids).some((key) => isPrefixOf(key, queryKeys.trackingDetail())),
      );
    }
  });

  it("is apart from Tracking's own read and from the task record", () => {
    assert.isFalse(isPrefixOf(queryKeys.tracking(), queryKeys.trackingDetail("t1")));
    assert.isFalse(isPrefixOf(queryKeys.trackingDetail(), queryKeys.tracking()));
    assert.isFalse(isPrefixOf(queryKeys.task("t1"), queryKeys.trackingDetail("t1")));
  });
});

describe("Your work's key", () => {
  it("is read again on every task push, with or without ids", () => {
    for (const ids of [[], ["t1"]]) {
      assert.isTrue(
        buildQueryKeys("task", ids).some((key) => isPrefixOf(key, queryKeys.yourWork())),
      );
    }
  });

  it("is read again on every signal push, with or without ids", () => {
    for (const ids of [[], ["s1"]]) {
      assert.isTrue(
        buildQueryKeys("signal", ids).some((key) => isPrefixOf(key, queryKeys.yourWork())),
      );
    }
  });

  it("is not read again by a push that cannot change it", () => {
    for (const topic of ["workflow", "connection", "plugin", "run"] as const) {
      assert.isFalse(
        buildQueryKeys(topic, ["x"]).some((key) => isPrefixOf(key, queryKeys.yourWork())),
      );
    }
  });
});

describe("the merge checks' key", () => {
  it("is the prefix of every pair's check", () => {
    assert.isTrue(isPrefixOf(queryKeys.mergeCheck(), queryKeys.mergeCheck("a", "b")));
    assert.isFalse(isPrefixOf(queryKeys.mergeCheck("a", "b"), queryKeys.mergeCheck("b", "a")));
  });

  it("is made out of date by every task push, ordinary or derived, with or without ids", () => {
    for (const derived of [undefined, true] as const) {
      for (const ids of [[], ["t1"]]) {
        assert.isTrue(
          buildQueryKeys("task", ids, undefined, derived).some((key) =>
            isPrefixOf(key, queryKeys.mergeCheck("a", "b")),
          ),
        );
      }
    }
  });
});

describe("the Work board's key", () => {
  it("is read again on every ordinary task push, with or without ids", () => {
    for (const ids of [[], ["t1"]]) {
      assert.isTrue(
        buildQueryKeys("task", ids).some((key) => isPrefixOf(key, queryKeys.workBoard())),
      );
    }
  });

  it("is, with the named Tasks' details, the only read of a derived task push, which leaves Tracking and Your work alone", () => {
    assert.deepStrictEqual(buildQueryKeys("task", [], undefined, true), [
      queryKeys.workBoard(),
      queryKeys.mergeCheck(),
    ]);
    assert.deepStrictEqual(buildQueryKeys("task", ["t1", "t2"], undefined, true), [
      queryKeys.workBoard(),
      queryKeys.taskDetail("t1"),
      queryKeys.taskDetail("t2"),
      queryKeys.mergeCheck(),
    ]);
  });

  it("reads the failure dot again on an ordinary task push, but not on a derived one", () => {
    for (const ids of [[], ["t1"]]) {
      assert.isTrue(
        buildQueryKeys("task", ids).some((key) => isPrefixOf(key, queryKeys.taskAttention())),
      );
      assert.isFalse(
        buildQueryKeys("task", ids, undefined, true).some((key) =>
          isPrefixOf(key, queryKeys.taskAttention()),
        ),
      );
    }
  });

  it("reads a Task's detail again on an ordinary task push, with or without ids", () => {
    assert.isTrue(
      buildQueryKeys("task", ["t1"]).some((key) => isPrefixOf(key, queryKeys.taskDetail("t1"))),
    );
    assert.isTrue(
      buildQueryKeys("task", []).some((key) => isPrefixOf(key, queryKeys.taskDetail("t1"))),
    );
  });
});

describe("the Inbox's and the entities' keys", () => {
  const inboxKeys = [queryKeys.inbox(), queryKeys.inboxCount()];

  // Each row is one topic and the exact keys its push reads again. A pane's
  // read is always the whole prefix: a pane embeds its parents' records, so a
  // push naming one entity can change another entity's pane.
  const rows: ReadonlyArray<{
    readonly name: string;
    readonly topic: "task" | "signal" | "externalEntity" | "connection" | "plugin";
    readonly derived?: true;
    readonly ids: ReadonlyArray<string>;
    readonly keys: ReadonlyArray<LiveQueryKey>;
  }> = [
    {
      name: "an externalEntity push naming ids reads every entity pane and Task details, not only the named ones",
      topic: "externalEntity",
      ids: ["e1", "e2"],
      keys: [
        ...inboxKeys,
        queryKeys.externalEntity(),
        queryKeys.workBoard(),
        queryKeys.task(),
        queryKeys.entitySuggestions(),
      ],
    },
    {
      name: "an externalEntity push naming no ids",
      topic: "externalEntity",
      ids: [],
      keys: [
        ...inboxKeys,
        queryKeys.externalEntity(),
        queryKeys.workBoard(),
        queryKeys.task(),
        queryKeys.entitySuggestions(),
      ],
    },
    {
      name: "a signal push naming ids reads the Inbox, the open entity panes and the signal lists, not the board or the suggestions",
      topic: "signal",
      ids: ["s1"],
      keys: [
        queryKeys.signals(),
        queryKeys.signal("s1"),
        queryKeys.yourWork(),
        ...inboxKeys,
        queryKeys.externalEntity(),
      ],
    },
    {
      name: "a signal push naming no ids",
      topic: "signal",
      ids: [],
      keys: [
        queryKeys.signals(),
        queryKeys.signal(),
        queryKeys.yourWork(),
        ...inboxKeys,
        queryKeys.externalEntity(),
      ],
    },
    {
      name: "a plain task push reads the entity panes and the suggestions",
      topic: "task",
      ids: ["t1"],
      keys: [
        queryKeys.tasks(),
        queryKeys.task("t1"),
        queryKeys.tracking(),
        queryKeys.trackingDetail("t1"),
        queryKeys.yourWork(),
        ...inboxKeys,
        queryKeys.externalEntity(),
        queryKeys.entitySuggestions(),
        queryKeys.mergeCheck(),
      ],
    },
    {
      name: "a plain task push naming no ids",
      topic: "task",
      ids: [],
      keys: [
        queryKeys.tasks(),
        queryKeys.task(),
        queryKeys.tracking(),
        queryKeys.trackingDetail(),
        queryKeys.yourWork(),
        ...inboxKeys,
        queryKeys.externalEntity(),
        queryKeys.entitySuggestions(),
        queryKeys.mergeCheck(),
      ],
    },
    {
      name: "a derived task push reads the board and the named Task's details only, which a busy agent causes every second, and marks the merge checks out of date",
      topic: "task",
      derived: true,
      ids: ["t1"],
      keys: [queryKeys.workBoard(), queryKeys.taskDetail("t1"), queryKeys.mergeCheck()],
    },
    {
      name: "a connection push naming ids reads the entity panes, the board, the Task details and the suggestions",
      topic: "connection",
      ids: ["c1"],
      keys: [
        queryKeys.connections(),
        queryKeys.connection("c1"),
        queryKeys.signals(),
        queryKeys.signal(),
        ...inboxKeys,
        queryKeys.externalEntity(),
        queryKeys.workBoard(),
        queryKeys.task(),
        queryKeys.entitySuggestions(),
      ],
    },
    {
      name: "a connection push naming no ids",
      topic: "connection",
      ids: [],
      keys: [
        queryKeys.connections(),
        queryKeys.connection(),
        queryKeys.signals(),
        queryKeys.signal(),
        ...inboxKeys,
        queryKeys.externalEntity(),
        queryKeys.workBoard(),
        queryKeys.task(),
        queryKeys.entitySuggestions(),
      ],
    },
    {
      name: "a plugin push reads the entity panes, the board, the Task details and the suggestions",
      topic: "plugin",
      ids: ["github"],
      keys: [
        queryKeys.plugins(),
        queryKeys.connection(),
        queryKeys.signals(),
        queryKeys.signal(),
        ...inboxKeys,
        queryKeys.externalEntity(),
        queryKeys.workBoard(),
        queryKeys.task(),
        queryKeys.entitySuggestions(),
      ],
    },
  ];

  for (const row of rows) {
    it(`reads exactly these keys again after ${row.name}`, () => {
      assert.deepStrictEqual(buildQueryKeys(row.topic, row.ids, undefined, row.derived), row.keys);
    });
  }

  it("reads the rail's outline again on every push that reads the Inbox's pages, because its key is inside the pages' prefix", () => {
    for (const topic of ["task", "signal", "externalEntity", "connection", "plugin"] as const) {
      const keys = buildQueryKeys(topic, ["x"]);
      assert.isTrue(
        keys.some((read) => isPrefixOf(read, queryKeys.inboxOutline())),
        topic,
      );
    }
    // The pages' own keys carry a query object, so the outline is a different cache entry.
    assert.notDeepEqual(
      queryKeys.inboxOutline(),
      queryKeys.inbox({ list: { savedQuery: "waits" } }),
    );
  });

  it("leaves the signal lists alone on an externalEntity push, because the controller announces a signal push when a thing's open signals gain their entity", () => {
    const keys = buildQueryKeys("externalEntity", ["e1"]);
    assert.isFalse(keys.some((read) => isPrefixOf(read, queryKeys.signals({ view: "to-do" }))));
  });

  it("reads the Inbox and the entity panes again on a push that names a workflow, because their offers come from the workflows, and not the count or the suggestions", () => {
    const keys = buildQueryKeys("workflow", ["w1"]);
    for (const key of [queryKeys.inbox(), queryKeys.externalEntity()]) {
      assert.isTrue(keys.some((read) => isPrefixOf(read, key)));
    }
    for (const key of [queryKeys.inboxCount(), queryKeys.entitySuggestions()]) {
      assert.isFalse(keys.some((read) => isPrefixOf(read, key)));
    }
  });

  it("leaves the Inbox, the entity panes and the signals alone on a derived workflow push, which a trigger's counts, next fire time or health cause", () => {
    const keys = buildQueryKeys("workflow", ["w1"], undefined, true);
    for (const key of [
      ...inboxKeys,
      queryKeys.externalEntity(),
      queryKeys.entitySuggestions(),
      queryKeys.signals(),
    ]) {
      assert.isFalse(keys.some((read) => isPrefixOf(read, key)));
    }
  });

  it("still reads the workflow lists, the named workflow and every trigger on a derived workflow push", () => {
    assert.deepStrictEqual(buildQueryKeys("workflow", ["w1"], undefined, true), [
      queryKeys.workflows(),
      queryKeys.workflow("w1"),
      queryKeys.triggers(),
    ]);
  });

  it("leaves the Inbox alone on a workflow push that names no workflow, which is the first push of every subscription", () => {
    const keys = buildQueryKeys("workflow", []);
    for (const key of [...inboxKeys, queryKeys.externalEntity()]) {
      assert.isFalse(keys.some((read) => isPrefixOf(read, key)));
    }
  });

  it("leaves the entity panes, the suggestions and the Inbox alone for a push that cannot change them", () => {
    for (const topic of ["run", "session", "wikiPage"] as const) {
      for (const ids of [[], ["x"]]) {
        const keys = buildQueryKeys(topic, ids);
        for (const key of [
          ...inboxKeys,
          queryKeys.externalEntity(),
          queryKeys.entitySuggestions(),
        ]) {
          assert.isFalse(
            keys.some((read) => isPrefixOf(read, key)),
            `a ${topic} push naming ${ids.join() || "no ids"}`,
          );
        }
      }
    }
  });
});

describe("signal pushes", () => {
  it("invalidates every list, the changed signals, Your work, the Inbox and the entity panes", () => {
    assert.deepStrictEqual(buildQueryKeys("signal", ["first", "second"]), [
      queryKeys.signals(),
      queryKeys.signal("first"),
      queryKeys.signal("second"),
      queryKeys.yourWork(),
      queryKeys.inbox(),
      queryKeys.inboxCount(),
      queryKeys.externalEntity(),
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
    assert.deepStrictEqual(buildQueryKeys("signal", []), [
      queryKeys.signals(),
      queryKeys.signal(),
      queryKeys.yourWork(),
      queryKeys.inbox(),
      queryKeys.inboxCount(),
      queryKeys.externalEntity(),
    ]);
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
    const live = queryKeys.sessions({
      kind: ["agent", "run", "assistant"],
      status: LIVE_SESSION_STATUSES,
      archived: false,
    });
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

describe("skill pushes", () => {
  it("invalidates the list and the named skills' pages, never another skill's", () => {
    const keys = buildQueryKeys("skill", ["grilling"]);
    assert.deepStrictEqual(keys, [queryKeys.skills(), queryKeys.skill("grilling")]);
    assert.isFalse(keys.some((key) => isPrefixOf(key, queryKeys.skill("teach"))));
  });

  it("invalidates every skill's page after reconnect", () => {
    assert.deepStrictEqual(buildQueryKeys("skill", []), [queryKeys.skills(), queryKeys.skill()]);
  });

  it("reads a skill's diff again on a push naming the skill, since its current revision may have changed", () => {
    const diff = queryKeys.skillDiff("grilling", "e".repeat(64));
    assert.isTrue(buildQueryKeys("skill", ["grilling"]).some((key) => isPrefixOf(key, diff)));
    assert.isFalse(buildQueryKeys("skill", ["teach"]).some((key) => isPrefixOf(key, diff)));
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

describe("the composer's skill list keys", () => {
  it("is outside the session and sessions prefixes, so a session push does not make the runner scan its disk", () => {
    const keys = buildQueryKeys("session", ["s1"]);
    assert.isFalse(keys.some((key) => isPrefixOf(key, queryKeys.sessionSkills("s1"))));
    assert.isFalse(keys.some((key) => isPrefixOf(key, queryKeys.previewSkills())));
    assert.isFalse(isPrefixOf(queryKeys.session("s1"), queryKeys.sessionSkills("s1")));
  });

  it("is outside the Skill Library's keys, which a skill push marks stale", () => {
    const keys = buildQueryKeys("skill", []);
    assert.isFalse(keys.some((key) => isPrefixOf(key, queryKeys.sessionSkills("s1"))));
    assert.isFalse(keys.some((key) => isPrefixOf(key, queryKeys.previewSkills())));
  });

  it("keys a draft's list on its runner and repos, and a session's on its id", () => {
    const filter = { runnerId: "r1", resourceId: ["a", "b"] };
    assert.isTrue(isPrefixOf(queryKeys.previewSkills(), queryKeys.previewSkills(filter)));
    assert.notDeepEqual(
      queryKeys.previewSkills(filter),
      queryKeys.previewSkills({ runnerId: "r1", resourceId: ["a"] }),
    );
    assert.isTrue(isPrefixOf(queryKeys.sessionSkills(), queryKeys.sessionSkills("s1")));
    assert.notDeepEqual(queryKeys.sessionSkills("s1"), queryKeys.sessionSkills("s2"));
  });
});

describe("the Runner Metrics history keys", () => {
  it("is read by no push: the runnerMetrics topic maps to no key, and no other topic's keys cover it", () => {
    assert.deepEqual(buildQueryKeys("runnerMetrics", []), []);
    assert.deepEqual(buildQueryKeys("runnerMetrics", ["r1"]), []);
    const key = queryKeys.runnerMetrics(buildMachineFiveMinuteScope("r1"));
    for (const topic of ["runner", "session", "provider"] as const) {
      assert.isFalse(buildQueryKeys(topic, []).some((pushed) => isPrefixOf(pushed, key)));
    }
  });

  it("tells the histories of different scopes apart", () => {
    const keys = [
      queryKeys.runnerMetrics(FLEET_HOUR_METRICS_SCOPE),
      queryKeys.runnerMetrics(buildMachineFiveMinuteScope("r1")),
      queryKeys.runnerMetrics(buildMachineFiveMinuteScope("r2")),
    ];
    assert.strictEqual(new Set(keys.map((key) => JSON.stringify(key))).size, keys.length);
    assert.deepEqual(
      queryKeys.runnerMetrics(buildMachineFiveMinuteScope("r1")),
      queryKeys.runnerMetrics(buildMachineFiveMinuteScope("r1")),
    );
  });
});
