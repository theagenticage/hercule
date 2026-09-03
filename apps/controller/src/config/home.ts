import { mkdirSync } from "node:fs";
import { Context, Effect } from "effect";
import type { HomePaths } from "@hydra/home";
import { HydraHomeError } from "./errors";

/**
 * Hydra Home: the one directory holding everything Hydra keeps on a machine.
 * Only `dataDir` (the Data Root) moves with promotion (spec 15 section 5).
 *
 * The layout itself is `@hydra/home`, which every role links; this is the
 * controller's view of it, plus the two effects that put it on disk.
 */
export class HydraHome extends Context.Service<HydraHome, HomePaths>()(
  "hydra/controller/config/HydraHome",
) {}

/** Create one directory and its parents. Idempotent. */
export const createDirectory = Effect.fn("createDirectory")(function* (path: string) {
  yield* Effect.try({
    try: () => mkdirSync(path, { recursive: true }),
    catch: (cause) => new HydraHomeError({ path, cause }),
  });
});

/**
 * Create every directory of the layout (spec 15 section 5). Idempotent: an
 * existing home keeps everything already in it.
 */
export const createLayout = Effect.fn("createLayout")(function* (paths: HomePaths) {
  const directories = [
    paths.home,
    paths.dataDir,
    paths.runnerDir,
    paths.logsDir,
    paths.backupsDir,
    paths.tlsDir,
  ];
  for (const directory of directories) {
    yield* createDirectory(directory);
  }
});
