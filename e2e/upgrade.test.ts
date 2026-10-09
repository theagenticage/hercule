/**
 * Tests that a database filled by the previous `edge` release upgrades cleanly
 * to the new binary: the migrations run, the controller boots, and every record
 * is still readable.
 *
 * This catches migrations that are correct on an empty database but fail on
 * real data. The fixture is one representative conversation of several owner
 * turns (and the notices the old binary writes beside them), plus a named
 * Provider Instance. After the upgrade the test checks that those records,
 * their content, ordering and associations survived. It is not a matrix of
 * session states or provider behaviour.
 *
 * A live session and its transcript need a logged-in harness. That install and
 * a real turn sit outside the one-minute added-CI budget, and CI has no vendor
 * login. When `session spawn` does place a Thread, the test also checks that
 * session and its transcript; when placement refuses, the conversation turns
 * are the persisted thread.
 *
 * In CI the previous `edge` release must exist: a missing baseline fails the
 * job rather than skipping it. Locally, with no `edge` release, the test is
 * skipped and says so.
 */
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  completeSetup,
  runCli,
  startController,
  type Controller,
  type Ran,
} from "../scripts/controller-process";
import {
  createTemporaryHome,
  parseJsonOutputOrFail,
  readApiKey,
  readTranscript,
  waitForEnrolledRunner,
  type Page,
  type Row,
  type TemporaryHome,
} from "./harness";

const EDGE_TAG = "edge";

/** A few turns of one conversation, seeded through the old release's CLI. */
const TURNS = [
  "What is the status of the test-project repository?",
  "Which risks should we watch this week?",
  "What should we do next?",
] as const;

const PROVIDER_NAME = "upgrade-fixture";

interface SeededMessage {
  readonly id: string;
  readonly position: number;
  readonly senderRole: string;
  readonly text: string;
  readonly sessionId: string | null;
}

interface SeededSession {
  readonly id: string;
  readonly conversationId: string | null;
}

interface SeededTranscriptRow {
  readonly position: number;
  readonly tag: string;
}

interface SeededProvider {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
}

let state: TemporaryHome | undefined;
let edgeBinary: string | undefined;
let newBinary: string;

/**
 * Returns the edge asset name for this process's platform, or `undefined`
 * when the edge release does not publish a binary for it.
 */
function resolveEdgeAssetName(): string | undefined {
  if (process.platform === "darwin" && process.arch === "arm64") return "hercule-darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "hercule-linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "hercule-linux-arm64";
  return undefined;
}

/**
 * Downloads the `edge` release binary through the GitHub API, using the job
 * token when one is set. Returns the path, or `undefined` when no `edge`
 * release exists and this is not CI.
 *
 * Fails when CI has no `edge` release, when this platform has no edge asset,
 * and when the release exists but the expected asset is missing.
 */
async function downloadEdgeBinary(targetDir: string): Promise<string | undefined> {
  const assetName = resolveEdgeAssetName();
  if (assetName === undefined) {
    throw new Error(
      `Upgrade test has no edge asset for ${process.platform}-${process.arch}. ` +
        "Run it on linux-x64, linux-arm64, or darwin-arm64.",
    );
  }

  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  const repo =
    process.env["GH_REPO"] ?? process.env["GITHUB_REPOSITORY"] ?? "theagenticage/hercule";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token !== undefined && token !== "") headers.Authorization = `Bearer ${token}`;

  const view = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${EDGE_TAG}`, {
    headers,
  });
  if (view.status === 404) {
    if (process.env["CI"]) {
      throw new Error(
        "No edge release found. CI requires an edge release baseline to validate migrations.",
      );
    }
    return undefined;
  }
  if (!view.ok) {
    throw new Error(
      `Failed to look up the edge release: ${String(view.status)} ${await view.text()}`,
    );
  }

  const release = (await view.json()) as {
    assets: ReadonlyArray<{ name: string; url: string }>;
  };
  const asset = release.assets.find((one) => one.name === assetName);
  if (asset === undefined) {
    throw new Error(
      `Edge release exists but ${assetName} is missing. This indicates a CI misconfiguration.`,
    );
  }

  const downloadHeaders: Record<string, string> = { Accept: "application/octet-stream" };
  if (token !== undefined && token !== "") downloadHeaders.Authorization = `Bearer ${token}`;
  const download = await fetch(asset.url, { headers: downloadHeaders });
  if (!download.ok) {
    throw new Error(
      `Failed to download ${assetName}: ${String(download.status)} ${download.statusText}`,
    );
  }

  const binaryPath = join(targetDir, assetName);
  writeFileSync(binaryPath, Buffer.from(await download.arrayBuffer()), { mode: 0o755 });
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

/** Runs one CLI command and fails with that command's own output. */
function expectJson<A>(ran: Ran): A {
  return parseJsonOutputOrFail<A>(ran);
}

/**
 * Reads a list the CLI printed as JSON: either a page with `items` or a bare
 * array, depending on the operation.
 */
function readListedItems<A>(ran: Ran): A[] {
  const parsed = expectJson<A[] | Page<A>>(ran);
  return Array.isArray(parsed) ? parsed : [...parsed.items];
}

function summarizeMessage(message: SeededMessage): {
  readonly position: number;
  readonly senderRole: string;
  readonly text: string;
} {
  return { position: message.position, senderRole: message.senderRole, text: message.text };
}

function summarizeProvider(provider: SeededProvider): SeededProvider {
  return { id: provider.id, providerId: provider.providerId, name: provider.name };
}

function summarizeRow(row: Row): SeededTranscriptRow {
  return { position: row.position, tag: row.event._tag };
}

function sortByPosition<A extends { readonly position: number }>(
  rows: ReadonlyArray<A>,
): ReadonlyArray<A> {
  return [...rows].sort((left, right) => left.position - right.position);
}

/**
 * Waits until the conversation holds every owner turn, then returns the
 * messages (owner turns and any notices the old binary wrote beside them).
 */
async function waitForConversationTurns(
  options: { readonly home: string; readonly binary: string },
  conversationId: string,
): Promise<ReadonlyArray<SeededMessage>> {
  const deadline = Date.now() + 15_000;
  let lastMessages: ReadonlyArray<SeededMessage> = [];
  while (Date.now() < deadline) {
    lastMessages = readListedItems<SeededMessage>(
      await runCli(["conversation", "message", "list", conversationId, "--json"], options),
    );
    const ownerTexts = lastMessages
      .filter((message) => message.senderRole === "owner")
      .map((message) => message.text);
    if (TURNS.every((turn) => ownerTexts.includes(turn))) {
      await sleep(400);
      lastMessages = readListedItems<SeededMessage>(
        await runCli(["conversation", "message", "list", conversationId, "--json"], options),
      );
      return sortByPosition(lastMessages);
    }
    await sleep(200);
  }
  throw new Error(
    `conversation ${conversationId} never held the ${String(TURNS.length)} owner turns ` +
      `(${String(lastMessages.length)} messages: ${lastMessages.map((m) => `${m.senderRole}:${m.text}`).join(" | ")})`,
  );
}

/**
 * Returns the conversation's first session and its transcript when a session
 * exists and has at least one row. Returns `undefined` when placement wrote
 * no session.
 */
async function readPlacedSession(
  options: { readonly home: string; readonly binary: string },
  conversationId: string,
): Promise<
  | {
      readonly session: SeededSession;
      readonly transcript: ReadonlyArray<SeededTranscriptRow>;
    }
  | undefined
> {
  const sessions = readListedItems<SeededSession>(
    await runCli(["session", "list", "--conversation", conversationId, "--json"], options),
  );
  const session = sessions[0];
  if (session === undefined) return undefined;
  const deadline = Date.now() + 10_000;
  let lastTranscript: ReadonlyArray<Row> = [];
  while (Date.now() < deadline) {
    lastTranscript = await readTranscript({ ...options, id: session.id }).catch(() => []);
    if (lastTranscript.length > 0) {
      return { session, transcript: lastTranscript.map(summarizeRow) };
    }
    await sleep(200);
  }
  throw new Error(
    `session ${session.id} was placed but never wrote transcript rows ` +
      `(${String(lastTranscript.length)} rows). The baseline must be populated when a session exists.`,
  );
}

/**
 * Spawns a Thread through the old CLI. Returns the session when the spawn
 * succeeds, or `undefined` when placement refuses (no logged-in provider).
 */
async function trySpawnThread(options: {
  readonly home: string;
  readonly binary: string;
}): Promise<SeededSession | undefined> {
  const spawned = await runCli(["session", "spawn", "--json"], {
    ...options,
    stdin: TURNS[0],
  });
  if (spawned.code !== 0) {
    console.log(
      `session spawn refused (no logged-in provider):\n${spawned.stdout}\n${spawned.stderr}`,
    );
    return undefined;
  }
  return expectJson<SeededSession>(spawned);
}

/** Restarts the controller on the same port after a short wait for the bind to free. */
async function startOnPort(options: {
  readonly home: string;
  readonly binary: string;
  readonly port: number;
}): Promise<Controller> {
  let last: Error | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await startController(options);
    } catch (error) {
      last = error as Error;
      if (!/in use/.test(last.message)) throw last;
      await sleep(100);
    }
  }
  throw last ?? new Error("hercule serve did not start on the previous port");
}

beforeAll(async () => {
  const assetName = resolveEdgeAssetName();
  if (assetName === undefined) {
    if (process.env["CI"]) {
      throw new Error(
        `Upgrade test has no edge asset for ${process.platform}-${process.arch}. ` +
          "Run it on linux-x64, linux-arm64, or darwin-arm64.",
      );
    }
    console.log(`Skipping upgrade test: no edge asset for ${process.platform}-${process.arch}`);
    return;
  }

  newBinary = join(ROOT, "hercule");
  if (!existsSync(newBinary)) {
    throw new Error(
      `no binary at ${newBinary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }

  state = createTemporaryHome();
  const downloadDir = join(state.home, "edge-download");
  mkdirSync(downloadDir, { recursive: true });
  edgeBinary = await downloadEdgeBinary(downloadDir);
  if (edgeBinary !== undefined) {
    const bytes = statSync(edgeBinary).size;
    console.log(`Downloaded ${assetName} (${String(bytes)} bytes) from the ${EDGE_TAG} release.`);
  }
}, 60_000);

afterAll(() => {
  state?.remove();
});

describe("upgrading from the previous edge release", () => {
  it("fills a database with the edge binary, upgrades to the new binary, and reads every record back", async () => {
    if (edgeBinary === undefined) {
      if (process.env["CI"]) {
        throw new Error(
          "No edge release found. CI requires an edge release baseline to validate migrations.",
        );
      }
      console.log("Skipping upgrade test: no edge release exists yet");
      return;
    }

    const home = state!.home;
    const edge = { home, binary: edgeBinary };
    let controller: Controller | undefined;
    try {
      controller = await startController({ home, binary: edgeBinary });

      const setup = await completeSetup({ home, url: controller.url, binary: edgeBinary });
      expect(setup.code, `${setup.stdout}\n${setup.stderr}`).toBe(0);

      const login = await runCli(
        ["login", controller.url, "--username", USERNAME, "--password-stdin", "--name", "upgrade"],
        { ...edge, stdin: PASSWORD },
      );
      expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
      readApiKey(home);

      await waitForEnrolledRunner(edge);

      const createdProvider = expectJson<SeededProvider>(
        await runCli(
          ["provider", "create", "--provider", "claude-code", "--name", PROVIDER_NAME, "--json"],
          { ...edge, stdin: "{}" },
        ),
      );
      expect(createdProvider).toMatchObject({
        providerId: "claude-code",
        name: PROVIDER_NAME,
      });

      const seededProviders = readListedItems<SeededProvider>(
        await runCli(["provider", "list", "--json"], edge),
      )
        .map(summarizeProvider)
        .sort((left, right) => left.id.localeCompare(right.id));
      expect(seededProviders.some((row) => row.id === createdProvider.id)).toBe(true);

      const project = expectJson<{ id: string }>(
        await runCli(["project", "create", "--name", "test-project", "--json"], edge),
      );
      const resource = expectJson<{ id: string }>(
        await runCli(
          [
            "resource",
            "create",
            "--project",
            project.id,
            "--kind",
            "repo",
            "--remote",
            "https://github.com/example/repo",
            "--json",
          ],
          edge,
        ),
      );
      const assistant = expectJson<{ id: string; mainConversationId: string }>(
        await runCli(["assistant", "create", "--name", "upgrade-assistant", "--json"], edge),
      );

      for (const text of TURNS) {
        const sent = await runCli(
          ["conversation", "send", assistant.mainConversationId, "--json"],
          { ...edge, stdin: text },
        );
        expect(sent.code, `${sent.stdout}\n${sent.stderr}`).toBe(0);
      }

      const seededMessages = await waitForConversationTurns(edge, assistant.mainConversationId);
      expect(
        seededMessages.filter((message) => message.senderRole === "owner").map((m) => m.text),
      ).toEqual([...TURNS]);
      expect(seededMessages.length).toBeGreaterThanOrEqual(TURNS.length);

      const placed = await readPlacedSession(edge, assistant.mainConversationId);
      const spawnedThread = placed === undefined ? await trySpawnThread(edge) : undefined;
      let threadTranscript: ReadonlyArray<SeededTranscriptRow> | undefined;
      if (spawnedThread !== undefined) {
        for (const text of TURNS.slice(1)) {
          const input = await runCli(["session", "input", spawnedThread.id, "--json"], {
            ...edge,
            stdin: text,
          });
          expect(input.code, `${input.stdout}\n${input.stderr}`).toBe(0);
        }
        const deadline = Date.now() + 10_000;
        let rows: ReadonlyArray<Row> = [];
        while (Date.now() < deadline) {
          rows = await readTranscript({ ...edge, id: spawnedThread.id }).catch(() => []);
          if (rows.length > 0) break;
          await sleep(200);
        }
        if (rows.length === 0) {
          throw new Error(`thread ${spawnedThread.id} was spawned but never wrote transcript rows`);
        }
        threadTranscript = rows.map(summarizeRow);
      }

      console.log(
        `Seeded conversation ${assistant.mainConversationId}: ${String(seededMessages.length)} messages ` +
          `(${seededMessages.map((m) => m.senderRole).join(", ")}), ` +
          `provider ${createdProvider.id} (${createdProvider.name}), ` +
          (placed !== undefined
            ? `session ${placed.session.id} with ${String(placed.transcript.length)} transcript rows`
            : spawnedThread !== undefined
              ? `thread ${spawnedThread.id} with ${String(threadTranscript?.length ?? 0)} transcript rows`
              : "no session (placement refused)"),
      );

      const port = controller.port;
      expect(await controller.stop()).toBe(0);
      controller = undefined;

      controller = await startOnPort({ home, binary: newBinary, port });
      const upgraded = { home, binary: newBinary };

      expectJson(await runCli(["controller", "read", "--json"], upgraded));
      expectJson(await runCli(["project", "read", project.id, "--json"], upgraded));
      expectJson(await runCli(["resource", "read", resource.id, "--json"], upgraded));

      const readProvider = expectJson<SeededProvider>(
        await runCli(["provider", "read", createdProvider.id, "--json"], upgraded),
      );
      expect(readProvider).toMatchObject({
        id: createdProvider.id,
        providerId: "claude-code",
        name: PROVIDER_NAME,
      });
      const upgradedProviders = readListedItems<SeededProvider>(
        await runCli(["provider", "list", "--json"], upgraded),
      )
        .map(summarizeProvider)
        .sort((left, right) => left.id.localeCompare(right.id));
      expect(upgradedProviders).toEqual(seededProviders);

      const readAssistant = expectJson<{ id: string; mainConversationId: string }>(
        await runCli(["assistant", "read", assistant.id, "--json"], upgraded),
      );
      expect(readAssistant.mainConversationId).toBe(assistant.mainConversationId);

      const readConversation = expectJson<{ id: string; assistantId: string }>(
        await runCli(["conversation", "read", assistant.mainConversationId, "--json"], upgraded),
      );
      expect(readConversation).toMatchObject({
        id: assistant.mainConversationId,
        assistantId: assistant.id,
      });

      const upgradedMessages = readListedItems<SeededMessage>(
        await runCli(
          ["conversation", "message", "list", assistant.mainConversationId, "--json"],
          upgraded,
        ),
      );
      expect(sortByPosition(upgradedMessages).map(summarizeMessage)).toEqual(
        seededMessages.map(summarizeMessage),
      );

      if (placed !== undefined) {
        const readSession = expectJson<SeededSession>(
          await runCli(["session", "read", placed.session.id, "--json"], upgraded),
        );
        expect(readSession).toMatchObject({
          id: placed.session.id,
          conversationId: assistant.mainConversationId,
        });
        const upgradedTranscript = (
          await readTranscript({ ...upgraded, id: placed.session.id })
        ).map(summarizeRow);
        expect(upgradedTranscript).toEqual(placed.transcript);
      }

      if (spawnedThread !== undefined && threadTranscript !== undefined) {
        const readThread = expectJson<SeededSession>(
          await runCli(["session", "read", spawnedThread.id, "--json"], upgraded),
        );
        expect(readThread.id).toBe(spawnedThread.id);
        const upgradedThreadTranscript = (
          await readTranscript({ ...upgraded, id: spawnedThread.id })
        ).map(summarizeRow);
        expect(upgradedThreadTranscript).toEqual(threadTranscript);
      }
    } finally {
      await controller?.stop().catch(() => -1);
    }
  }, 180_000);
});
