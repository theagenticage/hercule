import type { JSX } from "react";
import type { HerculeClient } from "@hercule/client-core";
import { StepKicker } from "../../screens/first-run";
import { NewProjectForm } from "../../screens/new-project";

/**
 * Renders the project step around the New project form. Without GitHub, the
 * form accepts a folder or a typed name and adds no repository yet, and
 * `onConnectGitHub` goes back to the GitHub step.
 */
export function ProjectCard({
  client,
  gitHubConnected,
  onAdded,
  onConnectGitHub,
}: {
  readonly client: HerculeClient;
  readonly gitHubConnected: boolean;
  readonly onAdded: () => void;
  readonly onConnectGitHub: () => void;
}): JSX.Element {
  return (
    <>
      <StepKicker step="project" />
      <h1 className="st-h">Add your first project</h1>
      <p className="st-sub">
        {gitHubConnected
          ? "A project is a set of repositories your agents work in. Adopt an existing folder or let Hercule manage its own checkout."
          : "A project is a set of repositories your agents work in. Pick a folder or name the project now; add its repository once GitHub is connected."}
      </p>
      <NewProjectForm client={client} onAdded={onAdded} onConnectGitHub={onConnectGitHub} />
    </>
  );
}
