/** Exercises real Git working files through the packaged desktop and public API. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, it, onTestFinished } from "vitest";
import type { Session, StartingRevision, Workspace } from "../../packages/contract/src/index";
import { createClient } from "../../packages/client-core/src/index";
import { writeSettings } from "../../apps/desktop/scripts/packaged-app";
import { connectFleet } from "../../apps/desktop/scripts/fleet";
import {
  buildCleanEnv,
  findCompiledBinary,
  startController,
  startSetUpController,
} from "../../scripts/controller-process";
import { createTemporaryHome } from "../harness";
import {
  chooseMenuItem,
  keepWindowOnTop,
  createUserDataDirForTest,
  launchForTest,
  signInAndReadToken,
  startIdentityServerForTest,
} from "./harness";

/**
 * Runs the production workspace manager and session placement in a Bun child.
 * Only provider events are synthetic: this fixture never launches a harness.
 * Both runner modes use this same transport, with separate scratch storage.
 */
const RUNNER_SOURCE = String.raw`
import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Effect } from "effect";
import { makeWorkspaces } from "./apps/runner/src/workspaces/index.ts";
import { resolveSessionContext } from "./apps/runner/src/sessions/context.ts";
import { PROTOCOL_VERSION, WORKSPACE_LIFECYCLE_CAPABILITY } from "./packages/protocol/src/index.ts";
const options = JSON.parse(process.env.WORKSPACE_JOURNEY_RUNNER);
const workspaces = makeWorkspaces({ storageDir: options.home, gitEnv: options.gitEnv });
const machine = {
  providersDir: join(options.home, "providers"), scratchDir: join(options.home, "scratch"),
  binDir: join(options.home, "bin"), herculeTool: { skill: "# fixture", claudePluginDir: join(options.home, "plugin") },
  controllerUrl: options.url, baseEnv: { PATH: process.env.PATH }, findBinary: () => "/fixture/never-executed",
  workspaces, socketPath: join(options.home, "credentials.sock"),
};
const sessions = new Map();
let socket;
const send = (frame) => socket.send(JSON.stringify(frame));
const log = (event) => console.log(JSON.stringify(event));
const reportEvent = (session, event) => send({ _tag: "sessionEvent", seq: ++session.seq, event: {
  eventId: randomUUID(), sessionId: session.id, at: new Date().toISOString(), ...event,
} });
const observe = async (session) => {
  if (session.workspaceId !== null) send(await workspaces.inspect(session.workspaceId));
};
const input = (session, frame) => {
  send({ _tag: "sessionInputResult", requestId: frame.requestId, ok: true, delivery: session.turn ? "steered" : "opened" });
  if (!session.turn) {
    session.turn = randomUUID();
    reportEvent(session, { _tag: "turn.started", turnId: session.turn });
  }
  const itemId = randomUUID();
  reportEvent(session, { _tag: "item.started", turnId: session.turn, itemId, kind: "user_message", detail: { text: frame.input.text } });
  reportEvent(session, { _tag: "item.completed", turnId: session.turn, itemId, kind: "user_message", detail: { text: frame.input.text }, status: "completed" });
};
const handle = async (frame) => {
  switch (frame._tag) {
    case "ping": return send({ _tag: "pong" });
    case "probeRequest": return send({ _tag: "probeReport", requestId: frame.requestId, instanceId: frame.instanceId,
      result: { harnessVersion: "fixture", auth: { status: "ok" }, models: [{ slug: "fixture", name: "Fixture", isDefault: true, options: [] }] } });
    case "workspaceProvision": {
      const report = await workspaces.provision(frame);
      log({ kind: "workspace", id: frame.workspaceId, cwd: workspaces.resolve(frame.workspaceId)?.cwd });
      return send(report);
    }
    case "workspaceInspect": return send({ _tag: "workspaceInspection", requestId: frame.requestId, report: await workspaces.inspect(frame.workspaceId) });
    case "workspaceDispose": return send(await workspaces.dispose(frame));
    case "workspaceDetach": return send(await workspaces.detach(frame));
    case "sessionStart": {
      const resolved = await Effect.runPromise(resolveSessionContext(frame, machine, "fixture"));
      const session = { id: frame.sessionId, instanceId: frame.spec.instanceId, workspaceId: frame.spec.workspaceId, seq: 0, turn: null };
      sessions.set(session.id, session);
      reportEvent(session, { _tag: "session.started", providerRefs: { nativeSessionId: session.id } });
      await observe(session);
      input(session, frame);
      log({ kind: "session", id: session.id, cwd: resolved.ctx.cwd, resumed: frame.providerRefs !== undefined });
      return;
    }
    case "sessionInput": return input(sessions.get(frame.sessionId), frame);
    case "sessionStop": {
      const session = sessions.get(frame.sessionId);
      if (!session) return;
      if (session.turn) reportEvent(session, { _tag: "turn.completed", turnId: session.turn, state: "interrupted" });
      reportEvent(session, { _tag: "session.exited", reason: "stopped" });
      sessions.delete(session.id);
      return observe(session);
    }
  }
};
const dial = () => new Promise((done, fail) => {
  socket = new WebSocket(options.url.replace(/^http/, "ws") + "/api/v1/runners/socket", { headers: { authorization: "Bearer " + options.credential } });
  socket.onopen = () => send({ _tag: "runnerHello", protocolVersion: PROTOCOL_VERSION, capabilities: [WORKSPACE_LIFECYCLE_CAPABILITY], binaryVersion: "fixture", nonce: randomBytes(16).toString("base64"),
    facts: { os: options.os, arch: "arm64", totalMemoryBytes: 64 * 1024 ** 3, docker: false, toolchains: [], providers: [{ name: "claude", present: true, path: "/fixture/never-executed" }], adapters: ["claude-code"], identityPort: options.identityPort } });
  socket.onmessage = ({ data }) => {
    const frame = JSON.parse(String(data));
    if (frame._tag === "controllerHello") {
      send({ _tag: "sessionsReport", sessions: [...sessions.values()].map((session) => ({ sessionId: session.id, nativeSessionId: session.id, instanceId: session.instanceId })) });
      done();
    } else handle(frame).catch((error) => log({ kind: "fatal", message: String(error) }));
  };
  socket.onerror = fail;
});
await dial();
log({ kind: "online" });
createInterface({ input: process.stdin }).on("line", async (line) => {
  const command = JSON.parse(line);
  if (command.kind === "reconnect") {
    send({ _tag: "goodbye" });
    await new Promise((done) => { socket.onclose = done; socket.close(); });
    await dial();
    log({ kind: "reconnected" });
  }
  if (command.kind === "complete") {
    const session = sessions.get(command.id);
    reportEvent(session, { _tag: "turn.completed", turnId: session.turn, state: "completed" });
    session.turn = null;
    await observe(session);
    log({ kind: "completed", id: session.id });
  }
  if (command.kind === "quit") {
    send({ _tag: "goodbye" });
    socket.close();
    process.exit(0);
  }
});
`;

const GIT_ENV = {
  ...buildCleanEnv(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Workspace fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Workspace fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

/** Runs Git against the fixture without the developer's configuration. */
const runGit = (cwd: string, ...args: string[]): string => {
  const done = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (done.status !== 0) throw new Error(done.stderr);
  return done.stdout.trim();
};

/** Hashes user working files, index, config and hooks, allowing new shared Git refs. */
const hashUserFiles = (root: string): string => {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(path.slice(root.length)).update(readFileSync(path));
    }
  };
  for (const name of [
    "README.md",
    "local.txt",
    "ignored.txt",
    ".gitignore",
    ".git/index",
    ".git/config",
  ]) {
    hash.update(name).update(readFileSync(join(root, name)));
  }
  visit(join(root, ".git/hooks"));
  return hash.digest("hex");
};

interface RunnerRecord {
  readonly kind: string;
  readonly id?: string;
  readonly cwd?: string;
  readonly resumed?: boolean;
  readonly message?: string;
}

it("onboards existing files, retains and resumes a local worktree, then inspects, discards and detaches", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "hercule-desktop-workspaces-")));
  onTestFinished(() => {
    rmSync(scratch, { recursive: true, force: true });
    expect(existsSync(scratch)).toBe(false);
  });
  const source = join(scratch, "selected checkout");
  mkdirSync(source);
  runGit(source, "init", "-b", "main");
  writeFileSync(join(source, "README.md"), "shared source\n");
  writeFileSync(join(source, ".gitignore"), "ignored.txt\n");
  runGit(source, "add", ".");
  runGit(source, "commit", "-m", "remote base");
  const remoteCommit = runGit(source, "rev-parse", "HEAD");
  const remote = join(scratch, "remote.git");
  runGit(scratch, "clone", "--bare", source, remote);
  const remoteUrl = "https://github.com/workspace-fixture/shop.git";
  runGit(source, "remote", "add", "origin", remoteUrl);
  runGit(source, "checkout", "-b", "unpublished-source");
  writeFileSync(join(source, "local.txt"), "local commit\n");
  runGit(source, "add", "local.txt");
  runGit(source, "commit", "-m", "unpublished local base");
  const localCommit = runGit(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "ignored.txt"), "human ignored file\n");
  writeFileSync(join(source, "README.md"), "human staged change\n");
  runGit(source, "add", "README.md");
  const sourceHash = hashUserFiles(source);
  const gitConfig = join(scratch, "gitconfig");
  writeFileSync(
    gitConfig,
    `[url "file://${remote}"]\n\tinsteadOf = ${remoteUrl}\n[protocol "file"]\n\tallow = always\n`,
  );

  const { home, remove } = createTemporaryHome();
  onTestFinished(() => {
    remove();
    expect(existsSync(home)).toBe(false);
  });
  const booted = await startSetUpController({ home });
  await booted.stop();
  // Arrange a previously validated account without a live GitHub request or secret.
  const seed = spawnSync(
    "bun",
    [
      "--eval",
      String.raw`
    import { Database } from "bun:sqlite";
    const database = new Database(process.argv[1]);
    const id = Buffer.from(process.argv[2].replaceAll("-", ""), "hex");
    const at = new Date().toISOString();
    database.query("INSERT INTO connections (id,plugin_id,type,label,display_name,account_id,status,labels,config,created_at,updated_at,feed_intervals) VALUES (?, 'github','github/github','fixture','fixture','fixture','connected','[]','{}',?,?, '{}')").run(id,at,at);
    database.close();
  `,
      join(home, "data", "hercule.db"),
      "019a1234-5678-7000-8000-000000000001",
    ],
    { encoding: "utf8", env: { ...buildCleanEnv(), HERCULE_HOME: home } },
  );
  expect(seed.status, seed.stderr).toBe(0);
  const controller = await startController({
    home,
    binary: findCompiledBinary(),
    port: booted.port,
  });
  onTestFinished(async () => {
    await controller.stop();
  });
  const fleet = await connectFleet(controller.url);
  const client = createClient({ baseUrl: controller.url, token: fleet.token });
  expect((await client.connection.query({ query: { limit: 10 } })).items[0]?.type).toBe(
    "github/github",
  );
  await expect
    .poll(
      async () =>
        (await client.runner.query({ query: { limit: 10 } })).items.filter(
          (runner) => runner.connectivity === "online",
        ).length,
    )
    .toBe(1);
  const own = (await client.runner.query({ query: { limit: 10 } })).items.find(
    (runner) => runner.connectivity === "online",
  )!;
  await client.runner.retire({ params: { id: own.id }, payload: {} });

  /** Starts a positively identified runner using actual Git and context placement. */
  const enlistRunner = async (name: string, identityPort: number, os: "darwin" | "linux") => {
    const joinToken = await fleet.call<{ token: string }>("POST", "/runners/join-tokens");
    const joined = await fetch(`${controller.url}/api/v1/runners/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${joinToken.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(joined.status).toBe(201);
    const { runnerId, credential } = (await joined.json()) as {
      runnerId: string;
      credential: string;
    };
    const runnerHome = join(scratch, name);
    const records: RunnerRecord[] = [];
    let errors = "";
    const child = spawn("bun", ["--eval", RUNNER_SOURCE], {
      cwd: resolve(import.meta.dirname, "../.."),
      env: {
        ...buildCleanEnv(),
        HERCULE_HOME: runnerHome,
        WORKSPACE_JOURNEY_RUNNER: JSON.stringify({
          url: controller.url,
          runnerId,
          credential,
          identityPort,
          os,
          home: runnerHome,
          gitEnv: {
            GIT_CONFIG_GLOBAL: gitConfig,
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          },
        }),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    createInterface({ input: child.stdout }).on("line", (line) =>
      records.push(JSON.parse(line) as RunnerRecord),
    );
    onTestFinished(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.write('{"kind":"quit"}\n');
      await Promise.race([
        new Promise<void>((done) => child.once("exit", () => done())),
        new Promise<void>((done) => setTimeout(done, 2_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) => child.once("exit", () => done()));
        child.kill("SIGTERM");
        await exited;
      }
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(() => process.kill(child.pid!, 0)).toThrow();
    });
    await expect
      .poll(() => {
        if (child.exitCode !== null) throw new Error(errors);
        return records.some((record) => record.kind === "online");
      })
      .toBe(true);
    await fleet.call("PATCH", `/runners/${runnerId}`, { name });
    await expect
      .poll(async () =>
        (await client.provider.query())
          .find((instance) => instance.providerId === "claude-code")
          ?.snapshots.some(
            (snapshot) => snapshot.runnerId === runnerId && snapshot.auth.status === "ok",
          ),
      )
      .toBe(true);
    return {
      runnerId,
      records,
      command: (command: object) => child.stdin.write(`${JSON.stringify(command)}\n`),
    };
  };

  let localId = "";
  const identityPort = await startIdentityServerForTest(() => localId);
  const local = await enlistRunner("studio", identityPort, "darwin");
  localId = local.runnerId;
  const managed = await enlistRunner("remote-lab", 4948, "linux");
  await fleet.createProject("Notes");
  const evidence = process.env["HERCULE_WORKSPACE_EVIDENCE"];
  if (evidence !== undefined) mkdirSync(evidence, { recursive: true });
  const userDataDir = createUserDataDirForTest();
  writeSettings(userDataDir, {
    controllerUrl: controller.url,
    window: { bounds: { x: 0, y: 0, width: 1920, height: 1240 }, fullScreen: false },
  });
  const { app, page, close } = await launchForTest(
    userDataDir,
    async (application) => {
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(1920, 1200);
      });
    },
    evidence === undefined ? undefined : { dir: evidence, size: { width: 1920, height: 1200 } },
  );
  onTestFinished(async () => {
    await close();
    const videoPath = page.video()?.path();
    if (videoPath !== undefined) console.log("Workspace journey recording:", await videoPath);
  });
  await signInAndReadToken(page, controller.url);
  await page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();
  const capture = async (name: string) => {
    if (evidence === undefined) return;
    for (const theme of ["light", "dark"] as const) {
      await app.evaluate(({ nativeTheme }, chosen) => {
        nativeTheme.themeSource = chosen;
      }, theme);
      await page.waitForFunction(
        (dark) => matchMedia("(prefers-color-scheme: dark)").matches === dark,
        theme === "dark",
      );
      await page.screenshot({ path: join(evidence, `${name}-${theme}.png`) });
    }
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
  };
  await keepWindowOnTop(app);
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] });
  }, source);
  await chooseMenuItem(app, "File", "New Thread");
  await page
    .getByRole("dialog", { name: "New thread in" })
    .getByRole("button", { name: "New project" })
    .click();
  const onboarding = page.getByRole("dialog", { name: "New project" });
  await onboarding.getByRole("button", { name: "Choose a folder…" }).click();
  await expect.poll(() => onboarding.textContent()).toContain(source);
  await expect.poll(() => onboarding.textContent()).toContain("studio");
  await onboarding.getByRole("radio", { name: /^Use this checkout/ }).click();
  expect(await onboarding.getByRole("radio", { name: /^Create a separate checkout/ }).count()).toBe(
    1,
  );
  await capture("onboarding");
  await onboarding.getByRole("button", { name: "Add project" }).click();
  await onboarding.waitFor({ state: "hidden" });
  const projects = await client.project.query({ query: { limit: 10 } });
  const project = projects.items.find((each) => each.name === "selected checkout")!;
  const resource = (await client.resource.query({ query: { projectId: project.id, limit: 10 } }))
    .items[0]!;
  const attached = (
    await client.workspace.query({
      query: { resourceId: resource.id, runnerId: local.runnerId, limit: 10 },
    })
  ).items[0]!;
  expect(attached).toMatchObject({ status: "ready", ownership: "adopted", path: source });
  expect(hashUserFiles(source)).toBe(sourceHash);
  const main = await client.workspace.provision({
    payload: { resourceId: resource.id, runnerId: managed.runnerId },
  });
  await expect
    .poll(async () => (await client.workspace.read({ params: { id: main.id } })).status)
    .toBe("ready");
  const managedMain = await client.workspace.read({ params: { id: main.id } });
  expect(managedMain).toMatchObject({ status: "ready", ownership: "managed", path: null });
  expect(managedMain.checkouts[0]?.headCommit).toBe(remoteCommit);
  const macManaged = await enlistRunner("studio-managed", 4948, "darwin");
  const remoteExisting = await enlistRunner("remote-existing", 4948, "linux");
  const otherMacMain = await client.workspace.provision({
    payload: { resourceId: resource.id, runnerId: macManaged.runnerId },
  });
  await expect
    .poll(async () => (await client.workspace.read({ params: { id: otherMacMain.id } })).status)
    .toBe("ready");
  expect((await client.workspace.read({ params: { id: otherMacMain.id } })).ownership).toBe(
    "managed",
  );
  const remoteSource = join(scratch, "remote checkout");
  runGit(scratch, "clone", remote, remoteSource);
  runGit(remoteSource, "remote", "set-url", "origin", remoteUrl);
  const remoteConfig = readFileSync(join(remoteSource, ".git/config"));
  const remoteMain = await client.workspace.attach({
    payload: { resourceId: resource.id, runnerId: remoteExisting.runnerId, path: remoteSource },
  });
  await expect
    .poll(async () => (await client.workspace.read({ params: { id: remoteMain.id } })).status)
    .toBe("ready");
  expect(await client.workspace.read({ params: { id: remoteMain.id } })).toMatchObject({
    ownership: "adopted",
    path: remoteSource,
  });
  expect(readFileSync(join(remoteSource, ".git/config"))).toEqual(remoteConfig);
  expect(runGit(remoteSource, "rev-parse", "HEAD")).toBe(remoteCommit);
  expect(hashUserFiles(source)).toBe(sourceHash);
  const instanceId = (await client.provider.query()).find(
    (instance) => instance.providerId === "claude-code",
  )!.id;
  const spawnThread = (startingRevision: StartingRevision, runnerId = local.runnerId) =>
    client.session.spawn({
      payload: {
        prompt: "Inspect the fixture without editing files",
        projectId: project.id,
        runnerId,
        instanceId,
        workspace: {
          kind: "ephemeral",
          checkouts: [{ resourceId: resource.id, startingRevision }],
        },
      },
    });
  const waitWorkspace = async (session: Session): Promise<Workspace> => {
    await expect
      .poll(
        async () => (await client.workspace.read({ params: { id: session.workspaceId! } })).status,
      )
      .toBe("ready");
    return client.workspace.read({ params: { id: session.workspaceId! } });
  };
  for (const [revision, commit, runner] of [
    [{ kind: "current" }, localCommit, local],
    [{ kind: "local", branch: "unpublished-source" }, localCommit, local],
    [{ kind: "remote" }, remoteCommit, managed],
    [{ kind: "remote" }, remoteCommit, macManaged],
    [{ kind: "current" }, remoteCommit, remoteExisting],
  ] as const) {
    const session = await spawnThread(revision, runner.runnerId);
    const workspace = await waitWorkspace(session);
    expect(workspace.checkouts[0]).toMatchObject({
      baseCommit: commit,
      startingRevision: revision,
      headCommit: commit,
    });
    await expect
      .poll(
        () =>
          runner.records.find((record) => record.kind === "session" && record.id === session.id)
            ?.cwd,
      )
      .toBeTruthy();
    const cwd = runner.records.find(
      (record) => record.kind === "session" && record.id === session.id,
    )!.cwd!;
    expect(runGit(cwd, "rev-parse", "HEAD")).toBe(commit);
    const sourceWorkspaceId =
      runner === local
        ? attached.id
        : runner === managed
          ? main.id
          : runner === macManaged
            ? otherMacMain.id
            : remoteMain.id;
    const sourceCwd = runner.records.find(
      (record) => record.kind === "workspace" && record.id === sourceWorkspaceId,
    )!.cwd!;
    expect(cwd).not.toBe(sourceCwd);
    expect(runGit(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(
      runGit(sourceCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    await client.session.stop({ params: { id: session.id } });
    await expect
      .poll(async () => (await client.session.read({ params: { id: session.id } })).status)
      .toBe("exited");
    expect((await client.workspace.read({ params: { id: workspace.id } })).retentionPolicy).toBe(
      "manual",
    );
    if (revision.kind === "local") {
      runGit(cwd, "branch", "-m", "externally-renamed");
      await client.workspace.inspect({ params: { id: workspace.id } });
      await client.session.input({
        params: { id: session.id },
        payload: { text: "Continue in the same files" },
      });
      await expect
        .poll(
          () =>
            runner.records.filter((record) => record.kind === "session" && record.id === session.id)
              .length,
        )
        .toBe(2);
      expect(
        runner.records
          .filter((record) => record.kind === "session" && record.id === session.id)
          .every((record) => record.cwd === cwd),
      ).toBe(true);
      runner.command({ kind: "complete", id: session.id });
      await expect
        .poll(
          async () =>
            (await client.workspace.read({ params: { id: workspace.id } })).checkouts[0]?.branch,
        )
        .toBe("externally-renamed");
      await page
        .getByRole("navigation", { name: "Threads", exact: true })
        .locator(`a.side-row[href="/threads/${session.id}"]`)
        .first()
        .click();
      await page.getByRole("button", { name: /workspace.*details|details.*workspace/i }).click();
      await expect
        .poll(() => page.getByRole("dialog", { name: /workspace/i }).textContent())
        .toContain("externally-renamed");
      await capture("workspace-details");
      runner.command({ kind: "reconnect" });
      await expect
        .poll(() => runner.records.some((record) => record.kind === "reconnected"))
        .toBe(true);
      await client.session.stop({ params: { id: session.id } });
      await expect
        .poll(async () => (await client.session.read({ params: { id: session.id } })).status)
        .toBe("exited");
      writeFileSync(join(cwd, "human-untracked.txt"), "retain this work\n");
      await client.workspace.dispose({ params: { id: workspace.id }, payload: {} });
      await expect
        .poll(async () => (await client.workspace.read({ params: { id: workspace.id } })).status)
        .toBe("ready");
      expect(readFileSync(join(cwd, "human-untracked.txt"), "utf8")).toBe("retain this work\n");
      expect((await client.workspace.read({ params: { id: workspace.id } })).message).toMatch(
        /discard|changes|files/i,
      );
      await page.getByRole("button", { name: /^Refresh$/ }).click();
      await page.getByRole("button", { name: /^Discard workspace$/ }).click();
      const confirmation = page.getByRole("dialog", { name: /discard/i });
      await expect
        .poll(() => confirmation.textContent())
        .toMatch(/changes.*(lost|deleted|removed)|uncommitted/i);
      await expect
        .poll(() =>
          confirmation
            .locator(".workspace-details-body")
            .evaluate((body) => body.scrollWidth <= body.clientWidth),
        )
        .toBe(true);
      await capture("discard-confirmation");
      await confirmation.getByRole("button", { name: /^Discard( workspace| changes)?$/ }).click();
      await page
        .getByRole("dialog", { name: "Workspace details", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
    } else
      await client.workspace.dispose({
        params: { id: workspace.id },
        payload: { discardChanges: true },
      });
    await expect
      .poll(async () => (await client.workspace.read({ params: { id: workspace.id } })).status)
      .toBe("deleted");
    expect(existsSync(cwd)).toBe(false);
  }
  const shared = await client.session.spawn({
    payload: {
      prompt: "Share existing working files",
      projectId: project.id,
      runnerId: local.runnerId,
      instanceId,
      workspace: { kind: "existing", workspaceId: attached.id },
    },
  });
  await expect
    .poll(() =>
      local.records.some(
        (record) => record.kind === "session" && record.id === shared.id && record.cwd === source,
      ),
    )
    .toBe(true);
  expect(runGit(source, "branch", "--show-current")).toBe("unpublished-source");
  await client.session.stop({ params: { id: shared.id } });
  await expect
    .poll(async () => (await client.session.read({ params: { id: shared.id } })).status)
    .toBe("exited");
  await page
    .getByRole("navigation", { name: "Threads", exact: true })
    .locator(`a.side-row[href="/threads/${shared.id}"]`)
    .first()
    .click();
  await page.getByRole("button", { name: /workspace.*details|details.*workspace/i }).click();
  const adoptedDetails = page.getByRole("dialog", { name: "Workspace details", exact: true });
  await expect
    .poll(() =>
      adoptedDetails
        .locator(".workspace-details-body")
        .evaluate((body) => body.scrollWidth <= body.clientWidth),
    )
    .toBe(true);
  await capture("adopted-details");
  await page.getByRole("button", { name: /^Detach existing checkout$/ }).click();
  const detach = page.getByRole("dialog", { name: /detach/i });
  await expect.poll(() => detach.textContent()).toMatch(/files.*(stay|remain|kept)|keep.*files/i);
  await expect
    .poll(() =>
      detach
        .locator(".workspace-details-body")
        .evaluate((body) => body.scrollWidth <= body.clientWidth),
    )
    .toBe(true);
  await capture("detach-confirmation");
  await detach.getByRole("button", { name: /^Detach( existing checkout| checkout)?$/ }).click();
  await expect
    .poll(async () => (await client.workspace.read({ params: { id: attached.id } })).status)
    .toBe("deleted");
  expect(hashUserFiles(source)).toBe(sourceHash);
  expect(runGit(source, "branch", "--show-current")).toBe("unpublished-source");
  expect(runGit(source, "rev-parse", "HEAD")).toBe(localCommit);
  await client.workspace.detach({ params: { id: remoteMain.id } });
  await expect
    .poll(async () => (await client.workspace.read({ params: { id: remoteMain.id } })).status)
    .toBe("deleted");
  expect(readFileSync(join(remoteSource, ".git/config"))).toEqual(remoteConfig);
  expect(runGit(remoteSource, "rev-parse", "HEAD")).toBe(remoteCommit);
  expect(
    local.records
      .concat(managed.records, macManaged.records, remoteExisting.records)
      .filter((record) => record.kind === "fatal"),
  ).toEqual([]);
}, 120_000);
