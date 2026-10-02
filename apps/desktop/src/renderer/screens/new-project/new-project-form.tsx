import { useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  createProjectWithRepositories,
  filterGitHubConnections,
  isClonableRemote,
  isGitHubRemote,
  isNewProjectCreated,
  parseRepositoryName,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
  type NewProjectDraft,
} from "@hercule/client-core";
import type { FolderPickOutcome } from "../../../ipc/contract";
import { connectionsQuery } from "../../app/queries";
import { BranchIcon, PauseIcon, QuestionIcon, WorkspaceIcon } from "../../icons";
import { GitHubMark } from "../../logos";
import { FormField, MarkedCard, Warning } from "../step";
import "./new-project.css";

/** A folder the user picked, as git describes it. */
type PickedFolder = Exclude<FolderPickOutcome, { readonly _tag: "Cancelled" }>;

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
 * form says so. `onConnectGitHub`, when given, adds a Connect GitHub now
 * button there; the first run passes it to go back to its GitHub step.
 *
 * The folder itself is never changed: threads clone from the remote.
 *
 * Once everything is created, the project and resource reads are refreshed
 * and then `onAdded` is called with the project's id, so the caller finds
 * the project in the cache. When the project is created but its repository
 * is not, the form says why: Add project sends the repository again, and
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
  const [sent, setSent] = useState<NewProjectDraft | null>(null);

  const pick = useMutation({
    mutationFn: () => bridge.folder.pick(),
    onSuccess: (outcome) => {
      if (outcome._tag === "Cancelled") return;
      setFolder(outcome);
      setName(outcome.name);
      setRemote(outcome._tag === "Repository" ? outcome.remote : "");
      setSetupCommand("");
      setSent(null);
    },
  });

  const create = useMutation({
    mutationFn: (draft: NewProjectDraft) => createProjectWithRepositories(client, draft),
    onSuccess: async (next) => {
      setSent(next);
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
      <>
        <button
          type="button"
          className="pick-folder"
          disabled={pick.isPending}
          onClick={() => pick.mutate()}
        >
          <span className="ico">
            <WorkspaceIcon size={20} />
          </span>
          <b>Choose a folder…</b>
        </button>
        {pick.error === null ? null : (
          <p className="fl-err" role="alert">
            The folder dialog did not open: {readErrorMessage(pick.error)}
          </p>
        )}
        {gitHub === undefined ? (
          <p className="st-note">
            <WorkspaceIcon size={14} />
            <span>
              Until the repository joins, threads work without a checkout.{" "}
              <b>The folder you pick stays as it is.</b>
            </span>
          </p>
        ) : (
          <p className="st-note">
            <BranchIcon size={14} />
            <span>
              Threads work in their own worktrees, cloned from the remote.{" "}
              <b>The folder you pick stays as it is.</b>
            </span>
          </p>
        )}
      </>
    );
  }

  const projectId = sent?.projectId ?? null;
  const repository = sent?.repositories[0];
  const projectName = name.trim() === "" ? folder.name : name.trim();
  const pending = create.isPending;

  /** Sends the form, with the folder's repository or without it. */
  const submit = (withRepository: boolean): void => {
    if (pending) return;
    create.mutate({
      name,
      projectId,
      failure: null,
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
    <MarkedCard
      mark={<WorkspaceIcon size={18} />}
      name={<b className="mono">{folder.name}</b>}
      detail={describeFolder(folder)}
      end={
        // Once the project exists, another folder would make a second one.
        projectId === null ? (
          <button
            type="button"
            className="btn btn--sm btn--quiet"
            disabled={pending}
            onClick={() => pick.mutate()}
          >
            Change
          </button>
        ) : null
      }
    />
  );

  if (folder._tag === "NotGit" || folder._tag === "GitFailed") {
    return (
      <>
        {card}
        <Warning icon={<QuestionIcon size={14} />}>
          {folder._tag === "NotGit" ? (
            <b>This folder isn’t a git repository.</b>
          ) : (
            <>
              <b>Git could not read this folder.</b> It stopped with “{folder.line}”.
            </>
          )}{" "}
          Hercule clones projects from a remote, so it needs one. Choose another folder, or create
          the project now and add a repository later.
          <br />
          <button
            type="button"
            className="btn btn--sm"
            autoFocus
            disabled={pending}
            onClick={() => submit(false)}
          >
            Create {folder.name} without a repository
          </button>
        </Warning>
        {sent === null || sent.failure === null ? null : (
          <p className="fl-err new-project-err" role="alert">
            {sent.failure}
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
    <FormField label="Project name" error={sent?.failure ?? null}>
      <input
        value={name}
        // The first field takes the focus, and the remote comes first when it is asked for.
        autoFocus={!asksForRemote}
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
        <Warning icon={<PauseIcon size={14} />}>
          <b>{projectName} starts without its repository.</b> Runners clone it through a GitHub
          Connection,{" "}
          {onConnectGitHub === undefined ? (
            <>
              and there is none yet. Connect GitHub in the web app, then add {projectName}’s
              repository there.
            </>
          ) : (
            <>
              and you skipped that step. Connect GitHub, then add {projectName}’s repository.
              <br />
              <button type="button" className="btn btn--sm" onClick={onConnectGitHub}>
                <GitHubMark size={12} />
                Connect GitHub now
              </button>
            </>
          )}
        </Warning>
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
      {asksForRemote ? (
        <Warning icon={<QuestionIcon size={14} />}>
          {folder._tag === "NoRemote" ? (
            <>
              <b>This repository has no remote.</b> Runners clone from a remote, never from this
              folder. Push it to GitHub first, or enter a remote URL below.
            </>
          ) : (
            <>
              <b>Runners can’t clone from this remote.</b> They clone over https:// or SSH, never
              from this Mac. Enter a remote URL below.
            </>
          )}
        </Warning>
      ) : null}
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
              autoFocus
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
          hint="Runs in every new worktree before the agent starts."
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

/**
 * Returns the line under the folder's name on its card: where its
 * repository is hosted and its branch, or why it has no repository Hercule
 * can use.
 */
function describeFolder(folder: PickedFolder): ReactNode {
  switch (folder._tag) {
    case "NotGit":
      return "Not a git repository";
    case "GitFailed":
      return "Git could not read this folder";
    case "NoRemote":
      return folder.branch === null ? "git · no remote" : `git · ${folder.branch} · no remote`;
    case "Repository": {
      // A detached HEAD is on no branch, so none is named.
      const onBranch = folder.branch === null ? "" : ` · ${folder.branch}`;
      return isGitHubRemote(folder.remote) ? (
        <>
          <GitHubMark size={11} /> {parseRepositoryName(folder.remote) ?? folder.remote}
          {onBranch}
        </>
      ) : (
        `${folder.remote}${onBranch}`
      );
    }
  }
}
