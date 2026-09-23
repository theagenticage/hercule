import { chmodSync, mkdirSync } from "node:fs";
import { Context, Effect } from "effect";
import type { HomePaths } from "@hercule/home";
import { HerculeHomeError } from "./errors";

/**
 * Hercule Home: the one directory holding everything Hercule keeps on a machine.
 * Only `dataDir` (the Data Root) moves with promotion (spec 15 section 5).
 *
 * The layout itself is defined in `@hercule/home`, which every role links.
 * This module provides it as a controller service, plus the two effects that
 * create it on disk.
 */
export class HerculeHome extends Context.Service<HerculeHome, HomePaths>()(
  "hercule/controller/config/HerculeHome",
) {}

/**
 * Creates one directory and its parents, readable only by the owner. Does
 * nothing when the directory exists. Fails with `HerculeHomeError`.
 *
 * The home holds the master key, the setup URL and the database, so no other
 * user may read anything in it (spec 13 section 2.2).
 */
export const createDirectory = Effect.fn("createDirectory")(function* (path: string) {
  yield* Effect.try({
    try: () => mkdirSync(path, { recursive: true, mode: 0o700 }),
    catch: (cause) => new HerculeHomeError({ action: "create", path, cause }),
  });
});

/**
 * Creates every directory of the layout (spec 15 section 5), and makes the
 * home readable only by the owner. Fails with `HerculeHomeError`. An existing
 * home keeps everything already in it.
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
  // `mode` applies only when a directory is created, so a home created before
  // this rule, or whose permissions someone widened, is restricted again on
  // every boot.
  yield* Effect.try({
    try: () => chmodSync(paths.home, 0o700),
    catch: (cause) => new HerculeHomeError({ action: "secure", path: paths.home, cause }),
  });
});
