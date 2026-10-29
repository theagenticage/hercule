/**
 * Tests for the Codex adapter's probe, install, sessions and the isolation it
 * starts an app-server with, run against a scripted app-server. No Codex code
 * runs. The scripted replies use the shapes captured from codex 0.154.0, not
 * invented ones.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Logger, Stream } from "effect";
import { TestClock } from "effect/testing";
import { CODEX_VERSION } from "@hercule/home/version";
import {
  HarnessLoginMissing,
  HarnessNotInstalled,
  HarnessProtocolError,
  InputNotDelivered,
  SessionNotRunning,
  SteerRefused,
  AdapterFailed,
} from "@hercule/protocol";
import type { OutputSchema, ProbeResult, ProviderEvent, SessionSpec } from "@hercule/protocol";
import { SESSION_MARKS_DIR_VARIABLE, takeStartMarks } from "../../edit-marks";
import type { EditMarks, ProviderRunnerContext } from "../index";
import { INSTALL_DEADLINE } from "../install";
import { makeCodexAdapter, CONTROL_DEADLINE, type CodexSeam } from "./adapter";
import { RPC_DEADLINE } from "./rpc";
import { PROBE_DEADLINE } from "../probe";
import {
  METADATA_DEADLINE,
  MAX_PENDING_FRAMES,
  MAX_PENDING_BYTES,
  MAX_PENDING_THREADS,
} from "./threads";
import { NO_USER_MATERIAL_PATHS, writeTestImage } from "../testing";
import type { ResolvedSkillReference } from "../../skills/references";
import {
  computeSubagentAfter,
  createBareSubagent,
} from "../../../../controller/src/sessions/subagents";
import {
  API_KEY,
  type Answers,
  CHATGPT,
  cleanupHomes,
  buildContext,
  CWD,
  createDriving,
  FORKED,
  createCodexHome,
  INITIALIZE,
  LOGGED_OUT,
  PRIOR,
  RESUMED,
  buildRefusal,
  buildScriptedSeam,
  SESSION,
  listSentParams,
  settle,
  SILENT,
  SPEC,
  startTestSession,
  startBusySession,
  filterByTag,
  THREAD,
  TURN,
  waitUntil,
  type Spawn,
} from "./testing";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));

afterAll(cleanupHomes);

const runProbe = (
  answers: Answers = {},
  options: { readonly dies?: boolean } = {},
): {
  readonly result: Promise<ProbeResult>;
  readonly spawns: Array<Spawn>;
  readonly home: string;
} => {
  const home = createCodexHome();
  // A probe test starts from a machine with no login, unlike a session test.
  const { seam, spawns } = buildScriptedSeam(
    { "account/read": () => LOGGED_OUT, ...answers },
    options,
  );
  return {
    result: Effect.runPromise(makeCodexAdapter(seam).probe(buildContext(home), {})),
    spawns,
    home,
  };
};

const findModelOption = (
  models: ProbeResult["models"],
  slug: string,
  id: string,
): Record<string, unknown> | undefined =>
  models.find((model) => model.slug === slug)?.options.find((option) => option.id === id);

const listChoiceValues = (option: Record<string, unknown> | undefined): ReadonlyArray<string> =>
  ((option?.["choices"] ?? []) as ReadonlyArray<{ readonly value: string }>).map(
    (choice) => choice.value,
  );

describe("what the Codex adapter reports about a machine", () => {
  it("parses the harness version from the user agent, because initialize has no version field", async () => {
    const { result } = runProbe();

    const probed = await result;
    expect(probed.harnessVersion).toBe("0.154.0");
  });

  it("reports no version when the user agent has none", async () => {
    const { result } = runProbe({ initialize: () => ({ ...INITIALIZE, userAgent: "codex" }) });

    const probed = await result;
    // Null rather than a guess: `computeVersionVerdict` treats null as "unknown".
    expect(probed.harnessVersion).toBeNull();
    expect(probed.auth.status).toBe("unauthenticated");
  });

  it("reports a logged-out machine as unauthenticated, with no identity", async () => {
    const { result } = runProbe();

    const probed = await result;
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.auth.message).toBeUndefined();
    // The model list is still reported: `model/list` works while logged out.
    expect(probed.models).not.toEqual([]);
  });

  it("reports the ChatGPT account's email, plan and backend", async () => {
    const { result } = runProbe({ "account/read": () => CHATGPT });

    const probed = await result;
    expect(probed.auth).toMatchObject({
      status: "ok",
      identity: "rogier@example.com",
      planLabel: "pro",
      backend: "chatgpt",
    });
  });

  it("reports an API key login as logged in, with no identity", async () => {
    const { result } = runProbe({ "account/read": () => API_KEY });

    const probed = await result;
    expect(probed.auth.status).toBe("ok");
    expect(probed.auth.backend).toBe("apiKey");
    expect(probed.auth.identity).toBeUndefined();
  });

  it("maps each model to its slug, its name, and only the options it supports", async () => {
    const { result } = runProbe();

    const probed = await result;
    expect(probed.models.map((model) => model.slug)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.5",
    ]);
    expect(probed.models[0]).toMatchObject({ slug: "gpt-6-astra", name: "GPT-6-Astra" });
    expect(probed.models[0]?.isDefault).toBe(true);
    expect(probed.models[1]?.isDefault ?? false).toBe(false);

    const effort = findModelOption(probed.models, "gpt-6-astra", "effort");
    expect(effort).toMatchObject({ kind: "select", default: "low" });
    expect(listChoiceValues(effort)).toEqual(["low", "medium", "high"]);
    expect(listChoiceValues(findModelOption(probed.models, "gpt-5.5", "effort"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // A model the server lists no efforts for offers no effort choice.
    expect(findModelOption(probed.models, "gpt-5.6-sol", "effort")).toBeUndefined();

    // `serviceTiers` lists only the extra tiers, and `defaultServiceTier: null`
    // means the standard one. So Hercule adds the standard tier as a choice,
    // and makes it the default when Codex gives none. Otherwise every turn
    // would run on a paid tier nobody chose.
    expect(findModelOption(probed.models, "gpt-6-astra", "serviceTier")).toMatchObject({
      kind: "select",
      default: "standard",
    });
    expect(listChoiceValues(findModelOption(probed.models, "gpt-6-astra", "serviceTier"))).toEqual([
      "standard",
      "priority",
    ]);
    expect(listChoiceValues(findModelOption(probed.models, "gpt-5.6-sol", "serviceTier"))).toEqual([
      "standard",
      "priority",
      "ultrafast",
    ]);
    // Offered only when the server lists tiers: an empty select would be useless.
    expect(findModelOption(probed.models, "gpt-5.5", "serviceTier")).toBeUndefined();
  });

  it("takes images only on a model that lists image input, with no limit of its own", async () => {
    const { result } = runProbe();

    const probed = await result;
    expect(probed.models.map((model) => [model.slug, model.imageInput])).toEqual([
      ["gpt-6-astra", { maxBytes: null }],
      // No `inputModalities`, as an older app-server sends: text only.
      ["gpt-5.6-sol", null],
      ["gpt-5.5", null],
    ]);
  });

  it("reports an app-server that exits before replying to initialize as an error, not as a blank row", async () => {
    const { result } = runProbe({ initialize: SILENT }, { dies: true });

    const probed = await result;
    expect(probed.harnessVersion).toBeNull();
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message ?? "").not.toBe("");
    expect(probed.models).toEqual([]);
  });

  it("fails the probe of an app-server that never replies, and includes the timeout in the message", async () => {
    const home = createCodexHome();
    // A running child that never replies, which is what the timeout is for:
    // a child that exits is already reported when its stream ends.
    const { seam, spawns } = buildScriptedSeam({ initialize: SILENT });

    const probed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(
            makeCodexAdapter(seam).probe(buildContext(home), {}),
          );
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(PROBE_DEADLINE);
          return yield* Fiber.join(running);
        }),
        TestClock.layer(),
      ),
    );

    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message ?? "").toContain(Duration.format(PROBE_DEADLINE));
    expect(probed.models).toEqual([]);
    // The child belongs to the probe, so the probe kills it when it gives up.
    expect(spawns[0]?.kills()).toBe(1);
  });
});

describe("the process a probe runs on", () => {
  it("kills its own app-server, so a probe leaves nothing running", async () => {
    const { result, spawns } = runProbe();
    await result;

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.kills()).toBe(1);
  });

  it("starts a new app-server for a second probe, and for a session after a probe", async () => {
    const home = createCodexHome();
    const { seam, spawns } = buildScriptedSeam();
    const adapter = makeCodexAdapter(seam);
    const ctx = buildContext(home);

    await Effect.runPromise(adapter.probe(ctx, {}));
    await Effect.runPromise(adapter.probe(ctx, {}));
    expect(spawns).toHaveLength(2);

    const started = Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx)).then(
      () => undefined,
      () => undefined,
    );
    await waitUntil("spawned a third app-server", () => spawns.length === 3);
    // A session never uses a probe's app-server, which has already been killed.
    expect(spawns[2]?.kills()).toBe(0);
    await started;
  });

  it("does not keep a host whose initialize failed, and kills its child", async () => {
    const home = createCodexHome();
    let attempts = 0;
    const { seam, spawns } = buildScriptedSeam({
      initialize: () => {
        attempts += 1;
        return attempts === 1
          ? buildRefusal("the app-server could not start a session")
          : INITIALIZE;
      },
    });
    const adapter = makeCodexAdapter(seam);
    const ctx = buildContext(home);

    const refused = await Effect.runPromise(Effect.flip(adapter.startSession(SESSION, SPEC, ctx)));

    expect(refused).toBeInstanceOf(HarnessProtocolError);
    expect(refused.message).toContain("could not start a session");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.kills()).toBe(1);

    // If the failed host were kept under the session id, the next start
    // would reuse a host that cannot be used.
    const binding = await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));
    expect(binding.nativeSessionId).toBe(THREAD);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.kills()).toBe(0);
  });
});

describe("the home directories a session's app-server gets", () => {
  it("starts the app-server with the updater off and its own Codex and HOME directories, for a session that is not a Thread", async () => {
    const home = createCodexHome();
    const { seam, spawns } = buildScriptedSeam();
    const ctx = buildContext(home);

    const started = Effect.runPromise(makeCodexAdapter(seam).startSession(SESSION, SPEC, ctx)).then(
      () => undefined,
      () => undefined,
    );
    await waitUntil("spawned an app-server", () => spawns.length === 1);

    const spawn = spawns[0]!;
    expect(spawn.command).toEqual([
      ctx.binary,
      "app-server",
      "--strict-config",
      "-c",
      "check_for_update_on_startup=false",
    ]);

    const codexHome = join(home, "codex");
    const neutral = join(home, "home");
    expect(spawn.env["CODEX_HOME"]).toBe(codexHome);
    // Moved, because CODEX_HOME alone does not isolate skills: Codex reads
    // them from `.agents/skills` in the user's own home directory.
    expect(spawn.env["HOME"]).toBe(neutral);
    expect(existsSync(codexHome)).toBe(true);
    expect(existsSync(neutral)).toBe(true);
    expect(statSync(codexHome).mode & 0o777).toBe(0o700);
    expect(statSync(neutral).mode & 0o777).toBe(0o700);
    expect(readdirSync(neutral)).toEqual([]);
    for (const [key, value] of Object.entries(ctx.env)) {
      if (key === "HOME") continue;
      expect(spawn.env[key]).toBe(value);
    }
    await started;
  });

  it("turns automatic compaction off with arguments of the session's own app-server when the spec asks for it", async () => {
    const home = createCodexHome();
    const { seam, spawns } = buildScriptedSeam();
    const ctx = buildContext(home);

    const started = Effect.runPromise(
      makeCodexAdapter(seam).startSession(SESSION, { ...SPEC, autoCompaction: false }, ctx),
    ).then(
      () => undefined,
      () => undefined,
    );
    await waitUntil("spawned an app-server", () => spawns.length === 1);

    // The scope matters: in the default scope Codex caps the limit at 90% of
    // the context window, so the limit alone would change nothing.
    expect(spawns[0]?.command).toEqual([
      ctx.binary,
      "app-server",
      "--strict-config",
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      "model_auto_compact_token_limit_scope=body_after_prefix",
      "-c",
      "model_auto_compact_token_limit=9223372036854775807",
    ]);
    // Never written into the instance's config, which every session reads.
    expect(existsSync(join(home, "codex", "config.toml"))).toBe(false);
    await started;
  });

  it("installs the gate's hook in a session with an edit watch, trusted by its hash alone, and tells it the marks directory", async () => {
    const home = createCodexHome();
    const { seam, spawns } = buildScriptedSeam();
    const editMarks: EditMarks = {
      sessionMarksDir: "/var/hercule/runner/edit-marks/sessions/one",
      recordToolStart: () => {},
      recordProcessStart: () => {},
      recordProcessEnd: () => {},
      recordRequestOnRunningItem: () => {},
    };

    await Effect.runPromise(
      makeCodexAdapter(seam).startSession(SESSION, SPEC, { ...buildContext(home), editMarks }),
    );

    const spawn = spawns[0]!;
    const overrides = spawn.command.slice(5);
    expect(overrides).toHaveLength(4);
    expect(overrides[1]).toMatch(/^hooks\.PreToolUse=\[\{matcher="Bash\|apply_patch", hooks=/);
    // One trust entry, for this hook's key: the user's own hooks stay as
    // their settings make them, which `bypass_hook_trust` would not.
    expect(overrides[3]).toMatch(
      /^hooks\.state=\{"\/<session-flags>\/config\.toml:pre_tool_use:0:0"=\{trusted_hash="sha256:[0-9a-f]{64}"\}\}$/,
    );
    expect(spawn.command.join(" ")).not.toContain("bypass_hook_trust");
    expect(spawn.env[SESSION_MARKS_DIR_VARIABLE]).toBe(editMarks.sessionMarksDir);
  });

  describe("the gate's hook", () => {
    /** Starts a session with an edit watch and returns the hook's command and the hash it is trusted by. */
    const readHook = async () => {
      const { seam, spawns } = buildScriptedSeam();
      const editMarks: EditMarks = {
        sessionMarksDir: "/var/hercule/runner/edit-marks/sessions/one",
        recordToolStart: () => {},
        recordProcessStart: () => {},
        recordProcessEnd: () => {},
        recordRequestOnRunningItem: () => {},
      };
      await Effect.runPromise(
        makeCodexAdapter(seam).startSession(SESSION, SPEC, {
          ...buildContext(createCodexHome()),
          editMarks,
        }),
      );
      const overrides = spawns[0]!.command.slice(5);
      return {
        command: JSON.parse(/command=(".*"), timeout=10/.exec(overrides[1]!)![1]!) as string,
        trustedHash: /trusted_hash="(.*)"/.exec(overrides[3]!)![1],
      };
    };

    /** Runs the hook's command the way Codex does, with one line of hook input on stdin. */
    const runHook = (command: string, sessionMarksDir: string) =>
      Bun.spawnSync(["/bin/sh", "-c", command], {
        env: { [SESSION_MARKS_DIR_VARIABLE]: sessionMarksDir },
        stdin: new TextEncoder().encode('{"tool_use_id":"call-1"}\n'),
      });

    it("writes the call's mark and exits 0 with nothing on stdout", async () => {
      const { command } = await readHook();
      const dir = createCodexHome();
      const result = runHook(command, dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(takeStartMarks(dir).map(({ toolUseId }) => toolUseId)).toEqual(["call-1"]);
    });

    it("lets the call run, exiting 0 with nothing on stdout, when the mark cannot be written", async () => {
      const { command } = await readHook();
      const dir = createCodexHome();
      chmodSync(dir, 0o500);
      const result = runHook(command, dir);
      chmodSync(dir, 0o700);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(takeStartMarks(dir)).toEqual([]);
    });

    it("is trusted by the hash Codex computes for it", async () => {
      // Codex 0.154.0 hashes the hook's matcher and handler as canonical
      // JSON, with the keys sorted (codex-rs/hooks/src/engine/discovery.rs).
      const { command, trustedHash } = await readHook();
      const identity = JSON.stringify({
        event_name: "pre_tool_use",
        hooks: [{ async: false, command, timeout: 10, type: "command" }],
        matcher: "Bash|apply_patch",
      });
      expect(trustedHash).toBe(`sha256:${createHash("sha256").update(identity).digest("hex")}`);
    });
  });

  it("moves HOME for a Thread that sees the user's material too, and gives it the instance's own CODEX_HOME", async () => {
    const home = createCodexHome();
    const { seam, spawns } = buildScriptedSeam();
    const ctx: ProviderRunnerContext = {
      ...buildContext(home),
      env: { ...buildContext(home).env, HOME: "/Users/someone" },
      userMaterial: NO_USER_MATERIAL_PATHS,
    };

    await Effect.runPromise(makeCodexAdapter(seam).startSession(SESSION, SPEC, ctx));

    const spawn = spawns[0]!;
    // Under the real HOME, Codex would load the user's `.agents/skills` beside
    // the Skill Library's skills of the same name.
    expect(spawn.env["HOME"]).toBe(join(home, "home"));
    const codexHome = join(home, "codex");
    expect(spawn.env["CODEX_HOME"]).toBe(codexHome);
    // Codex reads an `AGENTS.md` in its home for every session of the
    // instance, so the user's instructions must never be placed there.
    expect(readdirSync(codexHome)).toEqual([]);
  });

  it("runs a Thread's commands in the user's real HOME, and no other session's", async () => {
    const startWith = async (userMaterial: ProviderRunnerContext["userMaterial"]) => {
      const home = createCodexHome();
      const { seam, spawns } = buildScriptedSeam();
      const ctx = buildContext(home);
      await Effect.runPromise(
        makeCodexAdapter(seam).startSession(SESSION, SPEC, {
          ...ctx,
          env: { ...ctx.env, HOME: '/Users/some "one"' },
          ...(userMaterial === undefined ? {} : { userMaterial }),
        }),
      );
      return spawns[0]!.command;
    };

    // The quotes in the path are escaped, so the value still parses as TOML.
    expect((await startWith(NO_USER_MATERIAL_PATHS)).slice(-2)).toEqual([
      "-c",
      'shell_environment_policy.set.HOME="/Users/some \\"one\\""',
    ]);
    expect((await startWith(undefined)).join(" ")).not.toContain("shell_environment_policy");
  });
});

describe("what a Codex session tells the edit watch", () => {
  it("names each command approval with its own approval id as a Request on a running item", async () => {
    const run = createDriving();
    const onRunningItems: Array<string> = [];
    const editMarks: EditMarks = {
      sessionMarksDir: "/var/hercule/runner/edit-marks/sessions/one",
      recordToolStart: () => {},
      recordProcessStart: () => {},
      recordProcessEnd: () => {},
      recordRequestOnRunningItem: (requestId) => void onRunningItems.push(requestId),
    };
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, { ...run.ctx, editMarks }));
    const server = run.spawns[0]!;
    // The first asks before its command runs. The second asks about input
    // written to a command that already runs, so Codex gives it an approval id.
    server.push({
      id: "before-run",
      method: "item/commandExecution/requestApproval",
      params: { threadId: THREAD, turnId: TURN, itemId: "c-1", command: "ls" },
    });
    server.push({
      id: "while-running",
      method: "item/commandExecution/requestApproval",
      params: { threadId: THREAD, turnId: TURN, itemId: "c-2", approvalId: "a-1", command: "y" },
    });
    await waitUntil(
      "opened both Requests",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );

    const opened = filterByTag(run.seen, "request.opened");
    expect(onRunningItems).toEqual([opened[1]!.request.requestId]);
  });
});

describe("the session's skills from the Skill Library", () => {
  const SESSION_SKILLS_FOLDER = "/var/hercule/runner/skills/session-one";

  it("names the session skills folder to every new app-server, after initialize and before the thread opens", async () => {
    const { adapter, ctx, requests, spawns } = createDriving();
    const withSkills = { ...ctx, librarySkillsFolder: SESSION_SKILLS_FOLDER };

    await Effect.runPromise(adapter.startSession(SESSION, SPEC, withSkills));
    await Effect.runPromise(adapter.stopSession(SESSION, "stopped"));
    const resumed: SessionSpec = { ...SPEC, continue: { nativeSessionId: THREAD, mode: "resume" } };
    await Effect.runPromise(adapter.startSession(SESSION, resumed, withSkills));

    // The app-server keeps the roots in memory only, so the resume's new
    // process needs them again.
    expect(spawns).toHaveLength(2);
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "account/read",
      "skills/extraRoots/set",
      "thread/start",
      "initialize",
      "account/read",
      "skills/extraRoots/set",
      "thread/resume",
    ]);
    expect(listSentParams(requests, "skills/extraRoots/set")).toEqual([
      { extraRoots: [join(SESSION_SKILLS_FOLDER, "skills")] },
      { extraRoots: [join(SESSION_SKILLS_FOLDER, "skills")] },
    ]);
  });

  it("names the repository skills folders after the session skills folder, in one request", async () => {
    const { adapter, ctx, requests } = createDriving();
    const repositorySkillsFolders = [
      "/var/hercule/runner/skills/repo-api",
      "/var/hercule/runner/skills/repo-web",
    ];

    await Effect.runPromise(
      adapter.startSession(SESSION, SPEC, {
        ...ctx,
        librarySkillsFolder: SESSION_SKILLS_FOLDER,
        repositorySkillsFolders,
      }),
    );

    expect(listSentParams(requests, "skills/extraRoots/set")).toEqual([
      {
        extraRoots: [
          join(SESSION_SKILLS_FOLDER, "skills"),
          ...repositorySkillsFolders.map((folder) => join(folder, "skills")),
        ],
      },
    ]);
  });

  it("names the repository skills folders for a session without a session skills folder", async () => {
    const { adapter, ctx, requests } = createDriving();
    const repositorySkillsFolders = ["/var/hercule/runner/skills/repo-api"];

    await Effect.runPromise(
      adapter.startSession(SESSION, SPEC, { ...ctx, repositorySkillsFolders }),
    );

    expect(listSentParams(requests, "skills/extraRoots/set")).toEqual([
      { extraRoots: [join(repositorySkillsFolders[0]!, "skills")] },
    ]);
  });

  it("names no skill roots for a session without a session skills folder", async () => {
    const { adapter, ctx, requests } = createDriving();

    await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    expect(listSentParams(requests, "skills/extraRoots/set")).toEqual([]);
  });

  it("refuses the start and kills the app-server when Codex refuses the skills folders", async () => {
    const { adapter, ctx, requests, spawns } = createDriving({
      "skills/extraRoots/set": () =>
        buildRefusal("Invalid request: AbsolutePathBuf deserialized without a base path"),
    });

    const refused = await Effect.runPromise(
      Effect.flip(
        adapter.startSession(SESSION, SPEC, { ...ctx, librarySkillsFolder: SESSION_SKILLS_FOLDER }),
      ),
    );

    // The app-server answered and refused, so the failure is not about the connection.
    expect(refused).toBeInstanceOf(AdapterFailed);
    expect(refused.message).toContain("skills folders");
    expect(refused.message).toContain("AbsolutePathBuf deserialized without a base path");
    // A session without its skills would run without saying so.
    expect(listSentParams(requests, "thread/start")).toEqual([]);
    expect(spawns[0]?.kills()).toBe(1);
    expect(await Effect.runPromise(adapter.listSessions)).toEqual([]);
  });

  it("reports Codex's refusal of the session skills folder, not an unrelated line on its stderr", async () => {
    const run = createDriving({
      "skills/extraRoots/set": () => {
        run.spawns[0]!.complain("WARN codex_core::config: an unrelated warning");
        return buildRefusal("Invalid request: AbsolutePathBuf deserialized without a base path");
      },
    });

    const refused = await Effect.runPromise(
      Effect.flip(
        run.adapter.startSession(SESSION, SPEC, {
          ...run.ctx,
          librarySkillsFolder: SESSION_SKILLS_FOLDER,
        }),
      ),
    );

    expect(refused.message).toContain("AbsolutePathBuf deserialized without a base path");
    expect(refused.message).not.toContain("an unrelated warning");
  });
});

describe("a session that cannot start", () => {
  it("fails with HarnessNotInstalled when the runner has no Codex binary", async () => {
    const { adapter, ctx, spawns } = createDriving();

    const refused = await Effect.runPromise(
      Effect.flip(adapter.startSession(SESSION, SPEC, { ...ctx, binary: undefined })),
    );

    expect(refused).toBeInstanceOf(HarnessNotInstalled);
    expect(refused.message).toContain("not installed");
    expect(spawns).toEqual([]);
  });

  it("fails with HarnessNotInstalled when spawning a binary that does not exist fails with ENOENT", async () => {
    const seam: CodexSeam = {
      appServer: () => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      },
      run: () => Effect.die("a session must not run a command"),
    };
    const home = createCodexHome();
    const ctx = { ...buildContext(home), binary: join(home, "no-such-codex") };

    const refused = await Effect.runPromise(
      Effect.flip(makeCodexAdapter(seam).startSession(SESSION, SPEC, ctx)),
    );

    expect(refused).toBeInstanceOf(HarnessNotInstalled);
  });

  it("says Codex is installed but cannot run when ENOENT comes for a binary that exists", async () => {
    // A launcher script whose interpreter is missing fails like this.
    const seam: CodexSeam = {
      appServer: () => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      },
      run: () => Effect.die("a session must not run a command"),
    };
    const ctx = { ...buildContext(createCodexHome()), binary: process.execPath };

    const refused = await Effect.runPromise(
      Effect.flip(makeCodexAdapter(seam).startSession(SESSION, SPEC, ctx)),
    );

    expect(refused._tag).toBe("AdapterFailed");
    expect(refused.message).toContain("installed");
    expect(refused.message).toContain("PATH");
  });

  it("fails with AdapterFailed when spawning fails for another reason, or the home cannot be prepared", async () => {
    const seam: CodexSeam = {
      appServer: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      run: () => Effect.die("a session must not run a command"),
    };
    const ctx = buildContext(createCodexHome());
    // The instance home is a file, so creating the `codex` folder in it fails with ENOTDIR.
    const file = join(createCodexHome(), "not-a-folder");
    writeFileSync(file, "");

    const cannotSpawn = await Effect.runPromise(
      Effect.flip(makeCodexAdapter(seam).startSession(SESSION, SPEC, ctx)),
    );
    const cannotPrepare = await Effect.runPromise(
      Effect.flip(makeCodexAdapter(seam).startSession(SESSION, SPEC, { ...ctx, home: file })),
    );

    expect(cannotSpawn).toBeInstanceOf(AdapterFailed);
    expect(cannotSpawn.message).toContain("permission denied");
    expect(cannotPrepare).toBeInstanceOf(AdapterFailed);
  });

  it("fails with HarnessLoginMissing and stops the app-server when Codex has no account", async () => {
    const { adapter, ctx, requests, spawns } = createDriving({
      "account/read": () => LOGGED_OUT,
    });

    const refused = await Effect.runPromise(Effect.flip(adapter.startSession(SESSION, SPEC, ctx)));

    expect(refused).toBeInstanceOf(HarnessLoginMissing);
    expect(refused.message).toContain("not logged in");
    // The app-server must not be left running for a session that never started.
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.kills()).toBe(1);
    expect(listSentParams(requests, "thread/start")).toEqual([]);
    expect(await Effect.runPromise(adapter.listSessions)).toEqual([]);
  });

  it("starts with an API key login, which Codex reports as an account", async () => {
    const { adapter, ctx } = createDriving({ "account/read": () => API_KEY });

    const binding = await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    expect(binding.nativeSessionId).toBe(THREAD);
  });

  it("starts without an account when Codex says its model provider needs no login", async () => {
    const { adapter, ctx } = createDriving({
      "account/read": () => ({ account: null, requiresOpenaiAuth: false }),
    });

    const binding = await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    expect(binding.nativeSessionId).toBe(THREAD);
  });

  it("fails with HarnessProtocolError when the app-server never answers account/read", async () => {
    const { adapter, ctx, spawns } = createDriving({ "account/read": SILENT });

    const refused = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const starting = yield* Effect.forkChild(
            Effect.flip(adapter.startSession(SESSION, SPEC, ctx)),
          );
          yield* Effect.promise(() => settle());
          yield* TestClock.adjust(RPC_DEADLINE);
          return yield* Fiber.join(starting);
        }),
        TestClock.layer(),
      ),
    );

    expect(refused).toBeInstanceOf(HarnessProtocolError);
    expect(spawns[0]?.kills()).toBe(1);
  });
});

describe("the thread a session gets", () => {
  it("starts a thread in the session's directory, with its model and access mode", async () => {
    const { adapter, ctx, requests, seen } = createDriving();

    const binding = await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    expect(binding).toEqual({
      sessionId: SESSION,
      nativeSessionId: THREAD,
      instanceId: SPEC.instanceId,
    });
    expect(listSentParams(requests, "thread/start")).toHaveLength(1);
    expect(listSentParams(requests, "thread/start")[0]).toMatchObject({
      cwd: CWD,
      model: "gpt-5.5",
      ephemeral: false,
      // The Codex settings for `approval-required`.
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    await waitUntil(
      "said the session started",
      () => filterByTag(seen, "session.started").length === 1,
    );
    await settle();
    expect(filterByTag(seen, "session.started")).toHaveLength(1);
  });

  it("continues a native thread by resuming it by id", async () => {
    const { adapter, ctx, requests } = createDriving();
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } };

    const binding = await Effect.runPromise(adapter.startSession(SESSION, spec, ctx));

    expect(listSentParams(requests, "thread/resume")).toEqual([
      expect.objectContaining({ threadId: PRIOR }),
    ]);
    expect(listSentParams(requests, "thread/start")).toEqual([]);
    expect(binding.nativeSessionId).toBe(RESUMED);
  });

  it("counts a resumed thread's usage from the restored report Codex sends right after the reply", async () => {
    const buildUsageReport = (
      total: readonly [number, number],
      last: readonly [number, number],
    ): Record<string, unknown> => {
      const buildBreakdown = ([input, output]: readonly [number, number]) => ({
        totalTokens: input + output,
        inputTokens: input,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: 0,
      });
      return {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: RESUMED,
          turnId: TURN,
          tokenUsage: {
            total: buildBreakdown(total),
            last: buildBreakdown(last),
            modelContextWindow: 272000,
          },
        },
      };
    };
    const restored = buildUsageReport([50_000, 5_000], [8_000, 1_000]);
    const run = createDriving({
      "thread/resume": () => {
        // Codex sends the restored usage right after the reply. The waiting
        // fiber resumes inside the reply's delivery and registers the
        // session before the reader reaches the next line, so the report is
        // kept. This test fails if that ever stops being true.
        queueMicrotask(() => run.spawns[0]!.push(restored));
        return { thread: { id: RESUMED } };
      },
    });
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } };
    await Effect.runPromise(run.adapter.startSession(SESSION, spec, run.ctx));
    const server = run.spawns[0]!;

    server.push({
      method: "turn/started",
      params: {
        threadId: RESUMED,
        turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" },
      },
    });
    // A cancelled first call makes Codex repeat the restored total.
    server.push(restored);
    server.push(buildUsageReport([70_000, 7_000], [20_000, 2_000]));
    await waitUntil(
      "reported both usage snapshots",
      () => filterByTag(run.seen, "session.usage.updated").length === 2,
    );

    expect(filterByTag(run.seen, "session.usage.updated").map((event) => event.usage)).toEqual([
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it("forks a native thread, and uses the new thread's id", async () => {
    const { adapter, ctx, requests } = createDriving();
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "fork" } };

    const binding = await Effect.runPromise(adapter.startSession(SESSION, spec, ctx));

    expect(listSentParams(requests, "thread/fork")).toEqual([
      expect.objectContaining({ threadId: PRIOR }),
    ]);
    expect(listSentParams(requests, "thread/start")).toEqual([]);
    // The fork is a new thread: using the original thread's id would point
    // the session at the thread it forked from.
    expect(binding.nativeSessionId).toBe(FORKED);
  });

  it("fails with the server's error message when a thread cannot be opened, and emits no events", async () => {
    const { adapter, ctx, seen } = createDriving({
      "thread/start": () => buildRefusal("no rollout found for thread id 00000000-0000"),
    });

    const refused = await Effect.runPromise(Effect.flip(adapter.startSession(SESSION, SPEC, ctx)));

    // Server text is never matched to find a cause, so a refused open stays a plain failure.
    expect(refused).toBeInstanceOf(AdapterFailed);
    expect(refused.message).toContain("no rollout found");
    await settle();
    // No `session.started` for a session that never started: the supervisor
    // treats that event as meaning the session is live.
    expect(seen).toEqual([]);
    expect(await Effect.runPromise(adapter.listSessions)).toEqual([]);
  });
});

describe("what an input does to a Codex session", () => {
  it("starts a turn with the text when no turn is running", async () => {
    const run = await startTestSession();

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    expect(sent).toEqual({ turnId: TURN, delivery: "opened" });
    const opened = listSentParams(run.requests, "turn/start");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ threadId: THREAD });
    expect(JSON.stringify(opened[0])).toContain("hello");
    expect(listSentParams(run.requests, "turn/steer")).toEqual([]);
  });

  it("steers the running turn, sending the turn id it expects", async () => {
    const run = await startBusySession();

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "and the tests" }));

    expect(sent).toEqual({ turnId: TURN, delivery: "steered" });
    const steered = listSentParams(run.requests, "turn/steer");
    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatchObject({ threadId: THREAD, expectedTurnId: TURN });
    expect(JSON.stringify(steered[0])).toContain("and the tests");
    // The only `turn/start` is the session's first turn; steering started no second one.
    expect(listSentParams(run.requests, "turn/start")).toHaveLength(1);
  });

  // Codex reads each image from its file, so the same items go on a new turn
  // and on a steer: the text, which names each file, then the files.
  for (const [method, start] of [
    ["turn/start", startTestSession],
    ["turn/steer", startBusySession],
  ] as const) {
    it(`sends attached images as localImage items after the text on ${method}`, async () => {
      const run = await start();
      const image = writeTestImage();

      await Effect.runPromise(
        run.adapter.sendInput(SESSION, { text: "what is this?", attachments: [image] }),
      );

      expect(listSentParams(run.requests, method).at(-1)).toMatchObject({
        input: [
          {
            type: "text",
            text: `what is this?\n\n[Attached image "screenshot.png" is saved at: ${image.path}]`,
            text_elements: [],
          },
          { type: "localImage", path: image.path },
        ],
      });
    });
  }

  describe("Skill References", () => {
    const scratch = mkdtempSync(join(tmpdir(), "codex-skill-items-"));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));

    /** Writes `<root>/<name>/SKILL.md` and returns the folder. */
    const writeSkillFolder = (root: string, name: string): string => {
      const folder = join(root, name);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: A skill.\n---\n`);
      return folder;
    };

    /** A library skill the way the runner stages it: a link inside the library skills folder. */
    const stageLibrarySkill = (name: string): ResolvedSkillReference => {
      const root = mkdtempSync(join(scratch, "library-"));
      const source = writeSkillFolder(join(root, "source"), name);
      const staged = join(root, "skills");
      mkdirSync(staged, { recursive: true });
      symlinkSync(source, join(staged, name));
      return {
        source: "library",
        skillName: name,
        folder: join(staged, name),
        referenceName: name,
        start: 0,
        end: name.length + 1,
      };
    };

    const buildRepositorySkill = (checkoutName: string, name: string): ResolvedSkillReference => ({
      source: "repository",
      skillName: name,
      checkoutName,
      folder: writeSkillFolder(mkdtempSync(join(scratch, `checkout-${checkoutName}-`)), name),
      referenceName: `${checkoutName}:${name}`,
      start: 0,
      end: checkoutName.length + name.length + 2,
    });

    /** Sends `skillReferences` with a turn and returns the `input` items of the `turn/start`. */
    const sendWithSkills = async (
      skillReferences: ReadonlyArray<ResolvedSkillReference>,
      withImage = false,
    ) => {
      const run = await startTestSession();
      await Effect.runPromise(
        run.adapter.sendInput(SESSION, {
          text: "use the skills",
          skillReferences,
          ...(withImage ? { attachments: [writeTestImage()] } : {}),
        }),
      );
      return (listSentParams(run.requests, "turn/start").at(-1) as { input: Array<unknown> }).input;
    };

    it("adds no skill item when the text references no skill", async () => {
      const input = await sendWithSkills([]);

      expect(input).toHaveLength(1);
    });

    it("adds a skill item for a library skill, with the real path of its SKILL.md", async () => {
      const review = stageLibrarySkill("review");

      const input = await sendWithSkills([review]);

      // The staged folder is a link, and Codex reports the path behind it.
      expect(JSON.stringify(input)).not.toContain(review.folder);
      expect(input.slice(1)).toEqual([
        {
          type: "skill",
          name: "review",
          path: join(realpathSync(review.folder), "SKILL.md"),
        },
      ]);
    });

    it("names a repository skill by its own name, not its qualified reference", async () => {
      const release = buildRepositorySkill("webshop", "release");

      const input = await sendWithSkills([release]);

      expect(input.slice(1)).toEqual([
        {
          type: "skill",
          name: "release",
          path: join(realpathSync(release.folder), "SKILL.md"),
        },
      ]);
    });

    it("keeps a library skill and a repository skill of the same name apart by their paths", async () => {
      const library = stageLibrarySkill("release");
      const repository = buildRepositorySkill("webshop", "release");

      const input = (await sendWithSkills([library, repository])) as Array<{ path: string }>;

      expect(input.slice(1).map((item) => item.path)).toEqual([
        join(realpathSync(library.folder), "SKILL.md"),
        join(realpathSync(repository.folder), "SKILL.md"),
      ]);
      expect(new Set(input.slice(1).map((item) => item.path)).size).toBe(2);
    });

    it("adds one item for a skill referenced twice", async () => {
      const review = stageLibrarySkill("review");

      const input = await sendWithSkills([review, { ...review, start: 20, end: 27 }]);

      expect(input).toHaveLength(2);
    });

    it("leaves out a skill whose SKILL.md is gone, and keeps the text", async () => {
      const gone = { ...stageLibrarySkill("gone"), folder: join(scratch, "does-not-exist") };

      const input = await sendWithSkills([gone]);

      expect(input).toHaveLength(1);
    });

    it("leaves out a skill whose SKILL.md resolves outside the skill folder", async () => {
      const secret = join(scratch, "secret.txt");
      writeFileSync(secret, "not a skill");
      const swapped = stageLibrarySkill("swapped");
      const target = join(realpathSync(swapped.folder), "SKILL.md");
      rmSync(target);
      symlinkSync(secret, target);

      const input = await sendWithSkills([swapped]);

      expect(input).toHaveLength(1);
      expect(JSON.stringify(input)).not.toContain(secret);
    });

    it("records on the user message only the skills it gave Codex an item for", async () => {
      const review = stageLibrarySkill("review");
      const gone = { ...stageLibrarySkill("gone"), folder: join(scratch, "does-not-exist") };
      const run = await startTestSession();

      await Effect.runPromise(
        run.adapter.sendInput(SESSION, {
          text: "$review $gone",
          skillReferences: [review, gone],
        }),
      );

      await waitUntil(
        "reported the user's message",
        () =>
          filterByTag(run.seen, "item.completed").filter((event) => event.kind === "user_message")
            .length === 1,
      );
      const reported = filterByTag(run.seen, "item.completed").find(
        (event) => event.kind === "user_message",
      );
      expect(reported?.detail).toEqual({ text: "$review $gone", skills: ["review"] });
    });

    it("refuses to steer an input with a skill into a running turn, before it changes anything", async () => {
      const review = stageLibrarySkill("review");
      const run = await startBusySession();
      const requestsBefore = run.requests.length;
      const seenBefore = run.seen.length;

      const refusal = await Effect.runPromise(
        Effect.flip(
          run.adapter.sendInput(SESSION, { text: "$review this", skillReferences: [review] }),
        ),
      );

      expect(refusal).toBeInstanceOf(SteerRefused);
      expect(refusal).toMatchObject({
        message:
          "Not steered: Codex can't start a skill in the middle of a turn. The input stays queued and runs when this turn ends.",
      });
      await settle();
      // Nothing reached Codex and nothing was published.
      expect(listSentParams(run.requests, "turn/steer")).toEqual([]);
      expect(listSentParams(run.requests, "turn/start")).toHaveLength(1);
      expect(run.requests).toHaveLength(requestsBefore);
      expect(run.seen).toHaveLength(seenBefore);
    });

    it("steers an input whose references all lost their SKILL.md, as any other", async () => {
      const gone = { ...stageLibrarySkill("gone"), folder: join(scratch, "does-not-exist") };
      const run = await startBusySession();

      const sent = await Effect.runPromise(
        run.adapter.sendInput(SESSION, { text: "$gone this", skillReferences: [gone] }),
      );

      expect(sent).toEqual({ turnId: TURN, delivery: "steered" });
      expect(listSentParams(run.requests, "turn/steer")).toHaveLength(1);
    });

    it("steers an input without a reference into a running turn", async () => {
      const run = await startBusySession();

      const sent = await Effect.runPromise(
        run.adapter.sendInput(SESSION, { text: "a price of $20", skillReferences: [] }),
      );

      expect(sent).toEqual({ turnId: TURN, delivery: "steered" });
      expect(listSentParams(run.requests, "turn/steer")).toHaveLength(1);
    });

    it("puts the skill items after the text and the images", async () => {
      const review = stageLibrarySkill("review");

      const input = await sendWithSkills([review], true);

      expect(input.map((item) => (item as { type: string }).type)).toEqual([
        "text",
        "localImage",
        "skill",
      ]);
    });
  });

  it("tells the agent which session sent a message, and reports the sender beside the original text", async () => {
    const run = await startTestSession();
    const sender = "0199e0e7-0000-7000-8000-0000000000e1";

    await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "rebase on main", senderSessionId: sender }),
    );

    expect(listSentParams(run.requests, "turn/start").at(-1)).toMatchObject({
      input: [
        {
          type: "text",
          text: `[Message from session ${sender}, another agent. To reply: hercule session input ${sender}]\n\nrebase on main`,
        },
      ],
    });
    await waitUntil(
      "reported the user's message",
      () =>
        filterByTag(run.seen, "item.completed").filter((event) => event.kind === "user_message")
          .length === 1,
    );
    const reported = filterByTag(run.seen, "item.completed").find(
      (event) => event.kind === "user_message",
    );
    expect(reported?.detail).toEqual({ text: "rebase on main", senderSessionId: sender });
  });

  it("starts a new turn instead when the turn it meant to steer is no longer active", async () => {
    const NEXT = "0199e0e7-0000-7000-8000-0000000000f9";
    let turns = 0;
    const run = await startBusySession({
      "turn/steer": () => buildRefusal(`expected active turn id \`${TURN}\` but found \`other\``),
      "turn/start": () => {
        turns += 1;
        const id = turns === 1 ? TURN : NEXT;
        return { turn: { id, items: [], itemsView: "full", status: "inProgress" } };
      },
    });

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));

    // Input is never rejected: it reaches the harness one way or the other,
    // and only the adapter knows which way it went.
    expect(sent).toEqual({ turnId: NEXT, delivery: "opened" });
    expect(listSentParams(run.requests, "turn/start")).toHaveLength(2);
  });

  it("starts a new turn instead when Codex says the turn it meant to steer ended", async () => {
    const run = await startBusySession({
      "turn/steer": () => buildRefusal("no active turn to steer"),
    });

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));

    expect(sent.delivery).toBe("opened");
    expect(listSentParams(run.requests, "turn/start")).toHaveLength(2);
  });

  it("starts a new turn instead for any steer refusal that carries an error code", async () => {
    const run = await startBusySession({
      "turn/steer": () => buildRefusal("failed to steer turn: something new", -32603),
    });

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));

    expect(sent.delivery).toBe("opened");
    expect(listSentParams(run.requests, "turn/start")).toHaveLength(2);
  });

  it("fails with SessionNotRunning for a session this runner does not host", async () => {
    const { adapter } = createDriving();

    const refused = await Effect.runPromise(
      Effect.flip(adapter.sendInput(SESSION, { text: "hi" })),
    );

    expect(refused).toBeInstanceOf(SessionNotRunning);
  });

  it("fails with HarnessProtocolError when Codex does not reply to turn/start in time", async () => {
    const { adapter, ctx } = createDriving({ "turn/start": SILENT });
    await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    const failure = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sending = yield* Effect.forkChild(
            Effect.flip(adapter.sendInput(SESSION, { text: "hi" })),
          );
          yield* Effect.promise(() => settle());
          yield* TestClock.adjust(RPC_DEADLINE);
          return yield* Fiber.join(sending);
        }),
        TestClock.layer(),
      ),
    );

    // Codex may have taken the input before the reply was lost.
    expect(failure).toBeInstanceOf(HarnessProtocolError);
    expect(failure.message).toContain("did not reply");
  });

  it("fails and starts no turn when the steer fails with no error code", async () => {
    const run = await startBusySession({
      "turn/steer": () => ({ error: { message: "failed to steer turn: the thread is gone" } }),
    });

    const failure = await Effect.runPromise(
      Effect.flip(run.adapter.sendInput(SESSION, { text: "carry on" })),
    );

    // A new turn here could deliver the input a second time.
    expect(failure).toBeInstanceOf(HarnessProtocolError);
    expect(failure.message).toContain("failed to steer turn: the thread is gone");
    expect(listSentParams(run.requests, "turn/start")).toHaveLength(1);
  });

  it("starts a new turn instead when the running turn cannot be steered", async () => {
    const NEXT = "0199e0e7-0000-7000-8000-0000000000f8";
    let turns = 0;
    const run = await startBusySession({
      "turn/steer": () => buildRefusal("cannot steer a review turn"),
      "turn/start": () => {
        turns += 1;
        const id = turns === 1 ? TURN : NEXT;
        return { turn: { id, items: [], itemsView: "full", status: "inProgress" } };
      },
    });

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));

    expect(sent).toEqual({ turnId: NEXT, delivery: "opened" });
    expect(listSentParams(run.requests, "turn/steer")).toHaveLength(1);
    expect(listSentParams(run.requests, "turn/start")).toHaveLength(2);
  });
});

describe("an interrupt that names a subagent", () => {
  it("ignores an unknown subagent without stopping the root", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "look around" }));

    // The user asked to stop one subagent, not the session's own turn.
    await Effect.runPromise(run.adapter.interrupt(SESSION, "child-thread"));
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([]);

    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: THREAD, turnId: TURN },
    ]);
  });
});

describe("an app-server that stops replying to a control request", () => {
  it("stops waiting for the interrupt after the timeout, rather than holding up the stop for ever", async () => {
    const { adapter, ctx, seen } = createDriving({ "turn/interrupt": SILENT });

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* adapter.startSession(SESSION, SPEC, ctx);
          yield* adapter.sendInput(SESSION, { text: "look around" });
          const stopping = yield* Effect.forkChild(adapter.stopSession(SESSION, "stopped"));
          // A stop that waited on the silent app-server with no time limit
          // would never end the session.
          yield* TestClock.adjust(CONTROL_DEADLINE);
          return yield* Fiber.join(stopping);
        }),
        TestClock.layer(),
      ),
    );

    expect(filterByTag(seen, "session.exited").map((event) => event.reason)).toEqual(["stopped"]);
  });

  it("reports the session's exit once when the thread closes while the stop is waiting", async () => {
    const run = createDriving({ "turn/interrupt": SILENT });
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "look around" }));

    const stopping = Effect.runFork(run.adapter.stopSession(SESSION, "stopped"));
    await waitUntil(
      "asked the server to end the turn",
      () => listSentParams(run.requests, "turn/interrupt").length === 1,
    );
    run.spawns[0]!.push({ method: "thread/closed", params: { threadId: THREAD } });
    await waitUntil(
      "reported the session gone",
      () => filterByTag(run.seen, "session.exited").length > 0,
    );
    await Effect.runPromise(Fiber.join(stopping));

    await settle();
    // The thread closing is what actually ended the session: it happened while
    // the stop was waiting on the harness. A second exit would record the same
    // end twice.
    expect(filterByTag(run.seen, "session.exited").map((event) => event.reason)).toEqual([
      "idle_unload",
    ]);
  });
});

describe("a thread the server unloads by itself", () => {
  it("ends the session as an idle unload and stops listing it", async () => {
    const run = await startTestSession();
    expect(await Effect.runPromise(run.adapter.listSessions)).toHaveLength(1);

    run.server.push({ method: "thread/closed", params: { threadId: THREAD } });

    await waitUntil(
      "reported the session gone",
      () => filterByTag(run.seen, "session.exited").length === 1,
    );
    // `idle_unload` is the one exit that leaves the native thread on disk, so
    // it is the one a later session can continue from.
    expect(filterByTag(run.seen, "session.exited")[0]?.reason).toBe("idle_unload");
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });

  it("emits nothing more when the supervisor stops a session that has already exited", async () => {
    const run = await startTestSession();
    run.server.push({ method: "thread/closed", params: { threadId: THREAD } });
    await waitUntil(
      "reported the session gone",
      () => filterByTag(run.seen, "session.exited").length === 1,
    );
    const reported = run.seen.length;

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    await settle();
    // A second exit would record the same end twice.
    expect(run.seen).toHaveLength(reported);
    expect(filterByTag(run.seen, "session.exited")).toHaveLength(1);
  });
});

const OTHER_SESSION = "0199e0e7-0000-7000-8000-0000000000f7";

const OTHER_THREAD = "0199e0e7-0000-7000-8000-0000000000f6";

/** The token the runner puts in each session's environment; each session has a different one. */
const TOKENS = { [SESSION]: "token-of-the-first", [OTHER_SESSION]: "token-of-the-second" };

/** Starts two sessions of one instance, each with its own token and its own app-server. */
const startSessionPair = async (): Promise<ReturnType<typeof createDriving>> => {
  let opened = 0;
  const run = createDriving({
    "thread/start": () => {
      opened += 1;
      return { thread: { id: opened === 1 ? THREAD : OTHER_THREAD } };
    },
  });
  const withToken = (sessionId: keyof typeof TOKENS) => ({
    ...run.ctx,
    env: { ...run.ctx.env, HERCULE_TOKEN: TOKENS[sessionId] },
  });
  await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, withToken(SESSION)));
  await Effect.runPromise(run.adapter.startSession(OTHER_SESSION, SPEC, withToken(OTHER_SESSION)));
  return run;
};

const listExitReasons = (
  seen: ReadonlyArray<ProviderEvent>,
  sessionId: string,
): ReadonlyArray<string> =>
  filterByTag(seen, "session.exited")
    .filter((event) => event.sessionId === sessionId)
    .map((event) => event.reason);

describe("each session's own app-server", () => {
  it("is a separate process, started with that session's token", async () => {
    const run = await startSessionPair();

    // Every shell command a Codex session runs is a child of its app-server
    // and inherits that process's environment. If two sessions shared one
    // process, the second would act as the first, with its credential, grants
    // and actor stamp, and both would get a 401 as soon as the first session's
    // token is revoked (spec 06 section 9.3).
    expect(run.spawns).toHaveLength(2);
    expect(run.spawns[0]?.env["HERCULE_TOKEN"]).toBe(TOKENS[SESSION]);
    expect(run.spawns[1]?.env["HERCULE_TOKEN"]).toBe(TOKENS[OTHER_SESSION]);
    expect(await Effect.runPromise(run.adapter.listSessions)).toHaveLength(2);
  });

  it("is killed when its session stops, and no other app-server is", async () => {
    const run = await startSessionPair();

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    // Killed, because a process left running would hold a revoked token; and
    // only that one, because the other session has not ended.
    expect(run.spawns[0]?.kills()).toBe(1);
    expect(run.spawns[1]?.kills()).toBe(0);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([
      { sessionId: OTHER_SESSION, nativeSessionId: OTHER_THREAD, instanceId: SPEC.instanceId },
    ]);

    await Effect.runPromise(run.adapter.stopSession(OTHER_SESSION, "stopped"));
    expect(run.spawns[1]?.kills()).toBe(1);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });

  it("interrupts the turn of a stopped session and leaves the other session alone", async () => {
    const run = await startSessionPair();
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "look around" }));

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    // A turn left running would keep working in the workspace, and its
    // notifications would arrive for a session that no longer exists.
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: THREAD, turnId: TURN },
    ]);
    expect(listExitReasons(run.seen, SESSION)).toEqual(["stopped"]);
    expect(listExitReasons(run.seen, OTHER_SESSION)).toEqual([]);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([
      { sessionId: OTHER_SESSION, nativeSessionId: OTHER_THREAD, instanceId: SPEC.instanceId },
    ]);
  });

  it("reports only the session whose app-server exited on its own as exited", async () => {
    const run = await startSessionPair();

    run.spawns[0]!.crash();

    await waitUntil(
      "reported the session gone",
      () => filterByTag(run.seen, "session.exited").length === 1,
    );
    expect(listExitReasons(run.seen, SESSION)).toEqual(["process_exit"]);
    expect(listExitReasons(run.seen, OTHER_SESSION)).toEqual([]);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([
      { sessionId: OTHER_SESSION, nativeSessionId: OTHER_THREAD, instanceId: SPEC.instanceId },
    ]);
  });

  it("keeps the Session alive when an introduced child thread closes", async () => {
    const run = await startTestSession({
      "thread/read": () => ({ thread: { id: OTHER_THREAD, parentThreadId: THREAD } }),
    });
    run.server.push({ method: "thread/closed", params: { threadId: OTHER_THREAD } });
    await waitUntil(
      "introduced the child",
      () => filterByTag(run.seen, "subagent.started").length === 1,
    );
    expect(filterByTag(run.seen, "session.exited")).toEqual([]);
    expect(await Effect.runPromise(run.adapter.listSessions)).toHaveLength(1);
  });
});

const SELECTED = {
  model: "gpt-6-astra",
  options: { effort: "high", serviceTier: "priority" },
} as const;

describe("the model a turn runs with", () => {
  it("sends the session's whole model selection when it starts a turn", async () => {
    const run = await startTestSession();

    await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "hello", modelSelection: SELECTED }),
    );

    // Sent every time rather than only when it changed: Codex takes all three
    // per turn, and a selection changed and changed back is still a change.
    expect(listSentParams(run.requests, "turn/start")[0]).toMatchObject({
      model: "gpt-6-astra",
      effort: "high",
      serviceTier: "priority",
    });
  });

  it("sends no model when the input has no model selection", async () => {
    const run = await startTestSession();

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    const opened = listSentParams(run.requests, "turn/start")[0] as Record<string, unknown>;
    // The thread keeps its own model: sending one here would mean Hercule chose it.
    expect(opened["model"]).toBeUndefined();
    expect(opened["effort"]).toBeUndefined();
    expect(opened["serviceTier"]).toBeUndefined();
  });

  it("sends no service tier when the standard tier is selected, and sends any other tier", async () => {
    // "standard" is Hercule's name for the tier Codex uses when no tier is
    // given, so selecting it means leaving the field out.
    const sendWithServiceTier = async (tier: string): Promise<Record<string, unknown>> => {
      const run = await startTestSession();
      await Effect.runPromise(
        run.adapter.sendInput(SESSION, {
          text: "hello",
          modelSelection: { model: "gpt-6-astra", options: { serviceTier: tier } },
        }),
      );
      return listSentParams(run.requests, "turn/start")[0] as Record<string, unknown>;
    };

    expect((await sendWithServiceTier("standard"))["serviceTier"]).toBeUndefined();
    expect((await sendWithServiceTier("priority"))["serviceTier"]).toBe("priority");
  });

  it("starts the thread with the session's model and service tier", async () => {
    const run = createDriving();

    await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...SPEC, modelSelection: SELECTED }, run.ctx),
    );

    expect(listSentParams(run.requests, "thread/start")[0]).toMatchObject({
      model: "gpt-6-astra",
      serviceTier: "priority",
    });
  });
});

/** The error code for an overloaded server (spec 06 section 10.2). */
const OVERLOADED = -32001;

const TURN_ANSWER = { turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" } };

/**
 * Steps a test clock through the three backoff delays, one attempt at a time,
 * and checks that no retry happens before its delay has passed. Each step
 * advances 750, 1250 and 2250 ms: the spec's 500, 1000 and 2000 ms plus the
 * full 250 ms of jitter, and not a millisecond more. A larger step would let
 * a wrong base delay pass.
 */
const expectBackoff = (attempts: () => number) =>
  Effect.gen(function* () {
    for (const step of [0, 1, 2]) {
      yield* Effect.promise(() => waitUntil(`sent attempt ${step + 1}`, () => attempts() > step));
      yield* Effect.promise(settle);
      expect(attempts(), `attempt ${step + 2} came before the backoff`).toBe(step + 1);
      yield* TestClock.adjust(Duration.millis(500 * 2 ** step + 250));
    }
  });

describe("a turn the server is too busy to start", () => {
  it("retries it with the spec's backoff and keeps the input", async () => {
    let attempts = 0;
    const { adapter, ctx, requests } = createDriving({
      "turn/start": () => {
        attempts += 1;
        return attempts < 4 ? buildRefusal("the server is overloaded", OVERLOADED) : TURN_ANSWER;
      },
    });

    const sent = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* adapter.startSession(SESSION, SPEC, ctx);
          const sending = yield* Effect.forkChild(adapter.sendInput(SESSION, { text: "hi" }));
          yield* expectBackoff(() => attempts);
          return yield* Fiber.join(sending);
        }),
        TestClock.layer(),
      ),
    );

    expect(sent).toEqual({ turnId: TURN, delivery: "opened" });
    expect(listSentParams(requests, "turn/start")).toHaveLength(4);
  });

  it("gives up after the third retry, and fails with the server's error message", async () => {
    let attempts = 0;
    const { adapter, ctx, requests } = createDriving({
      "turn/start": () => {
        attempts += 1;
        return buildRefusal("the server is overloaded", OVERLOADED);
      },
    });

    const refused = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* adapter.startSession(SESSION, SPEC, ctx);
          const sending = yield* Effect.forkChild(
            Effect.flip(adapter.sendInput(SESSION, { text: "hi" })),
          );
          yield* expectBackoff(() => attempts);
          return yield* Fiber.join(sending);
        }),
        TestClock.layer(),
      ),
    );

    expect(refused).toBeInstanceOf(InputNotDelivered);
    expect(refused.message).toContain("overloaded");
    // One attempt plus three retries, and no more.
    expect(listSentParams(requests, "turn/start")).toHaveLength(4);
  });

  it("does not retry an error that is not an overload", async () => {
    const { adapter, ctx, requests } = createDriving({
      "turn/start": () => buildRefusal("thread not found: 00000000-0000-0000-0000-000000000000"),
    });
    await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    const refused = await Effect.runPromise(
      Effect.flip(adapter.sendInput(SESSION, { text: "hi" })),
    );

    expect(refused).toBeInstanceOf(InputNotDelivered);
    expect(refused.message).toContain("thread not found");
    // A request the server rejected for its content would just be rejected
    // three more times.
    expect(listSentParams(requests, "turn/start")).toHaveLength(1);
  });

  it("fails with HarnessProtocolError, not a defect, when turn/start succeeds with a reply that has no turn", async () => {
    // The prompt may have been accepted, so the failure must say so by its type.
    const { adapter, ctx } = createDriving({ "turn/start": () => ({}) });
    await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    const failure = await Effect.runPromise(
      Effect.flip(adapter.sendInput(SESSION, { text: "hi" })),
    );

    expect(failure).toBeInstanceOf(HarnessProtocolError);
    expect(failure.message).toContain("turn/start");
  });

  it("fails with HarnessProtocolError, not a defect, when turn/steer succeeds with a reply that has no turn id", async () => {
    const run = await startBusySession({ "turn/steer": () => ({}) });

    const failure = await Effect.runPromise(
      Effect.flip(run.adapter.sendInput(SESSION, { text: "carry on" })),
    );

    expect(failure).toBeInstanceOf(HarnessProtocolError);
    expect(failure.message).toContain("turn/steer");
  });

  it("fails the start with HarnessProtocolError when thread/start succeeds with a reply that has no thread", async () => {
    const { adapter, ctx } = createDriving({ "thread/start": () => ({}) });

    const failure = await Effect.runPromise(Effect.flip(adapter.startSession(SESSION, SPEC, ctx)));

    expect(failure).toBeInstanceOf(HarnessProtocolError);
    expect(failure.message).toContain("thread/start");
  });
});

const ENV: Readonly<Record<string, string | undefined>> = { PATH: "/usr/local/bin:/usr/bin" };

const stubInstall = (
  answer: { readonly code: number; readonly stdout?: string; readonly stderr?: string },
  options: { readonly hangs?: boolean } = {},
): {
  readonly install: Effect.Effect<{ readonly ok: boolean; readonly message?: string }>;
  readonly commands: Array<ReadonlyArray<string>>;
  readonly envs: Array<Readonly<Record<string, string | undefined>>>;
} => {
  const commands: Array<ReadonlyArray<string>> = [];
  const envs: Array<Readonly<Record<string, string | undefined>>> = [];
  const seam: CodexSeam = {
    appServer: () => {
      throw new Error("installing must not start an app-server");
    },
    run: (command, env) => {
      commands.push(command);
      envs.push(env);
      return options.hangs === true
        ? Effect.never
        : Effect.succeed({
            code: answer.code,
            stdout: answer.stdout ?? "",
            stderr: answer.stderr ?? "",
          });
    },
  };
  return { install: makeCodexAdapter(seam).install!(ENV), commands, envs };
};

describe("installing the Codex harness", () => {
  it("runs the vendor's install script, pinned to the release this build supports", async () => {
    const { install, commands, envs } = stubInstall({ code: 0, stdout: "Installed codex" });

    const outcome = await Effect.runPromise(install);

    expect(outcome.ok).toBe(true);
    expect(commands).toEqual([
      [
        "bash",
        "-c",
        `curl -fsSL https://raw.githubusercontent.com/openai/codex/rust-v${CODEX_VERSION}/scripts/install/install.sh | CODEX_RELEASE=${CODEX_VERSION} CODEX_NON_INTERACTIVE=1 sh`,
      ],
    ]);
    expect(envs).toEqual([ENV]);
  });

  it("reports the installer's own output when it fails, not just that it failed", async () => {
    const stderr = [
      "resolving the release",
      "  % Total    % Received",
      "curl: (22) The requested URL returned error: 404",
      "install.sh: could not download the archive",
      "install.sh: giving up",
      "install.sh: nothing was installed",
    ].join("\n");
    const { install } = stubInstall({ code: 1, stderr });

    const outcome = await Effect.runPromise(install);

    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? "").toContain("install.sh: nothing was installed");
    // Only the last five lines, so the user does not read the banner above them.
    expect(outcome.message ?? "").toContain("  % Total    % Received");
    expect(outcome.message ?? "").not.toContain("resolving the release");
  });

  it("fails an installer that runs past the timeout, and includes the timeout in the message", async () => {
    const { install } = stubInstall({ code: 0 }, { hangs: true });

    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(install);
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(INSTALL_DEADLINE);
          return yield* Fiber.join(running);
        }),
        TestClock.layer(),
      ),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? "").toContain(Duration.format(INSTALL_DEADLINE));
  });
});

/**
 * Greps the runner's source for `pattern`, skipping generated files. Callers
 * build the pattern from pieces, so the literal does not appear in this file
 * and the grep does not find itself.
 */
const grepSource = (pattern: string): string =>
  Bun.spawnSync({
    cmd: ["bash", "-c", `grep -rn '${pattern}' apps/runner/src --include=*.ts || true`],
    cwd: root,
  })
    .stdout.toString()
    .split("\n")
    .filter((line) => line !== "" && !line.includes("/generated/"))
    .join("\n");

describe("the two Codex features this adapter must never use", () => {
  it("calls neither the shell-command method nor the process method", () => {
    // If a harness could start its own processes through the runner, that
    // work would run outside every session boundary Hercule sets.
    // The notification table in `normalize.ts` names the notifications of those
    // methods only to drop them, so it is not a call.
    const calls = grepSource(["thread/shell", "Command", "\\|process/", "spawn"].join(""))
      .split("\n")
      .filter((line) => !line.startsWith("apps/runner/src/providers/codex/normalize.ts:"));
    expect(calls.join("\n")).toBe("");
  });

  it("never refers to the user's own Codex home", () => {
    // The only Codex home a runner may touch is the one built from `ctx.home`.
    expect(grepSource(["~/\\", ".codex\\|$HOME/\\", ".codex"].join(""))).toBe("");
  });
});

/** The hercule tool the runner resolves once, at start, for every adapter. */
const TOOL = {
  orientation: "This session runs inside Hercule.",
  skill: "# hercule\n\nCall `hercule --help` to find out what this controller can do.\n",
  claudePluginDir: "/var/hercule/runner/storage/claude-plugin",
};

/**
 * What an Agent adds to a Codex session: its own instructions, and a schema
 * every turn must answer with (spec 06 section 7). The spec can also carry
 * `disallowedTools`, which Codex does not enforce.
 */
const OUTPUT_SCHEMA: OutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence"],
  properties: {
    verdict: { type: "string", enum: ["accept", "dismiss"] },
    confidence: { type: "number" },
  },
};

const SYSTEM_PROMPT = "You assess tasks and answer with a verdict.";

const STRUCTURED: SessionSpec = {
  ...SPEC,
  systemPrompt: SYSTEM_PROMPT,
  outputSchema: OUTPUT_SCHEMA,
};

const ANSWER = { verdict: "accept", confidence: 0.9 };

describe("hercule-as-a-tool on a Codex thread", () => {
  /** The orientation followed by the skill, as one string. */
  const ORIENTED = `${TOOL.orientation}\n\n${TOOL.skill}`;
  /** The orientation, the Agent's instructions and the skill, as one string. */
  const INSTRUCTED = `${TOOL.orientation}\n\n${SYSTEM_PROMPT}\n\n${TOOL.skill}`;
  const MEMORY = "## Memory (core)\nThe user is Rogier.\n\n## Memory topics\n- projects";
  const COORDINATION = "Other agent sessions may work on the same repositories as you.";

  const OPENINGS: ReadonlyArray<readonly [string, SessionSpec, string]> = [
    ["thread/start", SPEC, ORIENTED],
    ["thread/resume", { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } }, ORIENTED],
    ["thread/fork", { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "fork" } }, ORIENTED],
    ["thread/start", STRUCTURED, INSTRUCTED],
    [
      "thread/resume",
      { ...STRUCTURED, continue: { nativeSessionId: PRIOR, mode: "resume" } },
      INSTRUCTED,
    ],
    [
      "thread/fork",
      { ...STRUCTURED, continue: { nativeSessionId: PRIOR, mode: "fork" } },
      INSTRUCTED,
    ],
    // An assistant's memory comes last, after the skill.
    ["thread/start", { ...STRUCTURED, memory: MEMORY }, `${INSTRUCTED}\n\n${MEMORY}`],
    [
      "thread/resume",
      { ...STRUCTURED, memory: MEMORY, continue: { nativeSessionId: PRIOR, mode: "resume" } },
      `${INSTRUCTED}\n\n${MEMORY}`,
    ],
    // The coordination paragraph comes right before the memory.
    [
      "thread/start",
      { ...STRUCTURED, coordination: COORDINATION, memory: MEMORY },
      `${INSTRUCTED}\n\n${COORDINATION}\n\n${MEMORY}`,
    ],
  ];

  it.each(OPENINGS)(
    "sends the session's instructions as the developer instructions of %s",
    async (method, spec, instructions) => {
      const { adapter, ctx, requests } = createDriving();

      await Effect.runPromise(adapter.startSession(SESSION, spec, { ...ctx, herculeTool: TOOL }));

      // Developer instructions are the only way to tell the session the CLI
      // exists, and a session that is not told never calls it (spec 06 section
      // 9.1). An Agent's own prompt goes in the same field, and a continued
      // thread gets both.
      expect(listSentParams(requests, method)).toEqual([
        expect.objectContaining({ developerInstructions: instructions }),
      ]);
    },
  );

  it("writes no AGENTS.md into the session's scratch directory", async () => {
    const scratch = createCodexHome();
    const { adapter, ctx } = createDriving({}, scratch);

    await Effect.runPromise(adapter.startSession(SESSION, SPEC, { ...ctx, herculeTool: TOOL }));
    await settle();

    // Codex once got its instructions as an `AGENTS.md` in this directory;
    // they now go in the developer instructions. A file here would be
    // instructions the harness reads from a directory that must stay empty,
    // and one more copy of the skill to keep up to date.
    expect(existsSync(join(scratch, "AGENTS.md"))).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe("the user's own instructions on a Codex Thread", () => {
  const USER_INSTRUCTIONS = "Always answer in English.\nKeep commits small.";

  /** Writes the user's instructions file into a scratch directory and returns its path. */
  const writeInstructions = (text: string): string => {
    const file = join(createCodexHome(), "AGENTS.md");
    writeFileSync(file, text);
    return file;
  };

  /** Returns a context for a Thread whose user's instructions file is `instructionsFile`. */
  const buildThreadContext = (
    ctx: ProviderRunnerContext,
    instructionsFile: string,
  ): ProviderRunnerContext => ({
    ...ctx,
    herculeTool: TOOL,
    userMaterial: { ...NO_USER_MATERIAL_PATHS, instructionsFile },
  });

  const RESUME: SessionSpec["continue"] = { nativeSessionId: PRIOR, mode: "resume" };
  const FORK: SessionSpec["continue"] = { nativeSessionId: PRIOR, mode: "fork" };

  const OPENINGS: ReadonlyArray<readonly [string, SessionSpec, string]> = [
    ["thread/start", SPEC, `${TOOL.orientation}\n\n${USER_INSTRUCTIONS}\n\n${TOOL.skill}`],
    [
      "thread/resume",
      { ...SPEC, continue: RESUME },
      `${TOOL.orientation}\n\n${USER_INSTRUCTIONS}\n\n${TOOL.skill}`,
    ],
    [
      "thread/fork",
      { ...SPEC, continue: FORK },
      `${TOOL.orientation}\n\n${USER_INSTRUCTIONS}\n\n${TOOL.skill}`,
    ],
    [
      "thread/start",
      { ...SPEC, systemPrompt: SYSTEM_PROMPT },
      `${TOOL.orientation}\n\n${SYSTEM_PROMPT}\n\n${USER_INSTRUCTIONS}\n\n${TOOL.skill}`,
    ],
    [
      "thread/resume",
      { ...SPEC, systemPrompt: SYSTEM_PROMPT, continue: RESUME },
      `${TOOL.orientation}\n\n${SYSTEM_PROMPT}\n\n${USER_INSTRUCTIONS}\n\n${TOOL.skill}`,
    ],
    [
      "thread/fork",
      { ...SPEC, systemPrompt: SYSTEM_PROMPT, continue: FORK },
      `${TOOL.orientation}\n\n${SYSTEM_PROMPT}\n\n${USER_INSTRUCTIONS}\n\n${TOOL.skill}`,
    ],
  ];

  it.each(OPENINGS)(
    "sends the file's text between the system prompt and the skill on %s",
    async (method, spec, instructions) => {
      const { adapter, ctx, requests } = createDriving();
      const file = writeInstructions(USER_INSTRUCTIONS);

      await Effect.runPromise(adapter.startSession(SESSION, spec, buildThreadContext(ctx, file)));

      expect(listSentParams(requests, method)).toEqual([
        expect.objectContaining({ developerInstructions: instructions }),
      ]);
    },
  );

  it("reads the file again for each thread it opens, so a resumed thread gets the current text", async () => {
    const file = writeInstructions("The old text.");
    const first = createDriving();
    await Effect.runPromise(
      first.adapter.startSession(SESSION, SPEC, buildThreadContext(first.ctx, file)),
    );
    writeFileSync(file, "The new text.");
    const second = createDriving();

    await Effect.runPromise(
      second.adapter.startSession(
        SESSION,
        { ...SPEC, continue: RESUME },
        buildThreadContext(second.ctx, file),
      ),
    );

    expect(listSentParams(second.requests, "thread/resume")).toEqual([
      expect.objectContaining({
        developerInstructions: `${TOOL.orientation}\n\nThe new text.\n\n${TOOL.skill}`,
      }),
    ]);
  });

  it.each([
    ["a file that no longer exists", () => join(createCodexHome(), "AGENTS.md"), "ENOENT"],
    ["a directory", () => createCodexHome(), "it is not a regular file"],
  ])(
    "starts the Thread with only the orientation and the skill, and logs a warning, when the instructions are %s",
    async (_, makePath, reason) => {
      const { adapter, ctx, requests } = createDriving();
      const path = makePath();
      const warnings: Array<string> = [];
      const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(String(message));
      });

      await Effect.runPromise(
        Effect.provide(
          adapter.startSession(SESSION, SPEC, buildThreadContext(ctx, path)),
          Logger.layer([collecting]),
        ),
      );

      // The user's own files never stop a Thread from starting.
      expect(listSentParams(requests, "thread/start")).toEqual([
        expect.objectContaining({
          developerInstructions: `${TOOL.orientation}\n\n${TOOL.skill}`,
        }),
      ]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`Did not read ${path} into the Thread's instructions: `);
      expect(warnings[0]).toContain(reason);
    },
  );
});

/** Builds an agent message item. A Codex answer is read from the turn's final agent message. */
const buildAgentMessage = (text: string): Record<string, unknown> => ({
  type: "agentMessage",
  id: "0199e0e7-0000-7000-8000-0000000000e1",
  text,
});

/** An item that is not an agent message, so a turn can end without an answer. */
const COMMAND: Record<string, unknown> = {
  type: "commandExecution",
  id: "0199e0e7-0000-7000-8000-0000000000e2",
  command: "echo hi",
  cwd: CWD,
  status: "completed",
  commandActions: [],
  aggregatedOutput: "hi\n",
  exitCode: 0,
};

/**
 * Ends the running turn. The items are sent one by one as `item/completed`
 * and also listed on `turn/completed`, as the app-server does, so the script
 * does not decide which one an adapter reads the final message from.
 */
const completeTurn = (
  run: ReturnType<typeof createDriving>,
  items: ReadonlyArray<Record<string, unknown>>,
  status: "completed" | "failed" | "interrupted" = "completed",
): void => {
  const server = run.spawns[0]!;
  server.push({
    method: "turn/started",
    params: {
      threadId: THREAD,
      turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" },
    },
  });
  for (const item of items) {
    server.push({
      method: "item/completed",
      params: { threadId: THREAD, turnId: TURN, item, completedAtMs: 1789373122124 },
    });
  }
  server.push({
    method: "turn/completed",
    params: { threadId: THREAD, turn: { id: TURN, items, itemsView: "full", status } },
  });
};

/** Runs one turn that ends with these items, and returns its `turn.completed` event. */
const runTurnToCompletion = async (
  spec: SessionSpec,
  items: ReadonlyArray<Record<string, unknown>>,
  status: "completed" | "failed" | "interrupted" = "completed",
): Promise<Extract<ProviderEvent, { _tag: "turn.completed" }>> => {
  const run = createDriving();
  await Effect.runPromise(
    run.adapter.startSession(SESSION, spec, { ...run.ctx, herculeTool: TOOL }),
  );
  await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));
  completeTurn(run, items, status);
  await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
  return filterByTag(run.seen, "turn.completed")[0]!;
};

describe("a Codex session the controller spawned from an Agent", () => {
  it("sends the orientation, the Agent's instructions and the skill as the thread's developer instructions", async () => {
    const { adapter, ctx, requests } = createDriving();

    await Effect.runPromise(
      adapter.startSession(SESSION, STRUCTURED, { ...ctx, herculeTool: TOOL }),
    );

    // Both, in that order, and nothing else. The skill is how a session learns
    // the CLI exists (spec 06 section 9.1), so replacing it with the Agent's
    // prompt would take the tool away from every session an Agent spawns.
    expect(listSentParams(requests, "thread/start")).toEqual([
      expect.objectContaining({
        developerInstructions: `${TOOL.orientation}\n\n${SYSTEM_PROMPT}\n\n${TOOL.skill}`,
      }),
    ]);
  });

  it("sends the schema on every turn of the session, not just the first", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, run.ctx));

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));
    completeTurn(run, [buildAgentMessage(JSON.stringify(ANSWER))]);
    await waitUntil(
      "closed the first turn",
      () => filterByTag(run.seen, "turn.completed").length === 1,
    );
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "And this one." }));

    // Codex takes the schema per turn, so a session that sent it only once
    // would answer in prose from its second turn on.
    const opened = listSentParams(run.requests, "turn/start");
    expect(opened).toHaveLength(2);
    expect(opened[0]).toMatchObject({ outputSchema: OUTPUT_SCHEMA });
    expect(opened[1]).toMatchObject({ outputSchema: OUTPUT_SCHEMA });
  });

  it("sends no schema on the turns of a session without one", async () => {
    const run = await startTestSession();

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    // The field is absent, not null. A Thread answers in prose, and a schema
    // field on every turn would send something the spec does not contain.
    const opened = listSentParams(run.requests, "turn/start")[0] as Record<string, unknown>;
    expect("outputSchema" in opened).toBe(false);
  });

  it("sends the same requests whether or not the spec has disallowedTools", async () => {
    const startAndSend = async (spec: SessionSpec): Promise<ReadonlyArray<unknown>> => {
      const run = createDriving();
      await Effect.runPromise(
        run.adapter.startSession(SESSION, spec, { ...run.ctx, herculeTool: TOOL }),
      );
      await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));
      return [
        ...listSentParams(run.requests, "thread/start"),
        ...listSentParams(run.requests, "turn/start"),
      ];
    };

    // Codex declares `disallowedTools` as unsupported, and the record the
    // caller reads already says so. Inventing some enforcement here would be
    // the silent substitution the spec forbids.
    expect(await startAndSend({ ...STRUCTURED, disallowedTools: ["edit", "shell"] })).toEqual(
      await startAndSend(STRUCTURED),
    );
  });
});

describe("the structured result of a Codex turn with an output schema", () => {
  it("reports the final agent message as the turn's result when it satisfies the schema", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, [
      buildAgentMessage(JSON.stringify(ANSWER)),
    ]);

    expect(completed.state).toBe("completed");
    expect(completed.structuredResult).toEqual({ outcome: "ok", value: ANSWER });
  });

  it("reports a schema failure when the final agent message is not JSON at all", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, [
      buildAgentMessage("I had a look and I would accept it."),
    ]);

    // The adapter chooses the wording. The test only asserts that a reason is
    // present.
    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringMatching(/\S/) as string,
    });
  });

  it("reports a schema failure naming the field when the message is JSON the schema rejects", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, [
      buildAgentMessage(JSON.stringify({ verdict: "maybe", confidence: 0.9 })),
    ]);

    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("verdict") as string,
    });
  });

  it("reports a schema failure when the turn ended on an item that is not an agent message", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, [
      buildAgentMessage(JSON.stringify(ANSWER)),
      COMMAND,
    ]);

    // Reported at once rather than retried. The one such failure seen live was
    // the API refusing the schema, and a second identical turn would be
    // refused again (spec 06 section 7). An earlier message is not the answer
    // either, because the turn kept working after it.
    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringMatching(/\S/) as string,
    });
  });

  it("has no structured result on a session without a schema", async () => {
    const completed = await runTurnToCompletion(SPEC, [buildAgentMessage(JSON.stringify(ANSWER))]);

    // The key is absent, rather than an `ok` with no schema. A Thread answers
    // in prose, and a result on every turn of every session would give "ok" a
    // second meaning.
    expect("structuredResult" in completed).toBe(false);
  });

  it("has no structured result on a turn that failed or was interrupted", async () => {
    const failed = await runTurnToCompletion(STRUCTURED, [COMMAND], "failed");
    const interrupted = await runTurnToCompletion(STRUCTURED, [COMMAND], "interrupted");

    // The turn ended for a reason unrelated to the schema. A `schema-failure`
    // here would claim that an answer was checked and rejected.
    expect("structuredResult" in failed).toBe(false);
    expect("structuredResult" in interrupted).toBe(false);
  });

  it("judges each turn on its own answer, never on the turn before it", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));
    completeTurn(run, [buildAgentMessage(JSON.stringify(ANSWER))]);
    await waitUntil(
      "closed the first turn",
      () => filterByTag(run.seen, "turn.completed").length === 1,
    );

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "And this one." }));
    run.spawns[0]!.push({
      method: "turn/started",
      params: {
        threadId: THREAD,
        turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" },
      },
    });
    completeTurn(run, []);
    await waitUntil(
      "closed the second turn",
      () => filterByTag(run.seen, "turn.completed").length === 2,
    );

    // If the first turn's answer were kept, it would be reported as the
    // second turn's answer, and nobody could tell that stale result from a
    // fresh one.
    expect(filterByTag(run.seen, "turn.completed")[1]!.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: "the turn ended without a final agent message",
    });
  });

  it("reads the answer from the item/completed notifications, not from the turn/completed item list", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));

    // This completion lists only some of its items, as its `itemsView` says.
    // A list that may be incomplete cannot be trusted for the turn's answer.
    run.spawns[0]!.push({
      method: "turn/completed",
      params: {
        threadId: THREAD,
        turn: {
          id: TURN,
          items: [buildAgentMessage(JSON.stringify(ANSWER))],
          itemsView: "summary",
          status: "completed",
        },
      },
    });
    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);

    expect(filterByTag(run.seen, "turn.completed")[0]!.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: "the turn ended without a final agent message",
    });
  });
});

/**
 * The API's error when it cannot enforce the schema itself, captured from
 * codex 0.154.0 with the impossible fixture. The turn fails before the model
 * runs, and the message includes the name Codex gives the response format.
 */
const REFUSED = [
  '{\n  "type": "error",\n  "error": {\n    "type": "invalid_request_error",',
  '\n    "code": "invalid_json_schema",',
  '\n    "message": "Invalid schema for response_format \'codex_output_schema\': ',
  "context=('properties', 'answer'), const value b does not validate against ",
  "{'type': 'string', 'enum': ['a']}.\",\n    \"param\": \"text.format.schema\"\n  },",
  '\n  "status": 400\n}',
].join("");

describe("a Codex turn whose schema the API rejected", () => {
  it("reports the API's error message as the schema failure, and keeps the turn's failed state", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Answer." }));

    run.spawns[0]!.push({
      method: "turn/completed",
      params: {
        threadId: THREAD,
        turn: {
          id: TURN,
          items: [],
          itemsView: "full",
          status: "failed",
          error: { message: REFUSED, codexErrorInfo: "other" },
        },
      },
    });
    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);

    // The reason is the API's own message, and the state is the one Codex
    // reported: the turn never reached the model, and it failed because of the
    // schema. The rest of the error body (status, param, type) is left out,
    // because it would mean nothing to a reader of the transcript.
    const completed = filterByTag(run.seen, "turn.completed")[0]!;
    expect(completed.state).toBe("failed");
    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringMatching(/^Invalid schema for response_format/) as string,
    });
  });
});

const CHILD = "0199e0e7-0000-7000-8000-0000000000b1";
const GRANDCHILD = "0199e0e7-0000-7000-8000-0000000000b2";
const SIBLING = "0199e0e7-0000-7000-8000-0000000000b3";

const readSubagentMetadata = (params: unknown) => {
  const { threadId } = params as { threadId: string };
  return {
    thread: {
      id: threadId,
      parentThreadId: threadId === GRANDCHILD ? CHILD : THREAD,
      model: "child-model",
      agentRole: "reviewer",
      agentNickname: "Inspector",
    },
  };
};

const pushNativeTurn = (
  server: Spawn,
  threadId: string,
  turnId: string,
  status = "inProgress",
): void => {
  server.push({
    method: status === "inProgress" ? "turn/started" : "turn/completed",
    params: { threadId, turn: { id: turnId, status, items: [], itemsView: "full" } },
  });
};

/** Holds metadata replies and exposes the actual RPC ids written by the adapter. */
const createDelayedMetadataSession = async (spec: SessionSpec = SPEC, answers: Answers = {}) => {
  const run = buildScriptedSeam({ "thread/read": SILENT, ...answers });
  const metadataIds = new Map<string, string | number>();
  const submittedIds = new Map<string, string | number>();
  const interruptedIds = new Map<string, string | number>();
  const adapter = makeCodexAdapter({
    ...run.seam,
    appServer: (command, env) => {
      const child = run.seam.appServer(command, env);
      return {
        ...child,
        write: (text: string) => {
          for (const line of text.split("\n")) {
            if (line.trim() === "") continue;
            const frame = JSON.parse(line) as {
              id: string | number;
              method: string;
              params: { threadId: string };
            };
            if (frame.method === "thread/read") metadataIds.set(frame.params.threadId, frame.id);
            if (frame.method === "turn/start") submittedIds.set(frame.method, frame.id);
            if (frame.method === "turn/interrupt")
              interruptedIds.set(frame.params.threadId, frame.id);
          }
          child.write(text);
        },
      };
    },
  });
  const seen: ProviderEvent[] = [];
  Effect.runFork(
    Stream.runForEach(adapter.events, (event) =>
      Effect.sync(() => {
        seen.push(event);
      }),
    ),
  );
  await settle();
  await Effect.runPromise(
    adapter.startSession(SESSION, spec, buildContext(createCodexHome(), CWD)),
  );
  const server = run.spawns[0]!;
  const releaseMetadata = (threadId: string, parentThreadId = THREAD): void => {
    server.push({
      id: metadataIds.get(threadId),
      result: {
        thread: {
          id: threadId,
          parentThreadId,
          model: "child-model",
          agentRole: "reviewer",
          agentNickname: "Inspector",
        },
      },
    });
  };
  return {
    ...run,
    adapter,
    server,
    seen,
    metadataIds,
    submittedIds,
    interruptedIds,
    releaseMetadata,
  };
};

describe("stopping a Codex session's subagents", () => {
  it("stops a child and grandchild while leaving the sibling and root running", async () => {
    const run = await startBusySession({ "thread/read": readSubagentMetadata });
    for (const [id, turn] of [
      [CHILD, "child-turn"],
      [GRANDCHILD, "grandchild-turn"],
      [SIBLING, "sibling-turn"],
    ])
      pushNativeTurn(run.server, id!, turn!);
    await waitUntil(
      "reported all four turns",
      () => filterByTag(run.seen, "turn.started").length === 4,
    );
    await Effect.runPromise(run.adapter.interrupt(SESSION, CHILD));
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual(
      expect.arrayContaining([
        { threadId: CHILD, turnId: "child-turn" },
        { threadId: GRANDCHILD, turnId: "grandchild-turn" },
      ]),
    );
    expect(listSentParams(run.requests, "turn/interrupt")).toHaveLength(2);
    expect(
      await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "keep inspecting" })),
    ).toEqual({ turnId: TURN, delivery: "steered" });
    pushNativeTurn(run.server, CHILD, "child-turn", "interrupted");
    pushNativeTurn(run.server, CHILD, "continued-turn");
    await waitUntil("reported continued child work", () =>
      filterByTag(run.seen, "turn.started").some((event) => event.turnId === "continued-turn"),
    );
    expect(listSentParams(run.requests, "turn/interrupt")).toHaveLength(2);
  });

  it("stops background work while the root is idle, catches late child turns and allows the next message", async () => {
    const run = await startBusySession({ "thread/read": readSubagentMetadata });
    pushNativeTurn(run.server, CHILD, "child-turn");
    pushNativeTurn(run.server, THREAD, TURN, "completed");
    await waitUntil(
      "ended the root and started the child",
      () =>
        filterByTag(run.seen, "turn.completed").length === 1 &&
        filterByTag(run.seen, "turn.started").length === 2,
    );
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: CHILD, turnId: "child-turn" },
    ]);
    pushNativeTurn(run.server, SIBLING, "late-turn");
    await waitUntil(
      "interrupted the late child",
      () => listSentParams(run.requests, "turn/interrupt").length === 2,
    );
    pushNativeTurn(run.server, CHILD, "child-turn", "interrupted");
    pushNativeTurn(run.server, SIBLING, "late-turn", "interrupted");
    await settle();
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "start again" }));
    for (const [threadId, turnId, id] of [
      [THREAD, TURN, "root-approval"],
      [CHILD, "new-child-turn", "child-approval"],
    ]) {
      pushNativeTurn(run.server, threadId!, turnId!);
      run.server.push({
        id,
        method: "item/commandExecution/requestApproval",
        params: { threadId, turnId, itemId: `${id}-item`, command: "ls" },
      });
    }
    await waitUntil(
      "opened new root and child approvals",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
    expect(run.answered).toEqual([]);
    expect(listSentParams(run.requests, "turn/interrupt")).toHaveLength(2);
  });

  it("interrupts a turn whose metadata reply arrives after Stop", async () => {
    const run = await createDelayedMetadataSession();
    pushNativeTurn(run.server, CHILD, "late-turn");
    await waitUntil("requested child metadata", () => run.metadataIds.has(CHILD));
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([]);
    run.releaseMetadata(CHILD);
    await waitUntil(
      "interrupted the delayed child",
      () => listSentParams(run.requests, "turn/interrupt").length === 1,
    );
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: CHILD, turnId: "late-turn" },
    ]);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("keeps newly arriving Requests cancelled until the next input is accepted", async () => {
    const run = await startTestSession({ "thread/read": readSubagentMetadata });
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    run.server.push({
      id: "late-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: CHILD, turnId: "late-turn", itemId: "late-item", command: "ls" },
    });
    await waitUntil("cancelled the late approval", () =>
      run.answered.some((reply) => reply.id === "late-approval"),
    );
    expect(run.answered).toEqual([{ id: "late-approval", result: { decision: "cancel" } }]);
    expect(filterByTag(run.seen, "request.resolved")[0]).toMatchObject({
      subagentId: CHILD,
      decision: "cancel",
    });
  });
});

describe("bounded Codex subagent discovery", () => {
  it("keeps turn and usage frames by dropping queued transcript deltas first", async () => {
    const run = await createDelayedMetadataSession();
    // The turn's start comes first, as Codex sends it: deltas of a turn that
    // has not started are not shown.
    pushNativeTurn(run.server, SIBLING, "chatty-turn");
    for (let index = 0; index < MAX_PENDING_FRAMES; index += 1)
      run.server.push({
        method: "item/agentMessage/delta",
        params: { threadId: SIBLING, turnId: "chatty-turn", itemId: "item", delta: "text" },
      });
    pushNativeTurn(run.server, CHILD, "child-turn");
    pushChildCounterReport(run.server, buildChildCounterReport(900, 100));
    await waitUntil("requested both child metadata", () => run.metadataIds.size === 2);
    run.releaseMetadata(SIBLING);
    run.releaseMetadata(CHILD);
    await waitUntil(
      "reported retained child usage",
      () => filterByTag(run.seen, "session.usage.updated").length === 2,
    );
    // Three control frames (the sibling's turn, the child's turn and its usage
    // report) each push one delta out of the full queue.
    expect(filterByTag(run.seen, "content.delta")).toHaveLength(MAX_PENDING_FRAMES - 3);
    const reports = filterByTag(run.seen, "session.usage.updated");
    expect(reports.at(-1)?.usage).toEqual({
      inputTokens: 900,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(reports.at(-1)?.raw).toBeUndefined();
    expect(reports.at(-1)?.providerRefs).toBeUndefined();
    expect(filterByTag(run.seen, "runtime.warning")[0]?.message).toContain("Dropped 3 frames");
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("exits visibly if retaining lifecycle would exceed the queue bounds", async () => {
    const run = await createDelayedMetadataSession();
    for (let index = 0; index < MAX_PENDING_FRAMES / 2; index += 1) {
      pushNativeTurn(run.server, CHILD, `turn-${index}`);
      pushNativeTurn(run.server, CHILD, `turn-${index}`, "completed");
    }
    pushNativeTurn(run.server, SIBLING, "overflow-turn");
    await waitUntil(
      "reported lifecycle overflow exit",
      () => filterByTag(run.seen, "session.exited").length === 1,
    );
    expect(filterByTag(run.seen, "session.exited")[0]?.reason).toBe("crash");
    expect(
      filterByTag(run.seen, "runtime.warning").some((event) =>
        event.message.includes("losing its lifecycle"),
      ),
    ).toBe(true);
    expect(filterByTag(run.seen, "session.usage.updated").at(-1)?.usageReport?.status).toBe(
      "incomplete",
    );
    expect(run.server.kills()).toBe(1);
    expect(run.seen.at(-1)?._tag).toBe("session.exited");
  });

  it("aggregates capacity warnings and reports the dropped count when capacity returns", async () => {
    const run = await createDelayedMetadataSession();
    for (let index = 0; index < MAX_PENDING_THREADS; index += 1)
      pushNativeTurn(run.server, `pending-${index}`, `turn-${index}`);
    await waitUntil("filled metadata capacity", () => run.metadataIds.size === MAX_PENDING_THREADS);
    for (let index = 0; index < 101; index += 1)
      run.server.push({
        method: "item/agentMessage/delta",
        params: { threadId: "overflow", turnId: "overflow-turn", itemId: "item", delta: "text" },
      });
    await waitUntil(
      "reported metadata capacity overflow",
      () => filterByTag(run.seen, "runtime.warning").length !== 0,
    );
    await settle();
    expect(filterByTag(run.seen, "runtime.warning")).toHaveLength(1);
    run.releaseMetadata("pending-0");
    await waitUntil(
      "reported aggregate drop count",
      () => filterByTag(run.seen, "runtime.warning").length === 2,
    );
    expect(filterByTag(run.seen, "runtime.warning")[1]?.message).toContain(
      "Dropped 101 Codex subagent frames",
    );
    expect(filterByTag(run.seen, "session.usage.updated")[0]?.usageReport?.status).toBe(
      "incomplete",
    );
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("retains an authoritative parent when the parent's metadata cannot be read", async () => {
    const run = await createDelayedMetadataSession();
    for (let index = 0; index < MAX_PENDING_THREADS - 1; index += 1)
      pushNativeTurn(run.server, `pending-${index}`, `turn-${index}`);
    pushNativeTurn(run.server, GRANDCHILD, "grandchild-turn");
    await waitUntil("filled metadata capacity", () => run.metadataIds.size === MAX_PENDING_THREADS);
    run.releaseMetadata(GRANDCHILD, CHILD);
    await waitUntil(
      "introduced known ancestry without a parent lookup",
      () => filterByTag(run.seen, "subagent.started").length === 2,
    );
    expect(filterByTag(run.seen, "subagent.started").map((event) => event.subagentId)).toEqual([
      CHILD,
      GRANDCHILD,
    ]);
    expect(filterByTag(run.seen, "subagent.started")[1]?.parentSubagentId).toBe(CHILD);
    expect(run.metadataIds.has(CHILD)).toBe(false);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("introduces an unknown parent before releasing its grandchild's queued events", async () => {
    const run = await createDelayedMetadataSession();
    pushNativeTurn(run.server, GRANDCHILD, "grandchild-turn");
    await waitUntil("requested grandchild metadata", () => run.metadataIds.has(GRANDCHILD));
    run.releaseMetadata(GRANDCHILD, CHILD);
    await waitUntil("requested parent metadata", () => run.metadataIds.has(CHILD));
    expect(filterByTag(run.seen, "subagent.started")).toEqual([]);
    run.releaseMetadata(CHILD);
    await waitUntil(
      "reported grandchild turn",
      () => filterByTag(run.seen, "turn.started").length === 1,
    );
    expect(filterByTag(run.seen, "subagent.started").map((event) => event.subagentId)).toEqual([
      CHILD,
      GRANDCHILD,
    ]);
    expect(filterByTag(run.seen, "subagent.started")[1]?.parentSubagentId).toBe(CHILD);
    expect(filterByTag(run.seen, "turn.started")[0]?.subagentId).toBe(GRANDCHILD);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("rejects overflowing Requests explicitly and reports the dropped count", async () => {
    const run = await createDelayedMetadataSession();
    pushNativeTurn(run.server, CHILD, "child-turn");
    for (let index = 0; index < MAX_PENDING_FRAMES - 1; index += 1)
      run.server.push({
        method: "item/agentMessage/delta",
        params: { threadId: CHILD, turnId: "child-turn", itemId: "item", delta: "text" },
      });
    run.server.push({
      id: "overflow",
      method: "item/commandExecution/requestApproval",
      params: { threadId: CHILD, turnId: "child-turn", itemId: "approval", command: "ls" },
    });
    await waitUntil("rejected the overflowing Request", () =>
      run.answered.some((reply) => reply.id === "overflow"),
    );
    expect(run.answered[0]?.error?.code).toBe(-32603);
    run.releaseMetadata(CHILD);
    await waitUntil(
      "reported dropped frame count",
      () => filterByTag(run.seen, "runtime.warning").length === 1,
    );
    expect(filterByTag(run.seen, "content.delta")).toHaveLength(MAX_PENDING_FRAMES - 1);
    expect(filterByTag(run.seen, "runtime.warning")[0]?.message).toContain("Dropped 1 frames");
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("bounds bytes as well as frame count while metadata is pending", async () => {
    const run = await createDelayedMetadataSession();
    run.server.push({
      method: "item/agentMessage/delta",
      params: {
        threadId: CHILD,
        turnId: "child-turn",
        itemId: "item",
        delta: "x".repeat(MAX_PENDING_BYTES),
      },
    });
    await waitUntil("requested child metadata", () => run.metadataIds.has(CHILD));
    run.releaseMetadata(CHILD);
    await waitUntil(
      "reported dropped oversized frame",
      () => filterByTag(run.seen, "runtime.warning").length === 1,
    );
    expect(filterByTag(run.seen, "content.delta")).toEqual([]);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("drops pending metadata results after the hosting process exits", async () => {
    const run = await createDelayedMetadataSession();
    pushNativeTurn(run.server, CHILD, "child-turn");
    run.server.push({
      id: "child-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: CHILD, turnId: "child-turn", itemId: "approval", command: "ls" },
    });
    await waitUntil("requested child metadata", () => run.metadataIds.has(CHILD));
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    run.releaseMetadata(CHILD);
    await settle();
    expect(filterByTag(run.seen, "session.exited")).toHaveLength(1);
    expect(filterByTag(run.seen, "subagent.started")).toEqual([]);
    expect(filterByTag(run.seen, "turn.started")).toEqual([]);
    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
  });

  it("keeps a resumed subagent's original spawn item link and learns its unknown parent", async () => {
    const run = createDriving({ "thread/read": readSubagentMetadata });
    await Effect.runPromise(
      run.adapter.startSession(
        SESSION,
        {
          ...SPEC,
          continue: {
            nativeSessionId: PRIOR,
            mode: "resume",
            subagents: [{ subagentId: GRANDCHILD, itemId: "original-spawn" }],
          },
        },
        run.ctx,
      ),
    );
    pushNativeTurn(run.spawns[0]!, GRANDCHILD, "resumed-child-turn");
    await waitUntil(
      "introduced resumed child",
      () => filterByTag(run.seen, "subagent.started").length === 2,
    );
    expect(filterByTag(run.seen, "subagent.started")[1]).toMatchObject({
      subagentId: GRANDCHILD,
      parentSubagentId: CHILD,
      itemId: "original-spawn",
    });
  });

  it("uses thread/read nickname before the V2 path and accepts native thread/started discovery", async () => {
    const run = await startTestSession({ "thread/read": readSubagentMetadata });
    run.server.push({
      method: "item/started",
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: "subAgentActivity",
          id: "spawn-item",
          kind: "started",
          agentThreadId: CHILD,
          agentPath: "parent/path-name",
        },
      },
    });
    run.server.push({ method: "thread/started", params: { thread: { id: CHILD } } });
    await waitUntil(
      "introduced the V2 child",
      () => filterByTag(run.seen, "subagent.started").length === 1,
    );
    expect(filterByTag(run.seen, "subagent.started")[0]).toMatchObject({
      subagentId: CHILD,
      itemId: "spawn-item",
      description: "Inspector",
    });
    expect(listSentParams(run.requests, "thread/read")).toHaveLength(1);
  });

  it.each(["metadata-first", "spawn-first"])(
    "stores the exact V1 brief with %s ordering",
    async (order) => {
      const run = await createDelayedMetadataSession();
      const prompt = "Review database correctness.\nReport any defects.";
      const spawn = {
        type: "collabAgentToolCall",
        id: "spawn-brief",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: THREAD,
        receiverThreadIds: [CHILD],
        prompt,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      };
      const completedSpawn = () =>
        run.server.push({
          method: "item/completed",
          params: { threadId: THREAD, turnId: TURN, item: spawn },
        });
      if (order === "spawn-first") completedSpawn();
      pushNativeTurn(run.server, CHILD, "child-turn");
      await waitUntil(
        "requested child metadata",
        () => listSentParams(run.requests, "thread/read").length === 1,
      );
      run.server.push({
        id: run.metadataIds.get(CHILD),
        result: {
          thread: {
            id: CHILD,
            parentThreadId: THREAD,
            agentNickname: "Zeno",
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: THREAD,
                  depth: 1,
                  agent_path: null,
                  agent_nickname: "Zeno",
                  agent_role: null,
                },
              },
            },
          },
        },
      });
      await waitUntil(
        "introduced V1 child",
        () => filterByTag(run.seen, "subagent.started").length === 1,
      );
      if (order === "metadata-first") completedSpawn();
      run.server.push({
        method: "item/started",
        params: {
          threadId: CHILD,
          turnId: "child-turn",
          item: {
            type: "userMessage",
            id: "native-brief",
            clientId: null,
            content: [{ type: "text", text: prompt, text_elements: [] }],
          },
        },
      });
      await waitUntil("reported native V1 brief", () =>
        filterByTag(run.seen, "item.started").some(
          (event) => event.subagentId === CHILD && event.kind === "user_message",
        ),
      );
      const record = run.seen.reduce(
        (record, event) => computeSubagentAfter(record, event, { inFirstTurn: true }),
        createBareSubagent(SESSION, CHILD, new Date().toISOString()),
      );
      expect(record.description).toBe("Review database correctness.");
      expect(filterByTag(run.seen, "subagent.started")).toHaveLength(1);
      await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    },
  );

  it("keeps the V2 nickname when child metadata precedes the parent activity", async () => {
    const run = await startTestSession({
      "thread/read": () => ({
        thread: {
          id: CHILD,
          parentThreadId: THREAD,
          agentNickname: "Zeno",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: THREAD,
                depth: 1,
                agent_path: "/root/database",
                agent_nickname: "Zeno",
                agent_role: null,
              },
            },
          },
        },
      }),
    });
    pushNativeTurn(run.server, CHILD, "child-turn");
    await waitUntil(
      "introduced child before V2 activity",
      () => filterByTag(run.seen, "subagent.started").length === 1,
    );
    run.server.push({
      method: "item/started",
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: "subAgentActivity",
          id: "spawn-activity",
          kind: "started",
          agentThreadId: CHILD,
          agentPath: "/root/database",
        },
      },
    });
    await settle();
    expect(filterByTag(run.seen, "subagent.started")).toHaveLength(1);
    expect(filterByTag(run.seen, "subagent.started")[0]).toMatchObject({
      subagentId: CHILD,
      description: "Zeno",
    });
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });
});

describe("Codex metadata lookup failures and Stop races", () => {
  it("releases a resumed descendant through known ancestors when metadata capacity is full", async () => {
    const descendant = "resumed-descendant";
    const run = await createDelayedMetadataSession({
      ...SPEC,
      continue: {
        nativeSessionId: PRIOR,
        mode: "resume",
        subagents: [
          { subagentId: CHILD },
          { subagentId: GRANDCHILD, parentSubagentId: CHILD },
          { subagentId: descendant, parentSubagentId: GRANDCHILD },
        ],
      },
    });
    for (let index = 0; index < MAX_PENDING_THREADS - 1; index += 1)
      pushNativeTurn(run.server, `pending-${index}`, `turn-${index}`);
    pushNativeTurn(run.server, descendant, "descendant-turn");
    await waitUntil("filled metadata capacity", () => run.metadataIds.size === MAX_PENDING_THREADS);
    run.releaseMetadata(descendant, GRANDCHILD);
    await waitUntil(
      "released resumed descendant through its known ancestors",
      () => filterByTag(run.seen, "turn.started").length === 1,
    );
    expect(filterByTag(run.seen, "subagent.started").map((event) => event.subagentId)).toEqual([
      CHILD,
      GRANDCHILD,
      descendant,
    ]);
    expect(run.metadataIds.size).toBe(MAX_PENDING_THREADS);
    await Effect.runPromise(run.adapter.interrupt(SESSION, CHILD));
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: descendant, turnId: "descendant-turn" },
    ]);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it.each([true, false])(
    "retains resumed ancestry with parent turn %s and stops its subtree when metadata cannot be read",
    async (hasParentTurn) => {
      const run = createDriving({
        "thread/read": () => buildRefusal("thread metadata unavailable"),
      });
      await Effect.runPromise(
        run.adapter.startSession(
          SESSION,
          {
            ...SPEC,
            continue: {
              nativeSessionId: PRIOR,
              mode: "resume",
              subagents: [
                { subagentId: CHILD },
                { subagentId: GRANDCHILD, parentSubagentId: CHILD },
                { subagentId: SIBLING },
              ],
            },
          },
          run.ctx,
        ),
      );
      if (hasParentTurn) pushNativeTurn(run.spawns[0]!, CHILD, "child-turn");
      for (const [id, turn] of [
        [GRANDCHILD, "grandchild-turn"],
        [SIBLING, "sibling-turn"],
      ] as const)
        pushNativeTurn(run.spawns[0]!, id, turn);
      run.spawns[0]!.push({
        id: "resumed-descendant-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: GRANDCHILD,
          turnId: "grandchild-turn",
          itemId: "approval",
          command: "ls",
        },
      });
      await waitUntil(
        "reported all resumed turns after metadata refusals",
        () =>
          filterByTag(run.seen, "turn.started").length === (hasParentTurn ? 3 : 2) &&
          filterByTag(run.seen, "request.opened").length === 1,
      );
      await Effect.runPromise(run.adapter.interrupt(SESSION, CHILD));
      expect(listSentParams(run.requests, "turn/interrupt")).toEqual(
        expect.arrayContaining([
          ...(hasParentTurn ? [{ threadId: CHILD, turnId: "child-turn" }] : []),
          { threadId: GRANDCHILD, turnId: "grandchild-turn" },
        ]),
      );
      expect(listSentParams(run.requests, "turn/interrupt")).toHaveLength(hasParentTurn ? 2 : 1);
      expect(
        filterByTag(run.seen, "subagent.started").find((event) => event.subagentId === GRANDCHILD),
      ).toMatchObject({ parentSubagentId: CHILD });
      expect(run.answered).toEqual([
        { id: "resumed-descendant-approval", result: { decision: "cancel" } },
      ]);
      expect(filterByTag(run.seen, "request.resolved")).toMatchObject([
        { subagentId: GRANDCHILD, decision: "cancel" },
      ]);
    },
  );

  it("introduces a child after a metadata refusal and keeps its approval answerable", async () => {
    const run = await startTestSession({
      "thread/read": () => buildRefusal("thread metadata unavailable"),
    });
    run.server.push({
      id: "child-request",
      method: "item/commandExecution/requestApproval",
      params: { threadId: CHILD, turnId: "child-turn", itemId: "approval", command: "ls" },
    });
    await waitUntil(
      "opened child Request after lookup failure",
      () => filterByTag(run.seen, "request.opened").length === 1,
    );
    const started = filterByTag(run.seen, "subagent.started")[0]!;
    expect(started).toMatchObject({ subagentId: CHILD });
    expect(started.parentSubagentId).toBeUndefined();
    expect(filterByTag(run.seen, "runtime.warning")).toHaveLength(1);
    const opened = filterByTag(run.seen, "request.opened")[0]!;
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, opened.request.requestId, "allow"),
    );
    expect(run.answered).toEqual([{ id: "child-request", result: { decision: "accept" } }]);
  });

  it("times out a silent metadata read and releases the held turn", async () => {
    const run = await createDelayedMetadataSession();
    pushNativeTurn(run.server, CHILD, "child-turn");
    await waitUntil(
      "released the turn after metadata timeout",
      () => filterByTag(run.seen, "turn.started").length === 1,
      7000,
    );
    expect(filterByTag(run.seen, "subagent.started")[0]?.subagentId).toBe(CHILD);
    expect(filterByTag(run.seen, "runtime.warning")[0]?.message).toContain(
      "Could not read metadata",
    );
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  }, 8000);

  it("bounds concurrent reads and admits new discoveries after earlier reads finish", async () => {
    const run = await createDelayedMetadataSession();
    for (let index = 0; index < MAX_PENDING_THREADS; index += 1)
      pushNativeTurn(run.server, `child-${index}`, `turn-${index}`);
    run.server.push({
      id: "lookup-overflow",
      method: "item/commandExecution/requestApproval",
      params: { threadId: CHILD, turnId: "child-turn", itemId: "approval", command: "ls" },
    });
    await waitUntil("rejected lookup overflow", () =>
      run.answered.some((reply) => reply.id === "lookup-overflow"),
    );
    expect(run.metadataIds.size).toBe(MAX_PENDING_THREADS);
    expect(filterByTag(run.seen, "runtime.warning")[0]?.message).toContain("metadata lookup limit");
    run.releaseMetadata("child-0");
    await waitUntil(
      "introduced first child",
      () => filterByTag(run.seen, "subagent.started").length === 1,
    );
    pushNativeTurn(run.server, CHILD, "child-turn");
    await waitUntil("admitted another lookup", () => run.metadataIds.has(CHILD));
    run.releaseMetadata(CHILD);
    await waitUntil(
      "introduced another child",
      () => filterByTag(run.seen, "subagent.started").length === 2,
    );
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("stops an undiscovered grandchild even after its stopped parent completes", async () => {
    const run = await createDelayedMetadataSession();
    pushNativeTurn(run.server, CHILD, "child-turn");
    await waitUntil("requested child metadata", () => run.metadataIds.has(CHILD));
    run.releaseMetadata(CHILD);
    await waitUntil("started child", () => filterByTag(run.seen, "turn.started").length === 1);
    pushNativeTurn(run.server, GRANDCHILD, "grandchild-turn");
    await waitUntil("requested grandchild metadata", () => run.metadataIds.has(GRANDCHILD));
    await Effect.runPromise(run.adapter.interrupt(SESSION, CHILD));
    pushNativeTurn(run.server, CHILD, "child-turn", "interrupted");
    await waitUntil("ended child", () => filterByTag(run.seen, "turn.completed").length === 1);
    run.releaseMetadata(GRANDCHILD, CHILD);
    await waitUntil(
      "stopped delayed grandchild",
      () => listSentParams(run.requests, "turn/interrupt").length === 2,
    );
    expect(listSentParams(run.requests, "turn/interrupt")[1]).toEqual({
      threadId: GRANDCHILD,
      turnId: "grandchild-turn",
    });
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });
});

describe("subagent introductions under a full metadata queue", () => {
  it("introduces every child listed by a parent item without exceeding the lookup cap", async () => {
    const run = await createDelayedMetadataSession();
    for (let index = 0; index < MAX_PENDING_THREADS; index += 1)
      pushNativeTurn(run.server, `pending-${index}`, `turn-${index}`);
    await waitUntil("filled metadata lookups", () => run.metadataIds.size === MAX_PENDING_THREADS);
    pushNativeTurn(run.server, THREAD, TURN);
    run.server.push({
      method: "item/started",
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: "collabAgentToolCall",
          id: "overflow-spawn",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: THREAD,
          receiverThreadIds: [CHILD],
          prompt: "Review the changes",
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      },
    });
    await waitUntil(
      "introduced the listed child",
      () => filterByTag(run.seen, "subagent.started").length === 1,
    );
    expect(filterByTag(run.seen, "subagent.started")[0]).toMatchObject({
      subagentId: CHILD,
      itemId: "overflow-spawn",
      description: "Review the changes",
    });
    expect(filterByTag(run.seen, "item.started")[0]?.detail).toMatchObject({
      subagentIds: [CHILD],
    });
    expect(run.metadataIds.size).toBe(MAX_PENDING_THREADS);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("continues replay after a malformed buffered item", async () => {
    const run = await createDelayedMetadataSession();
    run.server.push({ method: "item/started", params: { threadId: CHILD, turnId: "child-turn" } });
    pushNativeTurn(run.server, CHILD, "child-turn");
    await waitUntil("requested metadata", () => run.metadataIds.has(CHILD));
    run.releaseMetadata(CHILD);
    await waitUntil(
      "replayed the valid turn",
      () => filterByTag(run.seen, "turn.started").length === 1,
    );
    expect(filterByTag(run.seen, "runtime.warning")).toHaveLength(1);
    expect(filterByTag(run.seen, "turn.started")[0]?.subagentId).toBe(CHILD);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });
});

const buildChildCounterReport = (
  inputTokens: number,
  outputTokens: number,
  lastInput = inputTokens,
  lastOutput = outputTokens,
) => {
  const count = (input: number, output: number) => ({
    inputTokens: input,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + output,
  });
  return {
    source: "codex.app-server.notification",
    payload: {
      threadId: CHILD,
      turnId: "child-turn",
      tokenUsage: {
        total: count(inputTokens, outputTokens),
        last: count(lastInput, lastOutput),
        modelContextWindow: 272000,
      },
    },
  };
};

const buildResumedChildSpec = (
  lastUsageReport?: ReturnType<typeof buildChildCounterReport>,
): SessionSpec => ({
  ...SPEC,
  continue: {
    nativeSessionId: THREAD,
    mode: "resume",
    subagents: [
      {
        subagentId: CHILD,
        itemId: "original-spawn",
        ...(lastUsageReport === undefined ? {} : { lastUsageReport }),
      },
    ],
  },
});

const pushChildCounterReport = (
  server: Spawn,
  report: ReturnType<typeof buildChildCounterReport>,
): void => {
  server.push({ method: "thread/tokenUsage/updated", params: report.payload });
};

describe("restoring Codex subagent counters before continuation", () => {
  it("preserves a usable baseline across a malformed current report and recovers growth", async () => {
    const run = createDriving({ "thread/read": readSubagentMetadata });
    await Effect.runPromise(
      run.adapter.startSession(
        SESSION,
        buildResumedChildSpec(buildChildCounterReport(50000, 5000)),
        run.ctx,
      ),
    );
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "continue" }));
    pushNativeTurn(run.spawns[0]!, CHILD, "child-turn");
    pushChildCounterReport(run.spawns[0]!, buildChildCounterReport(52000, 5200));
    const invalid = buildChildCounterReport(53000, 5300);
    pushChildCounterReport(run.spawns[0]!, {
      ...invalid,
      payload: {
        ...invalid.payload,
        tokenUsage: {
          ...invalid.payload.tokenUsage,
          total: { ...invalid.payload.tokenUsage.total, cachedInputTokens: -1 },
        },
      },
    });
    pushChildCounterReport(run.spawns[0]!, buildChildCounterReport(55000, 5500));
    await waitUntil(
      "reported recovered cumulative growth",
      () =>
        filterByTag(run.seen, "session.usage.updated").filter((event) => event.subagentId === CHILD)
          .length === 2,
    );
    const reports = filterByTag(run.seen, "session.usage.updated").filter(
      (event) => event.subagentId === CHILD,
    );
    expect(reports.map((event) => event.usage)).toEqual([
      { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 5000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(reports.every((event) => event.usageReport === undefined)).toBe(true);
    expect(filterByTag(run.seen, "runtime.warning")[0]?.message).toContain(
      "Keeping the last usable counters",
    );
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("keeps rejected usage replay incomplete instead of treating it as an unused child", async () => {
    const run = await createDelayedMetadataSession(buildResumedChildSpec(), {
      "thread/resume": readSubagentMetadata,
    });
    const sending = Effect.runPromise(run.adapter.sendInput(SESSION, { text: "continue" }));
    await waitUntil("awaited replay barrier", () => run.metadataIds.has(CHILD));
    const invalid = buildChildCounterReport(300, 10);
    pushChildCounterReport(run.server, {
      ...invalid,
      payload: {
        ...invalid.payload,
        tokenUsage: {
          ...invalid.payload.tokenUsage,
          total: { ...invalid.payload.tokenUsage.total, cachedInputTokens: -1 },
        },
      },
    });
    await waitUntil(
      "reported rejected replay",
      () => filterByTag(run.seen, "runtime.warning").length !== 0,
    );
    run.releaseMetadata(CHILD);
    await sending;
    pushNativeTurn(run.server, CHILD, "child-turn");
    pushChildCounterReport(run.server, buildChildCounterReport(300, 10, 0, 0));
    await waitUntil("reported post-replay counters", () =>
      filterByTag(run.seen, "session.usage.updated").some((event) => event.subagentId === CHILD),
    );
    await settle();
    const childReports = filterByTag(run.seen, "session.usage.updated").filter(
      (event) => event.subagentId === CHILD,
    );
    expect(
      childReports.every(
        (event) => event.usage === undefined && event.usageReport?.status === "incomplete",
      ),
    ).toBe(true);
    expect(childReports.at(-1)?.usageReport?.counts).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(
      filterByTag(run.seen, "runtime.warning").some((event) =>
        event.message.includes("incomplete"),
      ),
    ).toBe(true);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("uses a saved report without loading child context and counts only post-resume usage", async () => {
    const history = buildChildCounterReport(50000, 5000, 8000, 1000);
    const run = createDriving({ "thread/read": readSubagentMetadata });
    await Effect.runPromise(
      run.adapter.startSession(SESSION, buildResumedChildSpec(history), run.ctx),
    );
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "continue" }));
    expect(listSentParams(run.requests, "thread/resume")).toHaveLength(1);
    expect(listSentParams(run.requests, "thread/read")).toEqual([]);
    pushNativeTurn(run.spawns[0]!, CHILD, "child-turn");
    pushChildCounterReport(run.spawns[0]!, history);
    pushChildCounterReport(run.spawns[0]!, buildChildCounterReport(62000, 6000, 12000, 1000));
    await waitUntil(
      "reported repeated and new child counters",
      () => filterByTag(run.seen, "session.usage.updated").length === 4,
    );
    const childUsage = filterByTag(run.seen, "session.usage.updated").filter(
      (event) => event.subagentId === CHILD,
    );
    expect(childUsage.map((event) => event.usage)).toEqual([
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 12000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(filterByTag(run.seen, "session.usage.updated").at(-1)?.usage).toEqual(
      childUsage[1]!.usage,
    );
  });

  it("waits for the same-thread read barrier to consume usage replay before root input", async () => {
    const run = await createDelayedMetadataSession(buildResumedChildSpec(), {
      "thread/resume": readSubagentMetadata,
    });
    const sending = Effect.runPromise(run.adapter.sendInput(SESSION, { text: "continue" }));
    await waitUntil("requested the child replay barrier", () => run.metadataIds.has(CHILD));
    expect(listSentParams(run.requests, "turn/start")).toEqual([]);
    expect(listSentParams(run.requests, "thread/resume")[1]).toEqual({
      threadId: CHILD,
      excludeTurns: false,
    });
    pushChildCounterReport(run.server, buildChildCounterReport(50000, 5000, 8000, 1000));
    run.releaseMetadata(CHILD);
    await sending;
    pushNativeTurn(run.server, CHILD, "child-turn");
    pushChildCounterReport(run.server, buildChildCounterReport(50000, 5000, 8000, 1000));
    await waitUntil(
      "reported zero usage for cancellation",
      () => filterByTag(run.seen, "session.usage.updated").length === 2,
    );
    expect(filterByTag(run.seen, "session.usage.updated")[0]?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "continue again" }));
    expect(listSentParams(run.requests, "thread/resume")).toHaveLength(2);
    expect(listSentParams(run.requests, "thread/read")).toHaveLength(1);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("baselines an unused child at zero when the completed replay contains no usage report", async () => {
    const run = createDriving({
      "thread/resume": readSubagentMetadata,
      "thread/read": readSubagentMetadata,
    });
    await Effect.runPromise(run.adapter.startSession(SESSION, buildResumedChildSpec(), run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "continue" }));
    pushNativeTurn(run.spawns[0]!, CHILD, "child-turn");
    pushChildCounterReport(run.spawns[0]!, buildChildCounterReport(200, 30));
    await waitUntil(
      "reported unused child's first call",
      () => filterByTag(run.seen, "session.usage.updated").length === 2,
    );
    expect(filterByTag(run.seen, "session.usage.updated")[0]?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(listSentParams(run.requests, "thread/read")).toEqual([
      { threadId: CHILD, includeTurns: false },
    ]);
  });

  it("continues with visibly incomplete usage when a missing child counter cannot be restored", async () => {
    const run = createDriving({
      "thread/read": readSubagentMetadata,
      "thread/resume": (params) => {
        const { threadId } = params as { threadId: string };
        return threadId === CHILD
          ? buildRefusal("could not resume child")
          : { thread: { id: THREAD } };
      },
    });
    await Effect.runPromise(run.adapter.startSession(SESSION, buildResumedChildSpec(), run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "continue" }));
    expect(listSentParams(run.requests, "turn/start")).toHaveLength(1);
    await settle();
    expect(filterByTag(run.seen, "runtime.warning")[0]?.message).toContain("usage is incomplete");
    expect(filterByTag(run.seen, "session.usage.updated")[0]).toMatchObject({
      usageReport: { status: "incomplete" },
    });
    pushNativeTurn(run.spawns[0]!, CHILD, "child-turn");
    pushChildCounterReport(run.spawns[0]!, buildChildCounterReport(50000, 5000));
    pushChildCounterReport(run.spawns[0]!, buildChildCounterReport(52000, 5200));
    await waitUntil(
      "reported incomplete baseline and growth",
      () =>
        filterByTag(run.seen, "session.usage.updated").filter((event) => event.subagentId === CHILD)
          .length === 3,
    );
    const reports = filterByTag(run.seen, "session.usage.updated")
      .filter((event) => event.subagentId === CHILD)
      .slice(1);
    expect(reports.map((event) => event.usage)).toEqual([undefined, undefined]);
    expect(reports.map((event) => event.usageReport?.counts)).toEqual([
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });
});

describe("durable Codex Stop ownership", () => {
  it("cancels a queued first approval without needing a turn-start notification", async () => {
    const run = await createDelayedMetadataSession();
    run.server.push({
      id: "first-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: CHILD, turnId: "old-turn", itemId: "approval", command: "ls" },
    });
    await waitUntil("requested approval owner's metadata", () => run.metadataIds.has(CHILD));
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "new work" }));
    run.releaseMetadata(CHILD);
    await waitUntil(
      "reported queued first approval",
      () => filterByTag(run.seen, "request.opened").length === 1,
    );
    await settle();
    expect(run.answered).toEqual([{ id: "first-approval", result: { decision: "cancel" } }]);
    expect(listSentParams(run.requests, "turn/interrupt")).toContainEqual({
      threadId: CHILD,
      turnId: "old-turn",
    });
    expect(filterByTag(run.seen, "request.resolved")[0]?.requestId).toBe(
      filterByTag(run.seen, "request.opened")[0]?.request.requestId,
    );
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it.each([false, true])(
    "applies a targeted Stop when an existing child's parent is learned after continuation: %s",
    async (continued) => {
      const run = await startTestSession({
        "thread/read": (params) => {
          const { threadId } = params as { threadId: string };
          return { thread: { id: threadId, parentThreadId: threadId === CHILD ? THREAD : null } };
        },
      });
      pushNativeTurn(run.server, CHILD, "parent-turn");
      pushNativeTurn(run.server, SIBLING, "unlinked-turn");
      run.server.push({
        id: "late-link-approval",
        method: "item/commandExecution/requestApproval",
        params: { threadId: SIBLING, turnId: "unlinked-turn", itemId: "approval", command: "ls" },
      });
      await waitUntil(
        "reported unlinked approval",
        () => filterByTag(run.seen, "request.opened").length === 1,
      );
      await Effect.runPromise(run.adapter.interrupt(SESSION, CHILD));
      expect(run.answered).toEqual([]);
      if (continued) {
        pushNativeTurn(run.server, CHILD, "parent-turn", "interrupted");
        pushNativeTurn(run.server, CHILD, "continued-parent-turn");
        await waitUntil(
          "continued selected parent",
          () => filterByTag(run.seen, "turn.started").length === 3,
        );
      }
      run.server.push({
        method: "item/started",
        params: {
          threadId: CHILD,
          turnId: continued ? "continued-parent-turn" : "parent-turn",
          item: {
            type: "subAgentActivity",
            id: "late-spawn",
            kind: "started",
            agentThreadId: SIBLING,
            agentPath: "parent/child",
          },
        },
      });
      await waitUntil(
        "reported parent activity",
        () => filterByTag(run.seen, "item.started").length === 1,
      );
      await settle();
      expect(run.answered).toEqual([{ id: "late-link-approval", result: { decision: "cancel" } }]);
      expect(listSentParams(run.requests, "turn/interrupt")).toContainEqual({
        threadId: SIBLING,
        turnId: "unlinked-turn",
      });
      await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    },
  );

  it("allows a genuine selected continuation received before its metadata is ready", async () => {
    const run = await createDelayedMetadataSession();
    pushNativeTurn(run.server, CHILD, "old-turn");
    run.server.push({
      id: "old-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: CHILD, turnId: "old-turn", itemId: "old", command: "ls" },
    });
    await waitUntil("requested selected metadata", () => run.metadataIds.has(CHILD));
    await Effect.runPromise(run.adapter.interrupt(SESSION, CHILD));
    pushNativeTurn(run.server, CHILD, "old-turn", "interrupted");
    pushNativeTurn(run.server, CHILD, "new-turn");
    run.server.push({
      id: "new-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: CHILD, turnId: "new-turn", itemId: "new", command: "ls" },
    });
    await settle();
    run.releaseMetadata(CHILD);
    await waitUntil(
      "reported old and new approvals",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    await settle();
    expect(run.answered).toEqual([{ id: "old-approval", result: { decision: "cancel" } }]);
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: CHILD, turnId: "old-turn" },
    ]);
    const current = filterByTag(run.seen, "request.opened")[1]!;
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, current.request.requestId, "allow"),
    );
    expect(run.answered.at(-1)).toEqual({ id: "new-approval", result: { decision: "accept" } });
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("bounds one shared preparation deadline and introduces even unstarted restores before reports", async () => {
    const ids = [CHILD, GRANDCHILD, SIBLING, "0199e0e7-0000-7000-8000-0000000000b4"];
    const run = createDriving({
      "thread/resume": (params) =>
        (params as { threadId: string }).threadId === THREAD ? { thread: { id: THREAD } } : SILENT,
    });
    const spec: SessionSpec = {
      ...SPEC,
      continue: {
        nativeSessionId: THREAD,
        mode: "resume",
        subagents: ids.map((subagentId) => ({ subagentId })),
      },
    };
    await Effect.runPromise(run.adapter.startSession(SESSION, spec, run.ctx));
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sending = yield* Effect.forkChild(
            run.adapter.sendInput(SESSION, { text: "continue" }),
          );
          yield* TestClock.adjust(Duration.zero);
          expect(listSentParams(run.requests, "thread/resume")).toHaveLength(3);
          expect(listSentParams(run.requests, "turn/start")).toEqual([]);
          yield* TestClock.adjust(METADATA_DEADLINE);
          yield* Fiber.join(sending);
          yield* run.adapter.sendInput(SESSION, { text: "continue again" });
          expect(listSentParams(run.requests, "thread/resume")).toHaveLength(3);
        }),
        TestClock.layer(),
      ),
    );
    await settle();
    for (const id of ids) {
      const introduction = run.seen.findIndex(
        (event) => event._tag === "subagent.started" && event.subagentId === id,
      );
      const report = run.seen.findIndex(
        (event) => event._tag === "session.usage.updated" && event.subagentId === id,
      );
      expect(introduction).toBeGreaterThan(-1);
      expect(report).toBeGreaterThan(introduction);
    }
    expect(filterByTag(run.seen, "runtime.warning")).toHaveLength(1);
    expect(filterByTag(run.seen, "runtime.warning")[0]?.message).toContain("4 Codex subagents");
    expect(
      filterByTag(run.seen, "session.usage.updated").every((event) => event.usage === undefined),
    ).toBe(true);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("keeps queued old child work cancelled after a new root input is accepted", async () => {
    const run = await createDelayedMetadataSession();
    pushNativeTurn(run.server, CHILD, "old-child-turn");
    run.server.push({
      id: "old-child-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: CHILD, turnId: "old-child-turn", itemId: "approval", command: "ls" },
    });
    await waitUntil("requested old child metadata", () => run.metadataIds.has(CHILD));
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "new work" }));
    run.releaseMetadata(CHILD);
    await waitUntil(
      "released old child work",
      () => filterByTag(run.seen, "turn.started").length === 1,
    );
    await settle();
    expect(listSentParams(run.requests, "turn/interrupt")).toContainEqual({
      threadId: CHILD,
      turnId: "old-child-turn",
    });
    expect(run.answered).toContainEqual({
      id: "old-child-approval",
      result: { decision: "cancel" },
    });
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("keeps a selected agent's own queued old turn cancelled", async () => {
    const run = await createDelayedMetadataSession();
    pushNativeTurn(run.server, CHILD, "old-child-turn");
    run.server.push({
      id: "queued-own-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: CHILD, turnId: "old-child-turn", itemId: "approval", command: "ls" },
    });
    await waitUntil("requested selected agent metadata", () => run.metadataIds.has(CHILD));
    await Effect.runPromise(run.adapter.interrupt(SESSION, CHILD));
    run.releaseMetadata(CHILD);
    await waitUntil(
      "released selected old turn",
      () => filterByTag(run.seen, "turn.started").length === 1,
    );
    await settle();
    expect(listSentParams(run.requests, "turn/interrupt")).toContainEqual({
      threadId: CHILD,
      turnId: "old-child-turn",
    });
    expect(run.answered).toContainEqual({
      id: "queued-own-approval",
      result: { decision: "cancel" },
    });
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });

  it("keeps terminal closing irreversible while a submitted root input is accepted", async () => {
    const run = await createDelayedMetadataSession(SPEC, {
      "turn/start": SILENT,
      "turn/interrupt": SILENT,
      "thread/read": readSubagentMetadata,
    });
    pushNativeTurn(run.server, CHILD, "background-turn");
    await waitUntil(
      "introduced background child",
      () => filterByTag(run.seen, "turn.started").length === 1,
    );
    const sending = Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "before terminal Stop" }),
    );
    await waitUntil("submitted root input", () => run.submittedIds.has("turn/start"));
    const stopping = Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    await waitUntil("waited for child interrupt", () => run.interruptedIds.has(CHILD));
    const backgroundInterrupt = run.interruptedIds.get(CHILD);
    pushNativeTurn(run.server, THREAD, "late-root-turn");
    run.server.push({
      id: run.submittedIds.get("turn/start"),
      result: {
        turn: { id: "late-root-turn", status: "inProgress", items: [], itemsView: "full" },
      },
    });
    await sending;
    run.server.push({
      id: "closing-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: THREAD, turnId: "late-root-turn", itemId: "approval", command: "ls" },
    });
    await waitUntil("cancelled closing approval", () =>
      run.answered.some((reply) => reply.id === "closing-approval"),
    );
    expect(listSentParams(run.requests, "turn/interrupt")).toContainEqual({
      threadId: THREAD,
      turnId: "late-root-turn",
    });
    expect(run.answered).toContainEqual({ id: "closing-approval", result: { decision: "cancel" } });
    run.server.push({ id: backgroundInterrupt, result: {} });
    await stopping;
    await settle();
    expect(filterByTag(run.seen, "session.exited")).toHaveLength(1);
    expect(run.seen.at(-1)?._tag).toBe("session.exited");
  });

  it("does not let an already-submitted root input reopen stopped work", async () => {
    const run = await createDelayedMetadataSession(SPEC, { "turn/start": SILENT });
    const sending = Effect.runPromise(run.adapter.sendInput(SESSION, { text: "before Stop" }));
    await waitUntil(
      "submitted root input",
      () => listSentParams(run.requests, "turn/start").length === 1,
    );
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    pushNativeTurn(run.server, THREAD, "late-root-turn");
    await settle();
    expect(listSentParams(run.requests, "turn/interrupt")).toContainEqual({
      threadId: THREAD,
      turnId: "late-root-turn",
    });
    run.server.crash();
    await sending.catch(() => undefined);
  });

  it("preempts restoration, refuses its waiting input and never retries preparation", async () => {
    const run = await createDelayedMetadataSession(buildResumedChildSpec(), {
      "thread/resume": readSubagentMetadata,
    });
    const sending = Effect.runPromise(run.adapter.sendInput(SESSION, { text: "before Stop" })).then(
      () => "accepted",
      (error: unknown) => String(error),
    );
    await waitUntil("awaited child replay barrier", () => run.metadataIds.has(CHILD));
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect(await sending).toContain("stopped");
    expect(listSentParams(run.requests, "turn/start")).toEqual([]);
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "new work" }));
    expect(listSentParams(run.requests, "thread/resume")).toHaveLength(2);
    expect(listSentParams(run.requests, "turn/start")).toHaveLength(1);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
  });
});

describe("restoring only missing child reports", () => {
  it("loads the invalid-report child while leaving a usable-report sibling unloaded", async () => {
    const checkpoint = buildChildCounterReport(50000, 5000);
    const run = createDriving({
      "thread/resume": readSubagentMetadata,
      "thread/read": readSubagentMetadata,
    });
    const spec: SessionSpec = {
      ...SPEC,
      continue: {
        nativeSessionId: THREAD,
        mode: "resume",
        subagents: [
          { subagentId: CHILD, lastUsageReport: checkpoint },
          { subagentId: SIBLING, lastUsageReport: { ...checkpoint, source: "different-provider" } },
        ],
      },
    };
    await Effect.runPromise(run.adapter.startSession(SESSION, spec, run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "continue" }));
    expect(
      listSentParams(run.requests, "thread/resume").map(
        (params) => (params as { threadId: string }).threadId,
      ),
    ).toEqual([THREAD, SIBLING]);
    expect(listSentParams(run.requests, "thread/read")).toEqual([
      { threadId: SIBLING, includeTurns: false },
    ]);
  });
});

describe("descendants first discovered after a subtree Stop", () => {
  it.each([false, true])(
    "stops a late descendant when its parent has completed: %s",
    async (parentCompleted) => {
      const run = await startTestSession({ "thread/read": readSubagentMetadata });
      pushNativeTurn(run.server, CHILD, "parent-turn");
      await waitUntil(
        "started the parent",
        () => filterByTag(run.seen, "turn.started").length === 1,
      );
      await Effect.runPromise(run.adapter.interrupt(SESSION, CHILD));
      if (parentCompleted) {
        pushNativeTurn(run.server, CHILD, "parent-turn", "interrupted");
        await waitUntil(
          "completed the stopped parent",
          () => filterByTag(run.seen, "turn.completed").length === 1,
        );
      }
      pushNativeTurn(run.server, GRANDCHILD, "late-descendant-turn");
      run.server.push({
        id: "late-descendant-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: GRANDCHILD,
          turnId: "late-descendant-turn",
          itemId: "approval",
          command: "ls",
        },
      });
      await waitUntil(
        "opened the descendant approval",
        () => filterByTag(run.seen, "request.opened").length === 1,
      );
      await settle();
      expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
        { threadId: CHILD, turnId: "parent-turn" },
        { threadId: GRANDCHILD, turnId: "late-descendant-turn" },
      ]);
      expect(run.answered).toEqual([
        { id: "late-descendant-approval", result: { decision: "cancel" } },
      ]);
      expect(filterByTag(run.seen, "request.resolved")[0]).toMatchObject({
        subagentId: GRANDCHILD,
        decision: "cancel",
      });
    },
  );

  it("allows new descendant work after the selected parent deliberately starts a new turn", async () => {
    const run = await startTestSession({ "thread/read": readSubagentMetadata });
    pushNativeTurn(run.server, CHILD, "parent-turn");
    await waitUntil("started the parent", () => filterByTag(run.seen, "turn.started").length === 1);
    await Effect.runPromise(run.adapter.interrupt(SESSION, CHILD));
    pushNativeTurn(run.server, CHILD, "parent-turn", "interrupted");
    pushNativeTurn(run.server, CHILD, "continued-parent-turn");
    await waitUntil(
      "continued the selected parent",
      () => filterByTag(run.seen, "turn.started").length === 2,
    );
    pushNativeTurn(run.server, GRANDCHILD, "new-descendant-turn");
    run.server.push({
      id: "new-descendant-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: GRANDCHILD,
        turnId: "new-descendant-turn",
        itemId: "approval",
        command: "ls",
      },
    });
    await waitUntil(
      "opened new descendant approval",
      () => filterByTag(run.seen, "request.opened").length === 1,
    );
    await settle();
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: CHILD, turnId: "parent-turn" },
    ]);
    expect(run.answered).toEqual([]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
  });
});

describe("notifications that name no thread", () => {
  const CONFIG_WARNING = {
    method: "configWarning",
    params: { summary: "Bad key in config.toml", details: null },
  };

  /** Starts a session, collecting the runner's own warning lines in `logged`. */
  const startLogged = async (run: ReturnType<typeof createDriving>, sessionId = SESSION) => {
    const logged: Array<string> = [];
    const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn") logged.push(String(message));
    });
    await Effect.runPromise(
      Effect.provide(
        run.adapter.startSession(sessionId, SPEC, run.ctx),
        Logger.layer([collecting]),
      ),
    );
    return logged;
  };

  const listWarningMessages = (seen: ReadonlyArray<ProviderEvent>): ReadonlyArray<string> =>
    filterByTag(seen, "runtime.warning").map((event) => event.message);

  it("reaches the session when Codex sends it during start-up, after session.started", async () => {
    const run: ReturnType<typeof createDriving> = createDriving({
      initialize: () => {
        run.spawns[0]!.push(CONFIG_WARNING);
        return INITIALIZE;
      },
    });

    await startLogged(run);

    expect(run.seen.map((event) => event._tag)).toEqual(["session.started", "runtime.warning"]);
    expect(listWarningMessages(run.seen)).toEqual(["Bad key in config.toml"]);
  });

  it("reaches the session when Codex sends it in the middle of the session", async () => {
    const run = await startTestSession();

    run.server.push({
      method: "deprecationNotice",
      params: { summary: "Flag x is old", details: "Use y" },
    });

    await waitUntil("showed the notice", () => listWarningMessages(run.seen).length === 1);
    expect(listWarningMessages(run.seen)).toEqual(["Flag x is old\nUse y"]);
  });

  it("reaches the root thread when it is a warning for no thread", async () => {
    const run = await startTestSession();

    run.server.push({ method: "warning", params: { threadId: null, message: "Disk is full" } });

    await waitUntil("showed the warning", () => listWarningMessages(run.seen).length === 1);
    expect(filterByTag(run.seen, "runtime.warning")[0]).toMatchObject({
      sessionId: SESSION,
      message: "Disk is full",
    });
  });

  it("goes only to the session whose app-server sent it", async () => {
    const run = await startSessionPair();

    run.spawns[1]!.push(CONFIG_WARNING);

    await waitUntil("showed the warning", () => listWarningMessages(run.seen).length === 1);
    await settle();
    expect(filterByTag(run.seen, "runtime.warning").map((event) => event.sessionId)).toEqual([
      OTHER_SESSION,
    ]);
  });

  it("becomes a labelled unknown item each time, and one log line however often a new method comes", async () => {
    const run = createDriving();
    const logged = await startLogged(run);
    const future = { method: "future/thing", params: { value: 1 } };

    run.spawns[0]!.push(future);
    run.spawns[0]!.push(future);

    await waitUntil("showed both", () => filterByTag(run.seen, "item.completed").length === 2);
    expect(filterByTag(run.seen, "item.completed").map((event) => event.detail)).toEqual([
      { label: "codex: future/thing" },
      { label: "codex: future/thing" },
    ]);
    expect(logged.filter((line) => line.includes("codex: future/thing"))).toHaveLength(1);
  });

  it("is dropped, and shown to nobody, on a probe's app-server", async () => {
    const run: ReturnType<typeof createDriving> = createDriving({
      initialize: () => {
        run.spawns[0]!.push(CONFIG_WARNING);
        return INITIALIZE;
      },
    });

    await Effect.runPromise(run.adapter.probe(run.ctx, {}));
    await settle();

    expect(run.seen).toEqual([]);
  });

  // The scripted app-server sends one more notification with no thread id
  // right after it replies to `initialize`, so a test that fills the list
  // counts it as one more frame.
  it("keeps the first 100 sent during start-up, drops the rest, and logs the exact count once", async () => {
    const run: ReturnType<typeof createDriving> = createDriving({
      initialize: () => {
        for (let count = 0; count < 105; count += 1) {
          run.spawns[0]!.push({
            method: "configWarning",
            params: { summary: `Warning ${count}`, details: null },
          });
        }
        return INITIALIZE;
      },
    });

    const logged = await startLogged(run);

    const shown = listWarningMessages(run.seen);
    expect(shown).toHaveLength(100);
    expect(shown[0]).toBe("Warning 0");
    expect(shown[99]).toBe("Warning 99");
    expect(logged.filter((line) => line.includes("Dropped 6 of them"))).toHaveLength(1);
  });

  it("keeps no more than a megabyte of them, and drops the one that does not fit", async () => {
    const run: ReturnType<typeof createDriving> = createDriving({
      initialize: () => {
        run.spawns[0]!.push({
          method: "configWarning",
          params: { summary: "x".repeat(2 * 1024 * 1024), details: null },
        });
        run.spawns[0]!.push(CONFIG_WARNING);
        return INITIALIZE;
      },
    });

    const logged = await startLogged(run);

    expect(listWarningMessages(run.seen)).toEqual(["Bad key in config.toml"]);
    expect(logged.filter((line) => line.includes("Dropped 1 of them"))).toHaveLength(1);
  });

  it("drops a turn or usage frame with no thread, and starts the session all the same", async () => {
    const run: ReturnType<typeof createDriving> = createDriving({
      initialize: () => {
        run.spawns[0]!.push({ method: "turn/completed", params: {} });
        run.spawns[0]!.push({ method: "thread/tokenUsage/updated", params: {} });
        return INITIALIZE;
      },
    });

    const logged = await startLogged(run);

    expect(run.spawns).toHaveLength(1);
    expect(run.seen.map((event) => event._tag)).toEqual(["session.started"]);
    expect(logged.filter((line) => line.includes("with no thread id"))).toHaveLength(2);
  });

  it("does not draw a row for an unknown frame while a turn is asked for but not started", async () => {
    const run = createDriving();
    const logged = await startLogged(run);
    // `turn/start` is answered, and Codex has not sent `turn/started` yet.
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "look around" }));
    const before = run.seen.length;

    run.spawns[0]!.push({ method: "future/thing", params: {} });
    await waitUntil("logged the frame", () =>
      logged.some((line) => line.includes("codex: future/thing")),
    );

    expect(run.seen.slice(before)).toEqual([]);
  });
});
