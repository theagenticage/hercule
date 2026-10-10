/** Verifies pre-change workspace and native-session associations through migration and public resume. */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { ALL_GRANTS, type Session, type Workspace } from "@hercule/contract";
import type { SessionStart, WorkspaceProvision } from "@hercule/protocol";
import { makeAttachmentCache } from "../../../../runner/src/attachments";
import { NO_CONTROLLER_UPLOADER } from "../../../../runner/src/providers/testing";
import { resolveSessionContext } from "../../../../runner/src/sessions/context";
import {
  makeTestWorkspaces,
  cleanTemporaries,
  createTemporaryDir,
  hashContents,
  makeRemote,
  runGitOrThrow,
} from "../../../../runner/src/workspaces/testing";
import { hashToken, mintToken } from "../../credentials";
import { binaryVersion, mintUuid, uuidFromString, uuidToString } from "../../db";
import { buildHomePaths, HerculeHome } from "../../config";
import { ControllerIdentity, controllerIdentityLayer } from "../../identity";
import { masterKeyLayer } from "../../secrets/masterKey";
import { secretsLayer } from "../../secrets/repository";
import { openDatabase } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { migrations } from "../../db/migrations";
import { get, post, PASSWORD, USERNAME } from "../../http/testing";
import { waitUntil } from "../../sessions/testing";
import { connectProofRunner, startControllerProcess } from "./transport.testing";

afterAll(cleanTemporaries);
const createFixtureId = (): string => uuidToString(mintUuid());
/** Records each path's mode and contents so shared Git additions cannot hide source changes. */
const readPaths = (root: string): ReadonlyMap<string, string> => {
  const paths = new Map<string, string>();
  for (const path of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const full = join(root, path);
    const stat = lstatSync(full);
    const contents = stat.isSymbolicLink()
      ? readlinkSync(full)
      : stat.isFile()
        ? readFileSync(full).toString("base64")
        : "directory";
    paths.set(path, `${String(stat.mode)}:${contents}`);
  }
  return paths;
};
const OLD = "2026-01-01T00:00:00.000Z";

const createLegacyInstallation = async () => {
  const home = createTemporaryDir("hercule-legacy-controller-home-");
  const storageDir = realpathSync(createTemporaryDir("hercule-legacy-runner-home-"));
  const remote = makeRemote();
  const resourceId = createFixtureId();
  const runnerId = createFixtureId();
  const instanceId = createFixtureId();
  const profileId = createFixtureId();
  const credential = mintToken();
  const token = mintToken();
  const userId = createFixtureId();
  const remoteUrl = `https://fixture.invalid/acme/${resourceId}`;
  const primaryId = createFixtureId();
  const ephemeralId = createFixtureId();
  const primary = join(storageDir, "primaries", resourceId);
  const cache = join(storageDir, "cache", `${resourceId}.git`);
  const ephemeral = join(storageDir, "workspaces", ephemeralId);
  mkdirSync(join(storageDir, "primaries"));
  mkdirSync(join(storageDir, "cache"));
  mkdirSync(join(storageDir, "workspaces"));
  runGitOrThrow(storageDir, "clone", remote.url, primary);
  runGitOrThrow(primary, "remote", "set-url", "origin", remoteUrl);
  runGitOrThrow(primary, "checkout", "-b", "legacy-local-only");
  writeFileSync(join(primary, "local.txt"), "standalone unpublished commit\n");
  runGitOrThrow(primary, "add", "local.txt");
  runGitOrThrow(primary, "commit", "-m", "Keep standalone local commit");
  writeFileSync(join(primary, "unfinished.txt"), "unfinished standalone work\n");
  runGitOrThrow(storageDir, "clone", "--bare", remote.url, cache);
  runGitOrThrow(cache, "remote", "set-url", "origin", remoteUrl);
  runGitOrThrow(cache, "worktree", "add", "-b", "legacy-cache-work", ephemeral, "main");
  writeFileSync(join(ephemeral, "cache-only.txt"), "cache-derived unpublished commit\n");
  runGitOrThrow(ephemeral, "add", "cache-only.txt");
  runGitOrThrow(ephemeral, "commit", "-m", "Keep cache-derived local commit");
  writeFileSync(join(ephemeral, "unfinished.txt"), "unfinished cache work\n");
  const entries = [
    {
      workspaceId: primaryId,
      kind: "primary",
      root: primary,
      checkouts: [{ checkoutId: createFixtureId(), resourceId, remote: remoteUrl, path: primary }],
    },
    {
      workspaceId: ephemeralId,
      kind: "ephemeral",
      root: ephemeral,
      checkouts: [
        { checkoutId: createFixtureId(), resourceId, remote: remoteUrl, path: ephemeral },
      ],
    },
  ];
  writeFileSync(join(storageDir, "workspaces.json"), JSON.stringify(entries));
  const sessions = entries.map((entry) => ({
    id: createFixtureId(),
    workspaceId: entry.workspaceId,
    cwd: entry.root,
    nativeSessionId: createFixtureId(),
  }));
  const providerHome = join(storageDir, "providers", instanceId);
  for (const session of sessions) {
    const directory = join(providerHome, "projects", session.cwd.replaceAll("/", "-"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${session.nativeSessionId}.jsonl`),
      `${JSON.stringify({ type: "user", sessionId: session.nativeSessionId, message: { role: "user", content: "Original provider transcript" } })}\n`,
    );
  }
  const database = join(home, "data", "hercule.db");
  mkdirSync(join(home, "data"));
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(migrations.filter(([id]) => id < 51));
      yield* sql`INSERT INTO users (id,username,password_hash,created_at,updated_at)
        VALUES (${uuidFromString(userId)},${USERNAME},${Bun.password.hashSync(PASSWORD, { algorithm: "argon2id", memoryCost: 1024, timeCost: 2 })},${OLD},${OLD})`;
      yield* sql`INSERT INTO login_tokens (id,user_id,token_hash,issued_at,expires_at,last_used_at)
        VALUES (${uuidFromString(createFixtureId())},${uuidFromString(userId)},${hashToken(token)},${OLD},'2030-01-01T00:00:00.000Z',${OLD})`;
      yield* sql`INSERT INTO setup_state (singleton,token_hash,completed_at) VALUES (1,null,${OLD})`;
      yield* sql`INSERT INTO runners (id,name,connectivity,lifecycle,reserved,labels,credential_hash,created_at,updated_at)
      VALUES (${uuidFromString(runnerId)},'legacy runner','offline','active',0,'[]',${hashToken(credential)},${OLD},${OLD})`;
      yield* sql`INSERT INTO permission_profiles (id,name,grants,shipped,created_at,updated_at)
      VALUES (${uuidFromString(profileId)},'legacy unrestricted',${JSON.stringify(ALL_GRANTS)},0,${OLD},${OLD})`;
      yield* sql`INSERT INTO provider_instances (id,provider_id,name,config,created_at,updated_at)
      VALUES (${uuidFromString(instanceId)},'claude-code','legacy provider','{}',${OLD},${OLD})`;
      yield* sql`INSERT INTO resources (id,kind,remote,canonical_remote,workspace_include,created_at,updated_at)
      VALUES (${uuidFromString(resourceId)},'repo',${remoteUrl},${`fixture.invalid/acme/${resourceId}`},1,${OLD},${OLD})`;
      for (const entry of entries) {
        yield* sql`INSERT INTO workspaces (id,runner_id,kind,status,created_at,provisioned_at,last_used_at)
        VALUES (${uuidFromString(entry.workspaceId)},${uuidFromString(runnerId)},${entry.kind},'ready',${OLD},${OLD},${OLD})`;
        yield* sql`INSERT INTO checkouts (id,workspace_id,resource_id,form,branch,branches,default_branch,position,created_at)
        VALUES (${uuidFromString(entry.checkouts[0]!.checkoutId)},${uuidFromString(entry.workspaceId)},${uuidFromString(resourceId)},${entry.kind === "primary" ? "clone" : "worktree"},${runGitOrThrow(entry.root, "branch", "--show-current")},${JSON.stringify([runGitOrThrow(entry.root, "branch", "--show-current")])},'main',0,${OLD})`;
      }
      for (const session of sessions) {
        const spec = {
          instanceId,
          workspaceId: session.workspaceId,
          modelSelection: { model: "fixture", options: {} },
          accessMode: "approval-required",
          timeouts: { inactivityMs: 60_000, absoluteMs: 60_000 },
        };
        yield* sql`INSERT INTO sessions (id,permission_profile_id,instance_id,runner_id,workspace_id,requested_access_mode,access_mode,spec,title,native_session_id,status,created_at,started_at,exited_at,last_activity_at,model_selection,agent_id,exit_reason)
        VALUES (${uuidFromString(session.id)},${uuidFromString(profileId)},${uuidFromString(instanceId)},${uuidFromString(runnerId)},${uuidFromString(session.workspaceId)},'approval-required','approval-required',${JSON.stringify(spec)},'Legacy human thread',${session.nativeSessionId},'exited',${OLD},${OLD},${OLD},${OLD},${JSON.stringify(spec.modelSelection)},null,'stopped')`;
        yield* sql`INSERT INTO workspace_leases (workspace_id,holder_kind,holder_id,acquired_at,released_at,retention,kept_until)
        VALUES (${uuidFromString(session.workspaceId)},'session',${uuidFromString(session.id)},${OLD},${OLD},'idle',${OLD})`;
        const event = {
          _tag: "session.started",
          eventId: createFixtureId(),
          sessionId: session.id,
          at: OLD,
          providerRefs: { nativeSessionId: session.nativeSessionId },
        };
        yield* sql`INSERT INTO session_stream (session_id,position,runner_seq,at,event)
        VALUES (${uuidFromString(session.id)},1,1,${OLD},${JSON.stringify(event)})`;
      }
    }).pipe(Effect.provide(openDatabase(database)), Effect.orDie),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* ControllerIdentity;
      yield* identity.ensure;
    }).pipe(
      Effect.provide(
        controllerIdentityLayer.pipe(
          Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
          Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
          Layer.provideMerge(openDatabase(database)),
        ),
      ),
      Effect.orDie,
    ),
  );
  const reader = new Database(database, { readonly: true });
  const before = {
    identity: reader.query("SELECT * FROM controller_identity").all(),
    sessions: reader.query("SELECT * FROM sessions ORDER BY id").all(),
    streams: reader.query("SELECT * FROM session_stream ORDER BY session_id").all(),
    checkouts: reader.query("SELECT * FROM checkouts ORDER BY id").all(),
    primaryPaths: readPaths(primary),
    primary: hashContents(primary),
    ephemeral: hashContents(ephemeral),
    provider: hashContents(providerHome),
    primaryHead: runGitOrThrow(primary, "rev-parse", "HEAD"),
    ephemeralHead: runGitOrThrow(ephemeral, "rev-parse", "HEAD"),
  };
  expect(
    reader.query("SELECT max(migration_id) AS version FROM effect_sql_migrations").get(),
  ).toEqual({ version: 50 });
  reader.close();
  return {
    home,
    storageDir,
    database,
    runnerId,
    resourceId,
    instanceId,
    credential,
    token,
    primaryId,
    ephemeralId,
    primary,
    ephemeral,
    cache,
    providerHome,
    sessions,
    before,
    gitEnv: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
      GIT_CONFIG_VALUE_0: remoteUrl,
    },
  };
};

const withLegacyController = async (
  body: (
    fixture: Awaited<ReturnType<typeof createLegacyInstallation>>,
    controller: Awaited<ReturnType<typeof startControllerProcess>>,
    wire: Awaited<ReturnType<typeof connectProofRunner>>,
    token: string,
  ) => Promise<void>,
) => {
  const fixture = await createLegacyInstallation();
  let controller = await startControllerProcess(fixture.home);
  let wire: Awaited<ReturnType<typeof connectProofRunner>> | undefined;
  try {
    // The controller owns SQLite exclusively. Stop it before examining the
    // migrated rows, then restart the same Home for the public resume proof.
    await controller.stop();
    const reader = new Database(fixture.database, { readonly: true });
    try {
      expect(
        reader.query("SELECT max(migration_id) AS version FROM effect_sql_migrations").get(),
      ).toEqual({ version: binaryVersion });
      expect(reader.query("SELECT * FROM controller_identity").all()).toEqual(
        fixture.before.identity,
      );
      expect(reader.query("SELECT * FROM sessions ORDER BY id").all()).toEqual(
        fixture.before.sessions,
      );
      expect(reader.query("SELECT * FROM session_stream ORDER BY session_id").all()).toEqual(
        fixture.before.streams,
      );
      expect(reader.query("SELECT * FROM checkouts ORDER BY id").all()).toEqual(
        fixture.before.checkouts.map((row) => ({
          ...(row as object),
          starting_revision: null,
          base_commit: null,
          head_commit: null,
          remote_branches: "[]",
        })),
      );
      expect(reader.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      reader.close();
    }
    controller = await startControllerProcess(fixture.home);
    const token = fixture.token;
    const manager = makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });
    wire = await connectProofRunner(
      controller.base,
      { credential: fixture.credential },
      { workspaces: manager, finishSessions: false },
    );
    await waitUntil("probed the retained provider instance", async () => {
      const providers = (await (
        await get(controller.base, "/api/v1/providers", token)
      ).json()) as ReadonlyArray<{ id: string; snapshots: ReadonlyArray<unknown> }>;
      return providers.find((provider) => provider.id === fixture.instanceId)?.snapshots.length ===
        1
        ? true
        : undefined;
    });
    await body(fixture, controller, wire, token);
  } finally {
    wire?.close();
    await controller.stop();
  }
};

describe("pre-change controller and provider-state upgrade", () => {
  it.each(["primary", "ephemeral"] as const)(
    "retains %s files, IDs and provider association through the real migration and public resume",
    async (kind) => {
      await withLegacyController(async (fixture, controller, wire, token) => {
        expect(hashContents(fixture.primary)).toBe(fixture.before.primary);
        expect(hashContents(fixture.ephemeral)).toBe(fixture.before.ephemeral);
        expect(hashContents(fixture.providerHome)).toBe(fixture.before.provider);
        const original = fixture.sessions[kind === "primary" ? 0 : 1]!;
        const workspaceResponse = await get(
          controller.base,
          `/api/v1/workspaces/${original.workspaceId}`,
          token,
        );
        expect(workspaceResponse.status).toBe(200);
        const workspace = (await workspaceResponse.json()) as Workspace;
        expect(workspace).toMatchObject({
          id: original.workspaceId,
          status: "ready",
          ownership: "managed",
          retentionPolicy: "manual",
          keptUntil: null,
        });
        expect(workspace.checkouts[0]!.form).toBe(kind === "primary" ? "clone" : "worktree");
        const beforeResume = (await (
          await get(controller.base, `/api/v1/sessions/${original.id}`, token)
        ).json()) as Session;
        expect(beforeResume).toMatchObject({
          id: original.id,
          workspaceId: original.workspaceId,
          runnerId: fixture.runnerId,
          instanceId: fixture.instanceId,
          status: "exited",
          resumable: true,
        });
        const resumed = await post(
          controller.base,
          `/api/v1/sessions/${original.id}/input`,
          { text: "Resume original provider state" },
          token,
        );
        expect(resumed.status, await resumed.clone().text()).toBe(200);
        const start = await waitUntil("sent the original native resume association", () =>
          wire.frames.find(
            (frame): frame is SessionStart =>
              frame._tag === "sessionStart" && frame.sessionId === original.id,
          ),
        );
        expect(start.spec).toMatchObject({
          instanceId: fixture.instanceId,
          workspaceId: original.workspaceId,
          continue: { nativeSessionId: original.nativeSessionId, mode: "resume" },
        });
        const manager = makeTestWorkspaces({
          storageDir: fixture.storageDir,
          gitEnv: fixture.gitEnv,
        });
        const context = await Effect.runPromise(
          resolveSessionContext(
            start,
            {
              providersDir: join(fixture.storageDir, "providers"),
              scratchDir: join(fixture.storageDir, "scratch"),
              attachmentsDir: join(fixture.storageDir, "attachments"),
              attachmentUploader: NO_CONTROLLER_UPLOADER,
              attachments: makeAttachmentCache({
                controllerUrl: "https://controller.example:4938",
                credential: "test",
              }),
              binDir: join(fixture.storageDir, "bin"),
              herculeTool: {
                skill: "# fixture",
                claudePluginDir: join(fixture.storageDir, "claude-plugin"),
              },
              controllerUrl: controller.base,
              baseEnv: { PATH: process.env["PATH"] ?? "" },
              findBinary: () => "/fixture/claude",
              workspaces: manager,
              socketPath: join(fixture.storageDir, "credential.sock"),
            },
            "claude",
          ),
        );
        expect(context.ctx.cwd).toBe(original.cwd);
        expect(context.ctx.home).toBe(fixture.providerHome);
        expect(context.scratch).toBeUndefined();
        expect(hashContents(fixture.primary)).toBe(fixture.before.primary);
        expect(hashContents(fixture.ephemeral)).toBe(fixture.before.ephemeral);
        expect(hashContents(fixture.providerHome)).toBe(fixture.before.provider);
        expect(runGitOrThrow(fixture.primary, "rev-parse", "HEAD")).toBe(
          fixture.before.primaryHead,
        );
        expect(runGitOrThrow(fixture.ephemeral, "rev-parse", "HEAD")).toBe(
          fixture.before.ephemeralHead,
        );
        expect(
          runGitOrThrow(
            fixture.ephemeral,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ),
        ).toBe(fixture.cache);
        expect(existsSync(join(fixture.primary, ".git", "objects"))).toBe(true);
      });
    },
    30_000,
  );

  it("creates new local work from the bound standalone main after migration while retaining the old cache worktree", async () => {
    await withLegacyController(async (fixture, controller, wire, token) => {
      const spawned = await post(
        controller.base,
        "/api/v1/sessions",
        {
          prompt: "Use unpublished standalone source",
          runnerId: fixture.runnerId,
          instanceId: fixture.instanceId,
          workspace: {
            kind: "ephemeral",
            checkouts: [
              {
                resourceId: fixture.resourceId,
                startingRevision: { kind: "local", branch: "legacy-local-only" },
              },
            ],
          },
        },
        token,
      );
      expect(spawned.status, await spawned.clone().text()).toBe(200);
      const session = (await spawned.json()) as Session;
      const instruction = await waitUntil(
        "received new local work bound to the legacy primary",
        () =>
          wire.frames.find(
            (frame): frame is WorkspaceProvision =>
              frame._tag === "workspaceProvision" && frame.workspaceId === session.workspaceId,
          ),
      );
      expect(instruction.checkouts[0]!.repositoryWorkspaceId).toBe(fixture.primaryId);
      const manager = makeTestWorkspaces({
        storageDir: fixture.storageDir,
        gitEnv: fixture.gitEnv,
      });
      const prepared = await Effect.runPromise(manager.provision(instruction));
      expect(prepared.status, prepared.message).toBe("ready");
      wire.write(prepared);
      const cwd = Effect.runSync(manager.resolve(instruction.workspaceId))!.cwd;
      expect(runGitOrThrow(cwd, "rev-parse", "HEAD")).toBe(fixture.before.primaryHead);
      expect(runGitOrThrow(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(
        runGitOrThrow(fixture.primary, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      );
      expect(
        runGitOrThrow(fixture.ephemeral, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      ).toBe(fixture.cache);
      const actualPaths = readPaths(fixture.primary);
      for (const [path, contents] of fixture.before.primaryPaths) {
        expect(actualPaths.get(path), `Preserve original source path ${path}`).toBe(contents);
      }
      // A new worktree adds its own registration and generated branch to the shared Git directory.
      const branch = runGitOrThrow(cwd, "branch", "--show-current");
      const gitDirectory = relative(
        fixture.primary,
        runGitOrThrow(cwd, "rev-parse", "--absolute-git-dir"),
      );
      const addedPaths = [...actualPaths.keys()].filter(
        (path) => !fixture.before.primaryPaths.has(path),
      );
      const branchPaths = [`.git/refs/heads/${branch}`, `.git/logs/refs/heads/${branch}`];
      for (const path of addedPaths) {
        expect(
          path === gitDirectory ||
            path.startsWith(`${gitDirectory}/`) ||
            gitDirectory.startsWith(`${path}/`) ||
            branchPaths.some((allowed) => allowed === path || allowed.startsWith(`${path}/`)),
          `Only add this worktree's registration and branch: ${path}`,
        ).toBe(true);
      }
      expect(runGitOrThrow(fixture.primary, "rev-parse", "HEAD")).toBe(fixture.before.primaryHead);
      expect(hashContents(fixture.ephemeral)).toBe(fixture.before.ephemeral);
      expect(hashContents(fixture.providerHome)).toBe(fixture.before.provider);
    });
  }, 30_000);
});
