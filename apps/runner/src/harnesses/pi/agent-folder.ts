/**
 * The private agent folder of a pi launch. pi reads its model files from its
 * agent directory (`PI_CODING_AGENT_DIR`), so every launch gets a folder of its
 * own, built from the account's Harness Home at the moment of the launch. A
 * launch therefore never sees the models of another launch, and Hercule never
 * writes into the home's `models.json`.
 *
 * What the folder holds, and what it leaves out on purpose:
 *
 * - `models-store.json`: a copy of the home's model list store (the list
 *   `pi update --models` refreshed). Without a store in the home, pi uses the
 *   list bundled in its release.
 * - `models.json`: the home's file, with the account's catalog models set in it
 *   when the launch carries a catalog (see `setProviderModels`). The home's file
 *   is where a user, or a test, points a provider at another `baseUrl`.
 * - The extension and the instructions of a session launch, which the adapter
 *   writes beside them.
 * - No `auth.json`: the account's key comes from the environment. No
 *   `settings.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md`, `CLAUDE.md`,
 *   `keybindings.json`, `trust.json`, `bin`, `prompts`, `themes`, `skills` or
 *   `extensions`: Hercule passes the model, the thinking level, the
 *   instructions and the extension on the command line, turns off pi's own
 *   discovery of the rest, and runs pi offline, so none of it is ever needed.
 *
 * Sessions and their transcripts stay in the Harness Home: pi gets
 * `--session-dir` and the transcript paths explicitly.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { HarnessRunnerContext } from "../index";
import { readModelStore, writeModelStore } from "./model-store";
import { setProviderModels } from "./models-file";
import { makeNativeModelLister } from "./native-models";
import { readPiProvider } from "./provider";
import { describeError, type PiSpawn } from "./rpc";

/** A session launch's private agent folder, shared by the session's pi processes. */
export interface AgentFolder {
  readonly path: string;
  /**
   * Records one more pi process that uses the folder, and returns the function
   * to call once that process has exited. The folder is removed when every
   * process that borrowed it has released it. Throws when the folder is
   * already removed.
   */
  readonly borrow: () => () => void;
  /** Removes the folder at once, for a launch that failed before it borrowed. */
  readonly discard: () => void;
}

/**
 * Creates an empty private agent folder, readable by this user only, in the
 * machine's temporary directory. That is where the probe keeps its scratch
 * folders too, and it keeps the folder away from the Harness Home. The folder
 * holds no key, only copies of model lists. A runner that crashes leaves it
 * behind, and the operating system's cleanup of the temporary directory
 * removes it. Throws when the folder cannot be created.
 */
export const createAgentFolder = (): AgentFolder => {
  const path = mkdtempSync(join(tmpdir(), "hercule-pi-agent-"));
  let borrowers = 0;
  let removed = false;
  const discard = (): void => {
    removed = true;
    try {
      // A few retries cover a pi that has just been killed and is still
      // closing a file in the folder.
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A folder left behind holds only copies of model lists.
    }
  };
  return {
    path,
    borrow: () => {
      if (removed) throw new Error("The agent folder of this session is already removed.");
      borrowers += 1;
      return () => {
        borrowers -= 1;
        if (borrowers === 0) discard();
      };
    },
    discard,
  };
};

const MODELS_FILE = "models.json";

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
 * Builds the function that writes the model files of a launch into a pi agent
 * directory. One writer belongs to one adapter, so the cache of the models pi
 * ships (see `makeNativeModelLister`) lives as long as the runner process.
 * Session launches and text generations both use it.
 *
 * The returned function reads the home's model store once and writes those
 * bytes into `directory` as `models-store.json`. It then writes `directory`'s
 * `models.json`, built from the home's `models.json`, if there is one:
 *
 * - `ctx.catalogModels` absent: the home's file as it is.
 * - `ctx.catalogModels` present, even if empty: the home's file with the
 *   provider's `models` set to the catalog models pi does not ship. Which
 *   models pi ships comes from pi itself, listed from the same store bytes the
 *   launch's pi will load, so the two agree. A declaration with the id of a
 *   shipped model would replace pi's own definition of it and lose its
 *   thinking levels, compatibility settings and cost.
 *
 * Fails with an `Error` when pi cannot list its models (a guess would declare
 * a shipped model), when there are models to declare and the home's file is not
 * a plain JSON object (a file with comments, say, which the copy could not
 * keep), and when a file cannot be read or written. The messages name the file
 * and what to do, and never quote its content.
 */
export const makeModelFilesWriter = (spawn: PiSpawn) => {
  const listNativeModels = makeNativeModelLister(spawn);
  return (
    directory: string,
    binary: string,
    ctx: Pick<HarnessRunnerContext, "home" | "modelArgument" | "catalogModels">,
    env: Readonly<Record<string, string | undefined>>,
  ): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const toError = (error: unknown): Error =>
        error instanceof Error ? error : new Error(describeError(error));
      const homeFile = join(ctx.home, MODELS_FILE);
      const { store, homeText } = yield* Effect.try({
        try: () => ({
          store: readModelStore(ctx.home),
          homeText: readOptionalText(homeFile),
        }),
        catch: toError,
      });
      let text = homeText;
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
        if (update._tag === "write") text = update.text;
      }
      yield* Effect.try({
        try: () => {
          writeModelStore(directory, store);
          if (text !== undefined) {
            writeFileSync(join(directory, MODELS_FILE), text, { mode: 0o600 });
          }
        },
        catch: toError,
      });
    });
};
