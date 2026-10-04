/**
 * The watch list: the repositories whose issues, pull requests and checks a
 * GitHub Connection follows (spec 08 section 5.1). It is the union of two
 * sources:
 *
 * - the repo Resources linked to the Connection, read through the
 *   `resources` capability, and
 * - the extra repositories in the Connection's own config.
 *
 * The feeds read it again on every poll, so a Resource linked a minute ago is
 * watched from the next tick on.
 */
import { Effect } from "effect";
import type { ConnectionResources, LinkedResource } from "@hercule/plugin-host";

/**
 * Returns `owner/repo` for a canonical remote on github.com, such as
 * `github.com/owner/repo`, and undefined for a remote on any other host or of
 * any other shape. A Resource on GitHub Enterprise is not watched: this
 * plugin calls github.com's API only.
 */
const parseGithubRemote = (remote: string): string | undefined => {
  const match = /^github\.com\/([^/]+\/[^/]+)$/i.exec(remote);
  return match?.[1];
};

/**
 * Builds the watch list from the Resources linked to the Connection and the
 * repositories in its config. Returns each repository once, as lowercase
 * `owner/repo`, sorted, so two spellings of one repository are one entry.
 */
export const buildWatchList = (
  resources: ReadonlyArray<LinkedResource>,
  configRepos: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const fromResources = resources.flatMap((resource) => {
    if (resource.kind !== "repo" || resource.remote === null) return [];
    const repo = parseGithubRemote(resource.remote);
    return repo === undefined ? [] : [repo];
  });
  const repos = new Set([...fromResources, ...configRepos].map((repo) => repo.toLowerCase()));
  return [...repos].sort();
};

/**
 * Reads the watch list as it stands now. A context without the `resources`
 * capability has no linked Resources, so only the config's repositories are
 * watched.
 */
export const readWatchList = (
  resources: ConnectionResources | undefined,
  configRepos: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>> =>
  resources === undefined
    ? Effect.succeed(buildWatchList([], configRepos))
    : Effect.map(resources.list(), (linked) => buildWatchList(linked, configRepos));
