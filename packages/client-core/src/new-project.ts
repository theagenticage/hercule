/**
 * Creates a new project and the repositories it works with. The web app's New
 * project dialog and the desktop app's first run both submit through
 * `createProjectWithRepositories`, so the order of the writes and the rule for
 * sending a form again are written once.
 */
import {
  canonicalizeRemote,
  type Runner,
  type Workspace,
  type RepositoryMode,
} from "@hercule/contract";
import { readEveryPage } from "./read-every-page";
import type { HerculeClient } from "./client";
import { readErrorMessage } from "./errors";
import { describeRemoteRefusal } from "./remote";

/** The error for a project with no name. */
export const PROJECT_NAME_REFUSAL = "Name the project";

/** The runner and repository mode selected before project creation. */
export interface ProjectWorkspaceSelection {
  readonly mode: RepositoryMode;
  readonly runnerId: string;
  readonly path: string;
}

/**
 * One repository in a New project form, as the form sends it and as a
 * submission leaves it. Each one becomes a repo resource of the project.
 */
export interface RepositorySubmission {
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
  /** An explicit checkout choice. Omitted by clients that only register a Resource. */
  readonly workspaceSelection?: ProjectWorkspaceSelection;
  /** The last preparation result, retained so retries keep the same workspace intent. */
  readonly workspace?: Workspace | null;
}

/**
 * A New project form as it is sent. A project needs no repository at all, so
 * `repositories` may be empty: such a project holds work that is not code.
 */
export interface NewProjectForm<Repository extends RepositorySubmission = RepositorySubmission> {
  readonly name: string;
  /** The project's id once a submission created it, or `null` while it does not exist. */
  readonly projectId: string | null;
  readonly repositories: readonly Repository[];
}

/** A New project form as a submission leaves it: what exists, and why the rest does not. */
export interface NewProjectSubmission<
  Repository extends RepositorySubmission = RepositorySubmission,
> extends NewProjectForm<Repository> {
  /** Why the project itself was not created, or `null`. */
  readonly failure: string | null;
}

/**
 * Creates the project in `form`, then one repo resource per repository, and
 * returns the form as the submission leaves it. It never throws: every error
 * is written into the returned submission, as `failure` for the project and
 * as `message` for a repository.
 *
 * - A blank name sends nothing and returns `PROJECT_NAME_REFUSAL` as the failure.
 * - Checks remotes before any write and reads the Resource catalogue to reuse
 *   existing canonical identities. Refuses unsupported remotes for new Resources.
 * - Creates the project before registering repositories or preparing workspaces.
 * - Preserves the connection and setup command of a reused Resource. Only its
 *   project association changes.
 *
 * A write that succeeded is not undone when a later one fails. Instead the
 * returned submission records what exists (`projectId`, each `createdId`),
 * and sending it as the next form skips that, so only the failed writes
 * are sent again. `isNewProjectCreated` checks whether anything is left to send.
 */
export const createProjectWithRepositories = async <Repository extends RepositorySubmission>(
  client: HerculeClient,
  form: NewProjectForm<Repository>,
): Promise<NewProjectSubmission<Repository>> => {
  const name = form.name.trim();
  if (name === "") return { ...form, failure: PROJECT_NAME_REFUSAL };

  let checked = form.repositories.map((repository): Repository => ({
    ...repository,
    message: null,
  }));
  let resources: Awaited<ReturnType<typeof client.resource.query>>["items"] = [];
  const unresolved = checked.filter((repository) => repository.createdId === null);
  if (unresolved.length > 0) {
    checked = checked.map((repository) => {
      const refusal = describeRemoteRefusal(repository.remote);
      const url = URL.canParse(repository.remote.trim()) ? new URL(repository.remote.trim()) : null;
      // An SSH URL can identify an existing Resource without changing the remote Git uses.
      const canReuse =
        url?.protocol === "ssh:" &&
        url.password === "" &&
        canonicalizeRemote(repository.remote) !== undefined;
      return repository.createdId === null && refusal !== null && !canReuse
        ? { ...repository, message: refusal }
        : repository;
    });
    if (checked.some((repository) => repository.message !== null))
      return { ...form, failure: null, repositories: checked };
    try {
      resources = await readEveryPage((page) => client.resource.query({ query: page }));
    } catch (error) {
      return {
        ...form,
        failure: null,
        repositories: checked.map((repository) =>
          repository.createdId === null
            ? { ...repository, message: readErrorMessage(error) }
            : repository,
        ),
      };
    }
    checked = checked.map((repository) => {
      const canonical = canonicalizeRemote(repository.remote);
      return repository.createdId === null &&
        !resources.some(
          (resource) =>
            resource.kind === "repo" &&
            canonical !== undefined &&
            resource.canonicalRemote === canonical,
        )
        ? { ...repository, message: describeRemoteRefusal(repository.remote) }
        : repository;
    });
    if (checked.some((repository) => repository.message !== null))
      return { ...form, failure: null, repositories: checked };
  }

  let projectId = form.projectId;
  if (projectId === null) {
    try {
      projectId = (await client.project.create({ payload: { name } })).id;
    } catch (error) {
      return { ...form, failure: readErrorMessage(error), repositories: checked };
    }
  }

  const repositories: Repository[] = [];
  for (const repository of checked) {
    let next: Repository = repository;
    try {
      if (next.createdId === null) {
        const canonical = canonicalizeRemote(next.remote);
        const existing = resources.find(
          (resource) =>
            resource.kind === "repo" &&
            canonical !== undefined &&
            resource.canonicalRemote === canonical,
        );
        const setupCommand = next.setupCommand.trim();
        const resource =
          existing === undefined
            ? await client.resource.create({
                payload: {
                  kind: "repo",
                  remote: next.remote.trim(),
                  ...(next.connectionId === null ? {} : { connectionId: next.connectionId }),
                  ...(setupCommand === "" ? {} : { setupCommand }),
                  projectIds: [projectId],
                },
              })
            : existing.projectIds.includes(projectId)
              ? existing
              : await client.resource.update({
                  params: { id: existing.id },
                  payload: { projectIds: [...existing.projectIds, projectId] },
                });
        resources = [...resources.filter((record) => record.id !== resource.id), resource];
        next = { ...next, createdId: resource.id };
      }
      const selection = next.workspaceSelection;
      if (
        selection !== undefined &&
        next.workspace?.status !== "ready" &&
        next.workspace?.status !== "provisioning"
      ) {
        const payload = { resourceId: next.createdId!, runnerId: selection.runnerId };
        const workspace =
          selection.mode === "existing"
            ? await client.workspace.attach({ payload: { ...payload, path: selection.path } })
            : await client.workspace.provision({ payload });
        next = {
          ...next,
          workspace,
          message:
            workspace.status === "failed"
              ? (workspace.message ??
                "Workspace preparation failed. Retry the same checkout choice.")
              : null,
        };
      }
    } catch (error) {
      next = { ...next, message: readErrorMessage(error) };
    }
    repositories.push(next);
  }
  return { ...form, projectId, failure: null, repositories };
};

/**
 * Checks whether the project and every repository in `submission` exist, so
 * nothing is left to send. When it returns true, `submission.projectId` is the
 * project's id.
 */
export const isNewProjectCreated = <Submission extends NewProjectSubmission>(
  submission: Submission,
): submission is Submission & { readonly projectId: string } =>
  submission.projectId !== null &&
  submission.repositories.every(
    (repository) =>
      repository.createdId !== null &&
      (repository.workspaceSelection === undefined || repository.workspace?.status === "ready"),
  );

/** Refreshes preparation results from the live Workspace records without replacing the selected intent. */
export const reconcileProjectWorkspaces = <Repository extends RepositorySubmission>(
  submission: NewProjectSubmission<Repository>,
  workspaces: ReadonlyArray<Workspace>,
): NewProjectSubmission<Repository> => ({
  ...submission,
  repositories: submission.repositories.map((repository) => {
    const workspace =
      repository.workspace === undefined || repository.workspace === null
        ? undefined
        : workspaces.find((record) => record.id === repository.workspace!.id);
    return workspace === undefined
      ? repository
      : {
          ...repository,
          workspace,
          message:
            workspace.status === "failed"
              ? (workspace.message ??
                "Workspace preparation failed. Retry the same checkout choice.")
              : null,
        };
  }),
});

/** Checks whether a submitted checkout is still being prepared by its runner. */
export const isProjectWorkspacePending = (submission: NewProjectSubmission): boolean =>
  submission.repositories.some(
    (repository) =>
      repository.workspaceSelection !== undefined &&
      repository.workspace?.status === "provisioning",
  );

/** Returns the currently identified online runner, or null until identity evidence is current. */
export const findProjectLocalRunner = (
  runners: ReadonlyArray<Runner>,
  localRunnerId: string | null | undefined,
  current: boolean,
  selection?: ProjectWorkspaceSelection,
): Runner | null =>
  current
    ? (runners.find(
        (runner) =>
          (selection === undefined || selection.runnerId === localRunnerId) &&
          runner.id === localRunnerId &&
          runner.connectivity === "online" &&
          runner.lifecycle === "active",
      ) ?? null)
    : null;
