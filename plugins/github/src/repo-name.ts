/**
 * How this plugin accepts a repository from a person: as `owner/repo`, in a
 * GitHub Connection's config and in a workflow action's params.
 */
import { Schema } from "effect";

/**
 * The pattern of a repository as `owner/repo`, unanchored, so a longer
 * pattern such as an External Ref can hold it. It allows only the characters
 * GitHub allows: letters, digits and hyphens in an owner, and dots and
 * underscores too in a repository name. Every caller puts the value into a
 * REST path as it is, so a name made of dots only, `.` or `..`, is refused:
 * a URL path would read `..` as "one level up".
 */
export const REPO_NAME_PATTERN = "[A-Za-z0-9-]+/(?!\\.{1,2}(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+";

/** A repository as `owner/repo`, as `REPO_NAME_PATTERN` allows it. */
export const RepoName = Schema.String.check(
  Schema.isPattern(new RegExp(`^${REPO_NAME_PATTERN}$`), {
    message: "Write the repository as owner/repo, such as octocat/hello-world.",
  }),
).annotate({ description: "The repository, written as owner/repo." });
