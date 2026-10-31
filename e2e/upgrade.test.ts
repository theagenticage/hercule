/**
 * Tests that a database filled by the previous `edge` release upgrades cleanly
 * to the new binary: the migrations run, the controller boots, and every record
 * is still readable.
 *
 * This catches migrations that are correct on an empty database but fail on
 * real data. The fixture is one representative conversation of several owner
 * turns, three Provider Accounts (one per vendor), one session with a few persisted
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
 * workflow is marked invalid.
 *
 * Migration 94 qualified the harness ids and renamed `providers` and
 * `providerRefs` in the edge binary already, so the fixture holds a runner row
 * with `harnesses` and qualified `adapters`, and a `session.started` event
 * and a user-message row of the session with `harnessRefs`. After the upgrade
 * those rows read as they were, and the user message is still found by the
 * transcript search. The runner row is written beside the real runner because
 * that one reports fresh facts as soon as it reconnects.
 *
 * The edge binary already ran migration 95, so its database holds Provider
 * Accounts (spec 04 "Provider account rows"). The edge boot seeds none, so the
 * fixture creates one per vendor (Anthropic, OpenAI and Z.ai) and labels the
 * Anthropic account `work` and gives it the person the stand-in `claude` also
 * reports. The Anthropic and OpenAI accounts are subscriptions that sign in on
 * each machine, which `provider-account create` makes without credentials. A
 * Z.ai account takes an API key that the create command checks against
 * api.z.ai, so the fixture writes that account and its encrypted key into the
 * database directly. Besides the session of the
 * conversation, the database holds a session on OpenAI without a native
 * session id, an exited Anthropic thread with a native session id, an Agent on
 * OpenAI, the assistant on the oldest account, a `textGeneration.model` choice
 * that names Z.ai, the user's `thread.providerAccountId`, and the snapshots
 * that two runners reported. After the upgrade the test checks:
 *
 * - the accounts are exactly the ones the edge binary had (the upgraded
 *   binary seeds none), with the same label, identity, kind and default
 *   harness, the snapshots of the runner that never reconnects, and
 *   `expiresAt: null`, which migration 96 adds;
 * - sessions read back with an account and a harness; the Agent, the assistant,
 *   `textGeneration.model` and the thread default read back as they were;
 * - the Z.ai key reaches the runner decrypted, in the account's home: a
 *   stand-in `pi` on the controller's PATH records the key and the home it was
 *   run in when the account is probed;
 * - the exited Anthropic thread resumes in its home with its native session
 *   id: a stand-in `claude` records its config directory and arguments.
 *
 * Migration 100 creates the Model Profile "Main" holding every account, in the
 * order the accounts were added, with each section still waiting for its
 * account's first Model Catalog read. The stand-in harnesses wait for a gate
 * file before they answer anything, so the runner of the upgraded controller
 * cannot read a catalog before the test has read the profile exactly as the
 * migration left it: revision 1, no entries, no default entry. Once the gate
 * opens, the first catalog reads fill the sections of the accounts the
 * stand-ins can sign in.
 *
 * Migration 102 adds `model_catalogs.first_read_at`, the time of an account's
 * first successful catalog read, which decides which models are announced as
 * new. When the edge database has the catalog table but not the column, the
 * fixture writes the catalog of two accounts into it: one with a first-seen
 * ledger whose models came in two reads, and one with an empty ledger. After
 * the upgrade the first reads are the earliest ledger time and the last read,
 * and the catalog still reads.
 *
 * It is not a matrix of session states or harness behaviour.
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
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  completeSetup,
  encryptAccountKey,
  runCli,
  startController,
  type Controller,
  type Ran,
} from "../scripts/controller-process";
import { CLAUDE_CODE_VERSION, PI_VERSION } from "../packages/home/src/version";
import {
  createTemporaryHome,
  parseJsonOutputOrFail,
  readApiKey,
  readRunnerStorageDir,
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

/** The label the fixture gives the Anthropic account. */
const ACCOUNT_LABEL = "work";
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

/**
 * The migration that creates the Model Profile "Main", holding every account
 * with a pending Default Selection.
 */
const MODEL_PROFILE_MIGRATION = 100;

/** The name of the profile that migration creates. */
const MAIN_MODEL_PROFILE = "Main";

/** The migration that adds `model_catalogs.first_read_at` and fills it for the catalogs that were read. */
const CATALOG_FIRST_READ_MIGRATION = 102;

/** The times of the seeded catalog reads, which the migration turns into a first read time. */
const SEEDED_CATALOG_FIRST_READ = "2026-10-01T08:00:00.000Z";
const SEEDED_CATALOG_SECOND_READ = "2026-10-01T12:00:00.000Z";
const SEEDED_CATALOG_LAST_READ = "2026-10-02T12:00:00.000Z";

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
  /** Absent before migration 67, which adds it. */
  readonly toolCalls?: number;
}

/** A session as the upgraded binary prints it: on a Provider Account, in a harness. */
interface UpgradedSession extends SeededSession {
  readonly providerAccountId: string;
  readonly harnessId: string;
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

/** A Provider Account as either binary prints it. `expiresAt` exists from migration 96 on. */
interface ListedAccount {
  readonly id: string;
  readonly providerId: string;
  readonly kind: string;
  readonly label: string | null;
  readonly identity: string | null;
  readonly planLabel: string | null;
  readonly defaultHarnessId: string;
  readonly expiresAt?: string | null;
  readonly snapshots: ReadonlyArray<{
    readonly runnerId: string;
    readonly harnessId: string;
    readonly auth: { readonly status: string };
  }>;
}

/** A Model Profile as `hercule model-profile list` prints it. Only the parts the upgrade check reads. */
interface ListedModelProfile {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly accounts: ReadonlyArray<{
    readonly providerAccountId: string;
    readonly harnessId: string | null;
    readonly resolvedHarnessId: string;
    readonly selectionPending: boolean;
    readonly entries: ReadonlyArray<{ readonly model: string; readonly harnessId: string | null }>;
    readonly newModels: ReadonlyArray<{
      readonly model: string;
      readonly name: string;
      readonly firstSeenAt: string;
    }>;
  }>;
  readonly defaultEntry: unknown;
  readonly dismissedNewModels: ReadonlyArray<unknown>;
}

/** An Agent or assistant as either binary prints it. */
interface SeededAgent {
  readonly id: string;
  readonly name: string;
  readonly providerAccountId: string;
  readonly harnessId: string | null;
}

/** The harness ids of the three accounts the fixture creates. */
const QUALIFIED_HARNESS_IDS = ["claude-code/claude-code", "codex/codex", "pi/pi"] as const;

/** The native session id in the seeded session's `session.started` event. */
const SEEDED_NATIVE_SESSION_ID = "upgrade-fixture-native";

/**
 * The text of the seeded user-message row. Codex and pi store `harnessRefs`
 * on such a row, and the transcript search indexes its text, so the search
 * must still find it after the upgrade.
 */
const SEEDED_USER_MESSAGE = "Please recap the quarterly roadmap handshake.";

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

/** The facts of `SEEDED_RUNNER_ID`, which the upgrade leaves as they are. */
const SEEDED_RUNNER_FACTS = {
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

/** Returns the session's fields that survive the upgrade unchanged. */
function summarizeSession(session: SeededSession): SeededSession {
  return {
    id: session.id,
    conversationId: session.conversationId,
    agentId: session.agentId,
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
 * Returns the folders, under the runner's storage directory, of the home a
 * seeded account uses for one harness (spec 06 section 9.1). Only an account
 * made by migration 95 keeps an older folder; the accounts of the edge boot do
 * not.
 */
function accountHome(providerAccountId: string, harnessId: string): ReadonlyArray<string> {
  return ["providers", "homes", providerAccountId, ...harnessId.split("/")];
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
  readonly providerAccountId: string;
  readonly harnessId: string;
  readonly runnerId: string;
  readonly permissionProfileId: string;
}): string {
  const sessionId = Bun.randomUUIDv7();
  const at = new Date().toISOString();
  const spec = JSON.stringify({
    providerAccountId: options.providerAccountId,
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
      harnessRefs: { nativeSessionId: SEEDED_NATIVE_SESSION_ID },
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
      eventId: "user-message",
      sessionId,
      at,
      turnId: "user-turn",
      itemId: "user-message",
      kind: "user_message",
      detail: { text: SEEDED_USER_MESSAGE },
      harnessRefs: { nativeSessionId: SEEDED_NATIVE_SESSION_ID },
    },
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
           provider_account_id, harness_id, runner_id, requested_access_mode, access_mode,
           spec, model_selection, status, created_at, started_at, exited_at,
           last_activity_at, native_session_id, exit_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'auto', 'auto', ?, ?, 'exited', ?, ?, ?, ?, ?, 'stopped')`,
      )
      .run(
        uuidBlob(sessionId),
        TURNS[0],
        uuidBlob(options.permissionProfileId),
        uuidBlob(options.agentId),
        uuidBlob(options.conversationId),
        uuidBlob(options.providerAccountId),
        options.harnessId,
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

/** The Z.ai key the fixture stores as pi's `zaiApiKey`. The upgrade must hand it to a runner unchanged. */
const ZAI_API_KEY = "zai-upgrade-fixture-key-7d41";

/** The person, and the plan, that the labelled Anthropic account is signed in as. */
const WORK_IDENTITY = { identity: "ada@example.com", planLabel: "Max" } as const;

/** The native session id of the exited Claude Code thread that the upgraded binary resumes. */
const RESUMABLE_NATIVE_SESSION_ID = "upgrade-fixture-resumable";

/**
 * Writes one exited Thread (a session with no Agent and no conversation) on
 * the Provider Account `providerAccountId`, in `harnessId`, into the database
 * the edge binary created, with the `session.started` and `session.exited` events a real one
 * leaves. A session with no `nativeSessionId` never reported a harness-native
 * session, so it cannot be resumed. Returns the new session's id.
 */
function persistThreadSession(options: {
  readonly home: string;
  readonly providerAccountId: string;
  readonly harnessId: string;
  readonly runnerId: string;
  readonly permissionProfileId: string;
  readonly title: string;
  readonly nativeSessionId: string | null;
}): string {
  const sessionId = Bun.randomUUIDv7();
  const at = new Date().toISOString();
  const spec = JSON.stringify({
    providerAccountId: options.providerAccountId,
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
      ...(options.nativeSessionId === null
        ? {}
        : { harnessRefs: { nativeSessionId: options.nativeSessionId } }),
    },
    { _tag: "session.exited", eventId: "e-exit", sessionId, at, reason: "stopped" },
  ];
  const database = new Database(join(options.home, "data", "hercule.db"));
  try {
    database
      .query(
        `INSERT INTO sessions (
           id, title, permission_profile_id, provider_account_id, harness_id, runner_id,
           requested_access_mode, access_mode, spec, model_selection, status,
           created_at, started_at, exited_at, last_activity_at, native_session_id, exit_reason
         ) VALUES (?, ?, ?, ?, ?, ?, 'auto', 'auto', ?, ?, 'exited', ?, ?, ?, ?, ?, 'stopped')`,
      )
      .run(
        uuidBlob(sessionId),
        options.title,
        uuidBlob(options.permissionProfileId),
        uuidBlob(options.providerAccountId),
        options.harnessId,
        uuidBlob(options.runnerId),
        spec,
        JSON.stringify({ model: "sonnet", options: {} }),
        at,
        at,
        at,
        at,
        options.nativeSessionId,
      );
    const insertEvent = database.query(
      `INSERT INTO session_stream (session_id, position, runner_seq, at, event, subagent_id)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    for (const [index, event] of events.entries()) {
      insertEvent.run(uuidBlob(sessionId), index + 1, index + 1, at, JSON.stringify(event));
    }
  } finally {
    database.close();
  }
  return sessionId;
}

/** What one runner reported for one account in one harness: who was signed in, or `null` when no one. */
interface SeededSnapshot {
  readonly providerAccountId: string;
  readonly harnessId: string;
  readonly runnerId: string;
  readonly person: { readonly identity: string; readonly planLabel: string | null } | null;
  readonly harnessVersion: string | null;
  /** How long before the seeding the runner probed. */
  readonly minutesAgo: number;
}

/**
 * Writes the snapshots the runners reported into the database the edge binary
 * created. A snapshot the edge binary already stored for the same account,
 * harness and runner is replaced, because the three are the table's key.
 */
function persistSnapshots(home: string, snapshots: ReadonlyArray<SeededSnapshot>): void {
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    const insert = database.query(
      `INSERT OR REPLACE INTO capability_snapshots
         (provider_account_id, harness_id, runner_id, probed_at, harness_version, auth_status, auth_identity,
          auth_plan_label, auth_backend, auth_message, models)
       VALUES (?, ?, ?, ?, ?, 'ok', ?, ?, NULL, NULL, '[]')`,
    );
    for (const snapshot of snapshots) {
      insert.run(
        uuidBlob(snapshot.providerAccountId),
        snapshot.harnessId,
        uuidBlob(snapshot.runnerId),
        new Date(Date.now() - snapshot.minutesAgo * 60_000).toISOString(),
        snapshot.harnessVersion,
        snapshot.person?.identity ?? null,
        snapshot.person?.planLabel ?? null,
      );
    }
  } finally {
    database.close();
  }
}

/**
 * Stores who is signed in on an account, as a probe that found one signed-in
 * person would have, into the database the edge binary created.
 */
function persistAccountIdentity(
  home: string,
  providerAccountId: string,
  person: typeof WORK_IDENTITY,
): void {
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    database
      .query("UPDATE provider_accounts SET identity = ?, plan_label = ? WHERE id = ?")
      .run(person.identity, person.planLabel, uuidBlob(providerAccountId));
  } finally {
    database.close();
  }
}

/**
 * Adds a Z.ai Provider Account to the database the edge binary created, with
 * its API key stored the way the edge binary stores a credential: encrypted
 * with AES-GCM under the Master Key, owned by the account, with the owner and
 * name as associated data. Returns the id of the account.
 */
function persistZaiAccount(home: string, apiKey: string): string {
  const id = Bun.randomUUIDv7();
  const now = new Date().toISOString();
  const { nonce, ciphertext } = encryptAccountKey(home, id, apiKey);
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    database
      .query(
        `INSERT INTO provider_accounts (id, provider_id, kind, default_harness_id, created_at, updated_at)
         VALUES (?, 'zai/zai', 'api-key', 'pi/pi', ?, ?)`,
      )
      .run(uuidBlob(id), now, now);
    database
      .query(
        `INSERT INTO secrets (id, owner_kind, owner_id, name, nonce, ciphertext, created_at)
         VALUES (?, 'provider-account', ?, 'apiKey', ?, ?, ?)`,
      )
      .run(uuidBlob(Bun.randomUUIDv7()), id, nonce, ciphertext, now);
  } finally {
    database.close();
  }
  return id;
}

/** The stand-in harness programs the upgraded controller's runner finds on its `PATH`. */
interface StandIns {
  /** The folder to put in front of the `PATH`. */
  readonly folder: string;
  /**
   * A file the stand-ins wait for before they answer anything. They give up
   * waiting after a minute, so a test that fails before it creates the file
   * leaves no process behind.
   */
  readonly gate: string;
  /** Where the stand-in `pi` appends the key and the home of every `auth check`. */
  readonly piRecord: string;
  /** Where the stand-in `claude` appends the config directory and arguments of every session start. */
  readonly claudeRecord: string;
}

/**
 * Writes a stand-in `pi` and `claude` into `folder`, so the test can see what
 * the runner hands to a harness without a vendor login.
 *
 * - `pi` answers the probe: its version, an `auth check` that is ready exactly
 *   when `ZAI_API_KEY` is set (and records that key and `PI_CODING_AGENT_DIR`),
 *   `update`, and one `get_available_models` request over RPC.
 * - `claude` answers `--version` and the SDK's `initialize` request, so the
 *   probe reports a signed-in `WORK_IDENTITY`. Any other start is a session:
 *   it records `CLAUDE_CONFIG_DIR` and its arguments (which hold `--resume=<id>`)
 *   and then reads its input until it closes.
 * - `codex` fails, so a machine that has a real, signed-in Codex cannot
 *   answer for the OpenAI account.
 *
 * Every stand-in waits for `StandIns.gate` first.
 */
function writeStandIns(folder: string): StandIns {
  mkdirSync(folder, { recursive: true });
  const piRecord = join(folder, "pi.record");
  const claudeRecord = join(folder, "claude.record");
  const gate = join(folder, "gate");
  const waitForGate = [
    "waited=0",
    `while [ ! -e '${gate}' ] && [ "$waited" -lt 600 ]; do sleep 0.1; waited=$((waited + 1)); done`,
  ];
  const pi = [
    "#!/bin/sh",
    ...waitForGate,
    'case "$1" in',
    `  --version) echo "${PI_VERSION}" ;;`,
    "  auth)",
    `    printf 'ZAI_API_KEY=%s\\nPI_CODING_AGENT_DIR=%s\\n' "\${ZAI_API_KEY-}" "\${PI_CODING_AGENT_DIR-}" >> '${piRecord}'`,
    '    if [ -n "${ZAI_API_KEY-}" ]; then echo \'{"status":"ready"}\'; else echo \'{"status":"not_ready"}\'; exit 1; fi ;;',
    "  update) ;;",
    "  --mode)",
    "    read -r line",
    `    id=$(printf '%s' "$line" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')`,
    `    printf '{"type":"response","id":"%s","command":"get_available_models","success":true,"data":{"models":[]}}\\n' "$id" ;;`,
    "esac",
    "",
  ].join("\n");
  const claude = [
    "#!/bin/sh",
    ...waitForGate,
    `if [ "$1" = "--version" ]; then echo "${CLAUDE_CODE_VERSION} (Claude Code)"; exit 0; fi`,
    "read -r first",
    `id=$(printf '%s' "$first" | sed -n 's/.*"request_id":"\\([^"]*\\)".*/\\1/p')`,
    `printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[],"agents":[],"output_style":"default","available_output_styles":["default"],"models":[],"account":{"email":"${WORK_IDENTITY.identity}","subscriptionType":"${WORK_IDENTITY.planLabel.toLowerCase()}"}}}}\\n' "$id"`,
    'for argument in "$@"; do',
    '  case "$argument" in',
    "    --resume=*)",
    `      { printf 'CLAUDE_CONFIG_DIR=%s\\n' "\${CLAUDE_CONFIG_DIR-}"; for each in "$@"; do printf 'ARG=%s\\n' "$each"; done; } >> '${claudeRecord}' ;;`,
    "  esac",
    "done",
    "while read -r line; do :; done",
    "",
  ].join("\n");
  writeFileSync(join(folder, "pi"), pi, { mode: 0o755 });
  const codex = ["#!/bin/sh", ...waitForGate, "exit 1", ""].join("\n");
  writeFileSync(join(folder, "claude"), claude, { mode: 0o755 });
  writeFileSync(join(folder, "codex"), codex, { mode: 0o755 });
  chmodSync(join(folder, "pi"), 0o755);
  chmodSync(join(folder, "claude"), 0o755);
  chmodSync(join(folder, "codex"), 0o755);
  return { folder, gate, piRecord, claudeRecord };
}

/** Returns the lines a stand-in has recorded so far, none when it was never run. */
function readRecord(path: string): ReadonlyArray<string> {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];
}

/** Waits until the stand-in's record holds more lines than `before`, and returns all of them. */
async function waitForRecordPast(
  path: string,
  before: number,
  what: string,
): Promise<ReadonlyArray<string>> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const lines = readRecord(path);
    if (lines.length > before) return lines;
    if (Date.now() > deadline) throw new Error(`${what} never reached the stand-in (${path})`);
    await sleep(250);
  }
}

/**
 * Writes a second, offline runner with `facts` into the database
 * the edge binary created. The real runner cannot hold the fixture: it
 * reports new facts as soon as it reconnects to the upgraded controller, which
 * replaces what the migration rewrote.
 */
function persistRunnerWithEdgeFacts(home: string, facts: typeof SEEDED_RUNNER_FACTS): void {
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

/**
 * Writes the Model Catalog of two accounts into the database the edge binary
 * created, when that database has the catalog table but not yet the column
 * for the first read. Returns whether it wrote.
 *
 * - `withLedger` gets a catalog whose models a and b came in the first read
 *   and c in a later one, last read at `SEEDED_CATALOG_LAST_READ`.
 * - `withoutLedger` gets a catalog that was read and lists no model.
 *
 * The rows go straight into the database because only a catalog read writes
 * one, and a read needs a signed-in harness, which CI does not have. A
 * database without the table has no catalog to migrate, and one with the
 * column is skipped because the fixture would not be in the old shape.
 */
function persistCatalogReads(
  home: string,
  accounts: { readonly withLedger: string; readonly withoutLedger: string },
): boolean {
  const version = readMigrationVersion(home);
  if (version < MODEL_PROFILE_MIGRATION || version >= CATALOG_FIRST_READ_MIGRATION) return false;
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    const insert = database.query(
      `INSERT INTO model_catalogs
         (provider_account_id, models, first_seen, read_at, error, models_stamp, attempt_stamp)
       VALUES (?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (provider_account_id) DO UPDATE SET
         models = excluded.models, first_seen = excluded.first_seen, read_at = excluded.read_at,
         error = NULL, models_stamp = excluded.models_stamp,
         attempt_stamp = excluded.attempt_stamp`,
    );
    const model = (slug: string) =>
      ({ slug, name: slug.toUpperCase(), imageInput: null, options: [] }) as const;
    insert.run(
      uuidBlob(accounts.withLedger),
      JSON.stringify([model("a"), model("b"), model("c")]),
      JSON.stringify({
        a: SEEDED_CATALOG_FIRST_READ,
        b: SEEDED_CATALOG_FIRST_READ,
        c: SEEDED_CATALOG_SECOND_READ,
      }),
      SEEDED_CATALOG_LAST_READ,
      SEEDED_CATALOG_LAST_READ,
      SEEDED_CATALOG_LAST_READ,
    );
    insert.run(
      uuidBlob(accounts.withoutLedger),
      "[]",
      "{}",
      SEEDED_CATALOG_LAST_READ,
      SEEDED_CATALOG_LAST_READ,
      SEEDED_CATALOG_LAST_READ,
    );
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
  /** Extra environment for the controller and the runner it starts, such as a `PATH`. */
  readonly env?: Readonly<Record<string, string>>;
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

      // The edge boot seeds no account, so the fixture creates one per vendor,
      // oldest first. A subscription that signs in on each machine takes no
      // credentials, so the controller checks no key with a real provider.
      const createSubscriptionAccount = async (provider: string): Promise<ListedAccount> => {
        const created = await runCli(
          [
            "provider-account",
            "create",
            "--provider",
            provider,
            "--kind",
            "subscription-per-machine",
            "--json",
          ],
          edge,
        );
        expect(created.code, `${created.stdout}\n${created.stderr}`).toBe(0);
        return expectJson<ListedAccount>(created);
      };
      const claudeAccount = await createSubscriptionAccount("anthropic/anthropic");
      const codexAccount = await createSubscriptionAccount("openai/openai");
      // A Z.ai account takes an API key, which `provider-account create` checks
      // against api.z.ai before it stores anything, and a fixture key fails
      // that check. So the account and its encrypted key are written into the
      // database the edge binary created, in the shape that binary stores them.
      const piAccountId = persistZaiAccount(home, ZAI_API_KEY);

      const edgeAccounts = readListedItems<ListedAccount>(
        await runCli(["provider-account", "list", "--json"], edge),
      );
      expect(new Set(edgeAccounts.map((account) => account.defaultHarnessId))).toEqual(
        new Set(QUALIFIED_HARNESS_IDS),
      );
      const piAccount = edgeAccounts.find((account) => account.id === piAccountId);
      if (piAccount === undefined)
        throw new Error("the edge binary does not list the Z.ai account");

      // The label is the one thing a user changes on the Anthropic account here.
      const labelled = expectJson<ListedAccount>(
        await runCli(
          ["provider-account", "update", claudeAccount.id, "--label", ACCOUNT_LABEL, "--json"],
          edge,
        ),
      );
      expect(labelled.label).toBe(ACCOUNT_LABEL);

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
      const assistant = expectJson<SeededAgent & { mainConversationId: string }>(
        await runCli(["assistant", "create", "--name", "upgrade-assistant", "--json"], edge),
      );
      // Left to choose, the assistant takes the oldest account.
      expect(assistant.providerAccountId).toBe(claudeAccount.id);
      expect(assistant.harnessId).toBeNull();

      const agent = expectJson<SeededAgent>(
        await runCli(
          [
            "agent",
            "create",
            "--name",
            "upgrade-agent",
            "--account",
            codexAccount.id,
            "--profile",
            unrestricted.id,
            "--json",
          ],
          { ...edge, stdin: "You review the upgrade fixture." },
        ),
      );
      expect(agent.providerAccountId).toBe(codexAccount.id);

      // An explicit Text Generation model on Z.ai, and the thread default on
      // the labelled Anthropic account.
      const textGenerationModel = { providerAccountId: piAccount.id, model: "glm-5.3-flash" };
      expectJson(
        await runCli(
          [
            "settings",
            "update",
            "--controller",
            JSON.stringify({ "textGeneration.model": textGenerationModel }),
            "--user",
            JSON.stringify({ "thread.providerAccountId": claudeAccount.id }),
            "--json",
          ],
          edge,
        ),
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
        providerAccountId: claudeAccount.id,
        harnessId: "claude-code/claude-code",
        runnerId,
        permissionProfileId: unrestricted.id,
      });
      // A session on Codex that never reported a native session, and an exited
      // Claude Code thread that did, which the upgraded binary resumes.
      const codexSessionId = persistThreadSession({
        home,
        providerAccountId: codexAccount.id,
        harnessId: "codex/codex",
        runnerId,
        permissionProfileId: unrestricted.id,
        title: "Codex thread without a native session",
        nativeSessionId: null,
      });
      const resumableSessionId = persistThreadSession({
        home,
        providerAccountId: claudeAccount.id,
        harnessId: "claude-code/claude-code",
        runnerId,
        permissionProfileId: unrestricted.id,
        title: "Claude Code thread to resume",
        nativeSessionId: RESUMABLE_NATIVE_SESSION_ID,
      });

      persistRunnerWithEdgeFacts(home, SEEDED_RUNNER_FACTS);
      const retiredSettingsSeeded = persistRetiredSettings(home);
      const signalSeeded = persistUnsortedSignal(home);
      const inputsSeeded = persistSessionInputs(home, sessionId);
      const seededTriggerEffects = persistTriggerEffects(home, boundedWorkflow.id);
      const legacyBoundSeeded = persistLegacySpawnBound(home, legacyBoundWorkflow.id);
      // The OpenAI account's Codex stand-in never answers, so a failed read
      // is all that can touch its catalog. The Z.ai account's catalog is read
      // again, which keeps the first read.
      const catalogReadsSeeded = persistCatalogReads(home, {
        withLedger: codexAccount.id,
        withoutLedger: piAccount.id,
      });
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

      const edgeSession = expectJson<UpgradedSession>(
        await runCli(["session", "read", sessionId, "--json"], edge),
      );
      expect(edgeSession).toMatchObject({
        providerAccountId: claudeAccount.id,
        harnessId: "claude-code/claude-code",
      });
      const seededSession = summarizeSession(edgeSession);
      expect(seededSession).toMatchObject({
        id: sessionId,
        conversationId: assistant.mainConversationId,
        agentId: assistant.id,
      });
      for (const [id, providerAccountId, harnessId] of [
        [codexSessionId, codexAccount.id, "codex/codex"],
        [resumableSessionId, claudeAccount.id, "claude-code/claude-code"],
      ] as const) {
        const thread = expectJson<UpgradedSession>(
          await runCli(["session", "read", id, "--json"], edge),
        );
        expect(thread).toMatchObject({ providerAccountId, harnessId, status: "exited" });
      }
      const edgeSettings = expectJson<{
        controller: Record<string, unknown>;
        user: Record<string, unknown>;
      }>(await runCli(["settings", "read", "--json"], edge));
      expect(edgeSettings.controller["textGeneration.model"]).toEqual(textGenerationModel);
      expect(edgeSettings.user["thread.providerAccountId"]).toBe(claudeAccount.id);
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
          `account ${claudeAccount.id} (${ACCOUNT_LABEL}), ` +
          `session ${sessionId} with ${String(seededTranscript.length)} transcript rows`,
      );

      expect(await controller.stop()).toBe(0);
      controller = undefined;

      // Written only now, with the edge controller stopped for the last time:
      // it probes every account again when its runner connects, and that
      // replaces the snapshots of the real runner and could set the identity.
      // The runner that never connects keeps its snapshots, and the labelled
      // account keeps the person the fixture signed in on it.
      persistAccountIdentity(home, claudeAccount.id, WORK_IDENTITY);
      persistSnapshots(home, [
        {
          providerAccountId: claudeAccount.id,
          harnessId: "claude-code/claude-code",
          runnerId: SEEDED_RUNNER_ID,
          person: WORK_IDENTITY,
          harnessVersion: CLAUDE_CODE_VERSION,
          minutesAgo: 60,
        },
        {
          providerAccountId: codexAccount.id,
          harnessId: "codex/codex",
          runnerId: SEEDED_RUNNER_ID,
          person: { identity: "linus@example.com", planLabel: "Pro" },
          harnessVersion: null,
          minutesAgo: 60,
        },
      ]);

      // Where the upgraded controller's log lines start, so the checks below
      // read only its lines and not the edge binary's.
      const controllerLog = join(home, "logs", "controller.log");
      const upgradedLogStart = statSync(controllerLog).size;
      // The upgraded controller's runner finds the stand-in `pi` and `claude`
      // first, so the test sees what a runner hands to each harness.
      const standIns = writeStandIns(join(home, "stand-ins"));
      controller = await startOnPort({
        home,
        binary: newBinary,
        port,
        env: { PATH: `${standIns.folder}${delimiter}${process.env["PATH"] ?? ""}` },
      });
      const upgraded = { home, binary: newBinary };

      expectJson(await runCli(["controller", "read", "--json"], upgraded));

      // Migration 100 made the profile "Main". The stand-ins have answered
      // nothing yet, so no catalog was read and the profile is as the
      // migration left it. The accounts are listed in the order they were
      // added.
      if (edgeVersion < MODEL_PROFILE_MIGRATION) {
        const profiles = readListedItems<ListedModelProfile>(
          await runCli(["model-profile", "list", "--json"], upgraded),
        );
        expect(profiles.map((profile) => profile.name)).toEqual([MAIN_MODEL_PROFILE]);
        const main = profiles[0]!;
        expect(main.revision).toBe(1);
        expect(main.defaultEntry).toBeNull();
        expect(main.dismissedNewModels).toEqual([]);
        expect(main.accounts).toEqual(
          edgeAccounts.map((account) => ({
            providerAccountId: account.id,
            harnessId: null,
            resolvedHarnessId: account.defaultHarnessId,
            selectionPending: true,
            entries: [],
          })),
        );
      } else {
        console.log(
          `Skipping the Model Profile fixture: the edge database already ran migration ${String(MODEL_PROFILE_MIGRATION)}.`,
        );
      }
      // From here the runner may probe, which reads the catalogs.
      writeFileSync(standIns.gate, "");

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

      const upgradedAccounts = readListedItems<ListedAccount>(
        await runCli(["provider-account", "list", "--json"], upgraded),
      );
      // No account is added, such as by a fresh-install seed, and none is lost.
      expect(upgradedAccounts.map((account) => account.id).sort()).toEqual(
        edgeAccounts.map((account) => account.id).sort(),
      );
      const findAccount = (id: string): ListedAccount => {
        const found = upgradedAccounts.find((account) => account.id === id);
        if (found === undefined) throw new Error(`no account ${id}`);
        return found;
      };
      // Migration 96 adds `expiresAt`: no account of the edge binary has an
      // expiry, so every one reads `null` (and not a missing field).
      for (const account of upgradedAccounts) {
        expect(account, `account ${account.id}`).toHaveProperty("expiresAt", null);
      }
      // The person on the labelled account is the one the fixture stored, and
      // the stand-in `claude` reports the same one when the runner probes it.
      expect(findAccount(claudeAccount.id)).toMatchObject({
        providerId: "anthropic/anthropic",
        kind: "subscription-per-machine",
        label: ACCOUNT_LABEL,
        ...WORK_IDENTITY,
        defaultHarnessId: "claude-code/claude-code",
      });
      expect(findAccount(codexAccount.id)).toMatchObject({
        providerId: "openai/openai",
        kind: "subscription-per-machine",
        label: null,
        identity: null,
        planLabel: null,
        defaultHarnessId: "codex/codex",
      });
      expect(findAccount(piAccount.id)).toMatchObject({
        providerId: "zai/zai",
        kind: "api-key",
        label: null,
        identity: null,
        defaultHarnessId: "pi/pi",
      });
      // The snapshot of the runner that never reconnected is kept, keyed by its harness.
      expect(
        findAccount(codexAccount.id).snapshots.map((snapshot) => [
          snapshot.runnerId,
          snapshot.harnessId,
        ]),
      ).toEqual(expect.arrayContaining([[SEEDED_RUNNER_ID, "codex/codex"]]));
      const readAccount = expectJson<ListedAccount>(
        await runCli(["provider-account", "read", claudeAccount.id, "--json"], upgraded),
      );
      expect(readAccount).toMatchObject({
        id: claudeAccount.id,
        label: ACCOUNT_LABEL,
        expiresAt: null,
      });

      // The stored facts of a runner that has not reconnected: `providers`
      // is now `harnesses` with the same binaries, the adapters are
      // qualified, and the other fields are as they were.
      const upgradedRunner = expectJson<{ facts: unknown }>(
        await runCli(["runner", "read", SEEDED_RUNNER_ID, "--json"], upgraded),
      );
      // The order of `adapters` is not promised and nothing reads it, so the
      // list is compared as a set and the other fields as they are.
      const { adapters: upgradedAdapters, ...upgradedFacts } = upgradedRunner.facts as {
        readonly adapters: ReadonlyArray<string>;
      };
      const { adapters: expectedAdapters, ...expectedFacts } = SEEDED_RUNNER_FACTS;
      expect(upgradedFacts).toEqual(expectedFacts);
      expect(new Set(upgradedAdapters)).toEqual(new Set(expectedAdapters));

      // An Agent and an assistant keep their account and the harness choice
      // they had: none, which is the account's default.
      const readAssistant = expectJson<SeededAgent & { mainConversationId: string }>(
        await runCli(["assistant", "read", assistant.id, "--json"], upgraded),
      );
      expect(readAssistant.mainConversationId).toBe(assistant.mainConversationId);
      expect(readAssistant).toMatchObject({
        providerAccountId: claudeAccount.id,
        harnessId: null,
      });
      const readAgent = expectJson<SeededAgent>(
        await runCli(["agent", "read", agent.id, "--json"], upgraded),
      );
      expect(readAgent).toMatchObject({
        id: agent.id,
        name: "upgrade-agent",
        providerAccountId: codexAccount.id,
        harnessId: null,
      });

      // The Text Generation choice and the thread default are as they were.
      const upgradedSettings = expectJson<{
        controller: Record<string, unknown>;
        user: Record<string, unknown>;
      }>(await runCli(["settings", "read", "--json"], upgraded));
      expect(upgradedSettings.controller["textGeneration.model"]).toEqual(textGenerationModel);
      expect(upgradedSettings.user["thread.providerAccountId"]).toBe(claudeAccount.id);
      expect(upgradedSettings.user).not.toHaveProperty(["thread.harnessId"]);

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

      const upgradedSession = expectJson<UpgradedSession>(
        await runCli(["session", "read", sessionId, "--json"], upgraded),
      );
      expect(summarizeSession(upgradedSession)).toEqual(seededSession);
      expect(upgradedSession).toMatchObject({
        providerAccountId: claudeAccount.id,
        harnessId: "claude-code/claude-code",
      });
      for (const [id, providerAccountId, harnessId] of [
        [codexSessionId, codexAccount.id, "codex/codex"],
        [resumableSessionId, claudeAccount.id, "claude-code/claude-code"],
      ] as const) {
        expect(
          expectJson<UpgradedSession>(await runCli(["session", "read", id, "--json"], upgraded)),
          `session ${id}`,
        ).toMatchObject({ providerAccountId, harnessId, status: "exited" });
      }
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
      const upgradedRows = await readTranscript({ ...upgraded, id: sessionId });
      const upgradedStart = upgradedRows.find((row) => row.event._tag === "session.started");
      expect(upgradedStart?.event).toMatchObject({
        harnessRefs: { nativeSessionId: SEEDED_NATIVE_SESSION_ID },
      });
      expect(upgradedStart?.event).not.toHaveProperty("providerRefs");
      // The same rename on a user message, which is also a search-indexed row.
      const upgradedUserMessage = upgradedRows.find((row) => row.event["kind"] === "user_message");
      expect(upgradedUserMessage?.event).toMatchObject({
        detail: { text: SEEDED_USER_MESSAGE },
        harnessRefs: { nativeSessionId: SEEDED_NATIVE_SESSION_ID },
      });
      expect(upgradedUserMessage?.event).not.toHaveProperty("providerRefs");

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
      // The user message that migration 94 rewrote is found by its text too.
      const rewrittenPassages = readListedItems<{ sessionId: string; excerpt: string }>(
        await runCli(
          ["transcript", "list", "--text", "handshake", "--session", sessionId, "--json"],
          upgraded,
        ),
      );
      expect(rewrittenPassages).toMatchObject([{ sessionId, excerpt: SEEDED_USER_MESSAGE }]);

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

      // The Z.ai key was encrypted under the account by the edge binary, and
      // the upgraded one must still decrypt it. Probing the account makes the
      // controller decrypt it and hand it to the runner, which puts it in the
      // environment of `pi`. The stand-in records it, with the home it ran in,
      // which is still the account's home.
      const storageDir = readRunnerStorageDir(home);
      const probedZai = await runCli(
        ["runner", "probe", runnerId, "--account", piAccount.id, "--json"],
        upgraded,
      );
      expect(probedZai.code, `${probedZai.stdout}\n${probedZai.stderr}`).toBe(0);
      expect(expectJson<{ auth: { status: string } }>(probedZai).auth.status).toBe("ok");
      const piRecorded = readRecord(standIns.piRecord);
      expect(piRecorded.length, "the stand-in pi never ran an auth check").toBeGreaterThan(0);
      for (const line of piRecorded) {
        if (line.startsWith("ZAI_API_KEY=")) expect(line).toBe(`ZAI_API_KEY=${ZAI_API_KEY}`);
        else
          expect(line).toBe(
            `PI_CODING_AGENT_DIR=${join(storageDir, ...accountHome(piAccount.id, "pi/pi"))}`,
          );
      }

      // The exited Claude Code thread resumes in its account's home, with the
      // native session id it reported. Sending it an input resumes it.
      expect(
        readRecord(standIns.claudeRecord),
        "nothing should have resumed a session yet",
      ).toEqual([]);
      const resumed = await runCli(["session", "input", resumableSessionId, "--json"], {
        ...upgraded,
        stdin: "Carry on.",
      });
      expect(resumed.code, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
      const claudeRecorded = await waitForRecordPast(
        standIns.claudeRecord,
        0,
        "the resumed session",
      ).catch(async (error: unknown) => {
        const after = await runCli(["session", "read", resumableSessionId, "--json"], upgraded);
        const inputs = await runCli(["input", "list", resumableSessionId, "--json"], upgraded);
        const logTail = readFileSync(controllerLog, "utf8").slice(upgradedLogStart).slice(-6000);
        throw new Error(
          `${String(error)}\nsession: ${after.stdout}\ninputs: ${inputs.stdout}\nlog:\n${logTail}`,
        );
      });
      expect(claudeRecorded).toContain(
        `CLAUDE_CONFIG_DIR=${join(storageDir, ...accountHome(claudeAccount.id, "claude-code/claude-code"))}`,
      );
      expect(claudeRecorded).toContain(`ARG=--resume=${RESUMABLE_NATIVE_SESSION_ID}`);

      // The first catalog reads, which the open gate let the runner make,
      // fill the sections of the two accounts a stand-in can sign in. Both
      // stand-ins list no models, so the sections are filled with none. The
      // OpenAI account has no Codex that works, so its section keeps waiting.
      if (edgeVersion < MODEL_PROFILE_MIGRATION) {
        const pendingByAccount = async () => {
          const [main] = readListedItems<ListedModelProfile>(
            await runCli(["model-profile", "list", "--json"], upgraded),
          );
          return new Map(
            main!.accounts.map((section) => [section.providerAccountId, section.selectionPending]),
          );
        };
        await expect.poll(pendingByAccount, { timeout: 60_000 }).toEqual(
          new Map([
            [claudeAccount.id, false],
            [codexAccount.id, true],
            [piAccount.id, false],
          ]),
        );
      }

      if (catalogReadsSeeded) {
        // The backfilled first read drives the announcements. The profile
        // takes in model a of the seeded OpenAI catalog and nothing else.
        // Model b came with the first read, so it is not new. Model c came
        // with the second read, after the first read the migration worked
        // out, so it is. A first read that was backfilled wrongly (later, or
        // missing) would hide c. The section is written with entries because
        // the account's Codex stand-in never answers, so its first read never
        // fills a waiting section.
        const takeInModelA = async (attempt: number): Promise<ListedModelProfile> => {
          const [main] = readListedItems<ListedModelProfile>(
            await runCli(["model-profile", "list", "--json"], upgraded),
          );
          if (main === undefined) throw new Error("the upgraded controller lists no profile");
          const storedEntry = { providerAccountId: codexAccount.id, model: "a", harnessId: null };
          // The other sections are sent as they are, a waiting one without entries.
          const sections = [
            ...main.accounts
              .filter((section) => section.providerAccountId !== codexAccount.id)
              .map((section) => ({
                providerAccountId: section.providerAccountId,
                harnessId: section.harnessId,
                ...(section.selectionPending
                  ? {}
                  : {
                      entries: section.entries.map((one) => ({
                        providerAccountId: section.providerAccountId,
                        model: one.model,
                        harnessId: one.harnessId,
                      })),
                    }),
              })),
            { providerAccountId: codexAccount.id, harnessId: null, entries: [storedEntry] },
          ];
          const updated = await runCli(
            [
              "model-profile",
              "update",
              main.id,
              "--expected-revision",
              String(main.revision),
              "--name",
              main.name,
              "--default-entry",
              JSON.stringify(storedEntry),
              "--json",
            ],
            {
              ...upgraded,
              stdin: [JSON.stringify(sections), JSON.stringify(main.dismissedNewModels)].join("\n"),
            },
          );
          // A first catalog read may change the profile between the list and
          // the update, which makes the update conflict: read it again.
          if (updated.code !== 0 && attempt < 5) return takeInModelA(attempt + 1);
          expect(updated.code, `${updated.stdout}\n${updated.stderr}`).toBe(0);
          return expectJson<ListedModelProfile>(updated);
        };
        const taken = await takeInModelA(1);
        const codexSection = taken.accounts.find(
          (section) => section.providerAccountId === codexAccount.id,
        );
        expect(codexSection?.newModels).toEqual([
          { model: "c", name: "C", firstSeenAt: SEEDED_CATALOG_SECOND_READ },
        ]);

        // The catalog the migration left still reads, with every model's
        // first-seen time from the old ledger.
        const catalog = expectJson<{
          models: ReadonlyArray<{ slug: string; firstSeenAt: string }>;
          readAt: string;
        }>(await runCli(["provider-account", "read-catalog", codexAccount.id, "--json"], upgraded));
        expect(catalog.models.map((one) => [one.slug, one.firstSeenAt])).toEqual([
          ["a", SEEDED_CATALOG_FIRST_READ],
          ["b", SEEDED_CATALOG_FIRST_READ],
          ["c", SEEDED_CATALOG_SECOND_READ],
        ]);
        expect(catalog.readAt).toBe(SEEDED_CATALOG_LAST_READ);
      } else {
        console.log(
          `Skipping the catalog first read fixture: the edge database has no catalog table, or already ran migration ${String(CATALOG_FIRST_READ_MIGRATION)}.`,
        );
      }

      expect(await controller.stop()).toBe(0);
      controller = undefined;
      if (catalogReadsSeeded) {
        // The first read is the earliest time of the ledger, or the last
        // read when the ledger is empty. The upgraded controller's later
        // reads leave it alone.
        const reader = new Database(join(home, "data", "hercule.db"), { readonly: true });
        try {
          const readFirstReadAt = (accountId: string) =>
            reader
              .query("SELECT first_read_at FROM model_catalogs WHERE provider_account_id = ?")
              .get(uuidBlob(accountId));
          expect(readFirstReadAt(codexAccount.id)).toEqual({
            first_read_at: SEEDED_CATALOG_FIRST_READ,
          });
          expect(readFirstReadAt(piAccount.id)).toEqual({
            first_read_at: SEEDED_CATALOG_LAST_READ,
          });
        } finally {
          reader.close();
        }
      }
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

      // What stayed on disk: the Z.ai key is still the account's `apiKey` and
      // nothing else is stored under an account owner, and the new column is
      // empty on every row.
      const accountReader = new Database(join(home, "data", "hercule.db"), { readonly: true });
      try {
        expect(
          accountReader
            .query(
              "SELECT owner_kind, owner_id, name FROM secrets WHERE owner_kind LIKE 'provider-%'",
            )
            .all(),
        ).toEqual([{ owner_kind: "provider-account", owner_id: piAccount.id, name: "apiKey" }]);
        expect(
          accountReader
            .query(
              "SELECT count(*) AS count FROM provider_accounts WHERE credential_expires_at IS NOT NULL",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        accountReader.close();
      }
    } finally {
      await controller?.stop().catch(() => -1);
    }
  }, 180_000);
});
