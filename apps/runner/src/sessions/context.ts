/**
 * Resolves what one session needs on this machine from its start frame. The
 * frame holds ids, and this file turns them into paths and an environment.
 * Only this file resolves the working directories. A Harness Home is the folder
 * the controller names, joined to the storage directory (`createHarnessHome`).
 * Managed workspace paths stay on the runner; an attached checkout's path is
 * explicitly registered on the controller.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MAX_MESSAGE_LENGTH, type SessionStart } from "@hercule/protocol";
import type { AttachmentCache, AttachmentUploader } from "../attachments";
import { buildGitCredentialEnv } from "../credentials";
import { createSessionMarksDir, type FileClock } from "../edit-marks";
import {
  buildSubstrateEnv,
  ensureRootBoundary,
  switchBranch,
  type Workspaces,
} from "../workspaces";
import type { HarnessRunnerContext } from "../harnesses";
import { createHarnessHome } from "../harnesses/account";
import { endSentence } from "../report";
import {
  listWorkspaceRepositorySkills,
  runBoundedListing,
  type RepositorySkillListing,
  type SessionSkillsFolders,
} from "../skills";
import { provisionUserMaterial } from "../user-material";
import { takeInitialState, type InitialState } from "./checkout-edits";
import { buildSessionCheckouts, type SessionCheckout } from "./edited-files";

/** The facts about this machine that a session's context is built from. */
export interface Machine {
  /**
   * The runner's storage directory. A Harness Home is a path the controller names, joined to
   * this directory: one isolated home per Provider Account and harness.
   */
  readonly storageDir: string;
  /** Where a workspace-less session's empty cwd is made, one directory per session. */
  readonly scratchDir: string;
  /** `<runner storage>/attachments`: one directory per session for the images of its input. */
  readonly attachmentsDir: string;
  /**
   * `<runner storage>/edit-marks`: one marks directory per session start, for
   * the marks its harness leaves before each tool that can write files.
   */
  readonly editMarksDir: string;
  /** The runner's file clock, which edit attribution reads every time from. */
  readonly fileClock: FileClock;
  /** Fetches the images of an input from the controller into a session's directory. */
  readonly attachments: AttachmentCache;
  /** Uploads the images a session's tools return to the controller. */
  readonly attachmentUploader: AttachmentUploader;
  /** Fetches the skills a start names into the start's session skills folder. */
  readonly sessionSkillsFolders: SessionSkillsFolders;
  /** `<home>/runner/bin`, holding the `hercule` symlink, prepended to a session's `PATH`. */
  readonly binDir: string;
  /** The skill and the Claude plugin directory, prepared once at runner start (spec 06 section 9.3). */
  readonly herculeTool: HarnessRunnerContext["herculeTool"];
  /** What a session reads as `HERCULE_API_URL`. */
  readonly controllerUrl: string;
  /** The runner's own environment. A session's environment is built on top of it. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** Returns the harness path the last probe found for a binary name, or undefined if it found none. */
  readonly findBinary: (binaryName: string) => string | undefined;
  /** The workspaces on this machine. A session with a workspace runs in it. */
  readonly workspaces: Workspaces;
  /** The socket the git credential helper connects to when it asks this runner for credentials. */
  readonly socketPath: string;
}

/** Why edits made by shell commands in a main workspace are not observed. */
const PRIMARY_WORKSPACE_REASON =
  "the workspace is the main one, where the user works too, so git cannot tell who changed a file";

/** The context a session start resolved on this machine. */
export interface Resolved {
  /** The adapter's context, except for its edit marks, which need the session's edit watch. */
  readonly ctx: Omit<HarnessRunnerContext, "editMarks">;
  /** The scratch directory, removed when the session exits. Undefined for a session that has a workspace. */
  readonly scratch: string | undefined;
  /** The directory the session's images are cached in, removed when the session exits. */
  readonly attachmentsDir: string;
  /** The session's marks directory, removed when the session exits. Null when its edits are not observed. */
  readonly sessionMarksDir: string | null;
  /** The directory the session runs in, which relative edited paths are resolved against. */
  readonly cwd: string;
  /** The checkouts of the session's workspace, empty for a session with none. Edited paths are mapped onto them. */
  readonly checkouts: ReadonlyArray<SessionCheckout>;
  /**
   * The repository skills the session's workspace offers, listed after the
   * branch switch. Undefined for a session without a workspace.
   */
  readonly repositorySkills: RepositorySkillListing | undefined;
  /**
   * Takes the state of the checkouts, which the edits made by shell commands
   * are measured against, and checks that the file times of every checkout
   * follow the runner's file clock. Only the first session placed in a
   * workspace takes it, so it is run on request and not when the context is
   * resolved. For a main workspace it takes nothing and returns
   * `unavailable`: the user works there too, and git cannot tell the user's
   * changes from a session's.
   */
  readonly takeInitialState: () => Effect.Effect<InitialState>;
}

/**
 * Builds a session's environment in two layers, the second overriding the
 * first (spec 06 section 4):
 *
 * - the runner's own environment, with git's and Hercule's own variables
 *   removed;
 * - Hercule's variables: the git credential helper, `GH_TOKEN`, the API URL,
 *   the session token, and `PATH`.
 *
 * The account's credential is not in it: the adapter adds that to the
 * environment of the harness process.
 *
 * The token and the git identity come only from the frame. `GH_TOKEN` is the
 * token the caller resolved (see `resolveSessionContext`); the runner never
 * makes one up. They are passed through the environment and
 * nowhere else, because anything written to disk would outlive the session
 * (spec 06 section 9.3). When there is no GitHub token, the variable is left
 * out: `gh` would read an empty one as a credential that failed, not as no
 * credential at all.
 *
 * Git's variables are removed from the inherited environment the same way the
 * substrate environment removes them. Otherwise a `GIT_ASKPASS` or a
 * `GIT_CONFIG_*` that the person who started the daemon exported for
 * themselves would answer credential prompts for the agent, or replace the
 * credential helper set below. The runner's own `HERCULE_*` variables are
 * removed the same way, so the session never inherits the runner's Home or
 * settings. Every `HERCULE_*` variable the session does get is added after
 * that removal: by the credential helper's variables, or by the lines below.
 */
const buildEnv = (
  machine: Machine,
  frame: SessionStart,
  githubToken: string | undefined,
): Record<string, string | undefined> => ({
  ...buildSubstrateEnv(machine.baseEnv),
  ...buildGitCredentialEnv({ socketPath: machine.socketPath, identity: frame.gitIdentity }),
  ...(githubToken === undefined ? {} : { GH_TOKEN: githubToken }),
  HERCULE_API_URL: machine.controllerUrl,
  HERCULE_TOKEN: frame.token,
  HERCULE_SESSION: "1",
  // The bin directory goes first, so `which hercule` finds this build, and the
  // machine's own tools still work after it (spec 15 section 2). The rest is
  // the machine's own `PATH`. An empty entry in `PATH` means the current directory,
  // so when the machine has no `PATH`, the result is the bin directory alone,
  // with no trailing colon.
  PATH:
    machine.baseEnv["PATH"] === undefined || machine.baseEnv["PATH"] === ""
      ? machine.binDir
      : `${machine.binDir}:${machine.baseEnv["PATH"]}`,
});

/**
 * Runs a filesystem operation. Fails with the error's message, which is the
 * text the user reads in the session's stream.
 */
const tryFilesystem = <A>(work: () => A): Effect.Effect<A, string> =>
  Effect.try({
    try: work,
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  });

/**
 * Removes a directory a session used, and logs a failure instead of
 * failing. Removal can fail while a file is still being written into the
 * directory, such as an image download that outlived its input; the
 * session has ended either way, and its teardown must still finish.
 *
 * The removal is synchronous, because these paths are named by the session
 * id alone: a fresh start of the same session reuses them, and must not
 * find a removal of the old ones still running.
 */
export const removeSessionDirectory = (path: string | undefined): Effect.Effect<void> =>
  path === undefined
    ? Effect.void
    : Effect.try(() => rmSync(path, { recursive: true, force: true })).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`could not remove ${path}: ${String(error.cause)}`),
        ),
      );

/**
 * Builds the message that refuses a start for a reason found while the
 * session's place was prepared. `what` says what the runner could not do.
 */
const buildRefusal = (what: string, reason: string): string =>
  `The runner could not ${what}: ${endSentence(reason)} The Thread did not start.`.slice(
    0,
    MAX_MESSAGE_LENGTH,
  );

/**
 * Returns the directory a session runs in, its scratch directory if it has
 * one, the checkouts of its workspace, and the repository skills the
 * workspace offers. Fails with a message when the workspace is not on this
 * runner, when git cannot switch to the requested branch, when the filesystem
 * fails, or when the workspace's repository skills cannot be read.
 *
 * A session without a workspace gets an empty scratch directory, not the
 * runner's own cwd, because every harness reads instruction files out of its
 * cwd. The adapter does the rest of keeping stray context out of the session:
 * no context-file discovery, auto memory off, and a strict MCP config
 * (spec 06 section 9.1).
 *
 * A session that runs in the workspace root, which is when the workspace has
 * no single checkout, first gets the root boundary (see `ensureRootBoundary`).
 * Claude Code looks for `.claude/` folders in its cwd and every folder above
 * it, and without the boundary that search reaches the user's home and loads
 * the user's own skills (#369).
 */
const placeSession = (
  frame: SessionStart,
  machine: Machine,
): Effect.Effect<
  {
    readonly cwd: string;
    readonly scratch: string | undefined;
    readonly checkouts: ReadonlyArray<SessionCheckout>;
    /** Whether the workspace is the user's main one, where the user works too. */
    readonly isPrimary: boolean;
    readonly repositorySkills: RepositorySkillListing | undefined;
  },
  string
> =>
  Effect.gen(function* () {
    const { workspaceId } = frame.spec;
    if (workspaceId === null) {
      return yield* tryFilesystem(() => {
        const scratch = joinPath(machine.scratchDir, frame.sessionId);
        // Remove and recreate rather than only create: the directory must be
        // empty, and one left behind by an earlier session with the same id
        // may not be.
        rmSync(scratch, { recursive: true, force: true });
        mkdirSync(scratch, { recursive: true, mode: 0o700 });
        return {
          cwd: scratch,
          scratch,
          checkouts: [],
          isPrimary: false,
          repositorySkills: undefined,
        };
      });
    }
    const workspace = yield* machine.workspaces.resolve(workspaceId);
    if (workspace === undefined) {
      // Never a silent fallback to a scratch directory: the session would run
      // somewhere the user did not choose.
      return yield* Effect.fail(`this runner does not hold workspace ${workspaceId}`);
    }
    const branch = frame.checkoutBranch;
    if (branch !== undefined) {
      // Never force the switch: a forced switch can throw away the user's
      // uncommitted work, and losing that is worse than not starting the
      // session. The switch waits for any other git work in this workspace:
      // two sessions that start in one primary at once, or a workspace step
      // running there, would otherwise collide on git's `index.lock`.
      const switched = yield* machine.workspaces
        .runExclusively(
          workspaceId,
          switchBranch(workspace.cwd, branch, buildSubstrateEnv(machine.baseEnv)),
        )
        .pipe(Effect.mapError((error) => error.message));
      if (!switched.ok) return yield* Effect.fail(switched.stderr);
    }
    if (workspace.cwd === workspace.root) {
      yield* ensureRootBoundary(workspace.root).pipe(
        Effect.mapError((error) =>
          buildRefusal("prepare the workspace folder for the session", error.message),
        ),
      );
    }
    // Listed after the branch switch, because the switch changes the files of
    // the checkout. A start has no deadline from the controller, so the bound
    // is the only thing that keeps a stalled disk from hanging it.
    const repositorySkills = yield* Effect.mapError(
      runBoundedListing(listWorkspaceRepositorySkills(workspace)),
      (reason) => buildRefusal("read the workspace's repository skills", reason),
    );
    // Real paths are resolved once here, so no edit has to resolve them again.
    return {
      cwd: workspace.cwd,
      scratch: undefined,
      checkouts: buildSessionCheckouts(workspace.checkouts),
      isPrimary: workspace.kind === "primary",
      repositorySkills,
    };
  });

/**
 * Resolves the context an adapter needs to start a session: its cwd, the
 * account's Harness Home, the harness binary, the environment, the model
 * argument and the account's credential. When the frame's `userMaterial` flag is set, the context also
 * carries the user's own material (spec 06 section 9.1). Fails with a message the user can read
 * when the session cannot be placed on this machine.
 *
 * On success the caller owns the scratch, images and marks directories in the
 * result. On failure, or when the work is interrupted, this function removes
 * the ones it had made, so a refused start leaves none behind.
 *
 * `githubToken` becomes the session's `GH_TOKEN`; when it is undefined,
 * `GH_TOKEN` is left unset. The caller resolves it and the frame's own
 * `ghToken` is not used here, because only the caller knows the runner's
 * GitHub token copies.
 */
export const resolveSessionContext = (
  frame: SessionStart,
  machine: Machine,
  binaryName: string,
  githubToken?: string,
): Effect.Effect<Resolved, string> =>
  Effect.gen(function* () {
    const placed = yield* placeSession(frame, machine);
    // Every directory made from here on, so a failure removes exactly these.
    const made: Array<string> = placed.scratch === undefined ? [] : [placed.scratch];
    return yield* Effect.gen(function* () {
      const home = yield* tryFilesystem(() =>
        createHarnessHome(machine.storageDir, frame.harnessAccount.harnessHome),
      );
      // Created before the harness starts, because Claude takes the directories
      // it may read only as a start option.
      const attachmentsDir = yield* tryFilesystem(() => {
        const dir = joinPath(machine.attachmentsDir, frame.sessionId);
        made.push(dir);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
      });
      // Created before the harness starts, because its gate writes into it from
      // the first command on. A session whose edits are not observed gets none.
      const isObserved = !placed.isPrimary && placed.checkouts.length > 0;
      const sessionMarksDir = isObserved
        ? yield* tryFilesystem(() => {
            const dir = createSessionMarksDir(machine.editMarksDir, frame.sessionId);
            made.push(dir);
            return dir;
          })
        : null;
      // Only a Thread on the controller's local runner sees the user's own
      // material. The key is left out for every other session, so its adapter
      // keeps the harness isolated from the user's installation.
      const userMaterial =
        frame.userMaterial === true
          ? yield* provisionUserMaterial(frame.harnessId, home, machine.baseEnv)
          : undefined;
      return {
        scratch: placed.scratch,
        attachmentsDir,
        sessionMarksDir,
        cwd: placed.cwd,
        checkouts: placed.checkouts,
        repositorySkills: placed.repositorySkills,
        takeInitialState: () =>
          placed.isPrimary
            ? Effect.succeed({ _tag: "unavailable", reason: PRIMARY_WORKSPACE_REASON })
            : takeInitialState(
                placed.checkouts,
                buildSubstrateEnv(machine.baseEnv),
                machine.fileClock,
              ),
        ctx: {
          cwd: placed.cwd,
          home,
          binary: machine.findBinary(binaryName),
          env: buildEnv(machine, frame, githubToken),
          // Passed to the adapter as they are, not added to the environment:
          // the adapter puts the credential in the environment of the harness
          // process only.
          modelArgument: frame.harnessAccount.modelArgument,
          credentialVariables: frame.harnessAccount.credentialVariables,
          ...(frame.harnessAccount.credential === undefined
            ? {}
            : { credential: frame.harnessAccount.credential }),
          herculeTool: machine.herculeTool,
          attachmentsDir,
          attachmentUploader: machine.attachmentUploader,
          ...(userMaterial === undefined ? {} : { userMaterial }),
        },
      } satisfies Resolved;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Effect.forEach(made, (path) => removeSessionDirectory(path), { discard: true })
          : Effect.void,
      ),
    );
  });
