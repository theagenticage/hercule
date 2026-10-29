/**
 * The branches of one checkout, as the starting revision menu offers them.
 *
 * A repository can have tens of thousands of branches, so the runner never
 * sends them all: it lists the newest ones whose name contains the text the
 * user typed, up to a limit, and says whether more match.
 */
import * as Effect from "effect/Effect";
import { MAX_FACT_LENGTH, type BranchListReport, type BranchListRequest } from "@hercule/protocol";
import { runGit, type GitEnv } from "./git";
import type { RegisteredCheckout } from "./registry";

/**
 * Lists the local branches and the branches of the checkout's remote whose
 * name contains `text`, ignoring letter case. Each list is sorted by the date
 * of the branch's newest commit, newest first, and holds at most `maxBranches`
 * names. `more` is true when either list left a matching branch out.
 *
 * Remote branches are named without the remote, and the remote's `HEAD` is
 * not a branch, so it is left out. Fails with git's error when git cannot
 * list the refs.
 */
export const listCheckoutBranches = (
  checkout: Pick<RegisteredCheckout, "path" | "remoteName">,
  { text, maxBranches }: Pick<BranchListRequest, "text" | "maxBranches">,
  env: GitEnv,
): Effect.Effect<Extract<BranchListReport["outcome"], { status: "listed" }>, Error> =>
  Effect.gen(function* () {
    const remotePrefix = `refs/remotes/${checkout.remoteName ?? "origin"}/`;
    // One git call lists both kinds, already sorted. The text is matched here,
    // never passed to git, where it would be read as a pattern.
    const listed = yield* runGit(
      [
        "-C",
        checkout.path,
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)",
        "refs/heads/",
        remotePrefix,
      ],
      { env },
    );
    if (!listed.ok) return yield* Effect.fail(new Error(listed.stderr));
    const needle = text.toLowerCase();
    const local: Array<string> = [];
    const remote: Array<string> = [];
    let more = false;
    for (const ref of listed.stdout.split("\n")) {
      const [list, name] = ref.startsWith("refs/heads/")
        ? [local, ref.slice("refs/heads/".length)]
        : ref.startsWith(remotePrefix) && ref !== `${remotePrefix}HEAD`
          ? [remote, ref.slice(remotePrefix.length)]
          : [undefined, ""];
      // A name longer than the protocol carries cannot be sent, and git
      // allows such names only in theory.
      if (list === undefined || name.length > MAX_FACT_LENGTH) continue;
      if (!name.toLowerCase().includes(needle)) continue;
      if (list.length < maxBranches) list.push(name);
      else more = true;
    }
    return { status: "listed", local, remote, more };
  });
