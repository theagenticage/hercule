import { describe, expect, it } from "vitest";
import {
  listWaiting,
  listWaitingRunSessions,
  prepareSessionPresentation,
  type AssistantRow,
  type DraftPlace,
} from "@hercule/client-core";
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
import type { OpenRequest, Project, Session, Workspace } from "@hercule/contract";
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
 * Returns the session of a run's step waiting on a command approval, titled
 * "Deploy · <id>", last active at 09:`minutes`.
 */
const waitingRunSession = (id: string, minutes: number): Session =>
  waiting(id, minutes, {
    title: `Deploy · ${id}`,
    kind: "run",
    agentId: "agent-1",
    runId: "run-1",
    stepId: id,
  });

/** Returns the key of the row of the group of the lone thread `id`, which has no workspace. */
const rowOf = (id: string): string => `group:session:${id}`;

/**
 * Returns the sidebar for `threads`, `assistantRows` and the runs'
 * sessions `runSessions`, in the fixture's
 * projects, workspaces and resources. With a `draft`, its row's second line
 * is "draft workspace · draft machine". The Done shelf is closed unless
 * `doneShelfLimit` says how many it shows.
 */
const buildFixtureSidebar = ({
  threads,
  assistantRows = [],
  runSessions = [],
  projects = [WEBSHOP_PROJECT, OPS_PROJECT],
  workspaces = [PRIMARY, THREAD_3F1],
  expanded = new Set(),
  selectedId = null,
  draft = null,
  unsentKeys = new Set(),
  doneShelfLimit = null,
  unfolded = new Set(),
  quietShown = new Set(),
  lastOpen = new Map(),
}: {
  readonly threads: readonly Session[];
  readonly assistantRows?: readonly AssistantRow[];
  readonly runSessions?: readonly Session[];
  readonly projects?: readonly Project[];
  readonly workspaces?: readonly Workspace[];
  readonly expanded?: ReadonlySet<SectionKey>;
  readonly selectedId?: string | null;
  readonly draft?: DraftPlace | null;
  readonly unsentKeys?: ReadonlySet<string>;
  readonly doneShelfLimit?: number | null;
  readonly unfolded?: ReadonlySet<string>;
  readonly quietShown?: ReadonlySet<string>;
  readonly lastOpen?: ReadonlyMap<string, string>;
}): Sidebar => {
  const presentation = prepareSessionPresentation({
    listedSessions: threads,
    openSession: null,
    projects,
    workspaces,
    resources: [WEBSHOP, INFRA, RUNBOOKS],
    runners: [MOSS],
    instances: [],
  });
  return buildSidebar({
    presentation,
    unfolded,
    quietShown,
    lastOpen,
    waiting: listWaiting(presentation.waitingSessions, assistantRows),
    waitingRunSessions: listWaitingRunSessions(runSessions),
    projects,
    draft:
      draft === null
        ? null
        : {
            place: draft,
            rowPlaceLabel: { clip: "draft workspace", keep: " · draft machine" },
          },
    unsentKeys,
    expanded,
    doneShelfLimit,
    selectedId,
  });
};

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
  waiting("s-runbook", 5, { projectId: WEBSHOP_PROJECT.id }),
  thread("s-flaky", 4, { status: "busy", projectId: WEBSHOP_PROJECT.id }),
  thread("s-bun", 3, { projectId: WEBSHOP_PROJECT.id }),
  thread("s-keys", 2, { status: "exited", resumable: true, projectId: OPS_PROJECT.id }),
  thread("s-price", 1),
];

/** The key of the row of the group working in webshop's main workspace. */
const PRIMARY_ROW = "group:workspace:ws-primary";

/** The key of that group, as the sidebar keeps it for what the user unfolded. */
const PRIMARY_GROUP = "workspace:ws-primary";

/** Returns a Thread in webshop's main workspace, which leads the group when it is the oldest. */
const lead = (id: string, minutes: number, over: Partial<Session> = {}): Session =>
  thread(id, minutes, { workspaceId: PRIMARY.id, projectId: WEBSHOP_PROJECT.id, ...over });

/** Returns an Agent's session working beside the lead in webshop's main workspace. */
const partner = (id: string, minutes: number, over: Partial<Session> = {}): Session =>
  thread(id, minutes, {
    agentId: "agent-1",
    role: id.replace("s-", ""),
    workspaceId: PRIMARY.id,
    projectId: WEBSHOP_PROJECT.id,
    ...over,
  });

/** A lead with a working reviewer and two idle partners: 3 sessions are quiet, 1 works. */
const CREW = [
  lead("s-lead", 1),
  partner("s-review", 2, { status: "busy" }),
  partner("s-lint", 3),
  partner("s-docs", 4),
];

describe("buildSidebar", () => {
  it("lays out Waiting on you, then each project's threads in one list, then the threads in no project", () => {
    const items = buildItems({ threads: WORLD_THREADS });

    expect(items.map(({ kind, key, section, leading }) => [kind, key, section, leading])).toEqual([
      ["waiting-header", "header:waiting", "waiting", 8],
      ["waiting-thread-row", "waiting:thread:s-runbook", "waiting", 1],
      ["project-header", "header:project:p-webshop", "project:p-webshop", 8],
      ["group-row", "group:session:s-runbook", "project:p-webshop", 1],
      ["group-row", "group:session:s-flaky", "project:p-webshop", 2],
      ["group-row", "group:session:s-bun", "project:p-webshop", 2],
      ["project-header", "header:project:p-ops", "project:p-ops", 8],
      ["group-row", "group:session:s-keys", "project:p-ops", 1],
      ["project-header", "header:project:none", "project:none", 8],
      ["group-row", "group:session:s-price", "project:none", 1],
    ]);
  });

  it("lists a waiting thread twice: in Waiting on you under its group's name with its question, and in its project, counted on the project's header", () => {
    const items = buildItems({ threads: WORLD_THREADS });

    expect(findItem(items, "header:waiting")).toMatchObject({ count: 1 });
    expect(findItem(items, "waiting:thread:s-runbook")).toMatchObject({
      sessionId: "s-runbook",
      title: "s-runbook",
      askerLabel: null,
      question: "Run git push?",
    });
    expect(findItem(items, "group:session:s-runbook")).toMatchObject({ kind: "group-row" });
    expect(findItem(items, "header:project:p-webshop")).toMatchObject({ waitingCount: 1 });
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

  it("gives the card of a row the project, machine and branch of the row", () => {
    const items = buildItems({
      threads: [thread("s-primary", 2, { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id })],
    });

    expect(findItem(items, "group:workspace:ws-primary")).toMatchObject({
      details: { projectName: "webshop", machine: "moss", branch: "main" },
    });
  });

  it("marks the threads whose composer holds unsent work, by session id", () => {
    const items = buildItems({
      threads: [thread("s-unsent", 2), thread("s-sent", 1)],
      unsentKeys: new Set(["s-unsent"]),
    });

    expect(findItem(items, "group:session:s-unsent")).toMatchObject({ unsent: true });
    expect(findItem(items, "group:session:s-sent")).toMatchObject({ unsent: false });
  });

  it("puts the draft's row first in the project that holds it", () => {
    const threads = [
      thread("s-worktree", 3, { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id }),
      // ops has the newest thread, so it would come first without the draft.
      thread("s-ops", 4, { projectId: OPS_PROJECT.id }),
    ];

    const items = buildItems({
      threads,
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id, createsWorkspace: false },
    });

    expect(listKeys(items)).toEqual([
      "header:project:p-webshop",
      "draft",
      "group:workspace:ws-thread-3f1",
      "header:project:p-ops",
      "group:session:s-ops",
    ]);
    expect(findItem(items, "draft")).toMatchObject({
      kind: "draft-row",
      placeClip: "draft workspace",
      placeKeep: " · draft machine",
    });
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
        waitingCount: 0,
        section: "project:none",
        leading: 8,
      },
      expect.objectContaining({ key: "group:session:s-a", section: "project:none", leading: 1 }),
      expect.objectContaining({ key: "group:session:s-b", section: "project:none", leading: 2 }),
    ]);
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

  it("draws a waiting assistant in Waiting on you by its name and question", () => {
    const items = buildItems({ threads: [], assistantRows: [waitingAssistant("ada", 3)] });

    expect(listKeys(items)).toEqual(["header:waiting", "waiting:assistant:ada"]);
    expect(findItem(items, "waiting:assistant:ada")).toMatchObject({
      kind: "waiting-assistant-row",
      assistantId: "ada",
      name: "ada",
      question: "Run git push?",
      leading: 1,
    });
  });

  it(`draws the runs' waiting sessions under "From runs", below the threads, 7px below them`, () => {
    const items = buildItems({
      threads: [waiting("s-a", 1)],
      runSessions: [waitingRunSession("approve", 2)],
    }).filter((item) => item.section === "waiting");

    expect(listKeys(items)).toEqual([
      "header:waiting",
      "waiting:thread:s-a",
      "label:waiting-runs",
      "waiting-run:approve",
    ]);
    expect(findItem(items, "header:waiting")).toMatchObject({ count: 2 });
    expect(findItem(items, "label:waiting-runs")).toMatchObject({ leading: 7 });
    expect(findItem(items, "waiting-run:approve")).toMatchObject({
      kind: "waiting-run-row",
      sessionId: "approve",
      title: "Deploy · approve",
      question: "Run git push?",
      leading: 1,
    });
  });

  it("draws Waiting on you for a run's waiting session when no thread waits, 7px between the header and From runs", () => {
    const items = buildItems({
      threads: [],
      workspaces: [],
      runSessions: [waitingRunSession("approve", 2)],
    });

    expect(listKeys(items)).toEqual([
      "header:waiting",
      "label:waiting-runs",
      "waiting-run:approve",
    ]);
    expect(findItem(items, "header:waiting")).toMatchObject({ count: 1 });
    // The book's 6px margin and the section's 1px gap, whatever sits above.
    expect(findItem(items, "label:waiting-runs")).toMatchObject({ leading: 7 });
  });

  it("caps the runs' sessions at 3 apart from the threads, counts the hidden ones on the more row and in the header, and shows them all once expanded", () => {
    const threads = [1, 2, 3, 4].map((minutes) => waiting(`s-${String(minutes)}`, minutes));
    const runSessions = [11, 12, 13, 14, 15].map((minutes) =>
      waitingRunSession(`step-${String(minutes)}`, minutes),
    );
    const items = buildItems({ threads, runSessions }).filter((item) => item.section === "waiting");

    expect(listKeys(items)).toEqual([
      "header:waiting",
      "waiting:thread:s-4",
      "waiting:thread:s-3",
      "waiting:thread:s-2",
      "label:waiting-runs",
      "waiting-run:step-15",
      "waiting-run:step-14",
      "waiting-run:step-13",
      "more:waiting",
    ]);
    expect(findItem(items, "header:waiting")).toMatchObject({ count: 9 });
    expect(findItem(items, "more:waiting")).toMatchObject({ label: "3 more waiting on you" });

    const expanded = buildItems({ threads: [], runSessions, expanded: new Set(["waiting"]) });
    expect(expanded.filter((item) => item.kind === "waiting-run-row")).toHaveLength(5);
    expect(listKeys(expanded)).not.toContain("more:waiting");
  });

  it("counts the groups a project hides on its more row, and draws them all once the section is expanded", () => {
    const threads = [1, 2, 3, 4, 5, 6, 7].map((minutes) =>
      thread(`s-${String(minutes)}`, minutes, { projectId: OPS_PROJECT.id }),
    );

    const capped = buildItems({ threads });
    expect(capped.filter((item) => item.kind === "group-row")).toHaveLength(5);
    expect(findItem(capped, "more:project:p-ops")).toMatchObject({ label: "2 more" });

    const expanded = buildItems({ threads, expanded: new Set(["project:p-ops"]) });
    expect(expanded.filter((item) => item.kind === "group-row")).toHaveLength(7);
    expect(listKeys(expanded)).not.toContain("more:project:p-ops");
  });

  it("shows every thread in no project once that section is expanded", () => {
    const threads = [1, 2, 3, 4, 5, 6, 7].map((minutes) => thread(`s-${String(minutes)}`, minutes));

    const items = buildItems({ threads, expanded: new Set(["project:none"]) });
    expect(items.filter((item) => item.kind === "group-row")).toHaveLength(7);
    expect(listKeys(items)).not.toContain("more:project:none");
  });

  it("takes a done thread out of its project and onto the Done shelf, which shows only its count while closed", () => {
    const threads = [
      thread("s-open", 3, { projectId: OPS_PROJECT.id }),
      thread("s-done", 2, { projectId: OPS_PROJECT.id, done: { at: at(4), by: "user" } }),
    ];

    expect(listKeys(buildItems({ threads }))).toEqual([
      "header:project:p-ops",
      "group:session:s-open",
      "header:done",
    ]);
    const open = buildItems({ threads, doneShelfLimit: 10 });
    expect(listKeys(open)).toEqual([
      "header:project:p-ops",
      "group:session:s-open",
      "header:done",
      "done:session:s-done",
    ]);
    expect(findItem(open, "header:done")).toMatchObject({ count: 1, open: true, section: "done" });
    expect(findItem(open, "done:session:s-done")).toMatchObject({ doneAt: at(4), leading: 1 });
  });

  it("counts what the open Done shelf hides on a more row", () => {
    const threads = [1, 2, 3].map((minutes) =>
      thread(`s-${String(minutes)}`, minutes, { done: { at: at(minutes), by: "user" } }),
    );

    const open = buildItems({ threads, doneShelfLimit: 2 });

    expect(listKeys(open)).toEqual([
      "header:done",
      "done:session:s-3",
      "done:session:s-2",
      "more:done",
    ]);
    expect(findItem(open, "more:done")).toMatchObject({ label: "Show 1 more" });
  });

  it("recedes a working row, but never the row of the group that holds the open session", () => {
    const threads = [
      ...WORLD_THREADS,
      lead("s-lead", 6),
      partner("s-review", 7, { status: "busy" }),
    ];
    const isReceded = (key: string, selectedId: string | null = null): boolean => {
      const item = findItem(buildItems({ threads, selectedId }), key);
      return item.kind === "group-row" && item.receded;
    };

    expect(isReceded("group:session:s-flaky")).toBe(true);
    expect(isReceded("group:session:s-bun")).toBe(false);
    expect(isReceded("group:session:s-flaky", "s-flaky")).toBe(false);
    // The open session may be a partner in a working group.
    expect(isReceded(PRIMARY_ROW)).toBe(true);
    expect(isReceded(PRIMARY_ROW, "s-lead")).toBe(false);
    expect(buildFixtureSidebar({ threads, selectedId: "s-lead" }).openGroupKey).toBe(PRIMARY_GROUP);
  });
});

describe("buildSidebar groups", () => {
  it("draws a group of several sessions as one row that carries its record, and a lone thread's row with no members for the card", () => {
    const crew = [
      lead("s-lead", 1),
      lead("s-second", 2),
      partner("s-review", 3, { status: "busy" }),
    ];
    const items = buildItems({ threads: crew });

    expect(listKeys(items)).toEqual(["header:project:p-webshop", PRIMARY_ROW]);
    const row = findItem(items, PRIMARY_ROW);
    expect(row).toMatchObject({
      kind: "group-row",
      row: { key: PRIMARY_GROUP, title: "s-lead", doneIds: ["s-lead", "s-second"] },
      openId: "s-lead",
      unfolded: false,
    });
    expect(row.kind === "group-row" && row.details.members.map((m) => m.sessionId)).toEqual([
      "s-review",
      "s-lead",
      "s-second",
    ]);
    expect(findItem(buildItems({ threads: [lead("s-solo", 1)] }), PRIMARY_ROW)).toMatchObject({
      details: { members: [] },
    });
  });

  it("draws the lines of an unfolded group, the last one ending it, and the quiet line while it folds them", () => {
    const folded = buildItems({ threads: CREW, unfolded: new Set([PRIMARY_GROUP]) });

    expect(listKeys(folded)).toEqual([
      "header:project:p-webshop",
      PRIMARY_ROW,
      "line:s-review",
      "quiet:workspace:ws-primary",
    ]);
    expect(findItem(folded, PRIMARY_ROW)).toMatchObject({ unfolded: true });
    expect(findItem(folded, "line:s-review")).toMatchObject({
      kind: "group-line",
      groupKey: PRIMARY_GROUP,
      groupTitle: "s-lead",
      member: { sessionId: "s-review", label: "review", dot: "working" },
      last: false,
    });
    expect(findItem(folded, "quiet:workspace:ws-primary")).toMatchObject({
      kind: "quiet-line",
      groupTitle: "s-lead",
      count: 3,
      last: true,
    });

    const shown = buildItems({
      threads: CREW,
      unfolded: new Set([PRIMARY_GROUP]),
      quietShown: new Set([PRIMARY_GROUP]),
    });
    expect(listKeys(shown).slice(2)).toEqual([
      "line:s-lead",
      "line:s-review",
      "line:s-lint",
      "line:s-docs",
    ]);
    expect(shown.flatMap((item) => (item.kind === "group-line" ? [item.last] : []))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("spaces lines 1px apart and adds 4px after the last line to the space the next item usually has", () => {
    const items = buildItems({
      threads: [...CREW, thread("s-other", 0, { projectId: WEBSHOP_PROJECT.id })],
      unfolded: new Set([PRIMARY_GROUP]),
    });

    expect(items.map(({ key, leading }) => [key, leading])).toEqual([
      ["header:project:p-webshop", 8],
      [PRIMARY_ROW, 1],
      ["line:s-review", 1],
      ["quiet:workspace:ws-primary", 1],
      [rowOf("s-other"), 6],
    ]);
  });

  it("draws a group on the Done shelf as one row with the group's Threads to reopen", () => {
    const done = { at: at(5), by: "user" } as const;
    const items = buildItems({
      threads: [lead("s-lead", 1, { done }), partner("s-review", 2, { status: "exited" })],
      doneShelfLimit: 10,
    });

    expect(listKeys(items)).toEqual(["header:done", "done:workspace:ws-primary"]);
    expect(findItem(items, "done:workspace:ws-primary")).toMatchObject({
      kind: "done-group-row",
      row: { key: PRIMARY_GROUP, title: "s-lead", threadIds: ["s-lead"] },
      openId: "s-lead",
      doneAt: at(5),
      details: { projectName: "webshop", members: [expect.anything(), expect.anything()] },
    });
  });

  describe("on the Done shelf", () => {
    const done = { at: at(5), by: "user" } as const;
    /** A lead and a second Thread, both Done, and a reviewer that has ended. */
    const DONE_CREW = [
      lead("s-lead", 1, { done }),
      lead("s-second", 2, { done }),
      partner("s-review", 3, { status: "exited" }),
    ];
    const DONE_ROW = "done:workspace:ws-primary";

    it("draws every line of an unfolded group, because all its sessions are quiet, and spaces a row after them like a row after the lines of a group in a project", () => {
      const other = thread("s-other", 0, { done: { at: at(4), by: "user" } });
      const items = buildItems({
        threads: [...DONE_CREW, other],
        doneShelfLimit: 10,
        unfolded: new Set([PRIMARY_GROUP]),
      });

      expect(items.map(({ key, leading }) => [key, leading])).toEqual([
        ["header:done", 8],
        [DONE_ROW, 1],
        ["line:s-lead", 1],
        ["line:s-second", 1],
        ["line:s-review", 1],
        ["done:session:s-other", 6],
      ]);
      expect(findItem(items, DONE_ROW)).toMatchObject({ unfolded: true });
      expect(findItem(items, "line:s-lead")).toMatchObject({ section: "done" });
    });
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

  it("lists no run's waiting session", () => {
    const items = buildItems({
      threads: [waiting("s-new", 5)],
      runSessions: [waitingRunSession("approve", 6)],
    });
    expect(items.some((item) => item.kind === "waiting-run-row")).toBe(true);
    expect(listGoMenuItems(items)).toEqual([
      { destination: { kind: "thread", sessionId: "s-new" }, title: "s-new" },
    ]);
  });

  it("lists one entry per group row, titled with the group and opening the session the row opens, and no line", () => {
    const items = buildItems({
      threads: CREW,
      unfolded: new Set([PRIMARY_GROUP]),
      lastOpen: new Map([["workspace:ws-primary", "s-review"]]),
    });

    expect(items.some((item) => item.kind === "group-line")).toBe(true);
    expect(listGoMenuItems(items)).toEqual([
      { destination: { kind: "thread", sessionId: "s-review" }, title: "s-lead" },
    ]);
  });

  it("lists a group once when a partner waits, opening the session that asks", () => {
    const items = buildItems({
      threads: [
        lead("s-lead", 1),
        partner("s-review", 2, { status: "busy", openRequests: [APPROVAL] }),
      ],
      selectedId: "s-lead",
    });

    expect(items.filter((item) => item.kind === "group-row")).toHaveLength(1);
    expect(listGoMenuItems(items)).toEqual([
      { destination: { kind: "thread", sessionId: "s-review" }, title: "s-lead" },
    ]);
  });

  it("lists no thread on the Done shelf", () => {
    const items = buildItems({
      threads: [thread("s-done", 1, { done: { at: at(2), by: "user" } })],
      doneShelfLimit: 10,
    });
    expect(listKeys(items)).toContain("done:session:s-done");
    expect(listGoMenuItems(items)).toEqual([]);
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

  it("picks the first run's session a pressed more row brought into view", () => {
    const runSessions = [1, 2, 3, 4].map((minutes) =>
      waitingRunSession(`step-${String(minutes)}`, minutes),
    );
    const before = buildItems({ threads: [], runSessions });
    const after = buildItems({ threads: [], runSessions, expanded: new Set(["waiting"]) });

    expect(pickFocusFallback("more:waiting", before, after)).toBe("waiting-run:step-1");
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
      "group:session:s-ops",
      "header:project:none",
      "group:session:s-last",
    ]);
    expect(pickFocusFallback("group:session:s-ops", before, after)).toBe("group:session:s-last");
  });

  it("picks the group's row when a line leaves because the group folded", () => {
    const before = buildItems({ threads: CREW, unfolded: new Set([PRIMARY_GROUP]) });
    const after = buildItems({ threads: CREW });

    expect(pickFocusFallback("line:s-review", before, after)).toBe(PRIMARY_ROW);
    expect(pickFocusFallback("quiet:workspace:ws-primary", before, after)).toBe(PRIMARY_ROW);
  });

  it("picks the row of a group on the Done shelf when a line leaves because the group folded", () => {
    const done = { at: at(5), by: "user" } as const;
    const threads = [
      lead("s-lead", 1, { done }),
      lead("s-second", 2, { done }),
      partner("s-review", 3, { status: "exited" }),
    ];
    const before = buildItems({
      threads,
      doneShelfLimit: 10,
      unfolded: new Set([PRIMARY_GROUP]),
    });
    const after = buildItems({ threads, doneShelfLimit: 10 });

    expect(pickFocusFallback("line:s-review", before, after)).toBe("done:workspace:ws-primary");
  });

  it("picks the first line a pressed quiet line brought into view", () => {
    const unfolded = new Set([PRIMARY_GROUP]);
    const before = buildItems({ threads: CREW, unfolded });
    const after = buildItems({
      threads: CREW,
      unfolded,
      quietShown: new Set([PRIMARY_GROUP]),
    });

    expect(pickFocusFallback("quiet:workspace:ws-primary", before, after)).toBe("line:s-lead");
  });

  it("picks the section's header when the row of a group leaves it for the Done shelf", () => {
    const other = thread("s-other", 0, { projectId: WEBSHOP_PROJECT.id });
    const before = buildItems({ threads: [lead("s-lead", 1), other] });
    const after = buildItems({
      threads: [lead("s-lead", 1, { done: { at: at(5), by: "user" } }), other],
    });

    expect(pickFocusFallback(PRIMARY_ROW, before, after)).toBe("header:project:p-webshop");
  });

  it("returns null when the list is now empty", () => {
    const threads = [thread("s-a", 1)];

    expect(pickFocusFallback("group:session:s-a", buildItems({ threads }), [])).toBeNull();
  });
});
