/**
 * Tests that a database filled by the previous `edge` release upgrades cleanly
 * to the new binary: the migrations run, the controller boots, and every record
 * is still readable.
 *
 * This catches migrations that are correct on an empty database but fail on
 * real data. The fixture is one representative conversation of several owner
 * turns, one named Provider Instance, one session with a few persisted
 * turns, the timezone first-run setup persisted, a project name and a
 * repository remote, two user settings that migration 60 deletes, and the
 * shipped permission profiles that migration 62 gives the signal grants.
 * After the upgrade the test checks that those records, their content,
 * ordering and associations survived. It is not a matrix of session states or
 * provider behaviour.
 *
 * A live session needs a logged-in harness, which CI does not have and which
 * sits outside the two-minute added-CI budget. The session and its transcript
 * are therefore written into the database the edge binary created, using ids
 * that binary persisted, then read back through that binary's CLI before the
 * upgrade. That is the same store a spawn would have written; the CLI is the
 * proof the rows are real.
 *
 * In CI the previous `edge` release must exist: a missing baseline fails the
 * job rather than skipping it. Locally, with no `edge` release, the test is
 * skipped and says so. An unsupported platform fails in CI and skips locally.
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const PROJECT_NAME = "test-project";
const REPO_REMOTE = "https://github.com/example/repo";

/**
 * Two user settings that migration 60 deletes, because no binary from that
 * migration on declares them. Each value is stored as JSON, as the settings
 * store writes it.
 */
const RETIRED_SETTINGS = {
  "topics.order": ["intake", "checkin"],
  "lastChecked.intake": "2026-10-01T08:00:00.000Z",
} as const;

/** The migration that deletes `RETIRED_SETTINGS`. */
const RETIRED_SETTINGS_MIGRATION = 60;

/** The migration that adds `SIGNAL_GRANTS` to the `SIGNAL_PROFILES`. */
const SIGNAL_GRANTS_MIGRATION = 62;

/** The shipped profiles that hold `SIGNAL_GRANTS` from migration 62 on. */
const SIGNAL_PROFILES = ["assistant", "worker", "unrestricted"] as const;

const SIGNAL_GRANTS = ["signal.read", "signal.write"] as const;

interface SeededProfile {
  readonly id: string;
  readonly name: string;
  readonly grants: ReadonlyArray<string>;
}

interface SeededMessage {
  readonly id: string;
  readonly position: number;
  readonly senderRole: string;
  readonly text: string;
}

interface SeededSession {
  readonly id: string;
  readonly conversationId: string | null;
  readonly agentId: string | null;
  readonly instanceId: string;
}

interface SeededTranscriptRow {
  readonly position: number;
  readonly tag: string;
  readonly text: string | undefined;
}

interface SeededProvider {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
}

let state: TemporaryHome | undefined;
let edgeBinary: string | undefined;
let newBinary: string;
/** Why this run is not exercising the upgrade; unset when it should run. */
let skipReason: string | undefined;

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

function summarizeSession(session: SeededSession): SeededSession {
  return {
    id: session.id,
    conversationId: session.conversationId,
    agentId: session.agentId,
    instanceId: session.instanceId,
  };
}

function summarizeRow(row: Row): SeededTranscriptRow {
  const event = row.event;
  return {
    position: row.position,
    tag: event._tag,
    text: event._tag === "content.delta" ? String(event["delta"]) : undefined,
  };
}

function sortByPosition<A extends { readonly position: number }>(
  rows: ReadonlyArray<A>,
): ReadonlyArray<A> {
  return [...rows].sort((left, right) => left.position - right.position);
}

/** Converts a canonical UUID to the 16 bytes the controller stores. */
function uuidBlob(id: string): Buffer {
  return Buffer.from(id.replaceAll("-", ""), "hex");
}

/**
 * Writes one exited session and a few transcript turns into the database the
 * edge binary created. `ids` are records that binary already persisted.
 * Returns the new session's id.
 */
function persistRepresentativeSession(options: {
  readonly home: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly instanceId: string;
  readonly runnerId: string;
  readonly permissionProfileId: string;
}): string {
  const sessionId = Bun.randomUUIDv7();
  const at = new Date().toISOString();
  const spec = JSON.stringify({
    instanceId: options.instanceId,
    workspaceId: null,
    modelSelection: { model: "sonnet", options: {} },
    accessMode: "auto",
    timeouts: { inactivityMs: 60_000, absoluteMs: 3_600_000 },
  });
  const events: Array<Record<string, unknown>> = [
    { _tag: "session.started", eventId: "e-start", sessionId, at },
  ];
  for (const [index, text] of TURNS.entries()) {
    const turnId = `turn-${String(index + 1)}`;
    const itemId = `item-${String(index + 1)}`;
    events.push(
      { _tag: "turn.started", eventId: `${turnId}-start`, sessionId, at, turnId },
      {
        _tag: "content.delta",
        eventId: `${turnId}-delta`,
        sessionId,
        at,
        turnId,
        itemId,
        streamKind: "assistant_text",
        delta: text,
      },
      {
        _tag: "turn.completed",
        eventId: `${turnId}-done`,
        sessionId,
        at,
        turnId,
        state: "completed",
      },
    );
  }
  events.push({ _tag: "session.exited", eventId: "e-exit", sessionId, at, reason: "stopped" });

  const database = new Database(join(options.home, "data", "hercule.db"));
  try {
    database
      .query(
        `INSERT INTO sessions (
           id, title, permission_profile_id, agent_id, conversation_id,
           instance_id, runner_id, requested_access_mode, access_mode,
           spec, model_selection, status, created_at, started_at, exited_at,
           last_activity_at, native_session_id, exit_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', 'auto', ?, ?, 'exited', ?, ?, ?, ?, ?, 'stopped')`,
      )
      .run(
        uuidBlob(sessionId),
        TURNS[0],
        uuidBlob(options.permissionProfileId),
        uuidBlob(options.agentId),
        uuidBlob(options.conversationId),
        uuidBlob(options.instanceId),
        uuidBlob(options.runnerId),
        spec,
        JSON.stringify({ model: "sonnet", options: {} }),
        at,
        at,
        at,
        at,
        "upgrade-fixture-native",
      );
    const insertEvent = database.query(
      `INSERT INTO session_stream (session_id, position, runner_seq, at, event)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [index, event] of events.entries()) {
      const position = index + 1;
      insertEvent.run(uuidBlob(sessionId), position, position, at, JSON.stringify(event));
    }
  } finally {
    database.close();
  }
  return sessionId;
}

/** Returns the id of the last migration the database in `home` ran. */
function readMigrationVersion(home: string): number {
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    const { version } = database
      .query("SELECT max(migration_id) AS version FROM effect_sql_migrations")
      .get() as { version: number };
    return version;
  } finally {
    database.close();
  }
}

/**
 * Stores `RETIRED_SETTINGS` for the one user in the database the edge binary
 * created, when that database predates the migration that deletes them.
 * Returns whether it stored them.
 *
 * The rows are written straight into the database because an edge binary
 * that already ran the migration no longer accepts the keys through the API.
 * Its database would keep the rows through the upgrade, since the migration
 * does not run twice, so the fixture is skipped there instead.
 */
function persistRetiredSettings(home: string): boolean {
  if (readMigrationVersion(home) >= RETIRED_SETTINGS_MIGRATION) return false;
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    const insert = database.query(
      `INSERT INTO user_settings (user_id, key, value, updated_at)
       SELECT id, ?, ?, ? FROM users`,
    );
    const at = new Date().toISOString();
    for (const [key, value] of Object.entries(RETIRED_SETTINGS)) {
      insert.run(key, JSON.stringify(value), at);
    }
    return true;
  } finally {
    database.close();
  }
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
    skipReason = `no edge asset for ${process.platform}-${process.arch}`;
    if (process.env["CI"]) {
      throw new Error(
        `Upgrade test has no edge asset for ${process.platform}-${process.arch}. ` +
          "Run it on linux-x64, linux-arm64, or darwin-arm64.",
      );
    }
    console.log(`Skipping upgrade test: ${skipReason}`);
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
  if (edgeBinary === undefined) {
    skipReason = "no edge release exists yet";
    console.log(`Skipping upgrade test: ${skipReason}`);
    return;
  }
  const bytes = statSync(edgeBinary).size;
  console.log(`Downloaded ${assetName} (${String(bytes)} bytes) from the ${EDGE_TAG} release.`);
}, 60_000);

afterAll(() => {
  state?.remove();
});

describe("upgrading from the previous edge release", () => {
  it("fills a database with the edge binary, upgrades to the new binary, and reads every record back", async () => {
    if (skipReason !== undefined || edgeBinary === undefined) {
      if (process.env["CI"]) {
        throw new Error(
          skipReason ??
            "No edge release found. CI requires an edge release baseline to validate migrations.",
        );
      }
      console.log(`Skipping upgrade test: ${skipReason ?? "no edge release exists yet"}`);
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

      const runnerId = await waitForEnrolledRunner(edge);

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

      const profiles = readListedItems<SeededProfile>(
        await runCli(["profile", "list", "--json"], edge),
      );
      // A database from before migration 62 has shipped profiles without the
      // signal grants, so the upgrade must add them. A newer one was seeded
      // with them, and the checks after the upgrade only show they survived.
      const signalGrantsMigrated = readMigrationVersion(home) < SIGNAL_GRANTS_MIGRATION;
      if (signalGrantsMigrated) {
        for (const name of SIGNAL_PROFILES) {
          const profile = profiles.find((one) => one.name === name);
          expect(profile, `the edge database has no ${name} profile`).toBeDefined();
          for (const grant of SIGNAL_GRANTS) expect(profile?.grants).not.toContain(grant);
        }
      } else {
        console.log(
          `The edge database already ran migration ${String(SIGNAL_GRANTS_MIGRATION)}: checking that the signal grants survive the upgrade.`,
        );
      }
      const unrestricted = profiles.find((profile) => profile.name === "unrestricted");
      if (unrestricted === undefined) {
        throw new Error(
          `no unrestricted permission profile (${profiles.map((profile) => profile.name).join(", ") || "none"})`,
        );
      }

      const seededSettings = expectJson<{ user: Record<string, unknown> }>(
        await runCli(["settings", "read", "--json"], edge),
      );
      expect(seededSettings.user["timezone"]).toBe("Europe/Amsterdam");

      const project = expectJson<{ id: string; name: string }>(
        await runCli(["project", "create", "--name", PROJECT_NAME, "--json"], edge),
      );
      expect(project.name).toBe(PROJECT_NAME);
      const resource = expectJson<{ id: string; remote: string }>(
        await runCli(
          [
            "resource",
            "create",
            "--project",
            project.id,
            "--kind",
            "repo",
            "--remote",
            REPO_REMOTE,
            "--json",
          ],
          edge,
        ),
      );
      expect(resource.remote).toBe(REPO_REMOTE);
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

      const port = controller.port;
      expect(await controller.stop()).toBe(0);
      controller = undefined;

      const sessionId = persistRepresentativeSession({
        home,
        conversationId: assistant.mainConversationId,
        agentId: assistant.id,
        instanceId: createdProvider.id,
        runnerId,
        permissionProfileId: unrestricted.id,
      });

      const retiredSettingsSeeded = persistRetiredSettings(home);

      controller = await startOnPort({ home, binary: edgeBinary, port });

      if (retiredSettingsSeeded) {
        const settingsWithRetired = expectJson<{ user: Record<string, unknown> }>(
          await runCli(["settings", "read", "--json"], edge),
        );
        expect(settingsWithRetired.user).toMatchObject(RETIRED_SETTINGS);
      } else {
        console.log(
          `Skipping the retired settings fixture: the edge database already ran migration ${String(RETIRED_SETTINGS_MIGRATION)}.`,
        );
      }

      const seededSession = summarizeSession(
        expectJson<SeededSession>(await runCli(["session", "read", sessionId, "--json"], edge)),
      );
      expect(seededSession).toMatchObject({
        id: sessionId,
        conversationId: assistant.mainConversationId,
        agentId: assistant.id,
        instanceId: createdProvider.id,
      });
      const seededTranscript = (await readTranscript({ ...edge, id: sessionId })).map(summarizeRow);
      expect(
        seededTranscript.length,
        "the baseline must contain transcript rows before the upgrade",
      ).toBeGreaterThan(0);
      expect(seededTranscript.map((row) => row.text).filter((text) => text !== undefined)).toEqual([
        ...TURNS,
      ]);

      console.log(
        `Seeded conversation ${assistant.mainConversationId}: ${String(seededMessages.length)} messages ` +
          `(${seededMessages.map((m) => m.senderRole).join(", ")}), ` +
          `provider ${createdProvider.id} (${createdProvider.name}), ` +
          `session ${sessionId} with ${String(seededTranscript.length)} transcript rows`,
      );

      expect(await controller.stop()).toBe(0);
      controller = undefined;

      // Where the upgraded controller's log lines start, so the checks below
      // read only its lines and not the edge binary's.
      const controllerLog = join(home, "logs", "controller.log");
      const upgradedLogStart = statSync(controllerLog).size;
      controller = await startOnPort({ home, binary: newBinary, port });
      const upgraded = { home, binary: newBinary };

      expectJson(await runCli(["controller", "read", "--json"], upgraded));

      const readSettings = expectJson<{ user: Record<string, unknown> }>(
        await runCli(["settings", "read", "--json"], upgraded),
      );
      expect(readSettings.user["timezone"]).toBe(seededSettings.user["timezone"]);
      if (retiredSettingsSeeded) {
        for (const key of Object.keys(RETIRED_SETTINGS)) {
          expect(readSettings.user).not.toHaveProperty([key]);
        }
        // The controller writes its log synchronously, so the read above is in
        // the file by now. The startup line shows that the slice holds this
        // run's lines, so the missing warning means something.
        const upgradedLog = readFileSync(controllerLog).subarray(upgradedLogStart).toString("utf8");
        expect(upgradedLog).toContain("Hercule is listening on");
        expect(upgradedLog).not.toContain("Ignoring the user setting");
      }

      const readProject = expectJson<{ id: string; name: string }>(
        await runCli(["project", "read", project.id, "--json"], upgraded),
      );
      expect(readProject).toMatchObject({ id: project.id, name: PROJECT_NAME });

      const readResource = expectJson<{ id: string; remote: string }>(
        await runCli(["resource", "read", resource.id, "--json"], upgraded),
      );
      expect(readResource).toMatchObject({ id: resource.id, remote: REPO_REMOTE });

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

      const readSession = summarizeSession(
        expectJson<SeededSession>(await runCli(["session", "read", sessionId, "--json"], upgraded)),
      );
      expect(readSession).toEqual(seededSession);
      const upgradedTranscript = (await readTranscript({ ...upgraded, id: sessionId })).map(
        summarizeRow,
      );
      expect(upgradedTranscript).toEqual(seededTranscript);

      const upgradedProfiles = readListedItems<SeededProfile>(
        await runCli(["profile", "list", "--json"], upgraded),
      );
      for (const name of SIGNAL_PROFILES) {
        const listed = upgradedProfiles.find((profile) => profile.name === name);
        expect(listed?.grants, `the ${name} profile after the upgrade`).toEqual(
          expect.arrayContaining([...SIGNAL_GRANTS]),
        );
        const seeded = profiles.find((profile) => profile.name === name);
        // Every grant the edge build seeded is still there beside the new ones.
        expect(listed?.grants).toEqual(expect.arrayContaining([...(seeded?.grants ?? [])]));
        const read = expectJson<SeededProfile>(
          await runCli(["profile", "read", listed?.id ?? name, "--json"], upgraded),
        );
        expect(read).toMatchObject({ id: listed?.id, name, grants: listed?.grants });
      }
    } finally {
      await controller?.stop().catch(() => -1);
    }
  }, 180_000);
});
