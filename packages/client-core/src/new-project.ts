/**
 * Creates a new project and the repositories it works with. The web app's New
 * project dialog and the desktop app's first run both submit through
 * `createProjectWithRepositories`, so the order of the writes and the rule for
 * sending a form again are written once.
 */
import type { HerculeClient } from "./client";
import { readErrorMessage } from "./errors";
import { isClonableRemote, REMOTE_REFUSAL } from "./remote";

/** The error for a project with no name. */
export const PROJECT_NAME_REFUSAL = "Name the project";

/**
 * One repository in a New project form, as the form holds it between
 * submissions. Each one becomes a repo resource of the project.
 */
export interface RepositoryDraft {
  /** The git remote, as typed or read from a folder. */
  readonly remote: string;
  /** The command a fresh checkout runs, or empty for none. */
  readonly setupCommand: string;
  /** The GitHub Connection the repository is cloned and pushed through, or `null` for none. */
  readonly connectionId: string | null;
  /** The resource's id once a submission created it, or `null` while it does not exist. */
  readonly createdId: string | null;
  /** Why the repository was not created: the form's own check or the controller's error. */
  readonly message: string | null;
}

/**
 * A New project form between submissions. A project needs no repository at
 * all, so `repositories` may be empty: such a project holds work that is not
 * code.
 */
export interface NewProjectDraft<Repository extends RepositoryDraft = RepositoryDraft> {
  readonly name: string;
  /** The project's id once a submission created it, or `null` while it does not exist. */
  readonly projectId: string | null;
  /** Why the project itself was not created, or `null`. */
  readonly failure: string | null;
  readonly repositories: readonly Repository[];
}

/**
 * Creates the project in `draft`, then one repo resource per repository, and
 * returns the draft as the submission leaves it. It never throws: every error
 * is written into the returned draft, as `failure` for the project and as
 * `message` for a repository.
 *
 * - A blank name sends nothing and returns `PROJECT_NAME_REFUSAL` as the failure.
 * - Every remote is checked before anything is sent. A remote git would not
 *   accept is a typo the user can fix without a round trip, so any refused
 *   remote sends nothing.
 * - The project is created first, because each repository names it.
 *
 * A write that succeeded is not undone when a later one fails. Instead the
 * returned draft records what exists (`projectId`, each `createdId`), and the
 * next submission of that draft skips it, so only the failed writes are sent
 * again. `isNewProjectCreated` checks whether anything is left to send.
 */
export const createProjectWithRepositories = async <Repository extends RepositoryDraft>(
  client: HerculeClient,
  draft: NewProjectDraft<Repository>,
): Promise<NewProjectDraft<Repository>> => {
  const name = draft.name.trim();
  if (name === "") return { ...draft, failure: PROJECT_NAME_REFUSAL };

  const checked = draft.repositories.map((repository) => ({
    ...repository,
    message:
      repository.createdId !== null || isClonableRemote(repository.remote) ? null : REMOTE_REFUSAL,
  }));
  if (checked.some((repository) => repository.message !== null)) {
    return { ...draft, failure: null, repositories: checked };
  }

  let projectId = draft.projectId;
  if (projectId === null) {
    try {
      projectId = (await client.project.create({ payload: { name } })).id;
    } catch (error) {
      return { ...draft, failure: readErrorMessage(error), repositories: checked };
    }
  }

  const repositories: Repository[] = [];
  for (const repository of checked) {
    if (repository.createdId !== null) {
      repositories.push(repository);
      continue;
    }
    const setupCommand = repository.setupCommand.trim();
    try {
      const resource = await client.resource.create({
        payload: {
          kind: "repo",
          remote: repository.remote.trim(),
          ...(repository.connectionId === null ? {} : { connectionId: repository.connectionId }),
          ...(setupCommand === "" ? {} : { setupCommand }),
          projectIds: [projectId],
        },
      });
      repositories.push({ ...repository, createdId: resource.id });
    } catch (error) {
      repositories.push({ ...repository, message: readErrorMessage(error) });
    }
  }
  return { ...draft, projectId, failure: null, repositories };
};

/**
 * Checks whether the project and every repository in `draft` exist, so nothing
 * is left to send. When it returns true, `draft.projectId` is the project's id.
 */
export const isNewProjectCreated = <Draft extends NewProjectDraft>(
  draft: Draft,
): draft is Draft & { readonly projectId: string } =>
  draft.projectId !== null &&
  draft.repositories.every((repository) => repository.createdId !== null);
