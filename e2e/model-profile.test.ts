/**
 * Tests a project's Model Profile through the release binary (spec 06 sections
 * 17.8 and 17.9): a second profile is created and filled, a project names it,
 * a Thread started in that project without a model starts on the profile's
 * default entry, and deleting the profile clears the project's choice.
 *
 * Everything the test arranges and checks goes through the CLI, the surface
 * agents use, except one profile update that goes over HTTP (see the call).
 * Only the arrangement of a runner needs more: a scripted runner
 * (`apps/desktop/scripts`) joins the controller and answers probes and session
 * starts, so no harness, model or login is involved and no tokens are spent.
 * The controller's own runner is never asked to host a thread: every spawn
 * names the scripted runner.
 *
 * Two Provider Accounts make the difference visible. The user's Thread
 * default is the first account on the model `scripted`; the second profile's
 * default entry is the second account on `scripted-large`. A Thread that
 * starts on the second account can only have got there through the profile.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectFleet, type Fleet } from "../apps/desktop/scripts/fleet";
import { pollUntil } from "../apps/desktop/scripts/poll";
import {
  findCompiledBinary,
  runCli,
  startController,
  type Controller,
  type Ran,
} from "../scripts/controller-process";
import {
  completeSetupAndLogin,
  createTemporaryHome,
  listProviderAccounts,
  parseJsonOutputOrFail,
  type TemporaryHome,
} from "./harness";

/** Each CLI call starts the compiled binary, so a step takes a moment; the whole test stays well under this. */
const TEST_TIMEOUT_MS = 60_000;

/** The model the user's Thread default names. The scripted runner lists it for every account. */
const DEFAULT_MODEL = "scripted";

/** The model the second profile's default entry names. */
const PROFILE_MODEL = "scripted-large";

/** The harness both accounts run in, and the one the sessions must report. */
const HARNESS_ID = "claude-code/claude-code";

interface Profile {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
}

interface Project {
  readonly id: string;
  readonly modelProfileId?: string | null;
}

interface Session {
  readonly id: string;
  readonly providerAccountId: string;
  readonly harnessId: string;
  readonly modelSelection: { readonly model: string };
}

let state: TemporaryHome;
let controller: Controller;
let fleet: Fleet;
let binary: string;
let apiKey: string;
let scriptedRunnerId: string;
let secondAccountId: string;

/** Runs one CLI command against the scratch controller. */
const run = (args: ReadonlyArray<string>, stdin?: string): Promise<Ran> =>
  runCli(args, { home: state.home, binary, stdin });

/** Runs a command that must succeed and parses its `--json` output. */
const runJson = async <A>(args: ReadonlyArray<string>, stdin?: string): Promise<A> =>
  parseJsonOutputOrFail<A>(await run([...args, "--json"], stdin));

/**
 * Starts a Thread in the project with no model, account or harness, pinned to
 * the scripted runner, and returns it as `session read` reports it.
 */
const spawnThreadInProject = async (projectId: string): Promise<Session> => {
  const spawned = await runJson<Session>(
    ["session", "spawn", "--project", projectId, "--runner", scriptedRunnerId],
    "Say hello.",
  );
  return runJson<Session>(["session", "read", spawned.id]);
};

/** Waits until the scripted runner has probed the second account as signed in, with both scripted models. */
const waitForSecondAccountProbe = async (): Promise<void> => {
  let lastSeen: unknown;
  await pollUntil(
    async () => {
      const accounts = await listProviderAccounts({ url: controller.url, apiKey });
      lastSeen = accounts;
      const probed = accounts
        .find((account) => account.id === secondAccountId)
        ?.snapshots.some(
          (snapshot) =>
            snapshot.auth.status === "ok" &&
            snapshot.models.some((model) => model.slug === PROFILE_MODEL),
        );
      return probed === true ? true : undefined;
    },
    {
      timeoutMs: 10_000,
      intervalMs: 50,
      timeoutMessage: () => `the second account was never probed: ${JSON.stringify(lastSeen)}`,
    },
  );
};

beforeAll(async () => {
  binary = findCompiledBinary();
  state = createTemporaryHome();
  controller = await startController({ home: state.home, binary });
  apiKey = await completeSetupAndLogin({
    home: state.home,
    url: controller.url,
    binary,
    apiKeyName: "model-profile e2e",
  });
  // Creates the first account and puts it in "Main"; the scripted runner's
  // first probe then fills Main's section with the two scripted models.
  fleet = await connectFleet(controller.url);
  // A second account, made before the scripted runner joins: a runner probes
  // every account when it connects, but not an account made after that.
  secondAccountId = (
    await runJson<{ readonly id: string }>([
      "provider-account",
      "create",
      "--provider",
      "anthropic/anthropic",
      "--kind",
      "subscription-per-machine",
      "--label",
      "work",
    ])
  ).id;
  scriptedRunnerId = (await fleet.enlistRunner("scripted")).runnerId;
  await waitForSecondAccountProbe();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await fleet?.disconnectRunners();
  await controller?.stop();
  state?.remove();
});

describe("a project's Model Profile", () => {
  it(
    "starts a Thread on the profile's default entry, and a deleted profile stops applying",
    async () => {
      const [firstAccount] = await listProviderAccounts({ url: controller.url, apiKey });

      // The user's Thread default: the first account on `scripted`.
      await runJson([
        "settings",
        "update",
        "--user",
        JSON.stringify({
          "thread.providerAccountId": firstAccount!.id,
          "thread.model": DEFAULT_MODEL,
        }),
      ]);

      // 1. A second profile, filled with an explicit entry so the test does not
      // wait for a catalog read.
      const [main] = await runJson<ReadonlyArray<Profile>>(["model-profile", "list"]);
      const created = await runJson<Profile>(["model-profile", "create", "--name", "Review"]);
      expect(created.name).toBe("Review");
      const entry = { providerAccountId: secondAccountId, model: PROFILE_MODEL, harnessId: null };
      // The CLI's update row cannot send an empty list (each `--dismissed-new-models`
      // value is one element), so this one call goes over HTTP.
      await fleet.call("PATCH", `/model-profiles/${created.id}`, {
        expectedRevision: created.revision,
        name: "Review",
        accounts: [{ providerAccountId: secondAccountId, harnessId: null, entries: [entry] }],
        defaultEntry: entry,
        dismissedNewModels: [],
      });

      // 2. A project that names it.
      const project = await runJson<Project>([
        "project",
        "create",
        "--name",
        "Reviews",
        "--model-profile",
        created.id,
      ]);
      expect(project.modelProfileId).toBe(created.id);

      // 3. A Thread there, naming no model, starts on the profile's default entry
      // and not on the user's Thread default.
      const onProfile = await spawnThreadInProject(project.id);
      expect(onProfile).toMatchObject({
        providerAccountId: secondAccountId,
        harnessId: HARNESS_ID,
        modelSelection: { model: PROFILE_MODEL },
      });

      // 4. Deleting the profile clears the project's choice. The Thread that
      // exists keeps its entry, and a new one starts on the Thread default again.
      await runJson(["model-profile", "delete", created.id]);
      expect((await runJson<Project>(["project", "read", project.id])).modelProfileId ?? null).toBe(
        null,
      );
      expect(await runJson<Session>(["session", "read", onProfile.id])).toMatchObject({
        providerAccountId: secondAccountId,
        modelSelection: { model: PROFILE_MODEL },
      });
      const afterDelete = await spawnThreadInProject(project.id);
      expect(afterDelete).toMatchObject({
        providerAccountId: firstAccount!.id,
        harnessId: HARNESS_ID,
        modelSelection: { model: DEFAULT_MODEL },
      });

      // 5. The last profile cannot be deleted.
      const refused = await run(["model-profile", "delete", main!.id]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("only Model Profile");
      // The CLI prints the message only; the error code is on the wire.
      const response = await fetch(`${controller.url}/api/v1/model-profiles/${main!.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${fleet.token}` },
      });
      expect(await response.json()).toMatchObject({ error: { code: "invalid_state" } });
      const remaining = await runJson<ReadonlyArray<Profile>>(["model-profile", "list"]);
      expect(remaining.map((profile) => profile.id)).toEqual([main!.id]);
    },
    TEST_TIMEOUT_MS,
  );
});
