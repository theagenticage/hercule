/**
 * Tests the sidebar's thread list for a large project in the packaged app,
 * signed in to a real controller whose threads a fleet of scripted runners
 * puts in known states (spec 17, §Design system, **The sidebar**): the list
 * mounts about as many rows for a project of 500 threads as for one of 40.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import { arrangeFleet, openSignedIn } from "./harness";
import { readCounts } from "./sidebar-helpers";

describe("the sidebar, with a large project", () => {
  it("mounts about as many rows for a project of 500 threads as for one of 40, expanded", async () => {
    const { url, fleet } = await arrangeFleet();
    const project = await fleet.createProject("Fleet");
    const [first, second] = await Promise.all(
      ["studio", "laptop"].map((name) => fleet.enlistRunner(name, { maxConcurrentSessions: 250 })),
    );
    await fleet.spawnThreads(40, { runner: first!, projectId: project.id });
    const { page } = await openSignedIn(url);
    await expect.poll(() => readCounts(page)).toBe("40 working · 0 waiting · 0 idle");

    // Every thread works alone, so a row is a thread and the project hides 35 rows.
    const moreRows = page.getByRole("button", { name: "35 more", exact: true });
    await moreRows.click();
    await moreRows.waitFor({ state: "detached" });
    const countMounted = () =>
      page.evaluate(() => ({
        rows: document.querySelectorAll('nav[aria-label="Threads"] .side-row').length,
        elements: document.querySelectorAll('nav[aria-label="Threads"] *').length,
      }));
    const with40 = await countMounted();

    await Promise.all([
      fleet.spawnThreads(210, { runner: first!, projectId: project.id }),
      fleet.spawnThreads(250, { runner: second!, projectId: project.id }),
    ]);
    await expect
      .poll(() => readCounts(page), { timeout: 30_000 })
      .toBe("500 working · 0 waiting · 0 idle");
    const with500 = await countMounted();

    console.info(
      `mounted in the thread list, one expanded project: ` +
        `40 threads, ${with40.rows} rows and ${with40.elements} elements; ` +
        `500 threads, ${with500.rows} rows and ${with500.elements} elements`,
    );
    // The component test holds the list to 45 mounted items for 500 threads;
    // every row is an item.
    expect(with500.rows).toBeLessThanOrEqual(45);
    expect(with500.rows).toBeLessThanOrEqual(with40.rows + 1);
  });
});
