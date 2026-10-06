/**
 * Tests the subagents of a thread in the packaged app, signed in to a real
 * controller whose thread runs on a scripted runner that makes the session's
 * own agent start subagents (spec 17, §Thread, Subagents):
 *
 * - while the main agent is idle and a subagent's question is docked, the
 *   subagent's Stop is two clicks away, through the pager's "Open subagent"
 *   and the status card's Stop, and using it closes the question;
 * - a spawn line under the work stretch that started a subagent opens the
 *   subagent's page, which shows the tinted crumb with its "subagent" tag,
 *   the brief card and the status card;
 * - the tally pill opens the side pane on its Subagents surface, and the
 *   header's toggle closes it again.
 *
 * Each test plays its script and waits, through the API, for the controller
 * to have recorded where it got to before it opens the thread, so what the
 * page shows comes from the thread's loader rather than from a race with the
 * live connection.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Locator } from "playwright";
import { describe, expect, it } from "vitest";
import type { ScriptStep } from "../../apps/desktop/scripts/scripted-runner";
import { arrangeFleet, openSignedIn, openThread } from "./harness";

/** The user's first message, which also titles the thread. */
const PROMPT = "Get the release ready.";

/** The subagent each test's script starts. */
const SUBAGENT = {
  id: "plan-migration",
  description: "Plan the database migration",
  agentType: "Plan",
  brief: "Plan the migration that adds the archived_at column, and how to roll it out safely.",
} as const;

/**
 * Returns a script for the session's own agent: it says what it will do,
 * starts `SUBAGENT` to play `steps`, and ends its turn as completed. With
 * `background`, the turn ends while the subagent still works.
 */
function buildDelegatingScript(
  steps: ReadonlyArray<ScriptStep>,
  background: boolean,
): ReadonlyArray<ScriptStep> {
  return [
    { kind: "message", text: "I'll hand the migration plan to a subagent." },
    {
      kind: "subagent",
      subagentId: SUBAGENT.id,
      description: SUBAGENT.description,
      agentType: SUBAGENT.agentType,
      brief: SUBAGENT.brief,
      background,
      steps,
    },
    { kind: "end", state: "completed" },
  ];
}

/**
 * Starts a controller with one thread, titled `PROMPT`, whose agent started
 * `SUBAGENT` and ended its turn once the subagent had finished, and the app
 * signed in to it with the thread open.
 */
async function arrangeFinishedSubagent() {
  const { url, fleet } = await arrangeFleet();
  const runner = await fleet.enlistRunner("studio");
  const { thread, played } = await fleet.spawnScriptedThread(
    { runner, prompt: PROMPT },
    buildDelegatingScript([{ kind: "message", text: "Adding the column takes two steps." }], false),
  );
  await played;
  await fleet.waitForTurn(thread.id, 1, "completed");
  const { page } = await openSignedIn(url);
  await openThread(page, PROMPT);
  return page;
}

/** Returns the inline `--hue` of the element `locator` finds, such as "var(--hue-3)". */
function readHue(locator: Locator): Promise<string> {
  return locator.evaluate((element) => (element as HTMLElement).style.getPropertyValue("--hue"));
}

describe("the subagents of a thread", () => {
  it("reaches a subagent's Stop in two clicks while the main agent is idle and the subagent's question is docked, and Stop closes the question", async () => {
    const { url, fleet, client } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: PROMPT },
      buildDelegatingScript(
        [
          {
            kind: "question",
            questions: [
              {
                question: "Can the migration take the service down for a minute?",
                header: "Downtime",
                options: [
                  { label: "Yes, at night", description: "One migration, run at 03:00." },
                  { label: "No", description: "The column is added in two steps." },
                ],
                multiSelect: false,
              },
            ],
          },
        ],
        true,
      ),
    );
    // The session's status follows only its own agent's turns, so the
    // thread is idle while the subagent's question waits.
    await expect
      .poll(async () => {
        const session = await client.session.read({ params: { id: thread.id } });
        return {
          status: session.status,
          askers: session.openRequests.map((request) => request.subagentId),
        };
      })
      .toEqual({ status: "idle", askers: [SUBAGENT.id] });
    const { page } = await openSignedIn(url);
    await openThread(page, PROMPT);

    const dock = page.getByRole("group", { name: "The agent needs answers." });
    await dock.waitFor();
    // The gap this closes: an idle composer has no Stop, and a question has
    // no decision to turn it down with.
    expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(0);
    expect(
      await page
        .getByText(`${SUBAGENT.description} asks · subagent of the main agent`, { exact: true })
        .count(),
    ).toBe(1);

    await page.getByRole("link", { name: "Open subagent" }).click();
    const statusCard = page.locator(".status-card");
    await statusCard.getByRole("button", { name: "Stop", exact: true }).click();

    await dock.waitFor({ state: "detached" });
    await statusCard.getByText(/^Stopped after \d/).waitFor();
    expect(await statusCard.getByRole("button", { name: "Stop", exact: true }).count()).toBe(0);
    expect((await client.session.read({ params: { id: thread.id } })).openRequests).toEqual([]);
    const { items } = await client.session.querySubagents({
      params: { id: thread.id },
      query: { limit: 10 },
    });
    expect(items.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: SUBAGENT.id, status: "stopped" },
    ]);
    await played;
  });

  it("opens a subagent's page from its spawn line under the work stretch, with the tinted crumb, the brief card and the status card", async () => {
    const page = await arrangeFinishedSubagent();
    const transcript = page.locator('section[aria-label="Transcript"]');
    // The spawn lines sit with the divider of the stretch that started them.
    const spawnLines = transcript
      .locator(".tx-item")
      .filter({ has: page.locator("button.worked") })
      .getByRole("list", { name: "Subagents started here" });
    const spawnLine = spawnLines.getByRole("link");
    expect(await spawnLine.count()).toBe(1);
    expect(await spawnLine.getByText(SUBAGENT.description, { exact: true }).count()).toBe(1);
    expect(await spawnLine.getByText(/^done · \d/).count()).toBe(1);
    const spawnLineHue = await readHue(spawnLine);

    await spawnLine.click();

    const crumbs = page.getByRole("navigation", { name: "Subagent's place in the thread" });
    await crumbs.waitFor();
    expect(await crumbs.getByRole("link", { name: PROMPT }).count()).toBe(1);
    const here = crumbs.locator('[aria-current="page"]');
    expect(await here.getByText(SUBAGENT.description, { exact: true }).count()).toBe(1);
    expect(await here.getByText("subagent", { exact: true }).count()).toBe(1);
    // The crumb, the brief card and the spawn line take the subagent's hue,
    // so the page matches the line that opened it.
    expect(spawnLineHue).toMatch(/^var\(--hue-/);
    const brief = page.getByRole("button", { name: SUBAGENT.brief });
    expect(await readHue(here)).toBe(spawnLineHue);
    // The brief's button sits directly in the brief card.
    expect(await readHue(brief.locator(".."))).toBe(spawnLineHue);

    expect(
      await page
        .getByText(`Brief from the main agent · ${SUBAGENT.agentType} agent`, { exact: true })
        .count(),
    ).toBe(1);
    expect(await brief.getAttribute("aria-expanded")).toBe("false");
    await brief.click();
    expect(await brief.getAttribute("aria-expanded")).toBe("true");

    const statusCard = page.locator(".status-card");
    expect(await statusCard.getByText(/^Done in \d/).count()).toBe(1);
    // The script reports no Token Usage, so the tokens are left out.
    expect(
      await statusCard.getByText("Subagent of the main agent · takes no messages").count(),
    ).toBe(1);
    expect(await statusCard.getByRole("button", { name: "Stop" }).count()).toBe(0);

    await statusCard.getByRole("link", { name: "Open parent" }).click();
    await crumbs.waitFor({ state: "detached" });
    await spawnLines.waitFor();
  });

  it("opens the side pane on the Subagents surface from the tally pill, and closes it from the header's toggle", async () => {
    const page = await arrangeFinishedSubagent();
    // The tally pill's name is its word and its count, such as "Subagents 1".
    const pill = page.getByRole("button", { name: /^Subagents \d/ });
    const pane = page.getByRole("complementary", { name: "Side pane" });
    expect(await pill.getAttribute("aria-pressed")).toBe("false");
    expect(await pane.count()).toBe(0);

    await pill.click();

    await pane.waitFor();
    expect(await pane.getByRole("tab", { name: "Subagents" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    const surface = pane.getByRole("tabpanel", { name: "Subagents" });
    await surface.getByRole("link", { name: SUBAGENT.description, exact: true }).waitFor();
    expect(await pill.getAttribute("aria-pressed")).toBe("true");

    const toggle = page.getByRole("button", { name: "Hide the side pane", exact: true });
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    await toggle.click();

    await pane.waitFor({ state: "detached" });
    expect(await pill.getAttribute("aria-pressed")).toBe("false");
    expect(
      await page
        .getByRole("button", { name: "Show the side pane", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
