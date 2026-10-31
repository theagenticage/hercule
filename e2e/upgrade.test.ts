/**
 * Tests that a database filled by the previous `edge` release upgrades cleanly
 * to the new binary: the migrations run, the controller boots, and every record
 * is still readable.
 *
 * This catches migrations that are correct on an empty database but fail on
 * real data. The fixture is one representative conversation of several owner
 * turns, one named Provider Instance, one session with a few persisted
 * turns and the audit entry of its creation, the timezone first-run setup
 * persisted, a project name and a repository remote, two user settings that
 * migration 60 deletes, the shipped permission profiles, which migration 65
 * gives the signal grants, migration 76 gives (to `unrestricted` only)
 * `thread.start`, migration 78 gives the discussion grants, migration 80
 * gives the wiki grants and migration 85 gives the `skill` grants (to
 * `unrestricted` and `assistant` only), and one open signal whose match
 * values migration 73 sorts by name. The session holds two inputs, one with
 * an image, which migration 77 copies into a rebuilt `session_inputs`. The
 * session's turns hold tool calls from its own agent and from a subagent
 * beside an item that is not a tool call, which
 * migration 67 counts. A disabled workflow has two start triggers: one the
 * edge binary paused, and one with spawned and discarded trigger effects,
 * which migration 74 rebuilds. A second workflow's stored definition sets a
 * spawn bound over the limits a save enforces now, which migration 74
 * clamps. After the upgrade the test checks that those
 * records, their content, ordering and associations survived, that the
 * session's messages are searchable, that migration 63 read who created the
 * session from the audit entry, that the session reads with the number of
 * tool calls its stream holds, that the session's inputs and the input's
 * image read as they did, that the signal reads with the same values,
 * stored sorted, that the paused trigger reads as paused manually, that
 * each spawned trigger effect started its run when it matched, and that the
 * trigger with the over-limit bound reads with the clamped bound while its
 * workflow is marked invalid. Migration 94 qualifies the bare harness ids
 * the edge binary stored: the fixture holds the three Provider Instances the
 * edge boot seeds (`claude-code`, `codex` and `pi`) beside the one created
 * here, a runner row with the facts as the edge binary stored them (a
 * `providers` list and bare `adapters`), and a `session.started` event of
 * the session whose `providerRefs` key the migration renames. After the
 * upgrade the instances read with qualified harness ids, and none is added
 * by the boot's default instances, the runner's facts read with `harnesses`
 * and qualified `adapters`, and the event reads with `harnessRefs`. The
 * runner row is written beside the real runner because that one reports
 * fresh facts as soon as it reconnects. An edge database that already ran
 * migration 94 is seeded in the new spelling instead (`--harness`, qualified
 * ids, `harnesses`, `harnessRefs`), and the checks then show only that the
 * rows survive. It is
 * not a matrix of session states or provider behaviour.
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

/**
 * The migration that indexes transcripts for search and fills each session's
 * `created_by` from the audit entry of its creation.
 */
const TRANSCRIPT_SEARCH_MIGRATION = 63;

/** The actor stamp on the seeded session's audit entry: another session spawned it. */
const SESSION_CREATOR = "session:0190c000-0000-7000-8000-000000000001";

/** The migration that counts each session's stored tool calls into `toolCalls`. */
const SESSION_TOOL_CALLS_MIGRATION = 67;

/**
 * The tool calls in the seeded session's stream: a command from its own
 * agent, the call that starts a subagent, and that subagent's file read. The
 * assistant message beside them is not a tool call.
 */
const SEEDED_TOOL_CALLS = 3;

/** The subagent the seeded session's last turn hands work to. */
const SEEDED_SUBAGENT = "upgrade-fixture-subagent";

/** The migration that adds `SIGNAL_GRANTS` to the `SIGNAL_PROFILES`. */
const SIGNAL_GRANTS_MIGRATION = 65;

/** The shipped profiles that hold `SIGNAL_GRANTS` from migration 65 on. */
const SIGNAL_PROFILES = ["assistant", "worker", "unrestricted"] as const;

const SIGNAL_GRANTS = ["signal.read", "signal.write"] as const;

/** The migration that adds the `thread.start` grant to the shipped `unrestricted` profile. */
const THREAD_START_GRANT_MIGRATION = 76;

/** The shipped profiles that never hold `thread.start`: the user opts a profile in. */
const PROFILES_WITHOUT_THREAD_START = ["assistant", "worker"] as const;

/** The migration that rebuilds `session_inputs`, so it can hold Discussion Inputs. */
const DISCUSSIONS_MIGRATION = 77;

/** The seeded session's delivered input, which carries `SEEDED_ATTACHMENT_ID`. */
const SEEDED_DELIVERED_INPUT_ID = "0199e0e7-0000-7000-8000-0000000007a1";

/** The seeded session's cancelled input, which carries no image. */
const SEEDED_CANCELLED_INPUT_ID = "0199e0e7-0000-7000-8000-0000000007a2";

/** The image attached to `SEEDED_DELIVERED_INPUT_ID`. */
const SEEDED_ATTACHMENT_ID = "0199e0e7-0000-7000-8000-0000000007b1";

/** The migration that adds `DISCUSSION_GRANTS` to the `DISCUSSION_PROFILES`. */
const DISCUSSION_GRANTS_MIGRATION = 78;

/** The shipped profiles that hold `DISCUSSION_GRANTS` from migration 78 on. */
const DISCUSSION_PROFILES = ["assistant", "worker", "unrestricted"] as const;

const DISCUSSION_GRANTS = ["discussion.read", "discussion.write"] as const;

/** The migration that adds `WIKI_GRANTS` to the same shipped profiles as `SIGNAL_GRANTS`. */
const WIKI_GRANTS_MIGRATION = 80;

const WIKI_GRANTS = ["wiki.read", "wiki.write"] as const;

/**
 * The migration that adds the `skill` grants of `SKILL_GRANTS_BY_PROFILE` to
 * the shipped profiles.
 */
const SKILL_GRANTS_MIGRATION = 85;

/**
 * The `skill` grants each shipped profile holds from migration 85 on. No
 * shipped profile holds `skill.apply`, and only `assistant` holds
 * `skill.write`: only the user gives a session the power to change a skill.
 */
const SKILL_GRANTS_BY_PROFILE: Readonly<Record<string, ReadonlyArray<string>>> = {
  assistant: ["skill.read", "skill.write"],
  unrestricted: ["skill.read"],
  worker: [],
};

/** The migration that sorts the fields of each signal's stored `match` by name. */
const SORTED_MATCH_MIGRATION = 73;

/** The id of the seeded signal. */
const SEEDED_SIGNAL_ID = "0199e0e7-0000-7000-8000-0000000005a1";

/** The seeded signal's match values, stored in the order a plugin built them. */
const SEEDED_SIGNAL_MATCH = '{"repo":"example/repo","author":"dependabot[bot]"}';

/**
 * The migration that adds the `held` state and `spawned_at` to trigger
 * effects, filling `spawned_at` on every spawned row from its run's
 * `created_at`, or from its `matched_at` when the run is gone, and
 * marks every paused start trigger as paused manually.
 */
const SPAWN_BOUNDS_MIGRATION = 74;

/** The start trigger whose trigger effects the fixture seeds. It sets its own spawn bound. */
const BOUNDED_TRIGGER = "on_task";

/** The spawn bound `BOUNDED_TRIGGER` sets in the workflow's source. */
const BOUNDED_TRIGGER_SPAWN_BOUND = { maxRuns: 5, windowSeconds: 3600 } as const;

/** The start trigger the edge binary pauses. It sets no spawn bound, so the default applies. */
const PAUSED_TRIGGER = "on_task_paused";

/** The spawn bound every start trigger without its own runs under while no setting changes it. */
const DEFAULT_SPAWN_BOUND = { maxRuns: 30, windowSeconds: 3600 } as const;

/**
 * A workflow with two start triggers on `task.created`. It is never enabled,
 * so no event reaches its triggers and the trigger effects the fixture
 * seeds stay as they were written.
 */
const BOUNDED_WORKFLOW = [
  "name: Upgrade fixture bounds",
  "triggers:",
  "  - kind: start",
  `    id: ${BOUNDED_TRIGGER}`,
  "    on:",
  "      kind: task.created",
  "    spawnBound:",
  `      maxRuns: ${String(BOUNDED_TRIGGER_SPAWN_BOUND.maxRuns)}`,
  `      windowSeconds: ${String(BOUNDED_TRIGGER_SPAWN_BOUND.windowSeconds)}`,
  "  - kind: start",
  `    id: ${PAUSED_TRIGGER}`,
  "    on:",
  "      kind: task.created",
  "steps:",
  "  - id: file_task",
  "    kind: action",
  "    action: task.create",
  "    params:",
  "      title: Look at the new task",
  "      description: Filed by the upgrade fixture.",
].join("\n");

/** The start trigger whose stored spawn bound the fixture raises over today's limits. */
const LEGACY_BOUND_TRIGGER = "on_task_legacy";

/**
 * A workflow with one start trigger. The edge binary stores it with a bound
 * inside today's limits, and the fixture then raises the bound in the stored
 * definition, as an older controller that accepted any bound would have
 * stored it.
 */
const LEGACY_BOUND_WORKFLOW = [
  "name: Upgrade fixture legacy bound",
  "triggers:",
  "  - kind: start",
  `    id: ${LEGACY_BOUND_TRIGGER}`,
  "    on:",
  "      kind: task.created",
  "    spawnBound:",
  "      maxRuns: 5",
  "      windowSeconds: 3600",
  "steps:",
  "  - id: file_task",
  "    kind: action",
  "    action: task.create",
  "    params:",
  "      title: Look at the new task",
  "      description: Filed by the upgrade fixture.",
].join("\n");

/** The spawn bound over today's limits that the fixture stores for `LEGACY_BOUND_TRIGGER`. */
const LEGACY_SPAWN_BOUND = { maxRuns: 20_000, windowSeconds: Number.MAX_SAFE_INTEGER } as const;

/** The bound migration 74 clamps `LEGACY_SPAWN_BOUND` to: the most a save accepts. */
const CLAMPED_SPAWN_BOUND = { maxRuns: 10_000, windowSeconds: 30 * 86_400 } as const;

/**
 * The trigger effects seeded for `BOUNDED_TRIGGER`, in arrival order, with
 * how many minutes before the seeding each one matched. Two spawned rows fall
 * inside the trigger's window and one before it, so the window counts only
 * the two. The discarded row never started a run, so it gets no `spawned_at`.
 * A `pending` row is left out on purpose: the edge binary's delivery would
 * start or discard it as soon as the controller boots, so its state after the
 * upgrade would depend on timing.
 */
const SEEDED_TRIGGER_EFFECTS = [
  { state: "spawned", minutesAgo: 180 },
  { state: "discarded", minutesAgo: 20 },
  { state: "spawned", minutesAgo: 15 },
  { state: "spawned", minutesAgo: 10 },
] as const;

/** How many seeded spawned rows started their run inside `BOUNDED_TRIGGER_SPAWN_BOUND`'s window. */
const SEEDED_RUNS_IN_WINDOW = 2;

interface SeededTrigger {
  readonly workflowId: string;
  readonly triggerId: string;
  readonly status?: string;
  /** Absent before migration 74, which adds it, and on an active trigger. */
  readonly pausedBy?: string;
  /** Absent before migration 74. */
  readonly spawnBound?: {
    readonly maxRuns: number;
    readonly windowSeconds: number;
    readonly isDefault: boolean;
  };
  /** Absent before migration 74. */
  readonly runsInWindow?: number;
  /** Absent before migration 74. */
  readonly heldCount?: number;
}

interface SeededTriggerEffect {
  readonly state: string;
  readonly matched_at: string;
}

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
  /** Absent before migration 67, which adds it. */
  readonly toolCalls?: number;
}

interface SeededTranscriptRow {
  readonly position: number;
  readonly tag: string;
  readonly text: string | undefined;
}

interface SeededInput {
  readonly id: string;
  readonly attachments: ReadonlyArray<{ readonly id: string }>;
}

/**
 * A Provider Instance as the edge binary prints it: it names its harness
 * `providerId` and, once edge has migration 94, `harnessId`.
 */
interface EdgeProvider {
  readonly id: string;
  readonly providerId?: string;
  readonly harnessId?: string;
  readonly name: string;
}

/** A Provider Instance as the upgraded binary prints it. */
interface SeededProvider {
  readonly id: string;
  readonly harnessId: string;
  readonly name: string;
}

/** The migration that qualifies harness ids and renames `providers` and `providerRefs`. */
const QUALIFIED_HARNESS_IDS_MIGRATION = 94;

/** The harness ids the edge boot seeds an instance for, as an edge before migration 94 stores them. */
const EDGE_HARNESS_IDS = ["claude-code", "codex", "pi"] as const;

/** The same harnesses by their qualified ids, which migration 94 stores. */
const QUALIFIED_HARNESS_IDS = ["claude-code/claude-code", "codex/codex", "pi/pi"] as const;

/** The native session id in the seeded session's `session.started` event. */
const SEEDED_NATIVE_SESSION_ID = "upgrade-fixture-native";

/** The runner row the fixture writes beside the real one. It never connects. */
const SEEDED_RUNNER_ID = "0199e0e7-0000-7000-8000-0000000009a1";

/** The harness binaries in the seeded runner's facts, which the migration keeps as they are. */
const SEEDED_HARNESS_BINARIES = [
  { name: "claude", present: true, path: "/usr/local/bin/claude" },
  { name: "codex", present: false },
] as const;

const SEEDED_RUNNER_FACTS_BASE = {
  os: "linux",
  arch: "x64",
  totalMemoryBytes: 17_179_869_184,
  docker: true,
  toolchains: [{ name: "node", version: "v22.1.0", path: "/usr/local/bin/node" }],
  identityPort: 8080,
} as const;

/** The facts of `SEEDED_RUNNER_ID` as an edge before migration 94 stores them. */
const SEEDED_RUNNER_FACTS_BEFORE = {
  ...SEEDED_RUNNER_FACTS_BASE,
  providers: SEEDED_HARNESS_BINARIES,
  adapters: [...EDGE_HARNESS_IDS],
} as const;

/** The same facts after migration 94, which is how they read after the upgrade. */
const SEEDED_RUNNER_FACTS_AFTER = {
  ...SEEDED_RUNNER_FACTS_BASE,
  harnesses: SEEDED_HARNESS_BINARIES,
  adapters: [...QUALIFIED_HARNESS_IDS],
} as const;

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
  return { id: provider.id, harnessId: provider.harnessId, name: provider.name };
}

/** Returns the harness id of an instance the edge binary printed, whichever field names it. */
function readEdgeHarnessId(provider: EdgeProvider): string {
  const harnessId = provider.harnessId ?? provider.providerId;
  if (harnessId === undefined) throw new Error(`instance ${provider.id} names no harness`);
  return harnessId;
}

/**
 * Summarizes a Provider Instance the edge binary printed, naming its harness
 * by the qualified id it has after migration 94: `codex` becomes `codex/codex`,
 * and an id that is already qualified stays.
 */
function summarizeEdgeProvider(provider: EdgeProvider): SeededProvider {
  const harnessId = readEdgeHarnessId(provider);
  return {
    id: provider.id,
    harnessId: harnessId.includes("/") ? harnessId : `${harnessId}/${harnessId}`,
    name: provider.name,
  };
}

/** Returns the session's fields that survive the upgrade unchanged. */
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
 * Writes one exited session, a few transcript turns with the
 * `SEEDED_TOOL_CALLS` tool calls among their items, and the audit entry of
 * the session's creation by `SESSION_CREATOR` into the database the edge
 * binary created. `ids` are records that binary already persisted. Returns
 * the new session's id.
 */
function persistRepresentativeSession(options: {
  readonly home: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly instanceId: string;
  readonly runnerId: string;
  readonly permissionProfileId: string;
  /** The key the edge binary stores the harness's own ids under on `session.started`. */
  readonly refsKey: "providerRefs" | "harnessRefs";
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
    {
      _tag: "session.started",
      eventId: "e-start",
      sessionId,
      at,
      [options.refsKey]: { nativeSessionId: SEEDED_NATIVE_SESSION_ID },
    },
  ];
  /** One item started in each turn, by the session's own agent unless a subagent is named. */
  const startedItems: ReadonlyArray<{ readonly kind: string; readonly subagentId?: string }> = [
    { kind: "command_execution" },
    { kind: "assistant_message" },
    { kind: "subagent" },
  ];
  for (const [index, text] of TURNS.entries()) {
    const turnId = `turn-${String(index + 1)}`;
    const itemId = `item-${String(index + 1)}`;
    events.push(
      { _tag: "turn.started", eventId: `${turnId}-start`, sessionId, at, turnId },
      {
        _tag: "item.started",
        eventId: `${turnId}-tool`,
        sessionId,
        at,
        turnId,
        itemId: `${itemId}-tool`,
        detail: {},
        ...startedItems[index],
      },
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
  events.push(
    {
      _tag: "item.started",
      eventId: "subagent-read",
      sessionId,
      at,
      turnId: "subagent-turn",
      itemId: "subagent-read",
      kind: "file_read",
      detail: { path: "README.md" },
      subagentId: SEEDED_SUBAGENT,
    },
    { _tag: "session.exited", eventId: "e-exit", sessionId, at, reason: "stopped" },
  );

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
        SEEDED_NATIVE_SESSION_ID,
      );
    const insertEvent = database.query(
      `INSERT INTO session_stream (session_id, position, runner_seq, at, event, subagent_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [index, event] of events.entries()) {
      const position = index + 1;
      const subagentId = typeof event["subagentId"] === "string" ? event["subagentId"] : null;
      insertEvent.run(
        uuidBlob(sessionId),
        position,
        position,
        at,
        JSON.stringify(event),
        subagentId,
      );
    }
    database
      .query(
        `INSERT INTO events (source, system, kind, occurred_at, received_at, dedup_key, payload, actor)
         VALUES ('platform', 'platform', 'session.spawned', ?, ?, ?, ?, ?)`,
      )
      .run(at, at, crypto.randomUUID(), JSON.stringify({ sessionId }), SESSION_CREATOR);
  } finally {
    database.close();
  }
  return sessionId;
}

/**
 * Writes a second, offline runner with `facts` into the database
 * the edge binary created. The real runner cannot hold the fixture: it
 * reports new facts as soon as it reconnects to the upgraded controller, which
 * replaces what the migration rewrote.
 */
function persistRunnerWithEdgeFacts(
  home: string,
  facts: typeof SEEDED_RUNNER_FACTS_BEFORE | typeof SEEDED_RUNNER_FACTS_AFTER,
): void {
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    const at = new Date().toISOString();
    database
      .query(
        `INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                              credential_hash, facts, created_at, updated_at)
         VALUES (?, 'upgrade-fixture-runner', 'offline', 'active', 0, '[]', ?, ?, ?, ?)`,
      )
      .run(
        uuidBlob(SEEDED_RUNNER_ID),
        "upgrade-fixture-credential-hash",
        JSON.stringify(facts),
        at,
        at,
      );
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
 * Stores one open signal of a plugin kind with `SEEDED_SIGNAL_MATCH` in the
 * database the edge binary created, when that database predates the
 * migration that sorts a signal's match values. Returns whether it stored it.
 *
 * The row is written straight into the database because only an event of an
 * installed plugin raises such a signal. An edge database that already ran
 * the migration would not sort the row, so the fixture is skipped there.
 */
function persistUnsortedSignal(home: string): boolean {
  if (readMigrationVersion(home) >= SORTED_MATCH_MIGRATION) return false;
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    const origin = { type: "api", actor: "user", eventIds: [], reason: "Upgrade fixture" };
    database
      .query(
        `INSERT INTO signals (id, kind, origin, title, priority, blocks, actions, match, status, created_at)
         VALUES (?, 'github/review-requested', ?, 'Review example/repo#1', 'normal', '[]', '[]', ?, 'open', ?)`,
      )
      .run(
        uuidBlob(SEEDED_SIGNAL_ID),
        JSON.stringify(origin),
        SEEDED_SIGNAL_MATCH,
        new Date().toISOString(),
      );
    return true;
  } finally {
    database.close();
  }
}

/**
 * Stores two inputs of the session `sessionId` in the database the edge
 * binary created, when that database predates the migration that rebuilds
 * `session_inputs`: a delivered input with the image `SEEDED_ATTACHMENT_ID`
 * and a cancelled one. Returns whether it stored them.
 *
 * The rows are written straight into the database because the seeded session
 * is not live, so no input can be sent to it. Both inputs are final, so the
 * controller never tries to send them. A database that already ran the
 * migration would not rebuild the table, so the fixture is skipped there.
 */
function persistSessionInputs(home: string, sessionId: string): boolean {
  if (readMigrationVersion(home) >= DISCUSSIONS_MIGRATION) return false;
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    const at = new Date().toISOString();
    database
      .query(
        `INSERT INTO attachments (id, name, mime_type, size_bytes, sha256, created_at, actor)
         VALUES (?, 'screenshot.png', 'image/png', 4, 'upgrade-fixture', ?, 'user')`,
      )
      .run(uuidBlob(SEEDED_ATTACHMENT_ID), at);
    database
      .query(
        `INSERT INTO session_inputs
           (id, session_id, source, actor, text, status, delivery, created_at, delivered_at, reason)
         VALUES (?, ?, 'user', 'user', 'Look at this screenshot', 'delivered', 'opened', ?, ?, NULL),
                (?, ?, 'user', 'user', 'Never mind', 'cancelled', NULL, ?, NULL, 'cancelled by the user')`,
      )
      .run(
        uuidBlob(SEEDED_DELIVERED_INPUT_ID),
        uuidBlob(sessionId),
        at,
        at,
        uuidBlob(SEEDED_CANCELLED_INPUT_ID),
        uuidBlob(sessionId),
        at,
      );
    database
      .query(
        `INSERT INTO session_input_attachments (input_id, attachment_id, position) VALUES (?, ?, 0)`,
      )
      .run(uuidBlob(SEEDED_DELIVERED_INPUT_ID), uuidBlob(SEEDED_ATTACHMENT_ID));
    return true;
  } finally {
    database.close();
  }
}

/**
 * Writes `SEEDED_TRIGGER_EFFECTS` for `BOUNDED_TRIGGER` of the workflow
 * `workflowId` into the database the edge binary created, when that database
 * predates the migration that adds `spawned_at`. Returns the rows as written,
 * in arrival order, or `undefined` when it wrote none.
 *
 * The rows go straight into the database because only a matched event writes
 * one, and the workflow stays disabled so that nothing changes them. Their
 * events and runs are not written: nothing references a trigger effect, and
 * an effect whose event was pruned is an ordinary row. A database that
 * already ran the migration would refuse a spawned row without `spawned_at`,
 * and would have nothing left to migrate, so the fixture is skipped there.
 */
function persistTriggerEffects(
  home: string,
  workflowId: string,
): ReadonlyArray<SeededTriggerEffect> | undefined {
  if (readMigrationVersion(home) >= SPAWN_BOUNDS_MIGRATION) return undefined;
  const now = Date.now();
  const rows = SEEDED_TRIGGER_EFFECTS.map((row) => ({
    state: row.state,
    matched_at: new Date(now - row.minutesAgo * 60_000).toISOString(),
  }));
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    const insert = database.query(
      `INSERT INTO trigger_effects (workflow_id, trigger_id, event_id, state, inputs, run_id, matched_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)`,
    );
    for (const [index, row] of rows.entries()) {
      const runId = row.state === "spawned" ? uuidBlob(Bun.randomUUIDv7()) : null;
      insert.run(
        uuidBlob(workflowId),
        BOUNDED_TRIGGER,
        1_000_000 + index,
        row.state,
        runId,
        row.matched_at,
      );
    }
    return rows;
  } finally {
    database.close();
  }
}

/**
 * Raises the spawn bound of `LEGACY_BOUND_TRIGGER` in the stored definition
 * of the workflow `workflowId` to `LEGACY_SPAWN_BOUND`, when the database the
 * edge binary created predates the migration that clamps it. Returns whether
 * it wrote.
 *
 * The edge binary may already refuse such a bound on a save, so the bound is
 * written straight into the database. A database that already ran the
 * migration would have nothing left to clamp, so the fixture is skipped there.
 */
function persistLegacySpawnBound(home: string, workflowId: string): boolean {
  if (readMigrationVersion(home) >= SPAWN_BOUNDS_MIGRATION) return false;
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    database
      .query(
        `UPDATE workflows SET definition = json_set(definition, '$.triggers[0].spawnBound', json(?))
         WHERE id = ?`,
      )
      .run(JSON.stringify(LEGACY_SPAWN_BOUND), uuidBlob(workflowId));
    return true;
  } finally {
    database.close();
  }
}

/** Lists the start triggers of the workflow `workflowId`, keyed by trigger id. */
async function readTriggers(
  options: { readonly home: string; readonly binary: string },
  workflowId: string,
): Promise<ReadonlyMap<string, SeededTrigger>> {
  const triggers = readListedItems<SeededTrigger>(
    await runCli(["trigger", "list", "--workflow", workflowId, "--json"], options),
  );
  return new Map(triggers.map((trigger) => [trigger.triggerId, trigger]));
}

/** Returns the id of the last migration the database in `home` ran. */
function readMigrationVersion(home: string): number {
  const database = new Database(join(home, "data", "hercule.db"), { readonly: true });
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

      // The edge database exists now, and a reader does not block the
      // running controller. Migration 94 changed how the CLI spells a harness.
      const edgeQualified = readMigrationVersion(home) >= QUALIFIED_HARNESS_IDS_MIGRATION;
      const createdProvider = expectJson<EdgeProvider>(
        await runCli(
          [
            "provider",
            "create",
            ...(edgeQualified
              ? ["--harness", "claude-code/claude-code"]
              : ["--provider", "claude-code"]),
            "--name",
            PROVIDER_NAME,
            "--json",
          ],
          { ...edge, stdin: "{}" },
        ),
      );
      expect(readEdgeHarnessId(createdProvider)).toBe(
        edgeQualified ? "claude-code/claude-code" : "claude-code",
      );
      expect(createdProvider.name).toBe(PROVIDER_NAME);

      const edgeProviders = readListedItems<EdgeProvider>(
        await runCli(["provider", "list", "--json"], edge),
      );
      // The edge boot seeds one instance per harness, so all three ids are
      // stored, bare before migration 94 and qualified after it.
      expect(new Set(edgeProviders.map(readEdgeHarnessId))).toEqual(
        new Set(edgeQualified ? QUALIFIED_HARNESS_IDS : EDGE_HARNESS_IDS),
      );
      const seededProviders = edgeProviders
        .map(summarizeEdgeProvider)
        .sort((left, right) => left.id.localeCompare(right.id));
      expect(seededProviders.some((row) => row.id === createdProvider.id)).toBe(true);

      const profiles = readListedItems<SeededProfile>(
        await runCli(["profile", "list", "--json"], edge),
      );
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

      const boundedWorkflow = expectJson<{ workflow: { id: string; enabled: boolean } }>(
        await runCli(["workflow", "create", "--json"], { ...edge, stdin: BOUNDED_WORKFLOW }),
      ).workflow;
      expect(boundedWorkflow.enabled).toBe(false);
      expectJson(
        await runCli(["trigger", "pause", boundedWorkflow.id, PAUSED_TRIGGER, "--json"], edge),
      );
      const seededTriggers = await readTriggers(edge, boundedWorkflow.id);
      expect(seededTriggers.get(BOUNDED_TRIGGER)?.status).toBe("active");
      expect(seededTriggers.get(PAUSED_TRIGGER)?.status).toBe("paused");
      const legacyBoundWorkflow = expectJson<{ workflow: { id: string } }>(
        await runCli(["workflow", "create", "--json"], { ...edge, stdin: LEGACY_BOUND_WORKFLOW }),
      ).workflow;

      const port = controller.port;
      expect(await controller.stop()).toBe(0);
      controller = undefined;

      // A database from before migration 63 has shipped profiles without the
      // signal grants, so the upgrade must add them. A newer one was seeded
      // with them, and the checks after the upgrade only show they survived.
      // The version is read only now, with the controller stopped, because a
      // running controller holds the database file locked.
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

      // The same holds for `thread.start`, which only `unrestricted` gains.
      const threadStartMigrated = readMigrationVersion(home) < THREAD_START_GRANT_MIGRATION;
      if (threadStartMigrated) {
        const edgeUnrestricted = profiles.find((one) => one.name === "unrestricted");
        expect(edgeUnrestricted, "the edge database has no unrestricted profile").toBeDefined();
        expect(edgeUnrestricted?.grants).not.toContain("thread.start");
      } else {
        console.log(
          `The edge database already ran migration ${String(THREAD_START_GRANT_MIGRATION)}: checking that thread.start survives the upgrade.`,
        );
      }

      // The same holds for the discussion grants.
      const discussionGrantsMigrated = readMigrationVersion(home) < DISCUSSION_GRANTS_MIGRATION;
      if (discussionGrantsMigrated) {
        for (const name of DISCUSSION_PROFILES) {
          const profile = profiles.find((one) => one.name === name);
          expect(profile, `the edge database has no ${name} profile`).toBeDefined();
          for (const grant of DISCUSSION_GRANTS) expect(profile?.grants).not.toContain(grant);
        }
      } else {
        console.log(
          `The edge database already ran migration ${String(DISCUSSION_GRANTS_MIGRATION)}: checking that the discussion grants survive the upgrade.`,
        );
      }

      // The same holds for the wiki grants, which the signal profiles gain.
      const wikiGrantsMigrated = readMigrationVersion(home) < WIKI_GRANTS_MIGRATION;
      if (wikiGrantsMigrated) {
        for (const name of SIGNAL_PROFILES) {
          const profile = profiles.find((one) => one.name === name);
          for (const grant of WIKI_GRANTS) expect(profile?.grants).not.toContain(grant);
        }
      } else {
        console.log(
          `The edge database already ran migration ${String(WIKI_GRANTS_MIGRATION)}: checking that the wiki grants survive the upgrade.`,
        );
      }

      // The same holds for the skill grants, which no edge build before
      // migration 85 knew.
      const skillGrantsMigrated = readMigrationVersion(home) < SKILL_GRANTS_MIGRATION;
      if (skillGrantsMigrated) {
        for (const name of Object.keys(SKILL_GRANTS_BY_PROFILE)) {
          const profile = profiles.find((one) => one.name === name);
          expect(profile, `the edge database has no ${name} profile`).toBeDefined();
          expect(profile?.grants.filter((grant) => grant.startsWith("skill."))).toEqual([]);
        }
      } else {
        console.log(
          `The edge database already ran migration ${String(SKILL_GRANTS_MIGRATION)}: checking that the skill grants survive the upgrade.`,
        );
      }

      const sessionId = persistRepresentativeSession({
        home,
        conversationId: assistant.mainConversationId,
        agentId: assistant.id,
        instanceId: createdProvider.id,
        runnerId,
        permissionProfileId: unrestricted.id,
        refsKey: edgeQualified ? "harnessRefs" : "providerRefs",
      });

      persistRunnerWithEdgeFacts(
        home,
        edgeQualified ? SEEDED_RUNNER_FACTS_AFTER : SEEDED_RUNNER_FACTS_BEFORE,
      );
      const retiredSettingsSeeded = persistRetiredSettings(home);
      const signalSeeded = persistUnsortedSignal(home);
      const inputsSeeded = persistSessionInputs(home, sessionId);
      const seededTriggerEffects = persistTriggerEffects(home, boundedWorkflow.id);
      const legacyBoundSeeded = persistLegacySpawnBound(home, legacyBoundWorkflow.id);
      const edgeVersion = readMigrationVersion(home);

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

      if (signalSeeded) {
        const seededSignal = expectJson<{ match: Record<string, string> }>(
          await runCli(["signal", "read", SEEDED_SIGNAL_ID, "--json"], edge),
        );
        expect(seededSignal.match).toEqual(JSON.parse(SEEDED_SIGNAL_MATCH));
      } else {
        console.log(
          `Skipping the sorted match fixture: the edge database already ran migration ${String(SORTED_MATCH_MIGRATION)}.`,
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

      const seededInputs = readListedItems<SeededInput>(
        await runCli(["input", "list", sessionId, "--json"], edge),
      );
      if (inputsSeeded) {
        expect(seededInputs.map((input) => input.id).sort()).toEqual(
          [SEEDED_DELIVERED_INPUT_ID, SEEDED_CANCELLED_INPUT_ID].sort(),
        );
        expect(
          seededInputs.find((input) => input.id === SEEDED_DELIVERED_INPUT_ID)?.attachments,
        ).toMatchObject([{ id: SEEDED_ATTACHMENT_ID }]);
      } else {
        console.log(
          `Skipping the session inputs fixture: the edge database already ran migration ${String(DISCUSSIONS_MIGRATION)}.`,
        );
      }

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
        harnessId: "claude-code/claude-code",
        name: PROVIDER_NAME,
      });
      const upgradedProviders = readListedItems<SeededProvider>(
        await runCli(["provider", "list", "--json"], upgraded),
      )
        .map(summarizeProvider)
        .sort((left, right) => left.id.localeCompare(right.id));
      // The same instances with qualified ids, and no second set from the
      // boot's default instances, which would show if migration 94 had not
      // run before the boot looked for a harness without an instance.
      expect(upgradedProviders).toEqual(seededProviders);
      expect(new Set(upgradedProviders.map((row) => row.harnessId))).toEqual(
        new Set(QUALIFIED_HARNESS_IDS),
      );

      // The stored facts of a runner that has not reconnected: `providers`
      // is now `harnesses` with the same binaries, the adapters are
      // qualified, and the other fields are as they were.
      const upgradedRunner = expectJson<{ facts: unknown }>(
        await runCli(["runner", "read", SEEDED_RUNNER_ID, "--json"], upgraded),
      );
      expect(upgradedRunner.facts).toEqual(SEEDED_RUNNER_FACTS_AFTER);

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

      // Migration 0062 gives every assistant that existed before it an empty
      // `core`, so an assistant from the edge build has memory to read.
      const upgradedCore = expectJson<{ name: string; body: string; size: number }>(
        await runCli(["memory", "read", assistant.id, "core", "--json"], upgraded),
      );
      expect(upgradedCore).toMatchObject({ name: "core", body: "", size: 0 });

      const upgradedMessages = readListedItems<SeededMessage>(
        await runCli(
          ["conversation", "message", "list", assistant.mainConversationId, "--json"],
          upgraded,
        ),
      );
      expect(sortByPosition(upgradedMessages).map(summarizeMessage)).toEqual(
        seededMessages.map(summarizeMessage),
      );

      const upgradedSession = expectJson<SeededSession>(
        await runCli(["session", "read", sessionId, "--json"], upgraded),
      );
      expect(summarizeSession(upgradedSession)).toEqual(seededSession);
      // When the edge binary already has migration 67, the fixture's rows
      // were inserted directly, so nothing counted them.
      if (edgeVersion < SESSION_TOOL_CALLS_MIGRATION) {
        expect(upgradedSession.toolCalls).toBe(SEEDED_TOOL_CALLS);
      } else {
        console.log(
          `Skipping the session tool calls fixture: the edge database already ran migration ${String(SESSION_TOOL_CALLS_MIGRATION)}.`,
        );
      }
      const upgradedTranscript = (await readTranscript({ ...upgraded, id: sessionId })).map(
        summarizeRow,
      );
      expect(upgradedTranscript).toEqual(seededTranscript);
      // Migration 94 renames `providerRefs` on stored events and keeps its value.
      const upgradedStart = (await readTranscript({ ...upgraded, id: sessionId })).find(
        (row) => row.event._tag === "session.started",
      );
      expect(upgradedStart?.event).toMatchObject({
        harnessRefs: { nativeSessionId: SEEDED_NATIVE_SESSION_ID },
      });
      expect(upgradedStart?.event).not.toHaveProperty("providerRefs");

      const upgradedInputs = readListedItems<SeededInput>(
        await runCli(["input", "list", sessionId, "--json"], upgraded),
      );
      expect(upgradedInputs).toEqual(seededInputs);

      const upgradedProfiles = readListedItems<SeededProfile>(
        await runCli(["profile", "list", "--json"], upgraded),
      );
      for (const name of SIGNAL_PROFILES) {
        const listed = upgradedProfiles.find((profile) => profile.name === name);
        expect(listed?.grants, `the ${name} profile after the upgrade`).toEqual(
          expect.arrayContaining([...SIGNAL_GRANTS, ...WIKI_GRANTS]),
        );
        const seeded = profiles.find((profile) => profile.name === name);
        // Every grant the edge build seeded is still there beside the new ones.
        expect(listed?.grants).toEqual(expect.arrayContaining([...(seeded?.grants ?? [])]));
        const read = expectJson<SeededProfile>(
          await runCli(["profile", "read", listed?.id ?? name, "--json"], upgraded),
        );
        expect(read).toMatchObject({ id: listed?.id, name, grants: listed?.grants });
      }

      for (const name of DISCUSSION_PROFILES) {
        const listed = upgradedProfiles.find((profile) => profile.name === name);
        expect(listed?.grants, `the ${name} profile after the upgrade`).toEqual(
          expect.arrayContaining([...DISCUSSION_GRANTS]),
        );
      }

      const upgradedUnrestricted = upgradedProfiles.find(
        (profile) => profile.name === "unrestricted",
      );
      const seededUnrestricted = profiles.find((profile) => profile.name === "unrestricted");
      expect(upgradedUnrestricted?.grants, "unrestricted after the upgrade").toEqual(
        expect.arrayContaining(["thread.start", ...(seededUnrestricted?.grants ?? [])]),
      );
      for (const name of PROFILES_WITHOUT_THREAD_START) {
        const listed = upgradedProfiles.find((profile) => profile.name === name);
        expect(listed, `the ${name} profile after the upgrade`).toBeDefined();
        expect(listed?.grants, `the ${name} profile after the upgrade`).not.toContain(
          "thread.start",
        );
      }

      for (const [name, grants] of Object.entries(SKILL_GRANTS_BY_PROFILE)) {
        const listed = upgradedProfiles.find((profile) => profile.name === name);
        expect(listed, `the ${name} profile after the upgrade`).toBeDefined();
        expect(
          listed?.grants.filter((grant) => grant.startsWith("skill.")).sort(),
          `the skill grants of ${name} after the upgrade`,
        ).toEqual([...grants].sort());
      }

      if (signalSeeded) {
        const upgradedSignal = expectJson<{ match: Record<string, string> }>(
          await runCli(["signal", "read", SEEDED_SIGNAL_ID, "--json"], upgraded),
        );
        expect(upgradedSignal.match).toEqual(JSON.parse(SEEDED_SIGNAL_MATCH));
      }

      // The messages written before the upgrade are searchable after it.
      const passages = readListedItems<{ sessionId: string; excerpt: string }>(
        await runCli(
          ["transcript", "list", "--text", "risks", "--session", sessionId, "--json"],
          upgraded,
        ),
      );
      expect(passages).toMatchObject([{ sessionId, excerpt: TURNS[1] }]);

      // A trigger paused before migration 74 reads as paused manually, and
      // each trigger's spawn bound comes from its source or the default.
      // The controller validates every stored workflow again when it starts,
      // and the fixture's workflow still validates.
      const upgradedWorkflow = expectJson<{ id: string; enabled: boolean }>(
        await runCli(["workflow", "read", boundedWorkflow.id, "--json"], upgraded),
      );
      expect(upgradedWorkflow).toMatchObject({ id: boundedWorkflow.id, enabled: false });
      expect(upgradedWorkflow).not.toHaveProperty("invalidSince");
      const upgradedTriggers = await readTriggers(upgraded, boundedWorkflow.id);
      expect([...upgradedTriggers.keys()].sort()).toEqual([...seededTriggers.keys()].sort());
      const pausedTrigger = upgradedTriggers.get(PAUSED_TRIGGER);
      expect(pausedTrigger).toMatchObject({
        status: "paused",
        pausedBy: "manual",
        spawnBound: { ...DEFAULT_SPAWN_BOUND, isDefault: true },
        heldCount: 0,
      });
      const boundedTrigger = upgradedTriggers.get(BOUNDED_TRIGGER);
      expect(boundedTrigger).toMatchObject({
        status: "active",
        spawnBound: { ...BOUNDED_TRIGGER_SPAWN_BOUND, isDefault: false },
        heldCount: 0,
      });
      expect(boundedTrigger).not.toHaveProperty("pausedBy");
      if (seededTriggerEffects !== undefined) {
        // The window counts runs by when they started, which for a row spawned
        // before the migration is when it matched.
        expect(boundedTrigger?.runsInWindow).toBe(SEEDED_RUNS_IN_WINDOW);
      } else {
        console.log(
          `Skipping the trigger effects fixture: the edge database already ran migration ${String(SPAWN_BOUNDS_MIGRATION)}.`,
        );
      }
      if (legacyBoundSeeded) {
        // The trigger runs under the clamped bound, and stays readable. Its
        // definition keeps the old bound, so the check at boot marks the
        // workflow invalid and tells its author to save it again.
        const legacyWorkflow = expectJson<{ invalidSince?: string }>(
          await runCli(["workflow", "read", legacyBoundWorkflow.id, "--json"], upgraded),
        );
        expect(legacyWorkflow.invalidSince).toEqual(expect.any(String));
        const legacyTriggers = await readTriggers(upgraded, legacyBoundWorkflow.id);
        expect(legacyTriggers.get(LEGACY_BOUND_TRIGGER)).toMatchObject({
          spawnBound: { ...CLAMPED_SPAWN_BOUND, isDefault: false },
        });
      } else {
        console.log(
          `Skipping the legacy spawn bound fixture: the edge database already ran migration ${String(SPAWN_BOUNDS_MIGRATION)}.`,
        );
      }

      expect(await controller.stop()).toBe(0);
      controller = undefined;
      if (signalSeeded) {
        const reader = new Database(join(home, "data", "hercule.db"), { readonly: true });
        try {
          expect(
            reader.query("SELECT match FROM signals WHERE id = ?").get(uuidBlob(SEEDED_SIGNAL_ID)),
          ).toEqual({ match: '{"author":"dependabot[bot]","repo":"example/repo"}' });
        } finally {
          reader.close();
        }
      }
      if (inputsSeeded) {
        // The rows were copied into the rebuilt table whole, and the image
        // still belongs to its input.
        const reader = new Database(join(home, "data", "hercule.db"), { readonly: true });
        try {
          expect(
            reader
              .query(
                `SELECT hex(id) AS id, source, status, delivery, reason
                 FROM session_inputs WHERE session_id = ? ORDER BY id`,
              )
              .all(uuidBlob(sessionId)),
          ).toEqual([
            {
              id: uuidBlob(SEEDED_DELIVERED_INPUT_ID).toString("hex").toUpperCase(),
              source: "user",
              status: "delivered",
              delivery: "opened",
              reason: null,
            },
            {
              id: uuidBlob(SEEDED_CANCELLED_INPUT_ID).toString("hex").toUpperCase(),
              source: "user",
              status: "cancelled",
              delivery: null,
              reason: "cancelled by the user",
            },
          ]);
          expect(
            reader
              .query(
                "SELECT hex(input_id) AS input_id, hex(attachment_id) AS attachment_id FROM session_input_attachments WHERE attachment_id = ?",
              )
              .all(uuidBlob(SEEDED_ATTACHMENT_ID)),
          ).toEqual([
            {
              input_id: uuidBlob(SEEDED_DELIVERED_INPUT_ID).toString("hex").toUpperCase(),
              attachment_id: uuidBlob(SEEDED_ATTACHMENT_ID).toString("hex").toUpperCase(),
            },
          ]);
          expect(reader.query("PRAGMA foreign_key_check(session_input_attachments)").all()).toEqual(
            [],
          );
        } finally {
          reader.close();
        }
      }
      if (edgeVersion < TRANSCRIPT_SEARCH_MIGRATION) {
        const reader = new Database(join(home, "data", "hercule.db"), { readonly: true });
        try {
          expect(
            reader.query("SELECT created_by FROM sessions WHERE id = ?").get(uuidBlob(sessionId)),
          ).toEqual({ created_by: SESSION_CREATOR });
        } finally {
          reader.close();
        }
      } else {
        console.log(
          `Skipping the session creator fixture: the edge database already ran migration ${String(TRANSCRIPT_SEARCH_MIGRATION)}.`,
        );
      }
      if (edgeVersion < SPAWN_BOUNDS_MIGRATION) {
        // The migration copies each trigger's spawn bound from its stored
        // definition, and no trigger has been resumed since it ran.
        const reader = new Database(join(home, "data", "hercule.db"), { readonly: true });
        try {
          expect(
            reader
              .query(
                `SELECT trigger_id, paused_by, spawn_bound_max_runs, spawn_bound_window_seconds,
                        held_at_resume
                 FROM triggers WHERE workflow_id = ? ORDER BY trigger_id`,
              )
              .all(uuidBlob(boundedWorkflow.id)),
          ).toEqual([
            {
              trigger_id: BOUNDED_TRIGGER,
              paused_by: null,
              spawn_bound_max_runs: BOUNDED_TRIGGER_SPAWN_BOUND.maxRuns,
              spawn_bound_window_seconds: BOUNDED_TRIGGER_SPAWN_BOUND.windowSeconds,
              held_at_resume: null,
            },
            {
              trigger_id: PAUSED_TRIGGER,
              paused_by: "manual",
              spawn_bound_max_runs: null,
              spawn_bound_window_seconds: null,
              held_at_resume: null,
            },
          ]);
        } finally {
          reader.close();
        }
      }
      if (seededTriggerEffects !== undefined) {
        // Every row survives in its order and state. The fixture writes no
        // runs, so a spawned row takes when it matched as when its run
        // started; a discarded row started none.
        const reader = new Database(join(home, "data", "hercule.db"), { readonly: true });
        try {
          expect(
            reader
              .query(
                `SELECT state, matched_at, spawned_at FROM trigger_effects
                 WHERE workflow_id = ? AND trigger_id = ? ORDER BY id`,
              )
              .all(uuidBlob(boundedWorkflow.id), BOUNDED_TRIGGER),
          ).toEqual(
            seededTriggerEffects.map((row) => ({
              ...row,
              spawned_at: row.state === "spawned" ? row.matched_at : null,
            })),
          );
        } finally {
          reader.close();
        }
      }
    } finally {
      await controller?.stop().catch(() => -1);
    }
  }, 180_000);
});
