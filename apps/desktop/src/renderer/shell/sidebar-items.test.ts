import { describe, expect, it } from "vitest";
import type { DraftPlace } from "@hercule/client-core";
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
import {
  buildSidebar,
  listGoMenuThreads,
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

/** Returns a thread in no project, idle on moss, last active at 09:`minutes`. */
const thread = (id: string, minutes: number, over: Partial<Session> = {}): Session =>
  buildSession({ id, title: id, lastActivityAt: at(minutes), ...over });

/** Returns a thread waiting on a command approval. */
const waiting = (id: string, minutes: number, over: Partial<Session> = {}): Session =>
  thread(id, minutes, { status: "busy", openRequest: APPROVAL, ...over });

/**
 * Returns the sidebar for `threads`, in the fixture's projects, workspaces and
 * resources. With a `draft`, its row's second line is "draft meta".
 */
const buildFixtureSidebar = ({
  threads,
  runners = [MOSS],
  projects = [WEBSHOP_PROJECT, OPS_PROJECT],
  workspaces = [PRIMARY, THREAD_3F1],
  expanded = new Set(),
  selectedId = null,
  draft = null,
}: {
  readonly threads: readonly Session[];
  readonly runners?: readonly Runner[];
  readonly projects?: readonly Project[];
  readonly workspaces?: readonly Workspace[];
  readonly expanded?: ReadonlySet<SectionKey>;
  readonly selectedId?: string | null;
  readonly draft?: DraftPlace | null;
}): Sidebar =>
  buildSidebar({
    threads,
    projects,
    workspaces,
    resources: [WEBSHOP, INFRA, RUNBOOKS],
    runners,
    instances: [],
    draft: draft === null ? null : { place: draft, rowMeta: "draft meta" },
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
  it("lays out Waiting on you, then each project with its workspace labels, then the threads in no project", () => {
    const items = buildItems({ threads: WORLD_THREADS });

    expect(items.map(({ kind, key, section, leading }) => [kind, key, section, leading])).toEqual([
      ["waiting-header", "header:waiting", "waiting", 8],
      ["waiting-row", "waiting:s-runbook", "waiting", 1],
      ["project-header", "header:project:p-webshop", "project:p-webshop", 8],
      ["workspace-label", "workspace:project:p-webshop:ws-thread-3f1", "project:p-webshop", 1],
      ["thread-row", "thread:s-runbook", "project:p-webshop", 1],
      ["thread-row", "thread:s-flaky", "project:p-webshop", 1],
      ["workspace-label", "workspace:project:p-webshop:ws-primary", "project:p-webshop", 9],
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
    expect(findItem(items, "waiting:s-runbook")).toMatchObject({
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

  it("draws a workspace label only for a group that has one", () => {
    const items = buildItems({
      threads: [
        thread("s-worktree", 3, { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id }),
        thread("s-bare", 2, { projectId: WEBSHOP_PROJECT.id }),
        thread("s-ops", 1, { projectId: OPS_PROJECT.id }),
      ],
    });

    // A project with threads in two places labels both, including the
    // threads that work without a checkout. A project whose threads all
    // work in one place, and the threads in no project, have no label.
    expect(
      items.flatMap((item) =>
        item.kind === "workspace-label" ? [[item.joinableWorkspaceId, item.clip, item.keep]] : [],
      ),
    ).toEqual([
      [THREAD_3F1.id, "hercule/thread-3f1", ""],
      [null, "no workspace", ""],
    ]);
  });

  it("offers no workspace for a new thread to join on the label of a workspace that is not ready", () => {
    const items = buildItems({
      threads: [
        thread("s-worktree", 2, { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id }),
        thread("s-bare", 1, { projectId: WEBSHOP_PROJECT.id }),
      ],
      workspaces: [PRIMARY, { ...THREAD_3F1, status: "failed" }],
    });

    expect(
      items.flatMap((item) =>
        item.kind === "workspace-label" ? [[item.joinableWorkspaceId, item.clip]] : [],
      ),
    ).toEqual([
      [null, "hercule/thread-3f1"],
      [null, "no workspace"],
    ]);
  });

  it("puts 8 px more space above a workspace label that follows a thread row than above one that follows its project's header", () => {
    const items = buildItems({
      threads: [
        thread("s-worktree", 3, { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id }),
        thread("s-primary", 2, { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id }),
        thread("s-bare", 1, { projectId: WEBSHOP_PROJECT.id }),
      ],
    });

    expect(items.map(({ key, leading }) => [key, leading])).toEqual([
      ["header:project:p-webshop", 8],
      ["workspace:project:p-webshop:ws-thread-3f1", 1],
      ["thread:s-worktree", 1],
      ["workspace:project:p-webshop:ws-primary", 9],
      ["thread:s-primary", 1],
      ["workspace:project:p-webshop:none", 9],
      ["thread:s-bare", 1],
    ]);
  });

  it("puts the draft's row last in its group, and as much space after it as after a thread row", () => {
    const threads = [
      thread("s-worktree", 3, { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id }),
      thread("s-primary", 2, { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id }),
    ];
    const joined = buildItems({
      threads,
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id, createsWorkspace: false },
    });
    const ownGroup = buildItems({
      threads,
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: null, createsWorkspace: true },
    });

    expect(joined.map(({ key, leading }) => [key, leading])).toEqual([
      ["header:project:p-webshop", 8],
      ["workspace:project:p-webshop:ws-thread-3f1", 1],
      ["thread:s-worktree", 1],
      ["draft", 1],
      ["workspace:project:p-webshop:ws-primary", 9],
      ["thread:s-primary", 1],
    ]);
    // A draft that creates its workspace sits directly under the header.
    expect(ownGroup.map(({ key, leading }) => [key, leading])).toEqual([
      ["header:project:p-webshop", 8],
      ["draft", 1],
      ["workspace:project:p-webshop:ws-thread-3f1", 9],
      ["thread:s-worktree", 1],
      ["workspace:project:p-webshop:ws-primary", 9],
      ["thread:s-primary", 1],
    ]);
    expect(findItem(joined, "draft")).toMatchObject({ kind: "draft-row", meta: "draft meta" });
  });

  it(`heads the threads in no project "No project", with no tint and no project to start a thread in`, () => {
    const items = buildItems({ threads: [thread("s-a", 2), thread("s-b", 1)] });

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
      "waiting:s-5",
      "waiting:s-4",
      "waiting:s-3",
      "more:waiting",
    ]);
    expect(findItem(items, "header:waiting")).toMatchObject({ count: 5 });
    expect(findItem(items, "more:waiting")).toMatchObject({ label: "2 more waiting on you" });
  });

  it("shows every waiting thread once Waiting on you is expanded", () => {
    const threads = [1, 2, 3, 4, 5].map((minutes) => waiting(`s-${String(minutes)}`, minutes));
    const items = buildItems({ threads, expanded: new Set(["waiting"]) }).filter(
      (item) => item.section === "waiting",
    );

    expect(items.filter((item) => item.kind === "waiting-row")).toHaveLength(5);
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

  it("returns no items when there are no threads", () => {
    expect(buildItems({ threads: [] })).toEqual([]);
  });

  it("counts the threads working, waiting on the user and idle, from the poses their rows show", () => {
    const { items, counts } = buildFixtureSidebar({ threads: WORLD_THREADS });

    expect(counts).toEqual({ working: 1, waiting: 1, idle: 2 });
    expect(findItem(items, "thread:s-flaky")).toMatchObject({ pose: "working" });
    expect(findItem(items, "thread:s-keys")).toMatchObject({ pose: "asleep" });
  });
});

describe("listGoMenuThreads", () => {
  it("lists the threads top to bottom, a waiting thread once, where it shows first", () => {
    expect(listGoMenuThreads(buildItems({ threads: WORLD_THREADS }))).toEqual([
      { sessionId: "s-runbook", title: "s-runbook" },
      { sessionId: "s-flaky", title: "s-flaky" },
      { sessionId: "s-bun", title: "s-bun" },
      { sessionId: "s-keys", title: "s-keys" },
      { sessionId: "s-price", title: "s-price" },
    ]);
  });

  it("lists no thread a more row hides", () => {
    const threads = [1, 2, 3, 4, 5, 6, 7].map((minutes) =>
      thread(`s-${String(minutes)}`, minutes, { projectId: OPS_PROJECT.id }),
    );
    expect(listGoMenuThreads(buildItems({ threads })).map((each) => each.sessionId)).toEqual([
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
    expect(listGoMenuThreads(items).map((each) => each.sessionId)).toEqual(
      ["12", "11", "10", "9", "8", "7", "6", "5", "4"].map((number) => `s-${number}`),
    );
  });

  it("lists no draft", () => {
    const items = buildItems({
      threads: [],
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: null, createsWorkspace: true },
    });
    expect(items.some((item) => item.kind === "draft-row")).toBe(true);
    expect(listGoMenuThreads(items)).toEqual([]);
  });
});

describe("pickFocusFallback", () => {
  const FIVE_WAITING = [1, 2, 3, 4, 5].map((minutes) => waiting(`s-${String(minutes)}`, minutes));

  it("picks the first row a pressed more row brought into view", () => {
    const before = buildItems({ threads: FIVE_WAITING });
    const after = buildItems({ threads: FIVE_WAITING, expanded: new Set(["waiting"]) });

    expect(pickFocusFallback("more:waiting", before, after)).toBe("waiting:s-2");
  });

  it("picks the section's more row when a row leaves a capped section", () => {
    const before = buildItems({ threads: FIVE_WAITING });
    const answered = FIVE_WAITING.map((session) =>
      session.id === "s-5" ? { ...session, openRequest: null } : session,
    );
    const after = buildItems({ threads: answered });

    expect(pickFocusFallback("waiting:s-5", before, after)).toBe("more:waiting");
  });

  it("picks the section's header when a row leaves a section with no more row", () => {
    const threads = [waiting("s-a", 2), waiting("s-b", 1)];
    const before = buildItems({ threads });
    const after = buildItems({ threads: [threads[0]!, { ...threads[1]!, openRequest: null }] });

    expect(pickFocusFallback("waiting:s-b", before, after)).toBe("header:waiting");
  });

  it("picks the item that now sits in the gone item's place when its section is gone", () => {
    const threads = [thread("s-ops", 2, { projectId: OPS_PROJECT.id }), thread("s-last", 1)];
    const before = buildItems({ threads });
    const after = buildItems({ threads: [threads[1]!] });

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
