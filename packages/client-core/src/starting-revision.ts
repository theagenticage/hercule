/** Describes a selected Git starting revision without guessing from later observations. */
import type { StartingRevision } from "@hercule/contract";

/** Returns the words that name the selected source, without assuming a remote name. */
export const describeStartingRevision = (revision: StartingRevision): string => {
  switch (revision.kind) {
    case "current":
      return "current committed state";
    case "local":
      return `local branch ${revision.branch}`;
    case "remote":
      return revision.branch === undefined ? "remote default" : `remote branch ${revision.branch}`;
  }
};

/** Returns a menu key that distinguishes a local branch from a remote branch of the same name. */
export const buildStartingRevisionKey = (revision: StartingRevision): string =>
  revision.kind === "current" ? "current" : `${revision.kind}:${revision.branch ?? ""}`;
