/**
 * What the Intake end-to-end files share (`intake.test.ts`,
 * `intake-moves.test.ts` and `intake-notification.test.ts`): raising signals,
 * editing the scratch database while the controller is stopped, and reading
 * the screen.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "playwright";
import { expect } from "vitest";
import { buildCleanEnv, findCompiledBinary, runCli } from "../../scripts/controller-process";
import type { ArrangedFleet } from "./harness";

/**
 * Raises a signal with `hercule signal raise`, as the user `fleet` signed in
 * as, and returns its id. `args` are the command's flags after `--reason`.
 * Fails when the command fails.
 */
export async function raiseSignal(
  { url, home, fleet }: ArrangedFleet,
  kind: string,
  title: string,
  args: ReadonlyArray<string> = [],
): Promise<string> {
  const ran = await runCli(
    [
      "signal",
      "raise",
      "--kind",
      kind,
      "--title",
      title,
      "--reason",
      "Raised by a test",
      // The CLI asks for at least one event. Nothing checks that the event
      // exists, and no plugin in the test binary can emit one.
      "--event-id",
      "1",
      ...args,
      "--json",
    ],
    {
      home,
      binary: findCompiledBinary(),
      env: { HERCULE_API_URL: url, HERCULE_TOKEN: fleet.token },
    },
  );
  expect(ran.code, ran.stderr).toBe(0);
  return (JSON.parse(ran.stdout) as { signalId: string }).signalId;
}

/**
 * Runs `script` against the controller's database, for the rare arrangement
 * no operation can make: only a plugin's kind may be urgent or carry its own
 * blocks, no plugin raises signals in the test binary, and a Connection to
 * GitHub cannot be signed in to offline. The script sees `database` (a
 * `bun:sqlite` database) and `args`, and its failure fails the test. The
 * controller must be stopped, because it holds its database locked while it
 * runs.
 */
export function editDatabase(home: string, script: string, args: ReadonlyArray<unknown>): void {
  const written = spawnSync(
    "bun",
    [
      "--eval",
      `
    import { Database } from "bun:sqlite";
    const database = new Database(process.argv[1]);
    const args = JSON.parse(process.argv[2]);
    ${script}
    database.close();
  `,
      join(home, "data", "hercule.db"),
      JSON.stringify(args),
    ],
    { encoding: "utf8", env: buildCleanEnv() },
  );
  expect(written.status, written.stderr).toBe(0);
}

/**
 * Sets columns of the signal `signalId`, to the values in `columns` (column
 * name to value). See `editDatabase`.
 */
export function writeSignalColumns(
  home: string,
  signalId: string,
  columns: Readonly<Record<string, string>>,
): void {
  editDatabase(
    home,
    String.raw`
    const [signalId, columns] = args;
    const id = Buffer.from(signalId.replaceAll("-", ""), "hex");
    const entries = Object.entries(columns);
    const assignments = entries.map(([name]) => name + " = ?").join(", ");
    const { changes } = database
      .query("UPDATE signals SET " + assignments + " WHERE id = ?")
      .run(...entries.map(([, value]) => value), id);
    if (changes !== 1) throw new Error("no signal " + signalId);
  `,
    [signalId, columns],
  );
}

/**
 * Returns the title of the screen in the main pane's bar, such as "Intake",
 * or null when the screen draws no such bar, as the Office does.
 */
export async function readScreenTitle(page: Page): Promise<string | null> {
  const [title] = await page.locator("main .bar .title").allTextContents();
  return title ?? null;
}

/** Returns the titles of Intake's rows, top to bottom. */
export const readRowTitles = (page: Page): Promise<string[]> =>
  page.locator('section[aria-label="Signals"] .ask-title').allTextContents();

/** Returns the selected row's title, or null when no row is selected. */
export async function readSelectedTitle(page: Page): Promise<string | null> {
  const selected = page.locator('section[aria-label="Signals"] .ask-row[aria-current="true"]');
  return (await selected.count()) === 0 ? null : selected.locator(".ask-title").textContent();
}

/** Returns the accessible names of the Hercule segment and the Intake row's count, "" when hidden. */
export async function readToDoCounts(page: Page): Promise<{ segment: string; row: string }> {
  const segment = page.getByRole("tablist", { name: "Sidebar" }).getByRole("tab").nth(1);
  const rowCount = page.locator("a.nav-row", { hasText: "Intake" }).locator(".count");
  return {
    // The segment carries an accessible name only while it has a count.
    segment:
      (await segment.getAttribute("aria-label")) ?? ((await segment.textContent()) ?? "").trim(),
    row: (await rowCount.count()) === 0 ? "" : ((await rowCount.textContent()) ?? ""),
  };
}

/** Selects the row titled `title` with a click, which also gives it the focus the keys need. */
export async function selectRow(page: Page, title: string): Promise<void> {
  await page.locator(".ask-row", { hasText: title }).click();
  await expect.poll(() => readSelectedTitle(page)).toBe(title);
}

/** The pane of the open signal. */
export const openSignalPane = (page: Page) => page.getByRole("region", { name: "The open signal" });

/** The folder the journey's video is written to, when one is asked for. */
export const evidence = process.env["HERCULE_INTAKE_EVIDENCE"];

/** How long the journey waits after each step, so a reviewer can see what changed. */
export const PAUSE_MS = 1200;
