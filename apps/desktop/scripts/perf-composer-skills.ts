/**
 * Measures what the composer's skills cost in the packaged app (#769), for
 * spec 17 §Performance:
 *
 *     pnpm --filter @hercule/desktop perf:composer-skills
 *
 * Run `pnpm build:binary` and `pnpm build:desktop` first. It starts a
 * controller from the compiled binary in a scratch Hercule Home, imports 100
 * skills into the Skill Library with `hercule skill import`, enlists a
 * scripted runner that lists 20 more from the checkout's `.agents/skills`, and
 * opens a finished thread in one plain launch of the test package (see
 * `launchPlainApp`). Nothing else is attached to the app. It never touches
 * the user's Hercule Home: the controller, the CLI login and the app's data
 * all live in scratch directories that are deleted at the end.
 *
 * It measures two ways, each in its own pass over the same steps, because
 * tracing slows the page down and the probe adds a little work of its own:
 *
 * - Busy time. A Chromium trace records, for each key, the renderer main
 *   thread's tasks from that key's `keydown` until the next key (see
 *   `sumTasksPerKey`). The keys are `KEY_INTERVAL_MS` apart.
 * - Input to paint. A probe in the page (see `INSTALL_PROBE`) times each key
 *   from its `keydown` to the frame that drew the last change the key caused.
 *
 * The steps:
 *
 * - Cold open: reload the page, and type `$` as soon as the message field
 *   exists, before the composer's own read of the skills has come back.
 * - Cached open and filter: type `$`, then the 6 characters of a filter, then
 *   clear the field. The two filters are `review` (narrows 120 rows to 10)
 *   and `team-w` (every description holds `team-wide`, so all 120 rows stay
 *   and each draws a highlight). Done back to back, so most opens find skills
 *   read less than 5 s ago. Each open is told apart by whether it made a
 *   request.
 * - Stale open: wait until the skills are older than 5 s, then type `$`.
 * - Long message: insert about 4,000 characters holding 10 Skill References
 *   (so 10 chips), type a sentence after them, and clear the field. The
 *   baseline is the same text with the names written without `$`.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file. It prints Markdown tables and fails no budget.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  PASSWORD,
  USERNAME,
  findCompiledBinary,
  runCli,
  startSetUpController,
} from "../../../scripts/controller-process.ts";
import { connectFleet } from "./fleet.ts";
import {
  assertExitedCleanly,
  connectInspector,
  formatTable,
  launchPlainApp,
  signInOnce,
  stopPlainApp,
  writeSettings,
  type Inspector,
} from "./packaged-app.ts";
import {
  CHECKOUT_NAME,
  INSTALL_PROBE,
  LIBRARY_SKILLS,
  LONG_MESSAGE_CHIPS,
  REPOSITORY_SKILLS,
  buildLongMessage,
  hasSettled,
  summarizeReadings,
  type ProbeReading,
  type Spread,
} from "./perf-composer-skills-measures.ts";
import {
  clearMessageField,
  focusMessageField,
  sumTasksPerKey,
  typeCharacter,
} from "./perf-keystrokes.ts";
import {
  TIMELINE_CATEGORY,
  findRendererMainTasks,
  openThreadOnce,
  readTrace,
  waitForPageSocketUrl,
  warmUpApp,
} from "./perf-measures.ts";
import { pollUntil } from "./poll.ts";

/** How many reloads the cold open is measured on. */
const COLD_RUNS = 20;
/** How many back-to-back opens-and-filters are measured, split evenly over `FILTERS`. */
const CACHED_ITERATIONS = 40;
/** How many opens of skills older than 5 s are measured. */
const STALE_RUNS = 20;
/** How many times each of the long message and its baseline is typed after. */
const LONG_ROUNDS = 6;

/** The time between two keys, in milliseconds: several frames at 60 Hz, so one key's work is over before the next key. */
const KEY_INTERVAL_MS = 100;
/** How long the page must stay unchanged after a key before the latency pass counts it as settled, in milliseconds. */
const QUIET_MS = 150;
/** How long the skills must have been unread for the app to read them again when a list opens: the 5 s window plus a margin, in milliseconds. */
const STALE_AFTER_MS = 5_500;
/** How long the launch settles before the first measurement, in milliseconds. */
const LAUNCH_SETTLE_MS = 5_000;

/** The filters typed after `$`. */
const FILTERS = ["review", "team-w"] as const;
/** The sentence typed after the long message: letters and spaces only. */
const TAIL = " the quick brown fox jumps over the lazy dog";

/** The message field, found whether its role is `textbox` or, while a list is open, `combobox`. */
const FIELD = '.composer-field [aria-label="Message"]';
/** The name the page gives each `keydown` in the trace, with `console.timeStamp`. */
const KEYDOWN_MARK = "keystroke";
/** The trace categories of a pass: the tasks, and the page's marks and requests. */
const TRACE_CATEGORIES = [TIMELINE_CATEGORY, "devtools.timeline"];

/** How many skills a list shows before the user types a filter. */
const SKILL_COUNT = LIBRARY_SKILLS.length + REPOSITORY_SKILLS.length;

/** The title of the thread the script opens; it is also its first message. */
const THREAD_PROMPT = "Review the checkout flow before the release";

/** Evaluates `expression` in the page and returns its value. */
const evaluate = (page: Inspector, expression: string): Promise<unknown> =>
  page.evaluate("Runtime.evaluate", { expression, returnByValue: true });

/** A controller with the skills seeded and the thread the script opens. */
interface World {
  readonly url: string;
  readonly threadId: string;
  readonly cleanup: () => Promise<void>;
}

/** Writes one skill folder per entry into `parent`, for `hercule skill import`. */
function writeSkillFolders(parent: string): void {
  for (const { name, description } of LIBRARY_SKILLS) {
    const folder = join(parent, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n# ${name}\n\nSteps.\n`,
    );
  }
}

/**
 * Starts a controller in a scratch Home, fills the Skill Library, enlists a
 * scripted runner that lists the checkout's skills, and runs a thread to the
 * end, so its composer takes a new message. Fails when the compiled binary is
 * missing or the login or import fails.
 */
async function startWorld(): Promise<World> {
  const scratch = mkdtempSync(join(tmpdir(), "hercule-769-perf-"));
  const home = join(scratch, "home");
  mkdirSync(home);
  const controller = await startSetUpController({ home });
  const fleet = await connectFleet(controller.url);
  try {
    const cliHome = join(scratch, "cli-home");
    const skillsFolder = join(scratch, "skills");
    mkdirSync(cliHome);
    writeSkillFolders(skillsFolder);
    const binary = findCompiledBinary();
    const login = await runCli(
      ["login", controller.url, "--username", USERNAME, "--password-stdin", "--name", "perf-769"],
      { home: cliHome, binary, stdin: PASSWORD },
    );
    if (login.code !== 0) throw new Error(`login failed:\n${login.stderr}`);
    const imported = await runCli(["skill", "import", skillsFolder], { home: cliHome, binary });
    if (imported.code !== 0) {
      throw new Error(`skill import failed:\n${imported.stdout}${imported.stderr}`);
    }

    const runner = await fleet.enlistRunner("studio-mac");
    runner.setSkills({
      repository: REPOSITORY_SKILLS.map(({ name, description }) => ({
        checkoutName: CHECKOUT_NAME,
        name,
        description,
        path: `.agents/skills/${name}`,
      })),
      names: [
        ...LIBRARY_SKILLS.map(({ name }) => name),
        ...REPOSITORY_SKILLS.map(({ name }) => `${CHECKOUT_NAME}:${name}`),
      ],
    });
    const project = await fleet.createProject(CHECKOUT_NAME);
    const repository = await fleet.createRepository(`https://github.com/acme/${CHECKOUT_NAME}`, [
      project.id,
    ]);
    const { thread, played } = await fleet.spawnScriptedThread(
      {
        runner,
        projectId: project.id,
        workspace: { kind: "primary", resourceId: repository.id },
        prompt: THREAD_PROMPT,
      },
      [
        {
          kind: "message",
          deltaMs: 2,
          text: "I read the checkout flow. The payment step handles every status it can return.",
        },
        { kind: "end", state: "completed" },
      ],
    );
    await played;
    return {
      url: controller.url,
      threadId: thread.id,
      cleanup: async () => {
        await fleet.disconnectRunners();
        await controller.stop();
        rmSync(scratch, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fleet.disconnectRunners();
    await controller.stop();
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

/** What one key cost in the latency pass. */
interface KeyLatency {
  /** From the key's `keydown` to the frame that drew the last change it caused, in milliseconds. */
  readonly latencyMs: number;
  /** From the key's `keydown` to the first frame after it, in milliseconds. */
  readonly firstPaintMs: number;
  /** How many rows the list had once the page settled. */
  readonly rows: number;
  /** Whether the list said "Reading skills…" at some point. */
  readonly sawReading: boolean;
  /** How many requests for skills the page had made when the key was armed. */
  readonly readsAtArm: number;
}

/**
 * Types `character` and waits until the page has settled, then returns what
 * the probe read. Fails when the key changes nothing in the page within 5 s.
 */
async function pressAndSettle(page: Inspector, character: string): Promise<KeyLatency> {
  const readsAtArm = (await evaluate(page, "window.__probe.arm()")) as number;
  await typeCharacter(page, character);
  await sleep(KEY_INTERVAL_MS);
  const reading = await pollUntil(
    async () => {
      const read = (await evaluate(page, "window.__probe.read()")) as ProbeReading;
      return hasSettled(read, QUIET_MS) ? read : undefined;
    },
    {
      timeoutMs: 5_000,
      intervalMs: 50,
      timeoutMessage: `the page did not change within 5 s of the key ${JSON.stringify(character)}`,
    },
  );
  return {
    latencyMs: reading.lastPaint! - reading.t0!,
    firstPaintMs: reading.firstPaint! - reading.t0!,
    rows: reading.rows,
    sawReading: reading.sawReading,
    readsAtArm,
  };
}

/** Reads how many requests for skills the page has made so far. */
async function readSkillReads(page: Inspector): Promise<number> {
  return ((await evaluate(page, "window.__probe.read()")) as ProbeReading).reads;
}

/** Returns the text of the message field. */
async function readFieldText(page: Inspector): Promise<string> {
  return (await evaluate(
    page,
    `document.querySelector(${JSON.stringify(FIELD)}).textContent`,
  )) as string;
}

/** Returns how many chips the message field holds. */
async function countChips(page: Inspector): Promise<number> {
  return (await evaluate(
    page,
    `document.querySelectorAll(${JSON.stringify(`${FIELD} [data-skill]`)}).length`,
  )) as number;
}

/**
 * Waits until the page has mounted the thread's transcript and the message
 * field, in a document that is not the one `markDocument` marked. Fails
 * after 15 s.
 */
async function waitForComposer(page: Inspector): Promise<void> {
  await pollUntil(
    async () =>
      (await evaluate(
        page,
        `window.__reloadMarker === undefined &&
          document.querySelector('section[aria-label="Transcript"]') !== null &&
          document.querySelector(${JSON.stringify(FIELD)}) !== null`,
      ))
        ? true
        : undefined,
    { timeoutMs: 15_000, intervalMs: 20, timeoutMessage: "the app did not reopen the thread" },
  );
}

/** Reloads the page and waits for the thread's composer. */
async function reloadPage(page: Inspector): Promise<void> {
  // A reload keeps the old document for a moment; the marker is gone from the new one.
  await evaluate(page, "window.__reloadMarker = true");
  await page.send("Page.reload", {});
  await waitForComposer(page);
}

/** What the busy pass read for one run of keys. */
interface KeyWork {
  /** The renderer main thread's busy time for each key, in milliseconds. */
  readonly busyMs: number[];
  /** The longest task that belongs to each key, in milliseconds. */
  readonly longestTaskMsByKey: number[];
  /** Whether the keys made a request for skills. */
  readonly madeRequest: boolean;
}

/**
 * Types `characters`, `KEY_INTERVAL_MS` apart, while a Chromium trace runs,
 * and returns what each key cost the renderer's main thread. The page must
 * mark each `keydown` (see `markKeydowns`). Fails when the trace lost events
 * or holds a different number of marks than keys.
 */
async function traceKeys(page: Inspector, characters: string): Promise<KeyWork> {
  await page.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: { includedCategories: TRACE_CATEGORIES },
  });
  for (const character of characters) {
    await typeCharacter(page, character);
    await sleep(KEY_INTERVAL_MS);
  }
  await page.send("Tracing.end");
  const events = await readTrace(page);
  const marks = events
    .filter((event) => event.name === "TimeStamp" && event.args?.data?.message === KEYDOWN_MARK)
    .map((event) => event.ts)
    .toSorted((a, b) => a - b);
  if (marks.length !== characters.length) {
    throw new Error(
      `the trace holds ${String(marks.length)} keydown marks for ${String(characters.length)} keys`,
    );
  }
  return {
    ...sumTasksPerKey(findRendererMainTasks(events), marks, KEY_INTERVAL_MS),
    madeRequest: events.some(
      (event) => event.name === "ResourceSendRequest" && event.args?.data?.url?.includes("/skills"),
    ),
  };
}

/** Makes the page write a mark into the trace at each `keydown`. */
const markKeydowns = (page: Inspector): Promise<unknown> =>
  evaluate(
    page,
    `document.addEventListener("keydown", () => console.timeStamp(${JSON.stringify(KEYDOWN_MARK)}), true)`,
  );

/** Empties the message field and waits for the list to close. Fails when the field is not empty after. */
async function emptyMessageField(page: Inspector): Promise<void> {
  await clearMessageField(page);
  await sleep(300);
  if ((await readFieldText(page)) !== "") throw new Error("the message field is not empty");
}

/** Returns `values` that `include` keeps. */
const pick = <T>(items: ReadonlyArray<T>, include: (item: T) => boolean): T[] =>
  items.filter(include);

/** What the busy pass read for the opens and filters, the stale opens and the long message. */
interface BusyReadings {
  /** One entry per back-to-back iteration: the open (`$`) and the filter's keys. */
  readonly cached: ReadonlyArray<{ readonly filter: string; readonly work: KeyWork }>;
  readonly stale: ReadonlyArray<KeyWork>;
  readonly longWithChips: ReadonlyArray<KeyWork>;
  readonly longPlain: ReadonlyArray<KeyWork>;
}

/** Inserts the long message, with its names written as references or not, and waits for its chips. */
async function insertLongMessage(page: Inspector, withReferences: boolean): Promise<void> {
  await page.send("Input.insertText", { text: buildLongMessage(withReferences) });
  const expected = withReferences ? LONG_MESSAGE_CHIPS : 0;
  await pollUntil(async () => ((await countChips(page)) === expected ? true : undefined), {
    timeoutMs: 5_000,
    intervalMs: 50,
    timeoutMessage: `the field does not hold ${String(expected)} chips`,
  });
  // The plugin also reads the document after the chips are in.
  await sleep(500);
}

/** Runs the busy pass: the same steps as the latency pass, under a trace. */
async function measureBusy(page: Inspector): Promise<BusyReadings> {
  await markKeydowns(page);
  const cached: Array<{ filter: string; work: KeyWork }> = [];
  for (let index = 0; index < CACHED_ITERATIONS; index += 1) {
    const filter = FILTERS[index % FILTERS.length]!;
    cached.push({ filter, work: await traceKeys(page, `$${filter}`) });
    await emptyMessageField(page);
  }
  const stale: KeyWork[] = [];
  for (let run = 0; run < STALE_RUNS; run += 1) {
    await sleep(STALE_AFTER_MS);
    stale.push(await traceKeys(page, "$"));
    await emptyMessageField(page);
  }
  const longWithChips: KeyWork[] = [];
  const longPlain: KeyWork[] = [];
  for (let round = 0; round < LONG_ROUNDS; round += 1) {
    for (const withReferences of [true, false]) {
      await insertLongMessage(page, withReferences);
      (withReferences ? longWithChips : longPlain).push(await traceKeys(page, TAIL));
      await emptyMessageField(page);
    }
  }
  return { cached, stale, longWithChips, longPlain };
}

/** What the latency pass read. */
interface LatencyReadings {
  readonly cold: ReadonlyArray<KeyLatency>;
  /** One entry per back-to-back iteration: the open (`$`), whether it made a request, and the filter's keys. */
  readonly cached: ReadonlyArray<{
    readonly filter: string;
    readonly open: KeyLatency;
    readonly openMadeRequest: boolean;
    readonly keys: ReadonlyArray<KeyLatency>;
  }>;
  readonly stale: ReadonlyArray<{ readonly open: KeyLatency; readonly openMadeRequest: boolean }>;
  readonly longWithChips: ReadonlyArray<ReadonlyArray<KeyLatency>>;
  readonly longPlain: ReadonlyArray<ReadonlyArray<KeyLatency>>;
}

/** Runs the latency pass. */
async function measureLatency(page: Inspector): Promise<LatencyReadings> {
  const cold: KeyLatency[] = [];
  for (let run = 0; run < COLD_RUNS; run += 1) {
    await reloadPage(page);
    if ((await readFieldText(page)) !== "") throw new Error("the reloaded field holds a draft");
    await focusMessageField(page);
    await evaluate(page, INSTALL_PROBE);
    cold.push(await pressAndSettle(page, "$"));
    await emptyMessageField(page);
  }

  const cached: Array<LatencyReadings["cached"][number]> = [];
  for (let index = 0; index < CACHED_ITERATIONS; index += 1) {
    const filter = FILTERS[index % FILTERS.length]!;
    const open = await pressAndSettle(page, "$");
    const keys: KeyLatency[] = [];
    for (const character of filter) keys.push(await pressAndSettle(page, character));
    const openMadeRequest = keys[0]!.readsAtArm > open.readsAtArm;
    cached.push({ filter, open, openMadeRequest, keys });
    await emptyMessageField(page);
  }

  const stale: Array<LatencyReadings["stale"][number]> = [];
  for (let run = 0; run < STALE_RUNS; run += 1) {
    await sleep(STALE_AFTER_MS);
    const open = await pressAndSettle(page, "$");
    await sleep(KEY_INTERVAL_MS);
    stale.push({ open, openMadeRequest: (await readSkillReads(page)) > open.readsAtArm });
    await emptyMessageField(page);
  }

  const longWithChips: KeyLatency[][] = [];
  const longPlain: KeyLatency[][] = [];
  for (let round = 0; round < LONG_ROUNDS; round += 1) {
    for (const withReferences of [true, false]) {
      await insertLongMessage(page, withReferences);
      const keys: KeyLatency[] = [];
      for (const character of TAIL) keys.push(await pressAndSettle(page, character));
      (withReferences ? longWithChips : longPlain).push(keys);
      await emptyMessageField(page);
    }
  }
  return { cold, cached, stale, longWithChips, longPlain };
}

/** Formats a spread of milliseconds as `p50 / p95`, to one decimal. */
const formatSpread = (spread: Spread): string =>
  `${spread.p50.toFixed(1)} / ${spread.p95.toFixed(1)}`;

/** Returns the mean of `values`. */
const mean = (values: ReadonlyArray<number>): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** Formats the busy times of `works` as `mean / p95 / longest task`, to two decimals. */
function formatBusy(
  works: ReadonlyArray<KeyWork>,
  keyIndexes?: (index: number) => boolean,
): string {
  const chosen = (values: ReadonlyArray<number>) =>
    values.filter((_, index) => keyIndexes === undefined || keyIndexes(index));
  const busy = works.flatMap((work) => chosen(work.busyMs));
  const spread = summarizeReadings(busy);
  const longest = Math.max(...works.flatMap((work) => chosen(work.longestTaskMsByKey)));
  return `${mean(busy).toFixed(2)} / ${spread.p95.toFixed(2)} / ${longest.toFixed(2)}`;
}

/** Prints both passes as Markdown tables. */
function report(busy: BusyReadings, latency: LatencyReadings, loadAtSpawn: number): void {
  const isOpen = (index: number) => index === 0;
  const isFilterKey = (index: number) => index > 0;
  const cachedOpens = pick(latency.cached, (iteration) => !iteration.openMadeRequest);
  const refreshedOpens = pick(latency.cached, (iteration) => iteration.openMadeRequest);
  const cachedBusy = pick(busy.cached, ({ work }) => !work.madeRequest);
  const rowsOf = (readings: ReadonlyArray<KeyLatency>) =>
    [...new Set(readings.map((reading) => reading.rows))].toSorted((a, b) => a - b).join(", ");
  const readingCount = latency.cold.filter((reading) => reading.sawReading).length;
  const paint = (readings: ReadonlyArray<KeyLatency>) => ({
    latency: summarizeReadings(readings.map((reading) => reading.latencyMs)),
    first: summarizeReadings(readings.map((reading) => reading.firstPaintMs)),
  });

  console.log(
    `\n### Composer skills, ${String(SKILL_COUNT)} skills (${String(LIBRARY_SKILLS.length)} library, ${String(REPOSITORY_SKILLS.length)} repository), load ${loadAtSpawn.toFixed(1)} at launch\n`,
  );
  console.log(
    `Keys ${String(KEY_INTERVAL_MS)} ms apart, typed with Input.dispatchKeyEvent. Latency is keydown to the frame that drew the last change, p50 / p95 in ms. Busy is the renderer main thread per key, mean / p95 / longest task in ms.\n`,
  );

  const rows: string[][] = [];
  const addLatency = (name: string, readings: ReadonlyArray<KeyLatency>, busyCell: string) => {
    const { latency: spread } = paint(readings);
    rows.push([
      name,
      String(readings.length),
      formatSpread(spread),
      `${Math.max(...readings.map((reading) => reading.latencyMs)).toFixed(1)}`,
      busyCell,
    ]);
  };
  addLatency(
    `Open \`$\`, cold (list shows rows at ${rowsOf(latency.cold)}; "Reading skills" in ${String(readingCount)} of ${String(latency.cold.length)})`,
    latency.cold,
    "-",
  );
  const first = paint(latency.cold).first;
  rows.push([
    "Open `$`, cold, first frame",
    String(latency.cold.length),
    formatSpread(first),
    "-",
    "-",
  ]);
  addLatency(
    `Open \`$\`, cached, no request (rows ${rowsOf(cachedOpens.map(({ open }) => open))})`,
    cachedOpens.map(({ open }) => open),
    cachedBusy.length === 0
      ? "-"
      : formatBusy(
          cachedBusy.map(({ work }) => work),
          isOpen,
        ),
  );
  if (refreshedOpens.length > 0) {
    addLatency(
      "Open `$`, cached, read again behind it (inside the back-to-back runs)",
      refreshedOpens.map(({ open }) => open),
      "-",
    );
  }
  addLatency(
    "Open `$`, skills older than 5 s",
    latency.stale.map(({ open }) => open),
    formatBusy(busy.stale),
  );
  for (const filter of FILTERS) {
    const keys = latency.cached
      .filter((iteration) => iteration.filter === filter)
      .flatMap((iteration) => iteration.keys);
    addLatency(
      `Filter \`${filter}\`, per key (rows ${rowsOf(keys)})`,
      keys,
      formatBusy(
        busy.cached.filter((iteration) => iteration.filter === filter).map(({ work }) => work),
        isFilterKey,
      ),
    );
  }
  addLatency(
    `Typing after a long message, ${String(LONG_MESSAGE_CHIPS)} chips`,
    latency.longWithChips.flat(),
    formatBusy(busy.longWithChips),
  );
  addLatency(
    "Typing after the same message, no `$`",
    latency.longPlain.flat(),
    formatBusy(busy.longPlain),
  );
  console.log(
    formatTable(
      ["Measure", "Samples", "Latency p50 / p95", "Latency max", "Busy mean / p95 / longest"],
      rows,
    ),
  );
  console.log(
    `\nBusy samples: ${String(cachedBusy.length)} of ${String(busy.cached.length)} back-to-back opens made no request.`,
  );
}

/**
 * Runs both passes in one launch of the test package that reopens the
 * world's thread. Fails when the thread does not show, a pass fails, or the
 * app does not quit cleanly.
 */
async function measureComposerSkills(userDataDir: string): Promise<void> {
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  let readings: { busy: BusyReadings; latency: LatencyReadings };
  try {
    const page = await connectInspector(await waitForPageSocketUrl(app.endpoint));
    try {
      await waitForComposer(page);
      await sleep(LAUNCH_SETTLE_MS);
      await focusMessageField(page);
      const busy = await measureBusy(page);
      const latency = await measureLatency(page);
      readings = { busy, latency };
    } finally {
      page.close();
    }
  } finally {
    await stopPlainApp(app);
  }
  assertExitedCleanly(app.process);
  report(readings.busy, readings.latency, loadAtSpawn);
}

const world = await startWorld();
const userDataDir = mkdtempSync(join(tmpdir(), "hercule-769-perf-app-"));
try {
  writeSettings(userDataDir, { controllerUrl: world.url });
  await signInOnce(userDataDir);
  await openThreadOnce(userDataDir, world.threadId);
  await warmUpApp(userDataDir);
  await measureComposerSkills(userDataDir);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await world.cleanup();
  rmSync(userDataDir, { recursive: true, force: true });
}
