import { chmodSync, mkdirSync } from "node:fs";
import { Context, Effect } from "effect";
import type { HomePaths } from "@hercule/home";
import { HerculeHomeError } from "./errors";

/**
 * Hercule Home: the one directory holding everything Hercule keeps on a machine.
 * Only `dataDir` (the Data Root) moves with promotion (spec 15 section 5).
 *
 * The layout itself is `@hercule/home`, which every role links; this is the
 * controller's view of it, plus the two effects that put it on disk.
 */
export class HerculeHome extends Context.Service<HerculeHome, HomePaths>()(
  "hercule/controller/config/HerculeHome",
) {}

/**
 * Create one directory and its parents, owner-only. Idempotent.
 *
 * The home holds the master key, the setup URL and the database, so nothing in
 * it is another user's business (spec 13 section 2.2).
 */
export const createDirectory = Effect.fn("createDirectory")(function* (path: string) {
  yield* Effect.try({
    try: () => mkdirSync(path, { recursive: true, mode: 0o700 }),
    catch: (cause) => new HerculeHomeError({ action: "create", path, cause }),
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
  // `mode` applies only when a directory is created, so a home that predates
  // this rule, or that someone widened, is narrowed again on every boot.
  yield* Effect.try({
    try: () => chmodSync(paths.home, 0o700),
    catch: (cause) => new HerculeHomeError({ action: "secure", path: paths.home, cause }),
  });
});
