/**
 * Tests that a database filled by the previous `edge` release upgrades cleanly
 * to the new binary: the migrations run, the controller boots, and every record
 * is still readable.
 *
 * This catches migrations that are correct on an empty database but fail on
 * real data. The fixture is one representative conversation: a few owner
 * turns, the session they placed, and that session's transcript. After the
 * upgrade the test checks that the session, message content, ordering and
 * associations survived. It is not a matrix of session states or provider
 * behaviour.
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
const BINARY_NAME = "hercule-darwin-arm64";

/** A few turns of one conversation, seeded through the old release's CLI. */
const TURNS = [
  "What is the status of the test-project repository?",
  "Which risks should we watch this week?",
  "What should we do next?",
] as const;

interface SeededMessage {
  readonly id: string;
  readonly position: number;
  readonly senderRole: string;
  readonly text: string;
  readonly sessionId: string | null;
}

interface SeededSession {
  readonly id: string;
  readonly conversationId: string;
}

interface SeededTranscriptRow {
  readonly position: number;
  readonly tag: string;
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

function summarizeMessage(message: SeededMessage): {
  readonly position: number;
  readonly senderRole: string;
  readonly text: string;
} {
  return { position: message.position, senderRole: message.senderRole, text: message.text };
}

function summarizeRow(row: Row): SeededTranscriptRow {
  return { position: row.position, tag: row.event._tag };
}

/**
 * Waits until the conversation holds every owner turn, one session exists,
 * and that session's transcript has at least one row.
 */
async function waitForSeededConversation(
  options: { readonly home: string; readonly binary: string },
  conversationId: string,
): Promise<{
  readonly messages: ReadonlyArray<SeededMessage>;
  readonly session: SeededSession;
  readonly transcript: ReadonlyArray<SeededTranscriptRow>;
}> {
  const deadline = Date.now() + 20_000;
  let lastMessages: ReadonlyArray<SeededMessage> = [];
  let lastSessions: ReadonlyArray<SeededSession> = [];
  let lastTranscript: ReadonlyArray<Row> = [];
  while (Date.now() < deadline) {
    lastMessages = expectJson<Page<SeededMessage>>(
      await runCli(["conversation", "message", "list", conversationId, "--json"], options),
    ).items;
    lastSessions = expectJson<Page<SeededSession>>(
      await runCli(["session", "list", "--conversation", conversationId, "--json"], options),
    ).items;
    const ownerTexts = lastMessages
      .filter((message) => message.senderRole === "owner")
      .map((message) => message.text);
    const session = lastSessions[0];
    if (session !== undefined && TURNS.every((turn) => ownerTexts.includes(turn))) {
      lastTranscript = await readTranscript({ ...options, id: session.id }).catch(() => []);
      if (lastTranscript.length > 0) {
        return {
          messages: [...lastMessages].sort((left, right) => left.position - right.position),
          session,
          transcript: lastTranscript.map(summarizeRow),
        };
      }
    }
    await sleep(200);
  }
  throw new Error(
    `conversation ${conversationId} never held a session with transcript rows ` +
      `(${String(lastSessions.length)} sessions, ${String(lastTranscript.length)} transcript rows, ` +
      `${String(lastMessages.length)} messages). A live provider would write more events; ` +
      `this fixture needs at least one persisted transcript row from the old binary.`,
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

      const seeded = await waitForSeededConversation(edge, assistant.mainConversationId);
      expect(
        seeded.messages.filter((message) => message.senderRole === "owner").map((m) => m.text),
      ).toEqual([...TURNS]);
      expect(seeded.session.conversationId).toBe(assistant.mainConversationId);
      expect(seeded.transcript.length).toBeGreaterThan(0);
      console.log(
        `Seeded conversation ${assistant.mainConversationId}: ${String(seeded.messages.length)} messages, ` +
          `session ${seeded.session.id}, ${String(seeded.transcript.length)} transcript rows.`,
      );

      const port = controller.port;
      expect(await controller.stop()).toBe(0);
      controller = undefined;

      controller = await startOnPort({ home, binary: newBinary, port });
      const upgraded = { home, binary: newBinary };

      expectJson(await runCli(["controller", "read", "--json"], upgraded));
      expectJson(await runCli(["project", "read", project.id, "--json"], upgraded));
      expectJson(await runCli(["resource", "read", resource.id, "--json"], upgraded));

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

      const upgradedMessages = expectJson<Page<SeededMessage>>(
        await runCli(
          ["conversation", "message", "list", assistant.mainConversationId, "--json"],
          upgraded,
        ),
      ).items;
      expect(
        [...upgradedMessages]
          .sort((left, right) => left.position - right.position)
          .map(summarizeMessage),
      ).toEqual(seeded.messages.map(summarizeMessage));

      const readSession = expectJson<SeededSession>(
        await runCli(["session", "read", seeded.session.id, "--json"], upgraded),
      );
      expect(readSession).toMatchObject({
        id: seeded.session.id,
        conversationId: assistant.mainConversationId,
      });

      const upgradedTranscript = (await readTranscript({ ...upgraded, id: seeded.session.id })).map(
        summarizeRow,
      );
      expect(upgradedTranscript).toEqual(seeded.transcript);
    } finally {
      await controller?.stop().catch(() => -1);
    }
  }, 180_000);
});
