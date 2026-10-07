import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  createProjectWithRepositories,
  filterGitHubConnections,
  findProjectLocalRunner,
  isProjectWorkspacePending,
  reconcileProjectWorkspaces,
  type ProjectWorkspaceSelection,
  isClonableRemote,
  isNewProjectCreated,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
  type NewProjectForm,
  type NewProjectSubmission,
} from "@hercule/client-core";
import {
  connectionsQuery,
  localRunnerQuery,
  runnersQuery,
  workspacesQuery,
} from "../../app/queries";
import { FormField } from "../step";
import {
  ChooseFolder,
  FolderCard,
  NoGitHubWarning,
  NotGitWarning,
  RemoteWarning,
  type PickedFolder,
} from "./folder-parts";
import "./new-project.css";

/** Calls `submit` when Enter is pressed in a field, as a form's own submit would. */
const submitOnEnter =
  (submit: () => void) =>
  (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") submit();
  };

/**
 * Renders manual project creation and explicit checkout choices for a local folder.
 * Keeps successful project and Resource writes through workspace preparation and
 * retries. Live Workspace records decide when the project can open.
 */
export function NewProjectForm({
  client,
  onAdded,
  onConnectGitHub,
}: {
  readonly client: HerculeClient;
  readonly onAdded: (projectId: string) => void;
  readonly onConnectGitHub?: () => void;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const queryClient = useQueryClient();
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const runnerRead = useQuery(runnersQuery(client));
  const identity = useQuery(localRunnerQuery(bridge, runnerRead.data ?? []));
  const workspaceRead = useQuery(workspacesQuery(client));
  const workspaces = workspaceRead.data;
  const gitHubConnections = filterGitHubConnections(connections);
  const gitHub = gitHubConnections[0];

  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const [name, setName] = useState("");
  const [remote, setRemote] = useState("");
  const [setupCommand, setSetupCommand] = useState("");
  const [mode, setMode] = useState<ProjectWorkspaceSelection["mode"] | null>(null);
  // What the last submission left: what exists, and why the rest does not.
  const [lastSubmission, setLastSubmission] = useState<NewProjectSubmission | null>(null);

  const localRunner = findProjectLocalRunner(
    runnerRead.data ?? [],
    identity.data,
    !identity.isPlaceholderData && !identity.isFetching && !runnerRead.isFetching,
    lastSubmission?.repositories[0]?.workspaceSelection,
  );
  const submission = useMemo(
    () =>
      lastSubmission === null ? null : reconcileProjectWorkspaces(lastSubmission, workspaces ?? []),
    [lastSubmission, workspaces],
  );
  const openedProject = useRef<string | null>(null);
  useEffect(() => {
    if (
      submission !== null &&
      isNewProjectCreated(submission) &&
      openedProject.current !== submission.projectId
    ) {
      openedProject.current = submission.projectId;
      onAdded(submission.projectId);
    }
  }, [submission, onAdded]);

  const pick = useMutation({
    mutationFn: () => {
      if (localRunner === null)
        throw new Error(
          "No online runner on this Mac has been identified. Connect the local runner before choosing a folder.",
        );
      return bridge.folder.pick();
    },
    onSuccess: (outcome) => {
      if (outcome._tag === "Cancelled") return;
      setFolder(outcome);
      setName(outcome.name);
      setRemote(outcome._tag === "Repository" ? outcome.remote : "");
      setSetupCommand("");
      setMode(null);
      setLastSubmission(null);
    },
  });

  const create = useMutation({
    mutationFn: (form: NewProjectForm) => createProjectWithRepositories(client, form),
    onSuccess: async (next) => {
      // Projects and resources have no live topic yet, so they are read again
      // here, before the caller looks the project up.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.resources() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces() }),
      ]);
      setLastSubmission(next);
    },
  });

  const projectId = submission?.projectId ?? null;
  const repository = submission?.repositories[0];
  const projectName = name.trim() === "" ? (folder?.name ?? "Your project") : name.trim();
  const pending =
    create.isPending || (submission !== null && isProjectWorkspacePending(submission));

  /** Sends the form, with the folder's repository or without it. */
  const submit = (withRepository: boolean): void => {
    if (pending || (withRepository && folder !== null && (localRunner === null || mode === null)))
      return;
    create.mutate({
      name,
      projectId,
      repositories:
        withRepository && gitHub !== undefined
          ? [
              {
                remote,
                setupCommand,
                connectionId: gitHub.id,
                createdId: repository?.createdId ?? null,
                message: null,
                ...(folder === null
                  ? {}
                  : {
                      workspaceSelection: repository?.workspaceSelection ?? {
                        mode: mode!,
                        runnerId: localRunner!.id,
                        path:
                          folder._tag === "Repository" || folder._tag === "NoRemote"
                            ? folder.path
                            : "",
                      },
                    }),
                workspace: repository?.workspace ?? null,
              },
            ]
          : [],
    });
  };

  const nameField = (
    <FormField label="Project name" error={submission?.failure ?? null}>
      <input
        value={name}
        disabled={projectId !== null}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={submitOnEnter(() =>
          submit(gitHub !== undefined && (folder !== null || remote.trim() !== "")),
        )}
      />
    </FormField>
  );

  if (folder === null) {
    return (
      <>
        <ChooseFolder
          pending={pick.isPending || localRunner === null || pending || projectId !== null}
          error={pick.error === null ? null : readErrorMessage(pick.error)}
          localRunnerUnavailable={localRunner === null}
          hasGitHub={gitHub !== undefined}
          onPick={() => pick.mutate()}
        />
        <p className="st-note">
          Or name a project and add its remote repository without choosing a folder.
        </p>
        <div className="st-form">
          {nameField}
          {gitHub === undefined ? null : (
            <FormField label="Remote URL" error={repository?.message ?? null}>
              <input
                className="mono"
                value={remote}
                disabled={repository?.createdId != null}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setRemote(event.target.value)}
                onKeyDown={submitOnEnter(() => remote.trim() !== "" && submit(true))}
              />
            </FormField>
          )}
        </div>
        <div className="st-actions">
          {gitHub === undefined ? null : (
            <button
              type="button"
              className="btn btn--accent btn--lg"
              disabled={pending || remote.trim() === ""}
              onClick={() => submit(true)}
            >
              Add project
            </button>
          )}
          <button
            type="button"
            className="btn btn--quiet"
            disabled={pending}
            onClick={() => submit(false)}
          >
            Add project without a repository
          </button>
        </div>
      </>
    );
  }

  const card = (
    <FolderCard
      folder={folder}
      pending={pending}
      // Once the project exists, another folder would make a second one.
      onChange={projectId === null && localRunner !== null ? () => pick.mutate() : undefined}
    />
  );

  if (folder._tag === "NotGit" || folder._tag === "GitFailed") {
    return (
      <>
        {card}
        <NotGitWarning
          folder={folder}
          pending={pending}
          onCreateWithoutRepository={() => submit(false)}
        />
        {submission === null || submission.failure === null ? null : (
          <p className="fl-err new-project-err" role="alert">
            {submission.failure}
          </p>
        )}
      </>
    );
  }

  // A repository whose remote runners cannot clone, such as a path on this
  // Mac, is treated as one with no remote: the user enters the remote.
  const asksForRemote =
    gitHub !== undefined && (folder._tag === "NoRemote" || !isClonableRemote(folder.remote));

  if (gitHub === undefined) {
    return (
      <>
        {card}
        <NoGitHubWarning projectName={projectName} onConnectGitHub={onConnectGitHub} />
        <div className="st-form">{nameField}</div>
        <div className="st-actions">
          <button
            type="button"
            className="btn btn--accent btn--lg"
            disabled={pending}
            onClick={() => submit(false)}
          >
            Add project without a repository
          </button>
        </div>
      </>
    );
  }

  const repositoryFailed = projectId !== null && repository?.createdId === null;

  return (
    <>
      {card}
      {asksForRemote ? <RemoteWarning folder={folder} /> : null}
      <p className="fine new-project-source">
        {folder.path}
        <br />
        {localRunner?.name ?? "Local runner unavailable"}
      </p>
      <fieldset
        className="new-project-choices"
        disabled={pending || projectId !== null || localRunner === null}
      >
        <legend>Choose the files agents use</legend>
        <label>
          <input
            type="radio"
            name="project-checkout"
            checked={mode === "existing"}
            onChange={() => setMode("existing")}
          />
          Use this checkout<span>Keep its current branch and working files.</span>
        </label>
        <label>
          <input
            type="radio"
            name="project-checkout"
            checked={mode === "managed"}
            onChange={() => setMode("managed")}
          />
          Create a separate checkout<span>Let Hercule manage a separate checkout.</span>
        </label>
      </fieldset>
      <div className="st-form">
        {asksForRemote ? (
          <FormField
            label="Remote URL"
            error={repository?.createdId === null ? repository.message : null}
          >
            <input
              className="mono"
              value={remote}
              disabled={repository?.createdId != null}
              placeholder={`git@github.com:you/${folder.name}.git`}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setRemote(event.target.value)}
              onKeyDown={submitOnEnter(() => remote.trim() !== "" && submit(true))}
            />
          </FormField>
        ) : null}
        {nameField}
        <FormField
          label="Setup command"
          aside={<span className="fine new-project-optional">optional</span>}
          hint={
            mode === "existing"
              ? "Leaves this checkout untouched. Runs in new workspaces before the agent starts."
              : "Runs in every new workspace before the agent starts."
          }
        >
          <input
            className="mono"
            value={setupCommand}
            disabled={repository?.createdId != null}
            placeholder="pnpm install"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setSetupCommand(event.target.value)}
            onKeyDown={submitOnEnter(() => submit(true))}
          />
        </FormField>
      </div>
      {gitHubConnections.length > 1 ? (
        <p className="fine new-project-through">Cloned through {gitHub.label}.</p>
      ) : null}
      {repositoryFailed && !asksForRemote && repository.message !== null ? (
        <p className="fl-err new-project-err" role="alert">
          {projectName} was added, but its repository wasn’t: {repository.message}
        </p>
      ) : null}
      {repository?.createdId !== null && repository?.message ? (
        <p className="fl-err new-project-err" role="alert">
          {projectName} and its repository were added. {repository.message}
        </p>
      ) : null}
      {repository?.workspaceSelection && localRunner === null ? (
        <p className="fine" role="status">
          Reconnect the originally selected runner on this Mac before retrying.
        </p>
      ) : null}
      {pending && workspaceRead.error !== null ? (
        <p className="fl-err new-project-err" role="alert">
          Workspace status could not be refreshed: {readErrorMessage(workspaceRead.error)}{" "}
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => void workspaceRead.refetch()}
          >
            Refresh status
          </button>
        </p>
      ) : null}
      {pending && repository?.workspace ? (
        <p className="fine" role="status">
          Preparing the selected workspace…
        </p>
      ) : null}
      <div className="st-actions">
        <button
          type="button"
          className="btn btn--accent btn--lg"
          disabled={
            pending ||
            localRunner === null ||
            mode === null ||
            (asksForRemote && remote.trim() === "")
          }
          onClick={() => submit(true)}
        >
          {repository?.createdId !== null && repository?.message
            ? mode === "existing"
              ? "Retry attachment"
              : "Retry workspace"
            : "Add project"}
        </button>
        {repositoryFailed ? (
          <button
            type="button"
            className="btn btn--quiet"
            disabled={pending}
            onClick={() => onAdded(projectId)}
          >
            Continue without the repository
          </button>
        ) : null}
      </div>
    </>
  );
}
