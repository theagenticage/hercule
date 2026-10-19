/** Tests the answers to a controller's inspection and preview of repository skills. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import type { Workspaces } from "../workspaces";
import { inspectRepositorySkills, previewRepositorySkills } from "./inspection";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Makes a folder holding one skill, `release`, and returns its path. */
const makeRepo = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hercule-inspection-")));
  roots.push(root);
  mkdirSync(join(root, ".agents/skills/release"), { recursive: true });
  writeFileSync(
    join(root, ".agents/skills/release/SKILL.md"),
    "---\ndescription: Cuts a release\n---\n",
  );
  return root;
};

/** Stands in for the runner's workspaces: each id is a primary workspace of one checkout. */
const buildWorkspaces = (
  paths: Readonly<Record<string, string>>,
  onResolve: () => Promise<void> = () => Promise.resolve(),
): Pick<Workspaces, "resolve"> => ({
  resolve: (workspaceId) =>
    Effect.promise(async () => {
      await onResolve();
      const path = paths[workspaceId];
      return path === undefined
        ? undefined
        : {
            kind: "primary" as const,
            root: path,
            cwd: path,
            checkouts: [
              {
                checkoutId: "checkout-1",
                resourceId: "resource-1",
                remote: "github.com/acme/app",
                path,
              },
            ],
          };
    }),
});

describe("previewRepositorySkills", () => {
  it("lists each repo from its main workspace under the subdirectory it would get", async () => {
    const api = makeRepo();
    const outcome = await Effect.runPromise(
      previewRepositorySkills(buildWorkspaces({ "workspace-api": api }), [
        { remote: "github.com/acme/api", subdirectory: "api", workspaceId: "workspace-api" },
      ]),
    );

    expect(outcome).toEqual({
      status: "listed",
      skills: [
        {
          checkoutName: "api",
          name: "release",
          description: "Cuts a release",
          path: "api/.agents/skills/release",
        },
      ],
      skipped: [],
      truncated: false,
    });
  });

  it("skips a repo without a main workspace, and one the runner cannot resolve, and still reserves their names", async () => {
    const outcome = await Effect.runPromise(
      previewRepositorySkills(buildWorkspaces({ "workspace-web": makeRepo() }), [
        { remote: "github.com/acme/api", subdirectory: "api", workspaceId: null },
        { remote: "github.com/acme/web", subdirectory: "web", workspaceId: "workspace-gone" },
        // Takes the prefix of the first checkout, which holds it though nothing was read.
        { remote: "github.com/acme/api", subdirectory: "api", workspaceId: "workspace-web" },
      ]),
    );

    expect(outcome).toMatchObject({
      status: "listed",
      skills: [],
      skipped: [
        {
          path: "api",
          reason:
            "the repo `api` has no ready main workspace on this runner; provision or attach its main workspace on this runner",
        },
        {
          path: "web",
          reason:
            "the repo `web` has no ready main workspace on this runner; provision or attach its main workspace on this runner",
        },
        {
          path: "api/.agents/skills/release",
          reason: "checkout `api` has the same skill prefix as another checkout in this workspace",
        },
      ],
      truncated: false,
    });
  });
});

describe("inspectRepositorySkills", () => {
  it("answers failed for a workspace the runner does not have", async () => {
    const outcome = await Effect.runPromise(inspectRepositorySkills(buildWorkspaces({}), "nope"));

    expect(outcome).toEqual({ status: "failed", message: "The runner has no workspace `nope`." });
  });

  it("reads at most four workspaces at a time, however many are asked for", async () => {
    const repo = makeRepo();
    let running = 0;
    let mostRunning = 0;
    const workspaces = buildWorkspaces({ one: repo }, async () => {
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
    });

    const outcomes = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 12 }, () => inspectRepositorySkills(workspaces, "one")),
        { concurrency: "unbounded" },
      ),
    );

    expect(outcomes.every((outcome) => outcome.status === "listed")).toBe(true);
    expect(mostRunning).toBe(4);
  });

  it("shares the limit between inspections and previews", async () => {
    const repo = makeRepo();
    let running = 0;
    let mostRunning = 0;
    const workspaces = buildWorkspaces({ one: repo }, async () => {
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
    });
    const preview = previewRepositorySkills(workspaces, [
      { remote: "github.com/acme/app", subdirectory: null, workspaceId: "one" },
    ]);

    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          index % 2 === 0 ? inspectRepositorySkills(workspaces, "one") : preview,
        ),
        { concurrency: "unbounded" },
      ),
    );

    expect(mostRunning).toBe(4);
  });
});

describe("a listing that never returns", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Stands in for a runner whose file system hangs: resolving the workspace never ends. */
  const stuckWorkspaces: Pick<Workspaces, "resolve"> = {
    resolve: () => Effect.never,
  };

  it("answers failed after nine seconds and frees its place for the next listing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const repo = makeRepo();
    const answers = Array.from({ length: 4 }, () =>
      Effect.runPromise(inspectRepositorySkills(stuckWorkspaces, "one")),
    );
    // All four places are taken. The fifth would wait forever if the first four kept them.
    const next = Effect.runPromise(inspectRepositorySkills(buildWorkspaces({ one: repo }), "one"));

    await vi.advanceTimersByTimeAsync(9000);

    for (const answer of await Promise.all(answers)) {
      expect(answer).toEqual({
        status: "failed",
        message: "listing the workspace's repository skills took longer than 9 seconds",
      });
    }
    await expect(next).resolves.toMatchObject({ status: "listed" });
  });

  it("answers a preview the same way", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const answer = Effect.runPromise(
      previewRepositorySkills(stuckWorkspaces, [
        { remote: "github.com/acme/app", subdirectory: null, workspaceId: "one" },
      ]),
    );

    await vi.advanceTimersByTimeAsync(9000);

    await expect(answer).resolves.toEqual({
      status: "failed",
      message: "listing the workspace's repository skills took longer than 9 seconds",
    });
  });
});
