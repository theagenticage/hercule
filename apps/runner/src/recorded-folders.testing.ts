/**
 * A `RecordedFolders` for tests that exercise an adapter and do not look at
 * the record: it makes and removes folders like the real one and writes no
 * record. Tests of the record itself use `makeRecordedFolders`.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RecordedFolders } from "./recorded-folders";

export const unrecordedFolders: RecordedFolders = {
  make: (parent, prefix) => {
    const folder = join(parent, prefix + Math.random().toString(16).slice(2, 10));
    mkdirSync(folder, { mode: 0o700 });
    return folder;
  },
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};
