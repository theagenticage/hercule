/**
 * How this plugin accepts a repository from a person: as `owner/repo`, in a
 * GitHub Connection's config and in a workflow action's params.
 */
import { Schema } from "effect";

/**
 * A repository as `owner/repo`. The pattern allows only the characters GitHub
 * allows: letters, digits and hyphens in an owner, and dots and underscores
 * too in a repository name. Every caller puts the value into a REST path as
 * it is, so a name made of dots only is refused: a URL path would read `..`
 * as "one level up".
 */
export const RepoName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/, {
    message: "Write the repository as owner/repo, such as octocat/hello-world.",
  }),
).annotate({ description: "The repository, written as owner/repo." });
