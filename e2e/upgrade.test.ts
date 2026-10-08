/**
 * Tests that a database filled by the previous `edge` release upgrades cleanly
 * to the new binary: the migrations run, the controller boots, and every record
 * is still readable.
 *
 * This catches migrations that are correct on an empty database but fail on
 * real data (a unique index on a column that has duplicates, a transformation
 * that assumes a shape older rows do not have), and checks that no landed
 * migration has been edited since `edge` was built.
 *
 * Seeding uses the previous release's own CLI against that release's
 * controller, the way an operator would. The fixture is a real conversation:
 * several owner turns, plus every notice or reply the old controller wrote
 * for them. After the upgrade the test asserts that conversation in full;
 * it does not drop notices or keep only owner lines.
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
  waitForEnrolledRunner,
  type Page,
  type TemporaryHome,
} from "./harness";

const EDGE_TAG = "edge";
const BINARY_NAME = "hercule-darwin-arm64";

/** Three turns of one conversation, seeded through the old release's CLI. */
const TURNS = [
  "What is the status of the test-project repository?",
  "Which risks should we watch this week?",
  "What should we do next?",
] as const;

/** The fields of a conversation message that a migration must keep intact. */
interface SeededMessage {
  readonly id: string;
  readonly position: number;
  readonly senderRole: string;
  readonly senderLabel: string;
  readonly text: string;
  readonly sessionId: string | null;
  readonly turnId: string | null;
}

interface SeededSession {
  readonly id: string;
  readonly conversationId: string;
}

let state: TemporaryHome | undefined;
let edgeBinary: string | undefined;
let newBinary: string;

/**
 * Downloads the `edge` release binary through the GitHub API, using the job
 * token when one is set. Returns the path, or `undefined` when no `edge`
 * release exists and this is not CI.
 *
 * Fails when CI has no `edge` release, and when the release exists but the
 * expected asset is missing.
 */
async function downloadEdgeBinary(targetDir: string): Promise<string | undefined> {
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
  const asset = release.assets.find((one) => one.name === BINARY_NAME);
  if (asset === undefined) {
    throw new Error(
      `Edge release exists but ${BINARY_NAME} is missing. This indicates a CI misconfiguration.`,
    );
  }

  const downloadHeaders: Record<string, string> = { Accept: "application/octet-stream" };
  if (token !== undefined && token !== "") downloadHeaders.Authorization = `Bearer ${token}`;
  const download = await fetch(asset.url, { headers: downloadHeaders });
  if (!download.ok) {
    throw new Error(
      `Failed to download ${BINARY_NAME}: ${String(download.status)} ${download.statusText}`,
    );
  }

  const binaryPath = join(targetDir, BINARY_NAME);
  writeFileSync(binaryPath, Buffer.from(await download.arrayBuffer()), { mode: 0o755 });
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

/** Runs one CLI command and fails with that command's own output. */
function expectJson<A>(ran: Ran): A {
  return parseJsonOutputOrFail<A>(ran);
}

/** Lists every message in a conversation, oldest first. */
async function listMessages(
  options: { readonly home: string; readonly binary: string },
  conversationId: string,
): Promise<ReadonlyArray<SeededMessage>> {
  const page = expectJson<Page<SeededMessage>>(
    await runCli(["conversation", "message", "list", conversationId, "--json"], options),
  );
  return [...page.items].sort((left, right) => left.position - right.position);
}

/**
 * Waits until the conversation holds every owner turn, then until the list
 * stops growing, so notices the controller writes after a send are kept.
 */
async function waitForSeededConversation(
  options: { readonly home: string; readonly binary: string },
  conversationId: string,
): Promise<ReadonlyArray<SeededMessage>> {
  const deadline = Date.now() + 30_000;
  let latest: ReadonlyArray<SeededMessage> = [];
  while (Date.now() < deadline) {
    latest = await listMessages(options, conversationId);
    const ownerTexts = latest
      .filter((message) => message.senderRole === "owner")
      .map((m) => m.text);
    if (TURNS.every((turn) => ownerTexts.includes(turn))) {
      await sleep(1_000);
      const again = await listMessages(options, conversationId);
      if (again.length === latest.length) return again;
      latest = again;
    }
    await sleep(250);
  }
  throw new Error(
    `conversation ${conversationId} never held all ${String(TURNS.length)} owner turns:\n${JSON.stringify(latest, null, 2)}`,
  );
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
    console.log(`Downloaded ${BINARY_NAME} (${String(bytes)} bytes) from the ${EDGE_TAG} release.`);
  }
}, 60_000);

afterAll(() => {
  state?.remove();
});

describe("upgrading from the previous edge release", () => {
  it("fills a database with the edge binary, upgrades to the new binary, and reads every record back", async () => {
    if (edgeBinary === undefined) {
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

      const project = expectJson<{ id: string; name: string }>(
        await runCli(["project", "create", "--name", "test-project", "--json"], edge),
      );

      const resource = expectJson<{ id: string; remote: string | null }>(
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

      const assistant = expectJson<{ id: string; name: string; mainConversationId: string }>(
        await runCli(["assistant", "create", "--name", "upgrade-assistant", "--json"], edge),
      );

      for (const text of TURNS) {
        const sent = await runCli(
          ["conversation", "send", assistant.mainConversationId, "--json"],
          {
            ...edge,
            stdin: text,
          },
        );
        expect(sent.code, `${sent.stdout}\n${sent.stderr}`).toBe(0);
      }

      const seededMessages = await waitForSeededConversation(edge, assistant.mainConversationId);
      const ownerMessages = seededMessages.filter((message) => message.senderRole === "owner");
      expect(ownerMessages.map((message) => message.text)).toEqual([...TURNS]);
      expect(
        seededMessages.length,
        "the conversation must keep every message the old controller wrote, not only owner turns",
      ).toBeGreaterThanOrEqual(TURNS.length);
      console.log(
        `Seeded conversation ${assistant.mainConversationId} with ${String(seededMessages.length)} messages: ${seededMessages
          .map((message) => `${message.senderRole}:${message.position}`)
          .join(", ")}`,
      );

      const seededSessions = expectJson<Page<SeededSession>>(
        await runCli(
          ["session", "list", "--conversation", assistant.mainConversationId, "--json"],
          edge,
        ),
      ).items;

      const settings = expectJson<{ user: { timezone?: string } }>(
        await runCli(
          ["settings", "update", "--user", '{"timezone":"America/New_York"}', "--json"],
          edge,
        ),
      );
      expect(settings.user.timezone).toBe("America/New_York");

      const port = controller.port;
      const stopCode = await controller.stop();
      expect(stopCode).toBe(0);
      controller = undefined;

      controller = await startOnPort({ home, binary: newBinary, port });
      const upgraded = { home, binary: newBinary };

      expectJson(await runCli(["controller", "read", "--json"], upgraded));

      const readProject = expectJson<{ id: string; name: string }>(
        await runCli(["project", "read", project.id, "--json"], upgraded),
      );
      expect(readProject).toMatchObject({ id: project.id, name: "test-project" });

      const readResource = expectJson<{ id: string; remote: string | null }>(
        await runCli(["resource", "read", resource.id, "--json"], upgraded),
      );
      expect(readResource).toMatchObject({
        id: resource.id,
        remote: "https://github.com/example/repo",
      });

      const readAssistant = expectJson<{ id: string; name: string; mainConversationId: string }>(
        await runCli(["assistant", "read", assistant.id, "--json"], upgraded),
      );
      expect(readAssistant).toMatchObject({
        id: assistant.id,
        name: "upgrade-assistant",
        mainConversationId: assistant.mainConversationId,
      });

      const readConversation = expectJson<{ id: string; assistantId: string }>(
        await runCli(["conversation", "read", assistant.mainConversationId, "--json"], upgraded),
      );
      expect(readConversation).toMatchObject({
        id: assistant.mainConversationId,
        assistantId: assistant.id,
      });

      const upgradedMessages = await listMessages(upgraded, assistant.mainConversationId);
      expect(upgradedMessages.map(summarizeMessage)).toEqual(seededMessages.map(summarizeMessage));

      const upgradedSessions = expectJson<Page<SeededSession>>(
        await runCli(
          ["session", "list", "--conversation", assistant.mainConversationId, "--json"],
          upgraded,
        ),
      ).items;
      expect(upgradedSessions.map((session) => session.id).sort()).toEqual(
        seededSessions.map((session) => session.id).sort(),
      );

      const upgradedSettings = expectJson<{ user: { timezone?: string } }>(
        await runCli(["settings", "read", "--json"], upgraded),
      );
      expect(upgradedSettings.user.timezone).toBe("America/New_York");
    } finally {
      await controller?.stop().catch(() => -1);
    }
  }, 180_000);
});

/** Returns the fields a migration must preserve on a conversation message. */
function summarizeMessage(message: SeededMessage): SeededMessage {
  return {
    id: message.id,
    position: message.position,
    senderRole: message.senderRole,
    senderLabel: message.senderLabel,
    text: message.text,
    sessionId: message.sessionId,
    turnId: message.turnId,
  };
}
