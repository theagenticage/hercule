/**
 * The private agent folder of one pi process. pi reads its model files and,
 * when its MCP extension is loaded, its MCP servers from its agent directory
 * (`PI_CODING_AGENT_DIR`). So every pi process, a session's own and each
 * subagent's, gets a folder of its own, created right before the process is
 * spawned and removed when the process has exited. An agent that may write
 * files without asking can write into its own folder, for example a
 * `models.json` that sends the account's key to another `baseUrl`, or an
 * `mcp.json` that runs a command nobody approved. Nothing it writes there
 * reaches another process, because no other process reads that folder.
 *
 * What a folder holds, and what it leaves out on purpose:
 *
 * - `models-store.json`: a copy of the home's model list store (the list
 *   `pi update --models` refreshed). Without a store in the home, pi uses the
 *   list bundled in its release.
 * - `models.json`: the home's file, with the account's catalog models set in it
 *   when the launch carries a catalog (see `setProviderModels`). The home's file
 *   is where a user, or a test, points a provider at another `baseUrl`.
 * - `bin`: a link to the home's `bin` folder, when the home has one. pi looks
 *   for its `fd` and `rg` tools there before it looks on PATH, and offline it
 *   never downloads them. Without the link, a runner whose working copies of
 *   those tools sit only in the home would lose them in every launch. pi reads
 *   the folder and, offline, never writes into it.
 * - The extension of the agent and, for a session's own agent, its
 *   instructions, which the adapter writes beside them.
 * - No `auth.json`: the account's key comes from the environment. No
 *   `settings.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md`, `CLAUDE.md`,
 *   `keybindings.json`, `trust.json`, `prompts`, `themes`, `skills` or
 *   `extensions`: Hercule passes the model, the thinking level, the
 *   instructions and the extension on the command line, turns off pi's own
 *   discovery of the rest, and runs pi offline, so none of it is ever needed.
 *
 * The model files are computed once per session launch (see
 * `makeModelFilesBuilder`) and written into each folder from memory, never
 * copied from another agent's folder, which that agent could have changed.
 *
 * Sessions and their transcripts stay in the Harness Home: pi gets
 * `--session-dir` and the transcript paths explicitly.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { HarnessRunnerContext } from "../index";
import { readModelStore, writeModelStore } from "./model-store";
import { setProviderModels } from "./models-file";
import { makeNativeModelLister } from "./native-models";
import { readPiProvider } from "./provider";
import { describeError, type PiSpawn } from "./rpc";

/**
 * The model files of one launch, as the launch computed them from the
 * account's Harness Home. Each is undefined when the home has none.
 */
export interface ModelFiles {
  /** The bytes of the home's model list store. */
  readonly store: Buffer | undefined;
  /** The text of `models.json`, with the launch's catalog models set in it. */
  readonly modelsText: string | undefined;
  /** The home's `bin` folder, which holds the `fd` and `rg` tools pi found or fetched earlier. */
  readonly toolsFolder: string | undefined;
}

const MODELS_FILE = "models.json";
const TOOLS_FOLDER = "bin";

/** Returns whether `path` is a folder, or a link to one. */
const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
};

/** Reads a text file, or returns undefined when there is none. Throws when it cannot be read for another reason. */
const readOptionalText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
};

/**
 * Writes `files` into `directory`: `models-store.json`, `models.json` and a
 * link named `bin` to the home's tools folder, for each that the launch has.
 * Throws when a file cannot be written.
 */
export const writeModelFiles = (directory: string, files: ModelFiles): void => {
  writeModelStore(directory, files.store);
  if (files.toolsFolder !== undefined) {
    symlinkSync(files.toolsFolder, join(directory, TOOLS_FOLDER));
  }
  if (files.modelsText !== undefined) {
    writeFileSync(join(directory, MODELS_FILE), files.modelsText, { mode: 0o600 });
  }
};

/** Removes an agent folder and what is in it. Never throws: a folder left behind holds only model files. */
export const removeAgentFolder = (path: string): void => {
  try {
    // A few retries cover a pi that has just been killed and is still
    // closing a file in the folder.
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // The operating system's cleanup of the temporary directory gets it later.
  }
};

/**
 * Creates a private agent folder holding `files`, readable by this user only,
 * in the machine's temporary directory, and returns its path. That is where
 * the probe keeps its scratch folders too, and it keeps the folder away from
 * the Harness Home. The folder holds no key, only the model files. Throws
 * when the folder cannot be created or the files cannot be written, after
 * removing the folder. A runner that crashes leaves its folders behind, and the
 * operating system's cleanup of the temporary directory removes them.
 */
export const createAgentFolder = (files: ModelFiles): string => {
  const path = mkdtempSync(join(tmpdir(), "hercule-pi-agent-"));
  try {
    writeModelFiles(path, files);
  } catch (error) {
    removeAgentFolder(path);
    throw error;
  }
  return path;
};

/**
 * Builds the function that computes the model files of a launch. One builder
 * belongs to one adapter, so the cache of the models pi ships (see
 * `makeNativeModelLister`) lives as long as the runner process. Session
 * launches and text generations both use it.
 *
 * The returned function reads the home's model store once, finds the home's
 * `bin` folder (the `fd` and `rg` tools pi found or fetched earlier) when it
 * has one, and builds the text of `models.json` from the home's `models.json`,
 * if there is one:
 *
 * - `ctx.catalogModels` absent: the home's file as it is.
 * - `ctx.catalogModels` present, even if empty: the home's file with the
 *   provider's `models` set to the catalog models pi does not ship. Which
 *   models pi ships comes from pi itself, listed from the same store bytes the
 *   launch's pi will load, so the two agree. A declaration with the id of a
 *   shipped model would replace pi's own definition of it and lose its
 *   thinking levels, compatibility settings and cost.
 *
 * It returns them in memory and writes nothing: `createAgentFolder` and
 * `writeModelFiles` write them into the folder of each pi process.
 *
 * Fails with an `Error` when pi cannot list its models (a guess would declare
 * a shipped model), when there are models to declare and the home's file is not
 * a plain JSON object (a file with comments, say, which the copy could not
 * keep), and when a file cannot be read. The messages name the file and what
 * to do, and never quote its content.
 */
export const makeModelFilesBuilder = (spawn: PiSpawn) => {
  const listNativeModels = makeNativeModelLister(spawn);
  return (
    binary: string,
    ctx: Pick<HarnessRunnerContext, "home" | "modelArgument" | "catalogModels">,
    env: Readonly<Record<string, string | undefined>>,
  ): Effect.Effect<ModelFiles, Error> =>
    Effect.gen(function* () {
      const toError = (error: unknown): Error =>
        error instanceof Error ? error : new Error(describeError(error));
      const homeFile = join(ctx.home, MODELS_FILE);
      const homeTools = join(ctx.home, TOOLS_FOLDER);
      const { store, homeText, toolsFolder } = yield* Effect.try({
        try: () => ({
          store: readModelStore(ctx.home),
          homeText: readOptionalText(homeFile),
          toolsFolder: isFolder(homeTools) ? homeTools : undefined,
        }),
        catch: toError,
      });
      let modelsText = homeText;
      const declarations = ctx.catalogModels;
      if (declarations !== undefined) {
        const provider = yield* Effect.try({
          try: () => readPiProvider(ctx.modelArgument),
          catch: toError,
        });
        const nativeIds = yield* listNativeModels(binary, ctx.home, store, env, provider).pipe(
          Effect.mapError(
            (message) =>
              new Error(
                `pi could not list the models it ships for ${provider}, so Hercule cannot tell which models to declare to it: ${message}`,
              ),
          ),
        );
        const update = setProviderModels(homeText, provider, declarations, nativeIds);
        if (update._tag === "unreadable") {
          return yield* Effect.fail(
            new Error(
              `pi's models.json (${homeFile}) is not a plain JSON object, so Hercule cannot add the models of ${provider} to the copy pi loads. Remove its comments, or delete the file.`,
            ),
          );
        }
        if (update._tag === "write") modelsText = update.text;
      }
      return { store, modelsText, toolsFolder };
    });
};
