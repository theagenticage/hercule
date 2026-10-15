/**
 * The desktop perf script's Discussions scenario: one plain launch of the app
 * on a Discussion with 190 Posts, among 60 Discussions in the list, which
 * measures the rows of spec 17 §What Discussions and Wiki cost that a script
 * can measure:
 *
 * - processes and memory with the Discussion open (see
 *   `measureDiscussionWork`);
 * - each process's CPU and wakeups with the Discussion open, visible and
 *   hidden, and how often the age clock fired in each sample;
 * - what one new Post costs while the Discussion is open: how many reads it
 *   causes, by what they read, how long after it the last of them answered,
 *   and the renderer's main thread and CPU, and the controller's CPU, per
 *   Post. Ten Posts take the Discussion to 200, the most it holds, so the
 *   memory is read again with 200 Posts open;
 * - which live topics the page holds on the Discussion, with the window
 *   hidden and shown again, on a wiki page, and on Settings, where no
 *   Discussions or Wiki screen is open (see `recordHeldTopics`).
 *
 * The seed (see `seedDiscussions`), all written by the agent sessions of the
 * fixture's busy threads, each with its own credential, as agents write:
 *
 * - 59 Discussions of one to three Posts each, then one Discussion of 190
 *   Posts, which the app opens. The list's first page holds 50, so the list
 *   holds more than one page;
 * - one wiki page with 60 revisions, 10 more than `wikiPage.read` lists.
 *
 * Only busy threads write, because a Discussion Input may open a turn of an
 * idle participant, and the fixture's census expects each thread to stay in
 * its state. The fixture sets the Discussions' times hours back (see
 * `prepareLaunch`), so no age on screen changes during a sample. The
 * Discussion's Posts show clock times, which never change.
 *
 * The routes' chunks and the first screen's bytes are not measured here:
 * `pnpm build:desktop`'s bundle check prints them.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import type {
  DiscussionCreated,
  Project,
  Resource,
  Session,
  WikiPage,
} from "../../../packages/contract/src/index";
import {
  assertExitedCleanly,
  connectInspector,
  type Inspector,
  evaluateInMain,
  formatTable,
  launchPlainApp,
  stopPlainApp,
} from "./packaged-app.ts";
import type { ThreadFixture } from "./perf-fixture.ts";
import {
  BUDGET,
  MEMORY_READ_AT_MS,
  READ_HELD_TOPICS,
  RECORD_FRAMES,
  SAMPLE_MS,
  VISIBLE_SAMPLE_AT_MS,
  buildTopicRows,
  evaluateInPage,
  openScreenOnce,
  readCpuMs,
  readProcessMemory,
  waitForPageSocketUrl,
  warmUpApp,
  type ProcessMemory,
  type TopicStep,
} from "./perf-measures.ts";
import {
  READ_READS,
  buildAtRestRows,
  callWindow,
  countAgeClockFires,
  findRendererPid,
  printLaunch,
  readMainThreadMs,
  sampleVisibleAndHidden,
  type BudgetRow,
  type LaunchAtRest,
  type Read,
} from "./perf-workflows.ts";
import { pollUntil } from "./poll.ts";

/** One Post of the open Discussion in the page, which the Posts list draws as a message. */
const POST_SELECTOR = ".open-pane .posts .msg";

/**
 * How many Discussions the seed makes in all, the open one among them. The
 * list reads 50 at a time, so this is more than its first page.
 */
const DISCUSSION_COUNT = 60;

/** How many Posts the open Discussion holds when the app launches. */
const POSTS_AT_LAUNCH = 190;

/** The most Posts a Discussion holds, which the measured Posts take the open Discussion to. */
const MAX_POSTS = 200;

/** How many Posts are written while the Discussion is open, one at a time. */
const PUSH_COUNT = MAX_POSTS - POSTS_AT_LAUNCH;
const PUSH_INTERVAL_MS = 1_000;

/** How long after the last Post the reading ends, so the last reads are in it. */
const PUSH_SETTLE_MS = 2_000;

/** How many revisions the wiki page has. `wikiPage.read` lists the newest 50. */
const WIKI_REVISIONS = 60;

/** How long a step of `recordHeldTopics` waits before it reads the topics held. */
const TOPIC_SETTLE_MS = 2_000;

/** How long the app is left alone after the Posts, before its memory is read again. */
const MEMORY_SETTLE_MS = 3_000;

/**
 * How many entries the page's resource timing buffer holds during the Posts.
 * Chromium keeps 250 by default and drops every entry after that.
 */
const RESOURCE_BUFFER_SIZE = 10_000;

/** The path every Discussion read goes to; the open Discussion's read adds its id. */
const DISCUSSIONS_PATH = "/api/v1/discussions";

/** The repository the Discussions and the wiki page are about. */
const REPOSITORY_REMOTE = "https://github.com/acme/webshop";

/** What the Discussions are about, handed out in turn. */
const SUBJECTS = [
  "Who changes the checkout router?",
  "The orders test fails on CI",
  "Splitting the payments module",
  "Which branch takes the schema change?",
  "Flaky retry in the mock server",
  "Renaming `fetchOrders`",
  "Release notes for the next version",
  "Do we keep the old cart endpoint?",
] as const;

/**
 * Returns the Markdown of Post number `number`. The four shapes of a real
 * Post come in turn: a paragraph, a paragraph with inline code and bold, a
 * list, and a paragraph with a code block, so the Posts list draws each kind
 * of block an agent writes.
 */
function buildPostText(number: number): string {
  const n = String(number);
  switch (number % 4) {
    case 0:
      return (
        `Post ${n}: I read through the change again and the order of the steps matters. ` +
        "The first step writes the cart, the second reads it back, and the third sends the " +
        "receipt. If the second runs before the first has finished, the receipt shows an " +
        "empty cart. I will keep the order as it is and add a test for it."
      );
    case 1:
      return (
        `Post ${n}: \`fetchOrders\` resolves after the test's timeout. The mock server answers ` +
        "in **120 ms**, and `checkout.test.ts` waits 100 ms. I raised the wait in " +
        "`vitest.config.ts` and the test passes on my side. Can someone confirm on CI?"
      );
    case 2:
      return [
        `Post ${n}: here is what I touched so far:`,
        "",
        "- `src/checkout/orders.ts`: the retry loop",
        "- `src/checkout/orders.test.ts`: the new case",
        "- `mocks/orders.ts`: the delay, now 80 ms",
        "",
        "I leave `src/payments` to you.",
      ].join("\n");
    default:
      return [
        `Post ${n}: this is the retry I added, tell me if the count is wrong:`,
        "",
        "```ts",
        "const orders = await fetchOrders({ retry: 2 });",
        "expect(orders).toHaveLength(3);",
        "```",
        "",
        "It waits 100 ms between the tries.",
      ].join("\n");
  }
}

/** Returns the body of the wiki page as of `revision`: a few paragraphs, a list and a code block. */
function buildWikiBody(revision: number): string {
  return [
    "# Release process",
    "",
    `This page is at revision ${String(revision)}. A release goes out from \`main\`, after the checks pass.`,
    "",
    "1. Bump the version in `package.json`.",
    "2. Run `pnpm build` and `pnpm test`.",
    "3. Tag the commit and push the tag.",
    "",
    "```sh",
    "git tag v1.2.3 && git push origin v1.2.3",
    "```",
    "",
    "A release that fails a check is not tagged. Fix the check first.",
  ].join("\n");
}

/** What the seed made, for the launch to open and the Posts to be written into. */
export interface SeededDiscussions {
  /** The Discussion with `POSTS_AT_LAUNCH` Posts, which the app opens. */
  readonly discussionId: string;
  /** The wiki page with `WIKI_REVISIONS` revisions. */
  readonly wikiPageId: string;
  /** The sessions that write, which are the fixture's busy threads. */
  readonly authorIds: readonly string[];
}

/**
 * Fills the controller with the Discussions and the wiki page that the top of
 * this file describes, written by the fixture's busy threads, and returns
 * what the launch needs. The repository is filed under the first project.
 * Fails when the controller has no project, or fewer than two busy threads,
 * or when a call is refused.
 */
export async function seedDiscussions(fixture: ThreadFixture): Promise<SeededDiscussions> {
  const { call, callAsSession } = fixture;
  const authorIds = (
    await call<{ readonly items: readonly Session[] }>("GET", "/sessions?thread=true&limit=500")
  ).items
    .filter((thread) => thread.status === "busy")
    .map((thread) => thread.id);
  if (authorIds.length < 2) {
    throw new Error("the controller has fewer than two busy threads to write Discussions");
  }
  const [project] = (await call<{ readonly items: readonly Project[] }>("GET", "/projects")).items;
  if (project === undefined) throw new Error("the controller has no project");
  const { id: resourceId } = await call<Resource>("POST", "/resources", {
    kind: "repo",
    remote: REPOSITORY_REMOTE,
    projectIds: [project.id],
  });
  const authorAt = (index: number) => authorIds[index % authorIds.length]!;
  const open = (number: number, text: string) =>
    callAsSession<DiscussionCreated>(authorAt(number), "POST", "/discussions", {
      resourceId,
      subject: `${SUBJECTS[number % SUBJECTS.length]!} (${String(number)})`,
      text,
    });
  const write = (discussionId: string, author: number, text: string) =>
    callAsSession(authorAt(author), "POST", `/discussions/${discussionId}/post`, { text });

  // The small Discussions come first, so the open one is the newest.
  for (let number = 1; number < DISCUSSION_COUNT; number += 1) {
    const { discussion } = await open(number, buildPostText(0));
    for (let post = 1; post <= number % 3; post += 1) {
      await write(discussion.id, number + post, buildPostText(post));
    }
  }
  const { discussion } = await open(DISCUSSION_COUNT, buildPostText(0));
  for (let post = 1; post < POSTS_AT_LAUNCH; post += 1) {
    await write(discussion.id, post, buildPostText(post));
  }

  const wikiPage = await callAsSession<WikiPage>(authorAt(0), "POST", "/wiki-pages", {
    resourceId,
    slug: "release-process",
    title: "Release process",
    summary: "How a release goes out, step by step.",
    body: buildWikiBody(1),
  });
  for (let revision = 2; revision <= WIKI_REVISIONS; revision += 1) {
    await callAsSession(authorAt(revision), "PATCH", `/wiki-pages/${wikiPage.id}`, {
      expectedRevision: revision - 1,
      body: buildWikiBody(revision),
    });
  }
  return { discussionId: discussion.id, wikiPageId: wikiPage.id, authorIds };
}

/**
 * Opens the Discussion `discussionId` once in the signed-in app on
 * `userDataDir`, so the app opens it again at its next launch (see
 * `openScreenOnce`). Fails when the Discussion does not show its Posts.
 */
export const openDiscussionOnce = (userDataDir: string, discussionId: string): Promise<void> =>
  openScreenOnce(userDataDir, `/discussions/${discussionId}`, (page: Page) =>
    page
      .locator(POST_SELECTOR)
      .nth(POSTS_AT_LAUNCH - 1)
      .waitFor(),
  );

/** What a read is for, by its URL. */
type ReadKind = "list" | "openDiscussion" | "other";

/**
 * Returns what the read of `url` is for: the list of Discussions, the open
 * Discussion `discussionId`, or anything else.
 */
function classifyRead(url: URL, discussionId: string): ReadKind {
  if (url.pathname === DISCUSSIONS_PATH) return "list";
  if (url.pathname === `${DISCUSSIONS_PATH}/${discussionId}`) return "openDiscussion";
  return "other";
}

/** What the new Posts cost, summed over all of them. */
interface PostCost {
  /** The controller process's CPU time, in milliseconds. */
  readonly controllerCpuMs: number;
  /** The renderer process's CPU time, all of its threads, in milliseconds. */
  readonly rendererCpuMs: number;
  /** The time the renderer's main thread spent running tasks, in milliseconds. */
  readonly rendererMainThreadMs: number;
  /** How many reads of each kind the page made. */
  readonly reads: Readonly<Record<ReadKind, number>>;
  /** Each read that is neither of the list nor of the open Discussion, by its path, with how many there were. */
  readonly otherPaths: ReadonlyMap<string, number>;
  /**
   * For each Post, how long from the request that wrote it until the last
   * Discussion read that started after it answered, in milliseconds, or null
   * when no Discussion read followed the Post.
   */
  readonly settleMs: ReadonlyArray<number | null>;
}

/** What the Discussions scenario measured. */
export interface DiscussionWork extends LaunchAtRest {
  /** Each process's memory, 13 s after the Posts ended, with `MAX_POSTS` Posts open. */
  readonly memoryAfterPosts: readonly ProcessMemory[];
  /** How many Posts the page drew once the Posts ended. */
  readonly postsDrawn: number;
  readonly posts: PostCost;
  readonly topics: readonly TopicStep[];
}

/**
 * Counts the reads in `reads` by kind, and finds when each Post's last
 * Discussion read answered. Each read counts to the Post before it started.
 * A read before the first Post is not counted.
 */
function countPostReads(
  reads: readonly Read[],
  postedAt: readonly number[],
  discussionId: string,
): Pick<PostCost, "reads" | "otherPaths" | "settleMs"> {
  const counts: Record<ReadKind, number> = { list: 0, openDiscussion: 0, other: 0 };
  const otherPaths = new Map<string, number>();
  const lastAnswer: (number | null)[] = postedAt.map(() => null);
  for (const read of reads) {
    const post = postedAt.findLastIndex((at) => at <= read.startedAt);
    if (post === -1) continue;
    const url = new URL(read.url);
    const kind = classifyRead(url, discussionId);
    counts[kind] += 1;
    if (kind === "other") {
      otherPaths.set(url.pathname, (otherPaths.get(url.pathname) ?? 0) + 1);
    } else {
      lastAnswer[post] = Math.max(lastAnswer[post] ?? 0, read.answeredAt);
    }
  }
  return {
    reads: counts,
    otherPaths,
    settleMs: lastAnswer.map((at, post) => (at === null ? null : at - postedAt[post]!)),
  };
}

/**
 * Writes `PUSH_COUNT` Posts into the open Discussion, one a second, each by
 * the next of the seed's sessions, with the app's page `page` open, and
 * returns what they cost, over the time from the first Post to 2 s after the
 * last. The controller's and the renderer's (`rendererPid`) CPU time come
 * from `ps`, and the renderer main thread's time from the page's DevTools
 * performance metrics. Each also holds whatever the process did while idle in
 * that time, so the numbers err high. The page's reads come from its resource
 * timing entries, which are cleared first. `Performance.enable` must have
 * been sent to `page` first.
 */
async function measurePosts(
  page: Inspector,
  fixture: ThreadFixture,
  rendererPid: number,
  seeded: SeededDiscussions,
): Promise<PostCost> {
  const evaluate = (expression: string) =>
    page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
  const controllerPid = fixture.readControllerPid();
  await evaluate(`performance.setResourceTimingBufferSize(${String(RESOURCE_BUFFER_SIZE)});
    performance.clearResourceTimings();`);
  const before = {
    controller: await readCpuMs(controllerPid),
    renderer: await readCpuMs(rendererPid),
    mainThread: await readMainThreadMs(page),
  };
  const postedAt: number[] = [];
  for (let post = 0; post < PUSH_COUNT; post += 1) {
    postedAt.push(Date.now());
    await fixture.callAsSession(
      seeded.authorIds[post % seeded.authorIds.length]!,
      "POST",
      `/discussions/${seeded.discussionId}/post`,
      { text: buildPostText(POSTS_AT_LAUNCH + post) },
    );
    await sleep(Math.max(0, postedAt.at(-1)! + PUSH_INTERVAL_MS - Date.now()));
  }
  await sleep(PUSH_SETTLE_MS);
  const after = {
    controller: await readCpuMs(controllerPid),
    renderer: await readCpuMs(rendererPid),
    mainThread: await readMainThreadMs(page),
  };
  const reads = (await evaluate(READ_READS)) as Read[];
  return {
    controllerCpuMs: after.controller - before.controller,
    rendererCpuMs: after.renderer - before.renderer,
    rendererMainThreadMs: after.mainThread - before.mainThread,
    ...countPostReads(reads, postedAt, seeded.discussionId),
  };
}

/** What `recordHeldTopics` needs of the launch it records in. */
interface TopicRecording {
  readonly pageSocketUrl: string;
  readonly inspectorUrl: string;
  /** Waits until an expression evaluates to true in the page, and fails with the message after 10 s. */
  readonly waitInPage: (expression: string, timeoutMessage: string) => Promise<true>;
  readonly seeded: SeededDiscussions;
}

/**
 * Records which live topics the page holds as it moves between screens, and
 * returns each step's topics with what the step expects. The page starts on
 * the open Discussion, and ends there.
 *
 * The recorder sees only the frames sent after it starts, and the page
 * subscribed at launch. So the first step leaves the Discussion for Settings
 * and comes back, which subscribes the topic again in front of the recorder.
 * The steps are:
 *
 * 1. the Discussion, back from Settings;
 * 2. the same page with the window hidden;
 * 3. the same page with the window shown again;
 * 4. the wiki page, opened from the sidebar's Wiki row;
 * 5. Settings, where no Discussions or Wiki screen is open;
 * 6. the Discussion, from the sidebar, where the scenario goes on.
 *
 * Settings opens through the `openSettings` menu command, which main sends
 * without showing the window, so the run does not take the keyboard focus.
 */
async function recordHeldTopics({
  pageSocketUrl,
  inspectorUrl,
  waitInPage,
  seeded,
}: TopicRecording): Promise<TopicStep[]> {
  const steps: TopicStep[] = [];
  const recordStep = async (
    name: string,
    { holds, lacks }: { readonly holds: readonly string[]; readonly lacks: readonly string[] },
  ) => {
    await sleep(TOPIC_SETTLE_MS);
    const { visibility, held } = (await evaluateInPage(pageSocketUrl, READ_HELD_TOPICS)) as {
      visibility: string;
      held: string[];
    };
    steps.push({ name, visibility, held, holds, lacks });
  };
  const clickWhenPresent = (selector: string, timeoutMessage: string) =>
    waitInPage(
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        element?.click();
        return element !== null;
      })()`,
      timeoutMessage,
    );
  const openSettings = async () => {
    await evaluateInMain(
      inspectorUrl,
      `require("electron").BrowserWindow.getAllWindows()[0].webContents.send("menu.command", "openSettings")`,
    );
    await waitInPage(`document.querySelector(".settings") !== null`, "Settings did not open");
  };
  const openDiscussionFromSidebar = async () => {
    await clickWhenPresent('a.nav-row[href="/discussions"]', "the sidebar has no Discussions row");
    await clickWhenPresent(
      `a[href="/discussions/${seeded.discussionId}"]`,
      "the list shows no row for the Discussion",
    );
    await waitInPage(
      `document.querySelectorAll(${JSON.stringify(POST_SELECTOR)}).length >= ${String(MAX_POSTS)}`,
      "the Discussion did not open with its Posts",
    );
  };
  const onDiscussion = { holds: ["discussion"], lacks: ["wikiPage"] };
  const onNeitherScreen = { holds: [], lacks: ["discussion", "wikiPage"] };

  await evaluateInPage(pageSocketUrl, RECORD_FRAMES);
  await openSettings();
  await openDiscussionFromSidebar();
  await recordStep("the Discussion, back from Settings", onDiscussion);

  await callWindow(inspectorUrl, "hide");
  await waitInPage(`document.visibilityState === "hidden"`, "the page never became hidden");
  await recordStep("the Discussion, window hidden", onNeitherScreen);

  await callWindow(inspectorUrl, "showInactive");
  await waitInPage(`document.visibilityState === "visible"`, "the page never became visible");
  await recordStep("the Discussion, window shown again", onDiscussion);

  await clickWhenPresent('a.nav-row[href="/wiki"]', "the sidebar has no Wiki row");
  await clickWhenPresent(
    `a[href="/wiki/${seeded.wikiPageId}"]`,
    "the list shows no row for the wiki page",
  );
  await waitInPage(`document.querySelector(".open-pane") !== null`, "the wiki page did not open");
  await recordStep("the wiki page", { holds: ["wikiPage"], lacks: ["discussion"] });

  await openSettings();
  await recordStep("Settings, no Discussions or Wiki screen open", onNeitherScreen);

  await openDiscussionFromSidebar();
  return steps;
}

/**
 * Starts the signed-in app on `userDataDir` as a plain process, warm (see
 * `warmUpApp`), where it opens the seeded Discussion again, and measures it.
 * Returns, read in this order:
 *
 * - each process's memory, 13 s after the page opened (see
 *   `readProcessMemory`);
 * - each process's CPU and wakeups over 10 s with the window visible, from
 *   30 s after the page opened, and over 10 s with the window hidden (see
 *   `sampleVisibleAndHidden`), with the age clock's fires in each;
 * - with the window shown again, what the Posts cost (see `measurePosts`);
 * - each process's memory again, 3 s after the Posts, with 200 Posts drawn.
 *   The page's DevTools connection was open for the Posts, so this reading
 *   is not comparable with the first;
 * - the live topics held at each step (see `recordHeldTopics`).
 *
 * Nothing stays attached to the page until the idle samples are over, as in
 * `perf.ts`. The window stays shown during the Posts, because a hidden page
 * drops the `discussion` topic.
 *
 * Fails when the Discussion does not show its Posts within 10 s, when the
 * window is not visible or hidden as each sample expects, when the page does
 * not draw every Post that was written, or when the app does not quit cleanly
 * afterwards.
 */
export async function measureDiscussionWork(
  userDataDir: string,
  fixture: ThreadFixture,
  seeded: SeededDiscussions,
): Promise<DiscussionWork> {
  await warmUpApp(userDataDir);
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  const { inspectorUrl } = app;
  let measured: DiscussionWork;
  try {
    const pageSocketUrl = await waitForPageSocketUrl(app.endpoint);
    const pageOpenedAt = Date.now();
    const sleepUntil = (msAfterOpen: number) =>
      sleep(Math.max(0, pageOpenedAt + msAfterOpen - Date.now()));
    const waitInPage = (expression: string, timeoutMessage: string) =>
      pollUntil(
        async () => ((await evaluateInPage(pageSocketUrl, expression)) === true ? true : undefined),
        { timeoutMs: 10_000, intervalMs: 100, timeoutMessage },
      );
    const countPostsDrawn = `document.querySelectorAll(${JSON.stringify(POST_SELECTOR)}).length`;

    await waitInPage(
      `${countPostsDrawn} >= ${String(POSTS_AT_LAUNCH)}`,
      "the app did not open the Discussion with its Posts",
    );
    await sleepUntil(MEMORY_READ_AT_MS);
    const memory = await readProcessMemory(app.process.pid!);
    const rendererPid = findRendererPid(memory);

    await sleepUntil(VISIBLE_SAMPLE_AT_MS);
    const samples = await sampleVisibleAndHidden(inspectorUrl, SAMPLE_MS);

    const page = await connectInspector(pageSocketUrl);
    let fires: { firesVisible: number; firesHidden: number };
    let posts: PostCost;
    try {
      fires = await countAgeClockFires(page, samples);
      await page.send("Performance.enable");
      posts = await measurePosts(page, fixture, rendererPid, seeded);
    } finally {
      page.close();
    }
    await waitInPage(
      `${countPostsDrawn} >= ${String(MAX_POSTS)}`,
      `the page did not draw all ${String(MAX_POSTS)} Posts`,
    );
    const postsDrawn = (await evaluateInPage(pageSocketUrl, countPostsDrawn)) as number;
    await sleep(MEMORY_SETTLE_MS);
    const memoryAfterPosts = await readProcessMemory(app.process.pid!);

    const topics = await recordHeldTopics({ pageSocketUrl, inspectorUrl, waitInPage, seeded });
    measured = {
      loadAtSpawn,
      memory,
      visible: samples.visible,
      visibleMs: samples.visibleTo - samples.visibleFrom,
      hidden: samples.hidden,
      ...fires,
      memoryAfterPosts,
      postsDrawn,
      posts,
      topics,
    };
  } finally {
    await stopPlainApp(app);
  }
  assertExitedCleanly(app.process);
  return measured;
}

/** Formats a count of reads as the count for one Post, with the total after it. */
const formatPerPost = (count: number) =>
  `${(count / PUSH_COUNT).toFixed(1)} a Post (${String(count)} for ${String(PUSH_COUNT)})`;

/** Formats a cost of all the Posts as the cost of one, with the total after it. */
const formatMsPerPost = (totalMs: number) =>
  `${(totalMs / PUSH_COUNT).toFixed(1)} ms a Post (${totalMs.toFixed(0)} ms for ${String(PUSH_COUNT)})`;

/** Builds the budget rows of the new Posts from `posts`. */
function buildPostRows(posts: PostCost): BudgetRow[] {
  const settled = posts.settleMs.filter((ms) => ms !== null).toSorted((a, b) => a - b);
  const otherPaths = [...posts.otherPaths]
    .map(([path, count]) => `${path} ${String(count)}`)
    .join(", ");
  const mainThreadPerPostMs = posts.rendererMainThreadMs / PUSH_COUNT;
  // A push reads the loaded pages and the open item again, once per 50 ms
  // window, and the Posts are a second apart.
  const oneAPost = (count: number) => count <= PUSH_COUNT;
  return [
    [
      "Post, reads of the list's loaded pages",
      "one a Post: its first page",
      formatPerPost(posts.reads.list),
      oneAPost(posts.reads.list),
    ],
    [
      "Post, reads of the open Discussion",
      "one a Post",
      formatPerPost(posts.reads.openDiscussion),
      oneAPost(posts.reads.openDiscussion),
    ],
    [
      "Post, other reads",
      "recorded; not budgeted",
      `${formatPerPost(posts.reads.other)}${otherPaths === "" ? "" : `: ${otherPaths}`}`,
      null,
    ],
    [
      "Post, until the last Discussion read answered",
      "recorded; not budgeted",
      settled.length === 0
        ? "no Discussion read followed a Post"
        : `median ${settled[Math.floor(settled.length / 2)]!.toFixed(0)} ms, ` +
          `longest ${settled.at(-1)!.toFixed(0)} ms, ` +
          `${String(settled.length)} of ${String(PUSH_COUNT)} Posts read a Discussion`,
      null,
    ],
    [
      "Post, renderer main thread",
      `at most ${String(BUDGET.rendererMainThreadPerNudgeMs)} ms, the thread list's nudge limit`,
      formatMsPerPost(posts.rendererMainThreadMs),
      mainThreadPerPostMs <= BUDGET.rendererMainThreadPerNudgeMs,
    ],
    ["Post, renderer CPU", "recorded; not budgeted", formatMsPerPost(posts.rendererCpuMs), null],
    [
      "Post, controller CPU",
      "recorded; not budgeted",
      formatMsPerPost(posts.controllerCpuMs),
      null,
    ],
  ];
}

/** Formats a change in megabytes with its sign, such as "+3.2 MB" or "-25.1 MB". */
const formatChange = (mb: number) => `${mb >= 0 ? "+" : ""}${mb.toFixed(1)} MB`;

/** Prints what the Discussions scenario measured, against spec 17 §What Discussions and Wiki cost. */
export function reportDiscussionWork(measured: DiscussionWork): void {
  const sumFootprint = (memory: readonly ProcessMemory[]) =>
    memory.reduce((sum, sample) => sum + sample.footprintMb, 0);
  const rendererFootprint = (memory: readonly ProcessMemory[]) =>
    memory.find((sample) => sample.label === "Tab")?.footprintMb ?? 0;
  const afterSummed = sumFootprint(measured.memoryAfterPosts);
  const afterRenderer = rendererFootprint(measured.memoryAfterPosts);
  const budgets: BudgetRow[] = [
    ...buildAtRestRows(
      measured,
      "0 fires: every age on screen is hours old, and a Post shows a clock time",
    ),
    [
      `Footprint, summed, ${String(measured.postsDrawn)} Posts open, after the Posts`,
      `at most ${String(BUDGET.summedFootprintMb)} MB`,
      `${afterSummed.toFixed(0)} MB (${formatChange(afterSummed - sumFootprint(measured.memory))} since the first reading)`,
      afterSummed <= BUDGET.summedFootprintMb,
    ],
    [
      `Footprint, renderer, ${String(measured.postsDrawn)} Posts open, after the Posts`,
      `at most ${String(BUDGET.rendererFootprintMb)} MB`,
      `${afterRenderer.toFixed(0)} MB (${formatChange(afterRenderer - rendererFootprint(measured.memory))} since the first reading)`,
      afterRenderer <= BUDGET.rendererFootprintMb,
    ],
    ...buildPostRows(measured.posts),
  ];
  printLaunch(
    `## Discussions: a Discussion of ${String(POSTS_AT_LAUNCH)} Posts open, ${String(DISCUSSION_COUNT)} listed`,
    measured,
    budgets,
  );
  console.log(
    "Live topics the page held at each step. The shell's own topics were subscribed before the recording started, so they are not listed:",
  );
  console.log(
    formatTable(["Step", "Visibility", "Held", "As expected"], buildTopicRows(measured.topics)),
  );
  console.log();
}
