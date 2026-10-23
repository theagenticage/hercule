import { describe, expect, it } from "vitest";
import {
  listWaiting,
  listWaitingRunSessions,
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
 * Returns the session of a run's step waiting on a command approval, titled
 * "Deploy · <id>", last active at 09:`minutes`.
 */
const waitingRunSession = (id: string, minutes: number): Session =>
  waiting(id, minutes, { title: `Deploy · ${id}`, kind: "run", runId: "run-1", stepId: id });

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
  runners = [MOSS],
  projects = [WEBSHOP_PROJECT, OPS_PROJECT],
  workspaces = [PRIMARY, THREAD_3F1],
  expanded = new Set(),
  selectedId = null,
  draft = null,
  unsentKeys = new Set(),
  doneShelfLimit = null,
  openSession = null,
  unfoldedGroups = new Set(),
  quietShownGroups = new Set(),
  lastOpen = new Map(),
}: {
  readonly threads: readonly Session[];
  readonly assistantRows?: readonly AssistantRow[];
  readonly runSessions?: readonly Session[];
  readonly runners?: readonly Runner[];
  readonly projects?: readonly Project[];
  readonly workspaces?: readonly Workspace[];
  readonly expanded?: ReadonlySet<SectionKey>;
  readonly selectedId?: string | null;
  readonly draft?: DraftPlace | null;
  readonly unsentKeys?: ReadonlySet<string>;
  readonly doneShelfLimit?: number | null;
  readonly openSession?: Session | null;
  readonly unfoldedGroups?: ReadonlySet<string>;
  readonly quietShownGroups?: ReadonlySet<string>;
  readonly lastOpen?: ReadonlyMap<string, string>;
}): Sidebar =>
  buildSidebar({
    sessions: threads,
    openSession,
    unfoldedGroups,
    quietShownGroups,
    lastOpen,
    waiting: listWaiting(threads, assistantRows),
    waitingRunSessions: listWaitingRunSessions(runSessions),
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
            rowPlaceLabel: { clip: "draft workspace", keep: " · draft machine" },
          },
    unsentKeys,
    expanded,
    doneShelfLimit,
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

  it("lists a waiting thread twice: in Waiting on you with its question, and in its project as an approval, counted on the project's header", () => {
    const items = buildItems({ threads: WORLD_THREADS });

    expect(findItem(items, "header:waiting")).toMatchObject({ count: 1 });
    expect(findItem(items, "waiting:thread:s-runbook")).toMatchObject({
      sessionId: "s-runbook",
      title: "s-runbook",
      askerLabel: null,
      question: "Run git push?",
    });
    expect(findItem(items, "group:session:s-runbook")).toMatchObject({
      openId: "s-runbook",
      pose: "waiting",
      status: "approval",
    });
    expect(findItem(items, "header:project:p-webshop")).toMatchObject({ waitingCount: 1 });
    expect(findItem(items, "header:project:p-ops")).toMatchObject({ waitingCount: 0 });
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

  it("sorts a project's threads by when they last started or were reopened, newest first, not by their latest activity", () => {
    const items = buildItems({
      threads: [
        // Created first, but the most recently active.
        thread("s-old", 1, { projectId: OPS_PROJECT.id, lastActivityAt: at(9) }),
        thread("s-new", 3, { projectId: OPS_PROJECT.id, lastActivityAt: at(4) }),
        thread("s-middle", 2, { projectId: OPS_PROJECT.id, lastActivityAt: at(5) }),
        // Created before the others, but reopened after them all.
        thread("s-reopened", 0, { projectId: OPS_PROJECT.id, reopenedAt: at(6) }),
      ],
    });

    expect(listKeys(items)).toEqual([
      "header:project:p-ops",
      "group:session:s-reopened",
      "group:session:s-new",
      "group:session:s-middle",
      "group:session:s-old",
    ]);
  });

  it("gives a thread row that shows its age the time of its last activity, and a working row no time, so it does not draw again as it works", () => {
    const items = buildItems({
      threads: [
        thread("s-old", 1, { projectId: OPS_PROJECT.id, lastActivityAt: at(9) }),
        thread("s-busy", 2, { projectId: OPS_PROJECT.id, status: "busy", lastActivityAt: at(8) }),
      ],
    });

    expect(findItem(items, "group:session:s-old")).toMatchObject({
      status: "age",
      activityAt: at(9),
    });
    expect(findItem(items, "group:session:s-busy")).toMatchObject({
      status: "working",
      activityAt: "",
    });
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

  it(`names on each thread's second line the branch a person chose, else the machine for a generated branch or no workspace`, () => {
    const items = buildItems({
      threads: [
        thread("s-worktree", 3, { projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id }),
        thread("s-primary", 2, { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id }),
        thread("s-bare", 1, { projectId: WEBSHOP_PROJECT.id }),
      ],
    });

    expect(
      items.flatMap((item) =>
        item.kind === "group-row" ? [[item.key, item.placeClip, item.placeKeep]] : [],
      ),
    ).toEqual([
      ["group:workspace:ws-thread-3f1", "moss", ""],
      ["group:workspace:ws-primary", "", "main"],
      ["group:session:s-bare", "moss", ""],
    ]);
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
      "group:workspace:ws-thread-3f1",
      "group:workspace:ws-primary",
      "header:project:p-ops",
      "group:session:s-ops",
    ];

    const joined = buildItems({
      threads,
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id, createsWorkspace: false },
    });
    expect(listKeys(joined)).toEqual(expected);
    expect(findItem(joined, "draft")).toMatchObject({
      kind: "draft-row",
      placeClip: "draft workspace",
      placeKeep: " · draft machine",
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
      "group:session:s-ops",
      "header:project:none",
      "draft",
      "group:session:s-none",
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
        waitingCount: 0,
        section: "project:none",
        leading: 8,
      },
      expect.objectContaining({ key: "group:session:s-a", section: "project:none", leading: 1 }),
      expect.objectContaining({ key: "group:session:s-b", section: "project:none", leading: 2 }),
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
  ])("draws %s with its pose and its status", (_name, over, runner, pose, status) => {
    const items = buildItems({ threads: [thread("s-a", 1, over)], runners: [runner] });

    expect(findItem(items, "group:session:s-a")).toMatchObject({ pose, status });
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

  it("caps the runs' sessions at 3 apart from the threads, and counts the hidden ones on the more row and in the header", () => {
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
  });

  it("shows every run's waiting session once Waiting on you is expanded", () => {
    const runSessions = [1, 2, 3, 4, 5].map((minutes) =>
      waitingRunSession(`step-${String(minutes)}`, minutes),
    );
    const items = buildItems({ threads: [], runSessions, expanded: new Set(["waiting"]) });

    expect(items.filter((item) => item.kind === "waiting-run-row")).toHaveLength(5);
    expect(listKeys(items)).not.toContain("more:waiting");
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
    expect(capped.filter((item) => item.kind === "group-row")).toHaveLength(5);
    expect(findItem(capped, "more:project:p-ops")).toMatchObject({ label: "2 more" });

    const selected = buildItems({ threads, selectedId: "s-1" });
    expect(listKeys(selected)).toContain("group:session:s-1");
    expect(findItem(selected, "more:project:p-ops")).toMatchObject({ label: "1 more" });

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

  it("keeps the open thread's row on the closed Done shelf, and counts what the open shelf hides", () => {
    const threads = [1, 2, 3].map((minutes) =>
      thread(`s-${String(minutes)}`, minutes, { done: { at: at(minutes), by: "user" } }),
    );

    expect(listKeys(buildItems({ threads, selectedId: "s-1" }))).toEqual([
      "header:done",
      "done:session:s-1",
    ]);
    const open = buildItems({ threads, doneShelfLimit: 2 });
    expect(listKeys(open)).toEqual([
      "header:done",
      "done:session:s-3",
      "done:session:s-2",
      "more:done",
    ]);
    expect(findItem(open, "more:done")).toMatchObject({ label: "Show 1 more" });
  });

  it("keeps a done thread with an open request in Waiting on you", () => {
    const items = buildItems({
      threads: [
        waiting("s-asks", 1, { projectId: OPS_PROJECT.id, done: { at: at(2), by: "user" } }),
      ],
    });

    expect(listKeys(items)).toEqual(["header:waiting", "waiting:thread:s-asks", "header:done"]);
  });

  it("recedes a working thread's row, but never the open thread's", () => {
    expect(findItem(buildItems({ threads: WORLD_THREADS }), "group:session:s-flaky")).toMatchObject(
      {
        status: "working",
        receded: true,
      },
    );
    expect(
      findItem(
        buildItems({ threads: WORLD_THREADS, selectedId: "s-flaky" }),
        "group:session:s-flaky",
      ),
    ).toMatchObject({ status: "working", receded: false });
    expect(findItem(buildItems({ threads: WORLD_THREADS }), "group:session:s-bun")).toMatchObject({
      receded: false,
    });
  });

  it("counts the threads working, waiting on the user and idle, from the poses their rows show", () => {
    const { items, counts } = buildFixtureSidebar({ threads: WORLD_THREADS });

    expect(counts).toEqual({ working: 1, waiting: 1, idle: 2 });
    expect(findItem(items, "group:session:s-flaky")).toMatchObject({ pose: "working" });
    expect(findItem(items, "group:session:s-keys")).toMatchObject({ pose: "asleep" });
  });
});

describe("buildSidebar groups", () => {
  it("draws a lone thread as one group row with no dots and no lines", () => {
    const items = buildItems({
      threads: [lead("s-lead", 1)],
      unfoldedGroups: new Set([PRIMARY_GROUP]),
    });

    expect(listKeys(items)).toEqual(["header:project:p-webshop", PRIMARY_ROW]);
    expect(findItem(items, PRIMARY_ROW)).toMatchObject({
      kind: "group-row",
      groupKey: "workspace:ws-primary",
      openId: "s-lead",
      title: "s-lead",
      summary: null,
      unfolded: false,
      doneIds: ["s-lead"],
      details: { members: [] },
    });
  });

  it("draws a group of several sessions as one row with dots, the Threads' Done ids and its members for the card", () => {
    const items = buildItems({
      threads: [lead("s-lead", 1), lead("s-second", 2), partner("s-review", 3, { status: "busy" })],
    });

    expect(listKeys(items)).toEqual(["header:project:p-webshop", PRIMARY_ROW]);
    const row = findItem(items, PRIMARY_ROW);
    expect(row).toMatchObject({
      kind: "group-row",
      title: "s-lead",
      status: "working",
      receded: true,
      unfolded: false,
      doneIds: ["s-lead", "s-second"],
      summary: { dots: ["working", "quiet", "quiet"], hiddenCount: 0 },
    });
    expect(row.kind === "group-row" && row.details.members.map((m) => m.sessionId)).toEqual([
      "s-lead",
      "s-second",
      "s-review",
    ]);
  });

  it("does not recede the row of the group that holds the open session", () => {
    const threads = [lead("s-lead", 1), partner("s-review", 2, { status: "busy" })];

    expect(findItem(buildItems({ threads }), PRIMARY_ROW)).toMatchObject({ receded: true });
    expect(findItem(buildItems({ threads, selectedId: "s-lead" }), PRIMARY_ROW)).toMatchObject({
      receded: false,
      holdsOpen: true,
    });
  });

  it("draws the lines of an unfolded group and folds the quiet sessions into one line", () => {
    const items = buildItems({ threads: CREW, unfoldedGroups: new Set([PRIMARY_GROUP]) });

    expect(listKeys(items)).toEqual([
      "header:project:p-webshop",
      PRIMARY_ROW,
      "line:s-review",
      "quiet:workspace:ws-primary",
    ]);
    expect(findItem(items, PRIMARY_ROW)).toMatchObject({ unfolded: true });
    expect(findItem(items, "line:s-review")).toMatchObject({
      kind: "group-line",
      groupKey: "workspace:ws-primary",
      groupTitle: "s-lead",
      label: "review",
      dot: "working",
      done: false,
      last: false,
    });
    expect(findItem(items, "quiet:workspace:ws-primary")).toMatchObject({
      kind: "quiet-line",
      groupTitle: "s-lead",
      count: 3,
      last: true,
    });
  });

  it("draws a line for every session once the quiet ones are shown, the last line ending the group", () => {
    const items = buildItems({
      threads: CREW,
      unfoldedGroups: new Set([PRIMARY_GROUP]),
      quietShownGroups: new Set(["workspace:ws-primary"]),
    });

    expect(listKeys(items).slice(2)).toEqual([
      "line:s-lead",
      "line:s-review",
      "line:s-lint",
      "line:s-docs",
    ]);
    expect(items.flatMap((item) => (item.kind === "group-line" ? [item.last] : []))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("spaces lines 1px apart and adds 4px after the last line to the space the next item usually has", () => {
    const items = buildItems({
      threads: [...CREW, thread("s-other", 0, { projectId: WEBSHOP_PROJECT.id })],
      unfoldedGroups: new Set([PRIMARY_GROUP]),
    });

    expect(items.map(({ key, leading }) => [key, leading])).toEqual([
      ["header:project:p-webshop", 8],
      [PRIMARY_ROW, 1],
      ["line:s-review", 1],
      ["quiet:workspace:ws-primary", 1],
      [rowOf("s-other"), 6],
    ]);
  });

  it("draws a line for the open session even when it is quiet, and does not count it among the folded ones", () => {
    const items = buildItems({
      threads: [...CREW, partner("s-ci", 5)],
      selectedId: "s-docs",
      unfoldedGroups: new Set([PRIMARY_GROUP]),
    });

    expect(listKeys(items)).toContain("line:s-docs");
    expect(findItem(items, "quiet:workspace:ws-primary")).toMatchObject({ count: 3 });
  });

  it("opens the session last open in the group, else the lead, and the open session while it is in the group", () => {
    const threads = [lead("s-lead", 1), partner("s-review", 2)];
    const openId = (over: Parameters<typeof buildItems>[0]): unknown =>
      (findItem(buildItems(over), PRIMARY_ROW) as { openId: string }).openId;

    expect(openId({ threads })).toBe("s-lead");
    expect(openId({ threads, lastOpen: new Map([["workspace:ws-primary", "s-review"]]) })).toBe(
      "s-review",
    );
    // A session no longer in the group is not opened.
    expect(openId({ threads, lastOpen: new Map([["workspace:ws-primary", "s-gone"]]) })).toBe(
      "s-lead",
    );
    expect(
      openId({
        threads,
        selectedId: "s-lead",
        lastOpen: new Map([["workspace:ws-primary", "s-review"]]),
      }),
    ).toBe("s-lead");
  });

  it("decides whether a click opens in the Office from the session it opens, and each line from its own session", () => {
    const threads = [
      lead("s-lead", 1, { done: { at: at(5), by: "user" } }),
      partner("s-review", 2, { status: "busy" }),
    ];
    const items = buildItems({
      threads,
      lastOpen: new Map([["workspace:ws-primary", "s-lead"]]),
      unfoldedGroups: new Set([PRIMARY_GROUP]),
    });

    expect(findItem(items, PRIMARY_ROW)).toMatchObject({ openId: "s-lead", seated: false });
    expect(findItem(items, "line:s-lead")).toMatchObject({ done: true, seated: false });
    expect(findItem(items, "line:s-review")).toMatchObject({ seated: true });
  });

  it("names a waiting session by its group and tells who asks", () => {
    const items = buildItems({
      threads: [
        lead("s-lead", 1),
        partner("s-review", 2, { status: "busy", openRequests: [APPROVAL] }),
      ],
    });

    expect(findItem(items, "waiting:thread:s-review")).toMatchObject({
      title: "s-lead",
      askerLabel: "review",
      question: "Run git push?",
    });
    expect(findItem(items, PRIMARY_ROW)).toMatchObject({
      status: "approval",
      ask: { askerLabel: "review", question: "Run git push?" },
    });
  });

  it('shows 5 groups of a project and counts the rest as "3 more", keeping the group of the open session', () => {
    const threads = [1, 2, 3, 4, 5, 6, 7, 8].map((minutes) =>
      thread(`s-${String(minutes)}`, minutes, { projectId: OPS_PROJECT.id }),
    );

    const capped = buildItems({ threads });
    expect(capped.filter((item) => item.kind === "group-row")).toHaveLength(5);
    expect(findItem(capped, "more:project:p-ops")).toMatchObject({ label: "3 more" });
    expect(
      findItem(buildItems({ threads, selectedId: "s-1" }), "more:project:p-ops"),
    ).toMatchObject({ label: "2 more" });
  });

  it("keeps a group with a live Agent session in its project until every Thread is done, and puts it on the shelf once both are", () => {
    const done = { at: at(5), by: "user" } as const;
    const partlyDone = [lead("s-lead", 1, { done }), partner("s-review", 2, { status: "busy" })];
    expect(listKeys(buildItems({ threads: partlyDone }))).toEqual([
      "header:project:p-webshop",
      PRIMARY_ROW,
    ]);
    expect(findItem(buildItems({ threads: partlyDone }), PRIMARY_ROW)).toMatchObject({
      doneIds: [],
    });

    const allDone = [lead("s-lead", 1, { done }), partner("s-review", 2, { status: "exited" })];
    const items = buildItems({ threads: allDone, doneShelfLimit: 10 });
    expect(listKeys(items)).toEqual(["header:done", "done:workspace:ws-primary"]);
    expect(findItem(items, "done:workspace:ws-primary")).toMatchObject({
      kind: "done-group-row",
      openId: "s-lead",
      title: "s-lead",
      threadCount: 1,
      doneAt: at(5),
      reopenIds: ["s-lead"],
      details: { projectName: "webshop", members: [expect.anything(), expect.anything()] },
    });
  });

  it("counts every Thread and Agent session that is not done in the foot", () => {
    const { counts } = buildFixtureSidebar({
      threads: [
        lead("s-lead", 1),
        partner("s-review", 2, { status: "busy" }),
        partner("s-asks", 3, { status: "busy", openRequests: [APPROVAL] }),
        thread("s-done", 4, { done: { at: at(5), by: "user" } }),
      ],
    });

    expect(counts).toEqual({ working: 1, waiting: 1, idle: 1 });
  });
});

describe("buildSidebar with the open session", () => {
  const OLD_DONE = thread("s-old", 1, {
    projectId: OPS_PROJECT.id,
    done: { at: at(2), by: "user" },
  });

  it("gives an old Done thread the read left out its row on the closed Done shelf while it is open", () => {
    const sidebar = buildFixtureSidebar({
      threads: [],
      selectedId: "s-old",
      openSession: OLD_DONE,
    });

    expect(listKeys(sidebar.items)).toEqual(["header:done", "done:session:s-old"]);
    expect(sidebar.openGroupKey).toBe("session:s-old");
    expect(listKeys(buildItems({ threads: [], selectedId: "s-old" }))).toEqual([]);
  });

  it("keeps the list's record when both hold the session, and counts the session once", () => {
    const reopened = thread("s-old", 1, { projectId: OPS_PROJECT.id, reopenedAt: at(9) });
    const sidebar = buildFixtureSidebar({
      threads: [reopened],
      selectedId: "s-old",
      openSession: OLD_DONE,
    });

    expect(listKeys(sidebar.items)).toEqual(["header:project:p-ops", rowOf("s-old")]);
    expect(sidebar.counts).toEqual({ working: 0, waiting: 0, idle: 1 });
  });

  it("ignores an open session that is no Thread or Agent session", () => {
    const run = waitingRunSession("approve", 2);

    expect(
      buildFixtureSidebar({ threads: [], selectedId: "approve", openSession: run }).items,
    ).toEqual([]);
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
      unfoldedGroups: new Set([PRIMARY_GROUP]),
      lastOpen: new Map([["workspace:ws-primary", "s-review"]]),
    });

    expect(items.some((item) => item.kind === "group-line")).toBe(true);
    expect(listGoMenuItems(items)).toEqual([
      { destination: { kind: "thread", sessionId: "s-review" }, title: "s-lead" },
    ]);
  });

  it("lists a waiting session once when the group row opens it too", () => {
    const items = buildItems({
      threads: [
        lead("s-lead", 1),
        partner("s-review", 2, { status: "busy", openRequests: [APPROVAL] }),
      ],
      selectedId: "s-review",
    });

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
    const before = buildItems({ threads: CREW, unfoldedGroups: new Set([PRIMARY_GROUP]) });
    const after = buildItems({ threads: CREW });

    expect(pickFocusFallback("line:s-review", before, after)).toBe(PRIMARY_ROW);
    expect(pickFocusFallback("quiet:workspace:ws-primary", before, after)).toBe(PRIMARY_ROW);
  });

  it("picks the first line a pressed quiet line brought into view", () => {
    const unfoldedGroups = new Set([PRIMARY_GROUP]);
    const before = buildItems({ threads: CREW, unfoldedGroups });
    const after = buildItems({
      threads: CREW,
      unfoldedGroups,
      quietShownGroups: new Set(["workspace:ws-primary"]),
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
