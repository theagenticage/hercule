import { useState, type JSX, type KeyboardEvent } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  createProjectWithRepositories,
  filterGitHubConnections,
  isClonableRemote,
  isNewProjectCreated,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
  type NewProjectForm,
  type NewProjectSubmission,
} from "@hercule/client-core";
import { connectionsQuery } from "../../app/queries";
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
 * Renders the New project form: the user picks a folder on this Mac, and
 * the form creates a project named after it, with the folder's repository
 * as the project's repo resource. The first run's project step draws it in
 * its card, and New thread's picker opens it in a dialog.
 *
 * Main reads the folder's `origin` remote with git, and the form shows what
 * it found:
 *
 * - a repository with a remote: the project name and an optional setup command;
 * - a repository with no remote, or a remote runners cannot clone: a field
 *   for the remote;
 * - a folder that is not a git repository, or that git could not read: an
 *   offer to create the project without a repository.
 *
 * Runners clone the repository through the first GitHub Connection. With no
 * GitHub Connection, the project is created without its repository, and the
 * form shows that. `onConnectGitHub`, when given, adds a Connect GitHub now
 * button there; the first run passes it to go back to its GitHub step.
 *
 * The folder itself is never changed: threads clone from the remote.
 *
 * Once a folder is picked, no field takes the focus, as in the book. The
 * name is already filled in, and a focused text field costs the GPU process
 * memory and wakeups for as long as it has the focus (spec 17, Measured).
 *
 * Once everything is created, the project and resource reads are refreshed
 * and then `onAdded` is called with the project's id, so the caller finds
 * the project in the cache. When the project is created but its repository
 * is not, the form shows why: Add project sends the repository again, and
 * "Continue without the repository" calls `onAdded` with the project as it
 * is.
 *
 * `client` is the client of the controller the project is created on. It
 * is passed in because the first run renders the form outside the routes
 * that hold a saved controller.
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
  const gitHubConnections = filterGitHubConnections(connections);
  const gitHub = gitHubConnections[0];

  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const [name, setName] = useState("");
  const [remote, setRemote] = useState("");
  const [setupCommand, setSetupCommand] = useState("");
  // What the last submission left: what exists, and why the rest does not.
  const [lastSubmission, setLastSubmission] = useState<NewProjectSubmission | null>(null);

  const pick = useMutation({
    mutationFn: () => bridge.folder.pick(),
    onSuccess: (outcome) => {
      if (outcome._tag === "Cancelled") return;
      setFolder(outcome);
      setName(outcome.name);
      setRemote(outcome._tag === "Repository" ? outcome.remote : "");
      setSetupCommand("");
      setLastSubmission(null);
    },
  });

  const create = useMutation({
    mutationFn: (form: NewProjectForm) => createProjectWithRepositories(client, form),
    onSuccess: async (next) => {
      setLastSubmission(next);
      // Projects and resources have no live topic yet, so they are read again
      // here, before the caller looks the project up.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.resources() }),
      ]);
      if (isNewProjectCreated(next)) onAdded(next.projectId);
    },
  });

  if (folder === null) {
    return (
      <ChooseFolder
        pending={pick.isPending}
        error={pick.error === null ? null : readErrorMessage(pick.error)}
        hasGitHub={gitHub !== undefined}
        onPick={() => pick.mutate()}
      />
    );
  }

  const projectId = lastSubmission?.projectId ?? null;
  const repository = lastSubmission?.repositories[0];
  const projectName = name.trim() === "" ? folder.name : name.trim();
  const pending = create.isPending;

  /** Sends the form, with the folder's repository or without it. */
  const submit = (withRepository: boolean): void => {
    if (pending) return;
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
              },
            ]
          : [],
    });
  };

  const card = (
    <FolderCard
      folder={folder}
      pending={pending}
      // Once the project exists, another folder would make a second one.
      onChange={projectId === null ? () => pick.mutate() : undefined}
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
        {lastSubmission === null || lastSubmission.failure === null ? null : (
          <p className="fl-err new-project-err" role="alert">
            {lastSubmission.failure}
          </p>
        )}
      </>
    );
  }

  // A repository whose remote runners cannot clone, such as a path on this
  // Mac, is treated as one with no remote: the user enters the remote.
  const asksForRemote =
    gitHub !== undefined && (folder._tag === "NoRemote" || !isClonableRemote(folder.remote));

  const nameField = (
    <FormField label="Project name" error={lastSubmission?.failure ?? null}>
      <input
        value={name}
        disabled={projectId !== null}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={submitOnEnter(() => submit(gitHub !== undefined))}
      />
    </FormField>
  );

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
      <div className="st-form">
        {asksForRemote ? (
          <FormField
            label="Remote URL"
            error={repository?.createdId === null ? repository.message : null}
          >
            <input
              className="mono"
              value={remote}
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
          hint="Runs in every new workspace before the agent starts."
        >
          <input
            className="mono"
            value={setupCommand}
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
      <div className="st-actions">
        <button
          type="button"
          className="btn btn--accent btn--lg"
          disabled={pending || (asksForRemote && remote.trim() === "")}
          onClick={() => submit(true)}
        >
          Add project
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
