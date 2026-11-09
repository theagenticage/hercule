/**
 * Proves the scripted fleet at the size of the Fleet screens' worst case,
 * against the compiled controller: 500 threads over two runners are spawned
 * and listed in one page. It prints how long spawning, settling and listing
 * took; vitest shows that output only with `--reporter=verbose`. No app
 * window is started. Run `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import { arrangeFleet } from "./harness";

describe("the scripted fleet, with many threads", () => {
  it("spawns 500 threads over two runners and lists them in one page", async () => {
    const { fleet, client } = await arrangeFleet();
    const runners = await Promise.all(
      ["scripted-1", "scripted-2"].map((name) =>
        fleet.enlistRunner(name, { maxConcurrentSessions: 250 }),
      ),
    );

    const began = performance.now();
    await Promise.all(runners.map((runner) => fleet.spawnThreads(250, { runner })));
    const spawned = performance.now();
    await expect
      .poll(
        async () => {
          const { items } = await client.session.query({ query: { kind: "thread", limit: 500 } });
          return items.filter((session) => session.status === "busy").length;
        },
        { timeout: 30_000 },
      )
      .toBe(500);
    const settled = performance.now();
    const { items } = await client.session.query({ query: { kind: "thread", limit: 500 } });
    const listed = performance.now();

    expect(items).toHaveLength(500);
    console.info(
      `500 threads: spawned in ${Math.round(spawned - began)} ms, ` +
        `all busy ${Math.round(settled - spawned)} ms later, ` +
        `listed in ${Math.round(listed - settled)} ms`,
    );
  });
});
