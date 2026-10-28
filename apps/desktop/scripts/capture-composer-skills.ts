/**
 * Captures the composer's skills (#769) in the packaged app, for a check by
 * eye against the signed-off prototype's screens:
 *
 *     node apps/desktop/scripts/capture-composer-skills.ts <stills|journey> <outDir>
 *
 * Run `pnpm build:binary` and `pnpm build:desktop` first. It starts a
 * controller from the compiled binary in a scratch Hercule Home, fills the
 * Skill Library through `hercule skill import`, enlists a scripted runner that
 * lists the checkout's skills, and opens a thread that has a running turn, an
 * open Request and a queued input. Then, for each of the two themes, it
 * starts the test package, drives the composer the way a user does and
 * screenshots it.
 *
 * - `stills` writes `<NN>-<scene>-<theme>.png`, named like the prototype's
 *   screens, and prints what it measured in the page.
 * - `journey` records one continuous flow as a video: `$`, filter, pick; `/`,
 *   pick; hover a chip; send; the chips in the transcript.
 *
 * It never touches the user's Hercule Home: every controller and every CLI
 * login lives in a scratch directory that is deleted at the end. It runs on
 * plain Node, so its imports name the `.ts` file.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page } from "playwright";
import { PASSWORD, USERNAME } from "../../../scripts/controller-process.ts";
import { startSkillsWorld, type SeededSkill, type SkillsWorld } from "./composer-skills-world.ts";
import { launchTestPackage, quitApp, signIn } from "./packaged-app.ts";

const THEMES = ["orient-express", "whitehaven"] as const;
type Theme = (typeof THEMES)[number];

/** The prototype's page is 1440 x 900 with a 48px switcher bar under the app. */
const APP_SIZE = { width: 1440, height: 852 } as const;

/** One skill of the Skill Library, as the prototype's fixture names it. */
const LIBRARY_SKILLS: ReadonlyArray<readonly [string, string]> = [
  [
    "code-review",
    "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue asked for?), in parallel sub-agents",
  ],
  [
    "codebase-design",
    "Shared vocabulary for deep modules: find deepening opportunities and decide where a seam goes, even when a module imports half the repo",
  ],
  [
    "debug",
    "Find the evidenced root cause of a failure before changing a line, then fix it and keep the reproduction as a test",
  ],
  ["domain-modeling", "Build and sharpen the project's domain model: GLOSSARY.md terms and ADRs"],
  ["grilling", "Grill the user about a plan, decision or idea until it holds up"],
  [
    "handoff",
    "Compact the conversation into a handoff document, keeping what is important for the next agent",
  ],
  [
    "implement",
    "Build a locked SPEC one slice at a time: tests from the spec first, then the code, then a review round",
  ],
  [
    "improve-codebase-architecture",
    "Scan the codebase for deepening opportunities and grill through the one you pick",
  ],
  ["playwright-cli", "Automate browser interactions and test web pages"],
  ["prototype", "Build a throwaway prototype to answer a design question"],
  ["research", "Investigate a question against primary sources and write the findings down"],
  ["review", "Review a diff with independent sub-agent reviewers who try to break it"],
  ["ship", "Check the outgoing set, commit, push, and open cross-referenced pull requests"],
  ["spec", "Turn a feature idea into a locked SPEC through a question-and-answer interview"],
  ["teach", "Teach the user a new skill or concept within this workspace"],
  ["to-tickets", "Break a plan into tracer-bullet tickets with their blocking edges"],
  ["triage", "Move issues and pull requests through the triage states and write agent briefs"],
  ["wayfinder", "Plan work too big for one session as a map of decision tickets"],
];

/** The skills the `webshop` checkout holds in its `.agents/skills`. */
const REPOSITORY_SKILLS: ReadonlyArray<readonly [string, string]> = [
  [
    "release-checklist",
    "Walk the release checklist before a deploy: migrations, flags, Stripe webhooks, rollback",
  ],
  [
    "review",
    "Review a checkout or storefront change against the shop's payment and accessibility rules",
  ],
  [
    "stripe-fixtures",
    "Create and reset Stripe test customers, 3-D Secure cards and failed charges",
  ],
];

/** Converts `[name, description]` pairs to the objects `startSkillsWorld` takes. */
const toSeededSkills = (pairs: ReadonlyArray<readonly [string, string]>): SeededSkill[] =>
  pairs.map(([name, description]) => ({ name, description }));

/** The sidebar row of a thread shows its first message; each constant is a part that finds one. */
const FIX_TITLE = "why checkout fails for EU cards";
const READ_TITLE = "Read the Stripe v14 changelog";
const READING_TITLE = "Thread that reads its skills";
const FAILING_TITLE = "Thread whose skills fail";
const OPENING_MESSAGE =
  "$debug why checkout fails for EU cards that need 3‑D Secure since deploy #1289, then run $webshop:release-checklist: it checks the rollout before we ship.";
const REFUSAL =
  "Not steered: Claude Code can't start a skill in the middle of a turn. The input stays queued and runs when this turn ends.";

/** Everything a capture needs: the skills world and the threads the scenes use. */
interface World extends SkillsWorld {
  readonly threads: {
    readonly fix: string;
    readonly reading: string;
    readonly failing: string;
    readonly mini: string;
  };
}

/**
 * Opens the threads the scenes use: the Fix thread, which has a running turn
 * and an open Request, and three idle ones. Returns their ids.
 */
async function openThreads(base: SkillsWorld): Promise<World["threads"]> {
  const { fleet, placement } = base;
  const { thread: fix } = await fleet.spawnScriptedThread(
    { ...placement, prompt: OPENING_MESSAGE },
    [
      { kind: "command", command: "grep -rn requires_action src/checkout", forMs: 150 },
      {
        kind: "message",
        deltaMs: 2,
        text: 'Found it. Since Stripe SDK v14, `confirmPayment` returns `status: \'requires_action\'` for cards that need 3-D Secure. `handlePaymentResult` in `src/checkout/payment.ts` only handles `succeeded` and treats everything else as a failure, so we show "Card declined" instead of opening the 3-D Secure modal.\n\n```ts\nif (result.status === "requires_action") {\n  return openThreeDSModal(result.clientSecret);\n}\n```\n\nI wrote a failing test first, then the fix.',
      },
      { kind: "file_change", path: "src/checkout/payment.ts", forMs: 150 },
      {
        kind: "message",
        deltaMs: 2,
        text: "Tests pass. Ready to push the branch and open a pull request.",
      },
      { kind: "command", command: "git push -u origin fix/3ds-eu-cards", ask: true },
    ],
  );
  await fleet.waitForTurn(fix.id, 1, "waiting");

  const openIdleThread = async (prompt: string): Promise<string> => {
    const { thread, played } = await fleet.spawnScriptedThread({ ...placement, prompt }, [
      { kind: "end", state: "completed" },
    ]);
    await played;
    return thread.id;
  };
  const mini = await openIdleThread(READ_TITLE);
  const reading = await openIdleThread(READING_TITLE);
  const failing = await openIdleThread(FAILING_TITLE);

  return { fix: fix.id, reading, failing, mini };
}

/** Starts the test package for `theme`, signs in, sizes the window and opens the Fix thread. */
async function openApp(
  world: World,
  theme: Theme,
  recordVideoDir?: string,
): Promise<{ page: Page; quit: () => Promise<void>; userDataDir: string }> {
  const userDataDir = mkdtempSync(join(tmpdir(), "hercule-769-app-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({
      controllerUrl: world.url,
      appearance: {
        theme,
        followSystem: false,
        dayTheme: "whitehaven",
        nightTheme: "orient-express",
        glassPercent: 40,
        reduceTransparency: false,
        density: "comfortable",
        textSize: 2,
        openOn: "lastScreen",
        reduceMotion: false,
        marks: true,
      },
    }),
  );
  const app = await launchTestPackage(
    userDataDir,
    recordVideoDir === undefined ? undefined : { dir: recordVideoDir, size: APP_SIZE },
  );
  const page = await app.firstWindow();
  page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));
  await signIn(page, { username: USERNAME, password: PASSWORD });
  await page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setPosition(40, 40);
    window.setContentSize(size.width, size.height);
  }, APP_SIZE);
  await sleep(600);
  return {
    page,
    userDataDir,
    quit: async () => {
      await quitApp(app);
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

async function openThread(page: Page, title: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Threads", exact: true })
    .locator("a.side-row", { hasText: title })
    .first()
    .click();
  await page.locator(".transcript").waitFor();
  await sleep(500);
}

/** The composer's field, whichever role it has while a list is open. */
const findMessageField = (page: Page): Locator =>
  page.locator(".composer-field [contenteditable]").first();

/** Empties the field and leaves the focus in it. */
async function clearField(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const field = findMessageField(page);
  await field.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await sleep(150);
}

/** Types `text` into the focused field as a user does, a new line being Shift+Enter. */
async function typeText(page: Page, text: string): Promise<void> {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (index > 0) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(line, { delay: 12 });
  }
}

/** Moves the pointer to a place with nothing to hover: the empty top of the transcript. */
const parkPointer = (page: Page): Promise<void> => page.mouse.move(1000, 150);

/** Waits for the page to settle, then writes the screenshot. */
async function shoot(page: Page, outDir: string, name: string): Promise<void> {
  await sleep(450);
  await page.screenshot({ path: join(outDir, `${name}.png`), animations: "disabled" });
  console.log(name);
}

const CHIPS_TEXT =
  "$implement the fix for EU cards, then run the $webshop:release-checklist before we ship.\n$webshop:stripe-fixtures sets up the test cards, so use it before $debug if the card still fails.";

/** The numbers a scene reports about the page, which a screenshot cannot show. */
interface Measure {
  readonly scene: string;
  readonly detail: unknown;
}
const measures: Array<Measure> = [];

/** Reads, in the page, where the composer's card is and whether the lines stacked above it are visible. */
const READ_STACK = `(() => {
  const composer = document.querySelector(".composer");
  const card = composer.querySelector(".composer-card");
  const box = card.getBoundingClientRect();
  const children = [...composer.children];
  return {
    card: [box.x, box.y, box.width, box.height].map((n) => Math.round(n * 100) / 100),
    above: children.slice(0, children.indexOf(card)).map((child) => ({
      class: child.className,
      visibility: getComputedStyle(child).visibility,
    })),
  };
})()`;

/** Reads, in the page, whether the chip of the queued input holding "the diff" sits inside its row. */
const READ_QUEUED_FIT = `(() => {
  const row = [...document.querySelectorAll(".queued")].find((each) => each.textContent.includes("the diff"));
  const chip = row.querySelector("[data-skill]").getBoundingClientRect();
  const box = row.getBoundingClientRect();
  return {
    row: [box.top, box.bottom].map(Math.round),
    chip: [chip.top, chip.bottom].map(Math.round),
    scrollHeight: row.scrollHeight,
    clientHeight: row.clientHeight,
  };
})()`;

const READ_FIELD_TEXT = `document.querySelector(".composer-field [contenteditable]").textContent`;

const readStack = (page: Page): Promise<Record<string, unknown>> => page.evaluate(READ_STACK);

async function captureStills(world: World, theme: Theme, outDir: string): Promise<void> {
  const { page, quit } = await openApp(world, theme);
  try {
    await openThread(page, FIX_TITLE);
    const field = findMessageField(page);

    // Queue the thread's own input first: "Also check the Apple Pay path".
    await field.click();
    await typeText(page, "Also check the Apple Pay path");
    await page.keyboard.press("Enter");
    await page.locator(".queued", { hasText: "Apple Pay" }).waitFor();

    const buildScreenName = (number: number, scene: string) =>
      `${String(number).padStart(2, "0")}-${scene}-${theme}`;

    await clearField(page);
    const stackClosed = await readStack(page);
    // 05 $ list, first row active.
    await typeText(page, "$imp");
    await page.locator(".composer-skill-list-row").first().waitFor();
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(5, "dollar-list"));
    const stackOpen = await readStack(page);
    measures.push({ scene: `${theme} stack above the card`, detail: { stackClosed, stackOpen } });

    // 06 pointer on the third row.
    const rows = page.locator(".composer-skill-list-row");
    await rows.nth(2).hover();
    await shoot(page, outDir, buildScreenName(6, "dollar-hover"));

    // 07 no match.
    await clearField(page);
    await typeText(page, "$zzz");
    await page.locator(".composer-skill-list-empty").waitFor();
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(7, "dollar-empty"));

    // 08 every skill, scrolls.
    await clearField(page);
    await typeText(page, "$");
    await page.locator(".composer-skill-list-row").first().waitFor();
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(8, "dollar-long"));

    // 09 / list, today only skills.
    await clearField(page);
    await typeText(page, "/rev");
    await page.locator(".composer-skill-list-row").first().waitFor();
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(9, "slash-list"));

    // 10 / list with no query: the real list holds skills only.
    await clearField(page);
    await typeText(page, "/");
    await page.locator(".composer-skill-list-row").first().waitFor();
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(10, "slash-kinds"));

    // 11 chips.
    await clearField(page);
    await typeText(page, CHIPS_TEXT);
    await page.locator("[data-skill]").nth(3).waitFor();
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(11, "chips"));

    // 12 one chip selected: the repository chip, by clicking it.
    const chips = page.locator(".composer-field [data-skill]");
    await chips.nth(1).click();
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(12, "chip-selected"));

    // 13 hover card, on a chip that is not selected: the arrow moves the caret past the chip.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("End");
    await chips.nth(1).hover();
    await page.locator(".skill-hover-card").waitFor();
    await shoot(page, outDir, buildScreenName(13, "chip-hover"));

    // 14 same name, library and repository.
    await clearField(page);
    await typeText(page, "Run $review on the diff, and $webshop:review on the checkout code.");
    await page.locator(".composer-field [data-skill]").nth(1).waitFor();
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(14, "chip-same-name"));
    await clearField(page);

    // 17 queued input with a skill.
    await typeText(page, "Then $review the diff");
    await page.keyboard.press("Enter");
    await page.locator(".queued", { hasText: "the diff" }).waitFor();
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(17, "queued-skill"));
    const queuedFit = await page.evaluate(READ_QUEUED_FIT);
    measures.push({ scene: `${theme} queued chip fits its row`, detail: queuedFit });

    // 16 refusal: Steer on the input with a skill, which the runner refuses.
    world.placement.runner.setSkills({ ...world.skills, refuseSkillSteer: REFUSAL });
    await page
      .locator(".queued", { hasText: "the diff" })
      .getByRole("button", { name: /Steer/ })
      .click();
    await page.locator(".queued-error", { hasText: "Not steered" }).waitFor();
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(16, "refusal"));
    world.placement.runner.setSkills(world.skills);

    // 15 transcript: the sent message with two skills, scrolled to its start. The wheel
    // scrolls as a user does, which shrinks the composer once focus has left it.
    await page.locator(".transcript").click({ position: { x: 700, y: 60 } });
    await page.mouse.wheel(0, -100_000);
    await sleep(600);
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(15, "transcript"));

    // Backspace deletes a chip in one press.
    await page.mouse.wheel(0, 100_000);
    await sleep(600);
    await clearField(page);
    await typeText(page, "$debug ");
    await page.locator(".composer-field [data-skill]").waitFor();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Backspace");
    const afterBackspace = await page.locator(".composer-field [data-skill]").count();
    const textAfter = await page.evaluate(READ_FIELD_TEXT);
    measures.push({
      scene: `${theme} one Backspace after a chip`,
      detail: { chipsLeft: afterBackspace, textLeft: textAfter },
    });
    await clearField(page);

    // Reading skills and a failed read, on threads whose skills were never read.
    // Each route is set before its thread opens, so the read is the thread's first.
    await page.route(`**/api/v1/sessions/${world.threads.reading}/skills*`, async (route) => {
      await sleep(8_000);
      await route.continue();
    });
    await openThread(page, READING_TITLE);
    await findMessageField(page).click();
    await typeText(page, "$");
    await page.locator(".composer-skill-list-empty").waitFor();
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(18, "reading-skills"));
    await clearField(page);

    await page.route(`**/api/v1/sessions/${world.threads.failing}/skills*`, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "internal", message: "The runner studio-mac did not answer in time." },
        }),
      }),
    );
    await openThread(page, FAILING_TITLE);
    await findMessageField(page).click();
    await typeText(page, "$");
    await page.locator(".composer-skill-list-empty").waitFor();
    await sleep(600);
    await parkPointer(page);
    await shoot(page, outDir, buildScreenName(19, "failed-skills"));
    await clearField(page);
  } finally {
    await quit();
  }
}

/** Records one continuous flow of the composer, in the dark theme. */
async function recordJourney(world: World, outDir: string): Promise<void> {
  const videoDir = join(outDir, "video-raw");
  mkdirSync(videoDir, { recursive: true });
  const { page, quit } = await openApp(world, "orient-express", videoDir);
  try {
    // An idle thread, so the sent message goes into the transcript at once and shows its chips.
    await openThread(page, READ_TITLE);
    const field = findMessageField(page);
    await field.click();
    await sleep(700);
    await typeText(page, "$");
    await sleep(900);
    await typeText(page, "imp");
    await sleep(1100);
    await page.keyboard.press("ArrowDown");
    await sleep(500);
    await page.keyboard.press("ArrowUp");
    await sleep(500);
    await page.keyboard.press("Enter");
    await sleep(700);
    await typeText(page, "the fix for EU cards, then ");
    await typeText(page, "/");
    await sleep(900);
    await typeText(page, "release");
    await sleep(1100);
    await page.keyboard.press("Enter");
    await sleep(900);
    await typeText(page, "before we ship.");
    await sleep(500);
    await page.locator(".composer-field [data-skill]").nth(1).hover();
    await page.locator(".skill-hover-card").waitFor();
    await sleep(1800);
    await parkPointer(page);
    await sleep(500);
    await page.keyboard.press("Enter");
    await page.locator(".transcript [data-skill]").first().waitFor();
    await sleep(2200);
  } finally {
    await quit();
  }
  console.log(`video in ${videoDir}: ${readdirSync(videoDir).join(", ")}`);
}

async function main(): Promise<void> {
  const [mode, outDir] = process.argv.slice(2);
  if ((mode !== "stills" && mode !== "journey") || outDir === undefined) {
    throw new Error("usage: capture-composer-skills.ts <stills|journey> <outDir>");
  }
  mkdirSync(outDir, { recursive: true });
  // Each run gets a controller of its own, so the queued inputs of one theme never reach the next.
  const runs = mode === "stills" ? THEMES : (["orient-express"] as const);
  for (const theme of runs) {
    const base = await startSkillsWorld({
      scriptName: "capture",
      librarySkills: toSeededSkills(LIBRARY_SKILLS),
      repositorySkills: toSeededSkills(REPOSITORY_SKILLS),
      checkoutName: "webshop",
    });
    try {
      const world: World = { ...base, threads: await openThreads(base) };
      if (mode === "stills") await captureStills(world, theme, outDir);
      else await recordJourney(world, outDir);
    } finally {
      await base.cleanup();
    }
  }
  if (mode === "stills") console.log(JSON.stringify(measures, null, 2));
}

await main();
