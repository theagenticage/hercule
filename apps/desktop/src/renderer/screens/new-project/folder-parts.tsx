/**
 * The presentational parts of the New project form that show the folder the
 * user picked, and what git found in it. Every part here takes values and
 * callbacks and reads nothing.
 */
import type { JSX, ReactNode } from "react";
import { isGitHubRemote, parseRepositoryName } from "@hercule/client-core";
import type { FolderPickOutcome } from "../../../ipc/contract";
import { BranchIcon } from "../../icons/branch";
import { PauseIcon } from "../../icons/pause";
import { QuestionIcon } from "../../icons/question";
import { WorkspaceIcon } from "../../icons/workspace";
import { GitHubMark } from "../../logos";
import { MarkedCard, Warning } from "../step";

/** A folder the user picked, as git describes it. */
export type PickedFolder = Exclude<FolderPickOutcome, { readonly _tag: "Cancelled" }>;

/**
 * Renders the form before a folder is picked: the Choose a folder button,
 * the error when the folder dialog did not open, and a note on what threads
 * do with the folder. `hasGitHub` picks the note: without a GitHub
 * Connection, threads work without a checkout.
 */
export function ChooseFolder({
  pending,
  error,
  hasGitHub,
  onPick,
}: {
  readonly pending: boolean;
  /** The folder dialog's error message, or `null`. */
  readonly error: string | null;
  readonly hasGitHub: boolean;
  readonly onPick: () => void;
}): JSX.Element {
  return (
    <>
      <button type="button" className="pick-folder" disabled={pending} onClick={onPick}>
        <span className="ico">
          <WorkspaceIcon size={20} />
        </span>
        <b>Choose a folder…</b>
      </button>
      {error === null ? null : (
        <p className="fl-err" role="alert">
          The folder dialog did not open: {error}
        </p>
      )}
      {hasGitHub ? (
        <p className="st-note">
          <BranchIcon size={14} />
          <span>
            Threads work in their own workspaces, cloned from the remote.{" "}
            <b>The folder you pick stays as it is.</b>
          </span>
        </p>
      ) : (
        <p className="st-note">
          <WorkspaceIcon size={14} />
          <span>
            Until the repository joins, threads work without a checkout.{" "}
            <b>The folder you pick stays as it is.</b>
          </span>
        </p>
      )}
    </>
  );
}

/**
 * Renders the card of the picked `folder`: its name, and under it where its
 * repository is hosted and its branch. When `onChange` is set, the card ends with a
 * Change button that picks another folder.
 */
export function FolderCard({
  folder,
  pending,
  onChange,
}: {
  readonly folder: PickedFolder;
  readonly pending: boolean;
  readonly onChange: (() => void) | undefined;
}): JSX.Element {
  return (
    <MarkedCard
      mark={<WorkspaceIcon size={18} />}
      name={<b className="mono">{folder.name}</b>}
      detail={renderFolderDetail(folder)}
      end={
        onChange === undefined ? null : (
          <button
            type="button"
            className="btn btn--sm btn--quiet"
            disabled={pending}
            onClick={onChange}
          >
            Change
          </button>
        )
      }
    />
  );
}

/**
 * Renders the line under the folder's name on its card: where its
 * repository is hosted and its branch, or why it has no repository Hercule
 * can use.
 */
function renderFolderDetail(folder: PickedFolder): ReactNode {
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

/**
 * Renders the warning for a folder git found no repository in: `NotGit` for
 * a folder that is not one, `GitFailed` with git's own line for a folder it
 * could not read. Its button creates the project without a repository.
 */
export function NotGitWarning({
  folder,
  pending,
  onCreateWithoutRepository,
}: {
  readonly folder: Extract<PickedFolder, { readonly _tag: "NotGit" | "GitFailed" }>;
  readonly pending: boolean;
  readonly onCreateWithoutRepository: () => void;
}): JSX.Element {
  return (
    <Warning icon={<QuestionIcon size={14} />}>
      {folder._tag === "NotGit" ? (
        <b>This folder isn’t a git repository.</b>
      ) : (
        <>
          <b>Git could not read this folder.</b> It stopped with “{folder.line}”.
        </>
      )}{" "}
      Hercule clones projects from a remote, so it needs one. Choose another folder, or create the
      project now and add a repository later.
      <br />
      <button
        type="button"
        className="btn btn--sm"
        disabled={pending}
        onClick={onCreateWithoutRepository}
      >
        Create {folder.name} without a repository
      </button>
    </Warning>
  );
}

/**
 * Renders the warning that `projectName` starts without its repository,
 * because there is no GitHub Connection to clone it through. With
 * `onConnectGitHub`, it offers Connect GitHub now; otherwise it sends the
 * user to the web app.
 */
export function NoGitHubWarning({
  projectName,
  onConnectGitHub,
}: {
  readonly projectName: string;
  readonly onConnectGitHub: (() => void) | undefined;
}): JSX.Element {
  return (
    <Warning icon={<PauseIcon size={14} />}>
      <b>{projectName} starts without its repository.</b> Runners clone it through a GitHub
      Connection,{" "}
      {onConnectGitHub === undefined ? (
        <>
          and there is none yet. Connect GitHub in the web app, then add {projectName}’s repository
          there.
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
  );
}

/**
 * Renders the warning over the Remote URL field: the repository in `folder`
 * has no remote, or one runners cannot clone, such as a path on this Mac.
 */
export function RemoteWarning({
  folder,
}: {
  readonly folder: Extract<PickedFolder, { readonly _tag: "Repository" | "NoRemote" }>;
}): JSX.Element {
  return (
    <Warning icon={<QuestionIcon size={14} />}>
      {folder._tag === "NoRemote" ? (
        <>
          <b>This repository has no remote.</b> Runners clone from a remote, never from this folder.
          Push it to GitHub first, or enter a remote URL below.
        </>
      ) : (
        <>
          <b>Runners can’t clone from this remote.</b> They clone over https:// or SSH, never from
          this Mac. Enter a remote URL below.
        </>
      )}
    </Warning>
  );
}
