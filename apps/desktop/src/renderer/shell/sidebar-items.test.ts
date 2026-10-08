import { describe, expect, it } from "vitest";
import { listWaiting, type AssistantRow, type DraftPlace } from "@hercule/client-core";
import {
  buildProject,
  buildSession,
  INFRA,
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  RUNBOOKS,
  THREAD_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
} from "@hercule/client-core/threads/testing";
import type { OpenRequest, Project, Runner, Session, Workspace } from "@hercule/contract";
import type { GoMenuItem } from "../../ipc/contract";
import {
  buildSidebar,
  listGoMenuItems,
  pickFocusFallback,
  type SectionKey,
  type Sidebar,
  type SidebarItem,
} from "./sidebar-items";

const APPROVAL: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

/** Returns a time `minutes` after 09:00, so a larger number is a newer thread. */
const at = (minutes: number): string => new Date(Date.UTC(2026, 8, 10, 9, minutes)).toISOString();

/** Returns a thread in no project, idle on moss, created and last active at 09:`minutes`. */
const thread = (id: string, minutes: number, over: Partial<Session> = {}): Session =>
  buildSession({ id, title: id, createdAt: at(minutes), lastActivityAt: at(minutes), ...over });

/** Returns a thread waiting on a command approval. */
const waiting = (id: string, minutes: number, over: Partial<Session> = {}): Session =>
  thread(id, minutes, { status: "busy", openRequests: [APPROVAL], ...over });

/**
 * Returns the row of an assistant whose session waits on a command approval,
 * named and identified `id`, its session last active at 09:`minutes`.
 */
const waitingAssistant = (id: string, minutes: number): AssistantRow => ({
  id,
  name: id,
  pose: "waiting",
  session: waiting(`${id}-session`, minutes),
});

/**
 * Returns the sidebar for `threads` and `assistantRows`, in the fixture's
 * projects, workspaces and resources. With a `draft`, its row's model is
 * "draft model" and its third line "draft meta".
 */
const buildFixtureSidebar = ({
  threads,
  assistantRows = [],
  runners = [MOSS],
  projects = [WEBSHOP_PROJECT, OPS_PROJECT],
  workspaces = [PRIMARY, THREAD_3F1],
  expanded = new Set(),
  selectedId = null,
  draft = null,
  unsentKeys = new Set(),
}: {
  readonly threads: readonly Session[];
  readonly assistantRows?: readonly AssistantRow[];
  readonly runners?: readonly Runner[];
  readonly projects?: readonly Project[];
  readonly workspaces?: readonly Workspace[];
  readonly expanded?: ReadonlySet<SectionKey>;
  readonly selectedId?: string | null;
  readonly draft?: DraftPlace | null;
  readonly unsentKeys?: ReadonlySet<string>;
}): Sidebar =>
  buildSidebar({
    threads,
    waiting: listWaiting(threads, assistantRows),
    projects,
    workspaces,
    resources: [WEBSHOP, INFRA, RUNBOOKS],
    runners,
    instances: [],
    draft:
      draft === null
        ? null
        : {
            place: draft,
            rowModel: "draft model",
            rowWorkspace: { clip: "draft workspace", keep: " · draft machine" },
          },
    unsentKeys,
    expanded,
    selectedId,
  });

/** Returns the sidebar's items for `threads`, as `buildFixtureSidebar` builds them. */
const buildItems = (sources: Parameters<typeof buildFixtureSidebar>[0]): readonly SidebarItem[] =>
  buildFixtureSidebar(sources).items;

/** Returns the keys of `items`, in order. */
const listKeys = (items: readonly SidebarItem[]): readonly string[] =>
  items.map((item) => item.key);

/** Returns the item with `key`, and fails the test when there is none. */
const findItem = (items: readonly SidebarItem[], key: string): SidebarItem => {
  const item = items.find((each) => each.key === key);
  if (item === undefined) throw new Error(`no item ${key} in ${listKeys(items).join(", ")}`);
  return item;
};

/** A sidebar with something in every place, like the book's. */
const WORLD_THREADS = [
  waiting("s-runbook", 5, { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id }),
  thread("s-flaky", 4, {
    status: "busy",
    projectId: WEBSHOP_PROJECT.id,
    workspaceId: THREAD_3F1.id,
  }),
  thread("s-bun", 3, { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id }),
  thread("s-keys", 2, { status: "exited", resumable: true, projectId: OPS_PROJECT.id }),
  thread("s-price", 1),
];

describe("buildSidebar", () => {
  it("lays out Waiting on you, then each project's threads in one list, then the threads in no project", () => {
    const items = buildItems({ threads: WORLD_THREADS });

    expect(items.map(({ kind, key, section, leading }) => [kind, key, section, leading])).toEqual([
      ["waiting-header", "header:waiting", "waiting", 8],
      ["waiting-thread-row", "waiting:thread:s-runbook", "waiting", 1],
      ["project-header", "header:project:p-webshop", "project:p-webshop", 8],
      ["thread-row", "thread:s-runbook", "project:p-webshop", 1],
      ["thread-row", "thread:s-flaky", "project:p-webshop", 1],
      ["thread-row", "thread:s-bun", "project:p-webshop", 1],
      ["project-header", "header:project:p-ops", "project:p-ops", 8],
      ["thread-row", "thread:s-keys", "project:p-ops", 1],
      ["project-header", "header:project:none", "project:none", 8],
      ["thread-row", "thread:s-price", "project:none", 1],
    ]);
  });

  it("lists a waiting thread twice: in Waiting on you with its question, and in its project with the waiting mark", () => {
    const items = buildItems({ threads: WORLD_THREADS });

    expect(findItem(items, "header:waiting")).toMatchObject({ count: 1 });
    expect(findItem(items, "waiting:thread:s-runbook")).toMatchObject({
      sessionId: "s-runbook",
      title: "s-runbook",
      question: "Run git push?",
    });
    expect(findItem(items, "thread:s-runbook")).toMatchObject({
      sessionId: "s-runbook",
      pose: "waiting",
      end: "waiting",
    });
  });

  it("gives each project the tint of its place in the project list", () => {
    const third = buildProject("p-docs", "docs");
    const items = buildItems({
      threads: [
        thread("s-a", 3, { projectId: third.id }),
        thread("s-b", 2, { projectId: OPS_PROJECT.id }),
        thread("s-c", 1, { projectId: WEBSHOP_PROJECT.id }),
      ],
      projects: [WEBSHOP_PROJECT, OPS_PROJECT, third],
    });

    expect(
      items.flatMap((item) => (item.kind === "project-header" ? [[item.name, item.tint]] : [])),
    ).toEqual([
      ["docs", "ops"],
      ["ops", "payments"],
      ["webshop", "webshop"],
    ]);
  });

  it("sorts a project's threads by when they were created, newest first, not by their latest activity", () => {
    const items = buildItems({
      threads: [
        // Created first, but the most recently active.
        thread("s-old", 1, { projectId: OPS_PROJECT.id, lastActivityAt: at(9) }),
        thread("s-new", 3, { projectId: OPS_PROJECT.id, lastActivityAt: at(4) }),
        thread("s-middle", 2, { projectId: OPS_PROJECT.id, lastActivityAt: at(5) }),
      ],
    });

    expect(listKeys(items)).toEqual([
      "header:project:p-ops",
      "thread:s-new",
      "thread:s-middle",
      "thread:s-old",
    ]);
  });

  it("sorts the projects by their newest thread's creation time, not by their latest activity", () => {
    const items = buildItems({
      threads: [
        thread("s-webshop", 1, { projectId: WEBSHOP_PROJECT.id, lastActivityAt: at(9) }),
        thread("s-ops", 2, { projectId: OPS_PROJECT.id, lastActivityAt: at(3) }),
      ],
    });

    expect(items.flatMap((item) => (item.kind === "project-header" ? [item.name] : []))).toEqual([
      "ops",
      "webshop",
    ]);
  });

  it(`names each thread's workspace on its third line: the branch of a worktree, the repo and machine of a main workspace, or "No workspace"`, () => {
    const items = buildItems({
      threads: [
        thread("s-worktree", 3, { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id }),
        thread("s-primary", 2, { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id }),
        thread("s-bare", 1, { projectId: WEBSHOP_PROJECT.id }),
      ],
    });

    expect(
      items.flatMap((item) =>
        item.kind === "thread-row" ? [[item.key, item.workspaceClip, item.workspaceKeep]] : [],
      ),
    ).toEqual([
      ["thread:s-worktree", "hercule/thread-3f1", ""],
      ["thread:s-primary", "webshop", " · moss"],
      ["thread:s-bare", "No workspace", ""],
    ]);
    expect(findItem(items, "thread:s-primary")).toMatchObject({
      details: { projectName: "webshop", machine: "moss", branch: "main" },
    });
  });

  it("marks the threads whose composer holds unsent work, by session id", () => {
    const items = buildItems({
      threads: [thread("s-unsent", 2), thread("s-sent", 1)],
      unsentKeys: new Set(["s-unsent"]),
    });

    expect(findItem(items, "thread:s-unsent")).toMatchObject({ unsent: true });
    expect(findItem(items, "thread:s-sent")).toMatchObject({ unsent: false });
  });

  it("puts the draft's row first in its project, and its project first, whatever workspace it joins", () => {
    const threads = [
      thread("s-worktree", 3, { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id }),
      thread("s-primary", 2, { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id }),
      // ops has the newest thread, so it would come first without the draft.
      thread("s-ops", 4, { projectId: OPS_PROJECT.id }),
    ];
    const expected = [
      "header:project:p-webshop",
      "draft",
      "thread:s-worktree",
      "thread:s-primary",
      "header:project:p-ops",
      "thread:s-ops",
    ];

    const joined = buildItems({
      threads,
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id, createsWorkspace: false },
    });
    expect(listKeys(joined)).toEqual(expected);
    expect(findItem(joined, "draft")).toMatchObject({
      kind: "draft-row",
      model: "draft model",
      workspaceClip: "draft workspace",
      workspaceKeep: " · draft machine",
    });
    const ownWorkspace = buildItems({
      threads,
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: null, createsWorkspace: true },
    });
    expect(listKeys(ownWorkspace)).toEqual(expected);
  });

  it(`puts a draft in no project first under "No project", which stays last`, () => {
    const items = buildItems({
      threads: [thread("s-ops", 1, { projectId: OPS_PROJECT.id }), thread("s-none", 2)],
      draft: { projectId: null, workspaceId: null, createsWorkspace: false },
    });

    expect(listKeys(items)).toEqual([
      "header:project:p-ops",
      "thread:s-ops",
      "header:project:none",
      "draft",
      "thread:s-none",
    ]);
  });

  it(`heads the threads in no project "No project", with no tint and no project to start a thread in`, () => {
    const items = buildItems({ threads: [thread("s-a", 2), thread("s-b", 1)], workspaces: [] });

    expect(items).toEqual([
      {
        kind: "project-header",
        key: "header:project:none",
        projectId: null,
        name: "No project",
        tint: null,
        section: "project:none",
        leading: 8,
      },
      expect.objectContaining({ key: "thread:s-a", section: "project:none", leading: 1 }),
      expect.objectContaining({ key: "thread:s-b", section: "project:none", leading: 1 }),
    ]);
  });

  it.each<[string, Partial<Session>, Runner, string, string]>([
    ["a busy thread", { status: "busy" }, MOSS, "working", "working"],
    ["a starting thread", { status: "starting" }, MOSS, "working", "working"],
    ["a queued thread", { status: "queued" }, MOSS, "working", "queued"],
    ["an idle thread", {}, MOSS, "idle", "age"],
    ["a resumable exited thread", { status: "exited", resumable: true }, MOSS, "asleep", "age"],
    ["an exited thread", { status: "exited" }, MOSS, "away", "age"],
    [
      "an idle thread on an offline runner",
      {},
      { ...MOSS, connectivity: "offline" },
      "away",
      "offline",
    ],
    [
      "an exited thread on an offline runner",
      { status: "exited", resumable: true },
      { ...MOSS, connectivity: "offline" },
      "away",
      "age",
    ],
  ])("draws %s with its pose and its end", (_name, over, runner, pose, end) => {
    const items = buildItems({ threads: [thread("s-a", 1, over)], runners: [runner] });

    expect(findItem(items, "thread:s-a")).toMatchObject({ pose, end });
  });

  it("shows the 3 newest waiting threads, and counts the rest on a more row", () => {
    const threads = [1, 2, 3, 4, 5].map((minutes) => waiting(`s-${String(minutes)}`, minutes));
    const items = buildItems({ threads }).filter((item) => item.section === "waiting");

    expect(listKeys(items)).toEqual([
      "header:waiting",
      "waiting:thread:s-5",
      "waiting:thread:s-4",
      "waiting:thread:s-3",
      "more:waiting",
    ]);
    expect(findItem(items, "header:waiting")).toMatchObject({ count: 5 });
    expect(findItem(items, "more:waiting")).toMatchObject({ label: "2 more waiting on you" });
  });

  it("draws a waiting assistant in Waiting on you by its name and question, newest first among the threads", () => {
    const items = buildItems({
      threads: [waiting("s-old", 1), waiting("s-new", 5)],
      assistantRows: [waitingAssistant("ada", 3)],
    }).filter((item) => item.section === "waiting");

    expect(listKeys(items)).toEqual([
      "header:waiting",
      "waiting:thread:s-new",
      "waiting:assistant:ada",
      "waiting:thread:s-old",
    ]);
    expect(findItem(items, "waiting:assistant:ada")).toMatchObject({
      kind: "waiting-assistant-row",
      assistantId: "ada",
      name: "ada",
      question: "Run git push?",
      leading: 1,
    });
  });

  it("caps Waiting on you at 3 rows, threads and assistants together", () => {
    const items = buildItems({
      threads: [waiting("s-1", 1), waiting("s-2", 2)],
      assistantRows: [waitingAssistant("ada", 3), waitingAssistant("milo", 4)],
    }).filter((item) => item.section === "waiting");

    expect(listKeys(items)).toEqual([
      "header:waiting",
      "waiting:assistant:milo",
      "waiting:assistant:ada",
      "waiting:thread:s-2",
      "more:waiting",
    ]);
    expect(findItem(items, "header:waiting")).toMatchObject({ count: 4 });
    expect(findItem(items, "more:waiting")).toMatchObject({ label: "1 more waiting on you" });
  });

  it("draws Waiting on you for a waiting assistant when no thread waits", () => {
    const items = buildItems({
      threads: [],
      workspaces: [],
      assistantRows: [waitingAssistant("ada", 3)],
    });

    expect(listKeys(items)).toEqual(["header:waiting", "waiting:assistant:ada"]);
  });

  it("shows every waiting thread once Waiting on you is expanded", () => {
    const threads = [1, 2, 3, 4, 5].map((minutes) => waiting(`s-${String(minutes)}`, minutes));
    const items = buildItems({ threads, expanded: new Set(["waiting"]) }).filter(
      (item) => item.section === "waiting",
    );

    expect(items.filter((item) => item.kind === "waiting-thread-row")).toHaveLength(5);
    expect(listKeys(items)).not.toContain("more:waiting");
  });

  it("shows 5 threads of a project and counts the rest, keeping the selected thread in view", () => {
    const threads = [1, 2, 3, 4, 5, 6, 7].map((minutes) =>
      thread(`s-${String(minutes)}`, minutes, { projectId: OPS_PROJECT.id }),
    );

    const capped = buildItems({ threads });
    expect(capped.filter((item) => item.kind === "thread-row")).toHaveLength(5);
    expect(findItem(capped, "more:project:p-ops")).toMatchObject({ label: "2 more threads" });

    const selected = buildItems({ threads, selectedId: "s-1" });
    expect(listKeys(selected)).toContain("thread:s-1");
    expect(findItem(selected, "more:project:p-ops")).toMatchObject({ label: "1 more thread" });

    const expanded = buildItems({ threads, expanded: new Set(["project:p-ops"]) });
    expect(expanded.filter((item) => item.kind === "thread-row")).toHaveLength(7);
    expect(listKeys(expanded)).not.toContain("more:project:p-ops");
  });

  it("shows every thread in no project once that section is expanded", () => {
    const threads = [1, 2, 3, 4, 5, 6, 7].map((minutes) => thread(`s-${String(minutes)}`, minutes));

    const items = buildItems({ threads, expanded: new Set(["project:none"]) });
    expect(items.filter((item) => item.kind === "thread-row")).toHaveLength(7);
    expect(listKeys(items)).not.toContain("more:project:none");
  });

  it("shows no workspace that no thread uses, kept or failed, and no project that has only such workspaces", () => {
    expect(
      buildItems({ threads: [], workspaces: [PRIMARY, { ...THREAD_3F1, status: "failed" }] }),
    ).toEqual([]);
    expect(
      listKeys(
        buildItems({
          threads: [thread("s-bare", 1, { projectId: WEBSHOP_PROJECT.id })],
          workspaces: [PRIMARY, THREAD_3F1],
        }),
      ),
    ).toEqual(["header:project:p-webshop", "thread:s-bare"]);
  });

  it("counts the threads working, waiting on the user and idle, from the poses their rows show", () => {
    const { items, counts } = buildFixtureSidebar({ threads: WORLD_THREADS });

    expect(counts).toEqual({ working: 1, waiting: 1, idle: 2 });
    expect(findItem(items, "thread:s-flaky")).toMatchObject({ pose: "working" });
    expect(findItem(items, "thread:s-keys")).toMatchObject({ pose: "asleep" });
  });
});

/** Returns the session ids of the thread items among `items`, in order. */
const listThreadSessionIds = (items: readonly GoMenuItem[]): readonly string[] =>
  items.flatMap(({ destination }) =>
    destination.kind === "thread" ? [destination.sessionId] : [],
  );

describe("listGoMenuItems", () => {
  it("lists the threads top to bottom, a waiting thread once, where it shows first", () => {
    const thread = (sessionId: string): GoMenuItem => ({
      destination: { kind: "thread", sessionId },
      title: sessionId,
    });
    expect(listGoMenuItems(buildItems({ threads: WORLD_THREADS }))).toEqual([
      thread("s-runbook"),
      thread("s-flaky"),
      thread("s-bun"),
      thread("s-keys"),
      thread("s-price"),
    ]);
  });

  it("lists a waiting assistant where Waiting on you shows it, titled with its name", () => {
    const items = buildItems({
      threads: [waiting("s-new", 5)],
      assistantRows: [waitingAssistant("ada", 3)],
    });
    expect(listGoMenuItems(items)).toEqual([
      { destination: { kind: "thread", sessionId: "s-new" }, title: "s-new" },
      { destination: { kind: "assistant", assistantId: "ada" }, title: "ada" },
    ]);
  });

  it("lists no assistant the more row of Waiting on you hides", () => {
    const items = buildItems({
      threads: [1, 2, 3].map((minutes) => waiting(`s-${String(minutes)}`, minutes + 10)),
      assistantRows: [waitingAssistant("ada", 1)],
    });
    expect(listGoMenuItems(items).some(({ destination }) => destination.kind === "assistant")).toBe(
      false,
    );
  });

  it("lists no thread a more row hides", () => {
    const threads = [1, 2, 3, 4, 5, 6, 7].map((minutes) =>
      thread(`s-${String(minutes)}`, minutes, { projectId: OPS_PROJECT.id }),
    );
    expect(listThreadSessionIds(listGoMenuItems(buildItems({ threads })))).toEqual([
      "s-7",
      "s-6",
      "s-5",
      "s-4",
      "s-3",
    ]);
  });

  it("lists only the first nine threads, one per shortcut", () => {
    const threads = Array.from({ length: 12 }, (_, index) =>
      thread(`s-${String(12 - index)}`, 12 - index, { projectId: OPS_PROJECT.id }),
    );
    const items = buildItems({ threads, expanded: new Set(["project:p-ops"]) });
    expect(listThreadSessionIds(listGoMenuItems(items))).toEqual(
      ["12", "11", "10", "9", "8", "7", "6", "5", "4"].map((number) => `s-${number}`),
    );
  });

  it("lists no draft", () => {
    const items = buildItems({
      threads: [],
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: null, createsWorkspace: true },
    });
    expect(items.some((item) => item.kind === "draft-row")).toBe(true);
    expect(listGoMenuItems(items)).toEqual([]);
  });
});

describe("pickFocusFallback", () => {
  const FIVE_WAITING = [1, 2, 3, 4, 5].map((minutes) => waiting(`s-${String(minutes)}`, minutes));

  it("picks the first row a pressed more row brought into view", () => {
    const before = buildItems({ threads: FIVE_WAITING });
    const after = buildItems({ threads: FIVE_WAITING, expanded: new Set(["waiting"]) });

    expect(pickFocusFallback("more:waiting", before, after)).toBe("waiting:thread:s-2");
  });

  it("picks the section's more row when a row leaves a capped section", () => {
    const before = buildItems({ threads: FIVE_WAITING });
    const answered = FIVE_WAITING.map((session) =>
      session.id === "s-5" ? { ...session, openRequests: [] } : session,
    );
    const after = buildItems({ threads: answered });

    expect(pickFocusFallback("waiting:thread:s-5", before, after)).toBe("more:waiting");
  });

  it("picks the section's header when a row leaves a section with no more row", () => {
    const threads = [waiting("s-a", 2), waiting("s-b", 1)];
    const before = buildItems({ threads });
    const after = buildItems({ threads: [threads[0]!, { ...threads[1]!, openRequests: [] }] });

    expect(pickFocusFallback("waiting:thread:s-b", before, after)).toBe("header:waiting");
  });

  it("picks the item that now sits in the gone item's place when its section is gone", () => {
    const threads = [thread("s-ops", 2, { projectId: OPS_PROJECT.id }), thread("s-last", 1)];
    const before = buildItems({ threads, workspaces: [] });
    const after = buildItems({ threads: [threads[1]!], workspaces: [] });

    // The ops project held only the gone thread, so its header left with it.
    expect(listKeys(before)).toEqual([
      "header:project:p-ops",
      "thread:s-ops",
      "header:project:none",
      "thread:s-last",
    ]);
    expect(pickFocusFallback("thread:s-ops", before, after)).toBe("thread:s-last");
  });

  it("returns null when the list is now empty", () => {
    const threads = [thread("s-a", 1)];

    expect(pickFocusFallback("thread:s-a", buildItems({ threads }), [])).toBeNull();
  });
});
