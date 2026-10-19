/**
 * Lists the skills Claude would load natively from `.claude/skills` folders,
 * so the Claude adapter can turn each of them off.
 */
import { join } from "node:path";
import * as Effect from "effect/Effect";
import {
  MAX_LISTING_ENTRIES,
  buildListingBudget,
  compareNames,
  readFolderEntries,
  runUntilStopped,
  type FolderEntries,
} from "./files";

/** The reason given when the folders hold more entries than the runner reads. */
const TOO_MANY_ENTRIES = `the workspace's \`.claude/skills\` folders hold more than ${String(MAX_LISTING_ENTRIES)} entries in all, plain files included. Keep them to ${String(MAX_LISTING_ENTRIES)} entries or fewer`;

/**
 * Returns the sorted, distinct names of the folders and links in
 * `<directory>/.claude/skills` for each of `directories`. Claude loads each of
 * them natively, under its plain name, when a session reads in that directory.
 * A link counts as a folder, because a skill folder may be linked in; plain
 * files such as `.DS_Store` do not. A link that leads outside the directory is
 * followed too, as Claude follows it: the names of the folder it leads to are
 * exactly the skills that would otherwise leak into the session. The names
 * are only used to turn skills off, so nothing is read from inside any of the
 * folders.
 *
 * A directory without a `.claude/skills` folder, or whose folder cannot be
 * read, gives no names: a folder the runner cannot read, Claude cannot read
 * either.
 *
 * The folders are untrusted input and can be huge or sit on a stalled mount,
 * so every entry read, plain files included, is charged to one budget of
 * `MAX_LISTING_ENTRIES` for all the directories together. Fails with a
 * message the user can act on when the budget runs out, because the names
 * read so far would leave skills turned on. The message holds no absolute
 * path. The caller bounds the time and the number of parallel reads (see
 * `runBoundedListing`).
 *
 * The effect can be interrupted. It then ends only once its file system calls
 * have stopped.
 */
export const listNativeClaudeSkills = (
  directories: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, string> =>
  runUntilStopped(async (signal) => {
    const budget = buildListingBudget(signal);
    const names = new Set<string>();
    for (const directory of new Set(directories)) {
      let folder: FolderEntries;
      try {
        folder = await readFolderEntries(join(directory, ".claude", "skills"), budget);
      } catch {
        // The abort reason is not a missing folder: it ends the whole read.
        signal.throwIfAborted();
        continue;
      }
      if (folder.stoppedBy !== undefined) return Effect.fail(TOO_MANY_ENTRIES);
      for (const entry of folder.entries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) names.add(entry.name);
      }
    }
    return Effect.succeed([...names].sort(compareNames));
  });
