/**
 * Tests what the controller does with the usage a runner reports for a
 * running session, over the runner socket against a real controller and one
 * fake runner (spec 06 section 18):
 *
 * - a report is stored for the Provider Account the session runs on, and
 *   shows on the account as read from a session;
 * - a report for a session whose account kind declares no usage is dropped.
 *
 * The runner frames travel the same queue as the session's own events, so a
 * report sent after another has been applied only after it.
 */
import { describe, expect, it, vi } from "vitest";
import type { ProviderAccount } from "@hercule/contract";
import type { UsageReading } from "@hercule/protocol";
import type { Plugin, ProviderDefinition } from "@hercule/plugin-host";
import { get } from "../../http/testing";
import { buildHarnessDefinition, createPluginFixture } from "../../plugins/testing";
import {
  WAIT_DEADLINE_MS,
  findProviderAccountId,
  spawnSessionOrFail,
  waitForStartFrames,
  waitUntil,
  withFleet,
  type Arranged,
} from "../../sessions/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const METERED_HARNESS_ID = "metered/metered";
const PLAIN_HARNESS_ID = "plain/plain";

/** Builds a plugin with a harness and a provider of the same name whose one account kind runs in it. */
const buildPlugin = (id: string, usage: ProviderDefinition["kinds"][number]["usage"]): Plugin => {
  const harnessId = `${id}/${id}`;
  return createPluginFixture({
    id,
    capabilities: ["harnesses", "providers"],
    definitions: [
      buildHarnessDefinition(id, [
        {
          providerId: harnessId,
          kinds: [{ kind: "subscription" }],
          modelArgument: "{model}",
          models: "all",
        },
      ]),
    ],
    providers: [
      {
        id,
        displayName: `Provider ${id}`,
        kinds: [
          {
            id: "subscription",
            title: "Subscription",
            description: "A plan signed in on each machine.",
            setup: [{ kind: "harness-login", method: "sign-in" }],
            ...(usage === undefined ? {} : { usage }),
            harnesses: [harnessId],
          },
        ],
        defaultHarnessId: harnessId,
      },
    ],
  }).plugin;
};

/** Runs `body` against a controller whose runner can run an account that reports usage and one that does not. */
const withUsageFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  withFleet(body, {
    plugins: [buildPlugin("metered", { readBy: "sessions" }), buildPlugin("plain", undefined)],
    facts: {
      os: "darwin",
      arch: "arm64",
      totalMemoryBytes: 68719476736,
      docker: false,
      toolchains: [],
      harnesses: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
      adapters: [METERED_HARNESS_ID, PLAIN_HARNESS_ID],
      identityPort: 4941,
    },
    models: [
      { slug: "fast", name: "Fast", imageInput: { maxBytes: null }, isDefault: true, options: [] },
    ],
  });

const fiveHour = (usedPercent: number): UsageReading => ({
  kind: "window",
  window: "five-hour",
  usedPercent,
  resetsAt: null,
  hit: false,
  takenAt: new Date().toISOString(),
});

/** Returns the account as the API shows it. */
const readAccount = async (arranged: Arranged, id: string): Promise<ProviderAccount> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/provider-accounts/${id}`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ProviderAccount;
};

/** Spawns a session on the account and waits until the runner got its start frame. */
const startSessionOn = async (arranged: Arranged, providerAccountId: string): Promise<string> => {
  const session = await spawnSessionOrFail(arranged, { prompt: "hello", providerAccountId });
  await waitForStartFrames(arranged, session.id, 1);
  return session.id;
};

describe("a runner's usage report for a session", () => {
  it("is stored for the session's account, and dropped when its kind declares no usage", async () => {
    await withUsageFleet(async (arranged) => {
      const metered = findProviderAccountId(arranged, METERED_HARNESS_ID);
      const plain = findProviderAccountId(arranged, PLAIN_HARNESS_ID);
      const meteredSession = await startSessionOn(arranged, metered);
      const plainSession = await startSessionOn(arranged, plain);

      // The plain account's report goes first. Reports are applied in the
      // order they arrive, so once the metered one is stored, the plain one
      // has been applied or dropped.
      arranged.wire.send({
        _tag: "accountUsageReported",
        sessionId: plainSession,
        readings: [fiveHour(30)],
      });
      arranged.wire.send({
        _tag: "accountUsageReported",
        sessionId: meteredSession,
        readings: [fiveHour(42)],
      });

      const stored = await waitUntil("stored the metered account's usage", async () => {
        const account = await readAccount(arranged, metered);
        return account.usage.length > 0 ? account : undefined;
      });
      expect(stored.usage).toMatchObject([
        { kind: "window", window: "five-hour", usedPercent: 42, source: "session" },
      ]);
      expect((await readAccount(arranged, plain)).usage).toEqual([]);
    });
  });
});
