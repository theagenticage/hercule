import { useEffect, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { githubConnections, projectRepos, queryKeys, repoName } from "@hydra/client-core";
import type { ResourceCreateInput } from "@hydra/contract";
import { Field, Input, Select } from "@hydra/ui";
import { connectionsQuery, resourcesQuery, workspaceQuery } from "../../app/queries";
import { messageOf } from "../save-status";

/**
 * The two ways out of a project with nothing checked out anywhere:
 * name a repo Hydra should clone, or point at a folder on this machine that
 * already holds one. Both are forms inside the workspace menu rather than
 * screens of their own - the user is in the middle of starting a thread.
 */
export function AddRepoForm({
  projectId,
  onDone,
  onCancel,
}: {
  readonly projectId: string;
  readonly onDone: () => void;
  /** The way back to the menu the form was opened from. */
  readonly onCancel: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_shell" });
  const queryClient = useQueryClient();
  const connections = githubConnections(useQuery(connectionsQuery(client)).data?.items ?? []);
  const [remote, setRemote] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [setupCommand, setSetupCommand] = useState("");

  const create = useMutation({
    mutationFn: (payload: ResourceCreateInput) => client.resource.create({ payload }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.resources() });
      onDone();
    },
  });

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({
          kind: "repo",
          remote: remote.trim(),
          ...(connectionId === "" ? {} : { connectionId }),
          ...(setupCommand.trim() === "" ? {} : { setupCommand: setupCommand.trim() }),
          projectIds: [projectId],
        });
      }}
    >
      <Field id="add-repo-remote" label="Remote URL">
        <Input
          id="add-repo-remote"
          autoFocus
          value={remote}
          placeholder="git@github.com:acme/webshop.git"
          onChange={(event) => {
            setRemote(event.target.value);
          }}
        />
      </Field>
      <Field id="add-repo-connection" label="GitHub Connection">
        <Select
          id="add-repo-connection"
          value={connectionId}
          onChange={(event) => {
            setConnectionId(event.target.value);
          }}
        >
          <option value="">No connection</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="add-repo-setup" label="Setup command">
        <Input
          id="add-repo-setup"
          value={setupCommand}
          placeholder="pnpm install"
          onChange={(event) => {
            setSetupCommand(event.target.value);
          }}
        />
      </Field>
      <Actions pending={create.isPending} onCancel={onCancel}>
        Add repo
      </Actions>
      <Refusal message={create.error === null ? null : messageOf(create.error)} />
    </form>
  );
}

/**
 * Adopting a folder that already holds a checkout. The workspace is made on
 * the machine, so what the form shows afterwards is the machine's own answer:
 * `provisioning` until it has finished, then `ready`, or what went wrong.
 */
export function AdoptForm({
  projectId,
  runnerId,
  onCancel,
}: {
  readonly projectId: string;
  /** The machine the draft is placed on: the one whose folder is adopted. */
  readonly runnerId: string | null;
  /** The way back to the menu the form was opened from. */
  readonly onCancel: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_shell" });
  const queryClient = useQueryClient();
  const repos = projectRepos(useQuery(resourcesQuery(client)).data?.items ?? [], projectId);
  const [resourceId, setResourceId] = useState("");
  const [path, setPath] = useState("");
  const [provisioned, setProvisioned] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const provision = useMutation({
    mutationFn: (input: { readonly runnerId: string }) =>
      client.workspace.provision({
        payload: { resourceId, runnerId: input.runnerId, path: path.trim() },
      }),
    onSuccess: (workspace) => {
      queryClient.setQueryData(queryKeys.workspace(workspace.id), workspace);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces() });
      setProvisioned(workspace.id);
    },
  });

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        // Neither half is guessed at: a folder is a folder of one repo on one
        // machine, and a control that does nothing when pressed says nothing.
        if (resourceId === "") {
          setRefused("Pick a repo first");
          return;
        }
        if (runnerId === null) {
          setRefused("Pick a machine first");
          return;
        }
        setRefused(null);
        provision.mutate({ runnerId });
      }}
    >
      <Field id="adopt-repo" label="Repo">
        <Select
          id="adopt-repo"
          value={resourceId}
          onChange={(event) => {
            setResourceId(event.target.value);
          }}
        >
          <option value="">Pick a repo</option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repoName(repo)}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="adopt-path" label="Path">
        <Input
          id="adopt-path"
          value={path}
          placeholder="/Users/you/code/webshop"
          onChange={(event) => {
            setPath(event.target.value);
          }}
        />
      </Field>
      <Actions pending={provision.isPending} onCancel={onCancel}>
        Adopt
      </Actions>
      {/* One message at a time: a refusal here means nothing was sent, so the
          last answer from the API cannot also be standing. */}
      <Refusal
        message={refused ?? (provision.error === null ? null : messageOf(provision.error))}
      />
      {provisioned === null ? null : <Provisioning workspaceId={provisioned} />}
    </form>
  );
}

/** What the machine has done with the folder so far, until it says either way. */
function Provisioning({ workspaceId }: { readonly workspaceId: string }): JSX.Element | null {
  const { client } = useRouteContext({ from: "/_shell" });
  const queryClient = useQueryClient();
  const workspace = useQuery(workspaceQuery(client, workspaceId)).data;
  const status = workspace?.status;

  // The menu behind this form lists the workspaces; the one being made joins
  // that list the moment the machine says it stands, so the listing is reread
  // once the polling stops rather than staying a row short until something
  // else happens to reread it.
  useEffect(() => {
    if (status === undefined || status === "provisioning") return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces() });
  }, [status, queryClient]);

  if (workspace === undefined) return null;
  return (
    <p className="text-[11px] text-faint">
      <span>{workspace.status}</span>
      {workspace.message === null ? null : (
        <span className="block text-fail">{workspace.message}</span>
      )}
    </p>
  );
}

/** What the form is done with: the write, and the way back to the menu. */
function Actions({
  pending,
  onCancel,
  children,
}: {
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly children: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <button type="submit" disabled={pending} className={ACTION}>
        {children}
      </button>
      <button type="button" onClick={onCancel} className={ACTION}>
        Cancel
      </button>
    </div>
  );
}

const ACTION =
  "cursor-pointer rounded-full border border-line bg-raised px-[11px] py-[3px] text-meta text-ink hover:bg-line-soft disabled:cursor-default disabled:text-faint";

/** Why it was not done: this form's own refusal, or the API's. */
function Refusal({ message }: { readonly message: string | null }): JSX.Element | null {
  if (message === null) return null;
  return (
    <p className="text-[11px] text-fail" role="alert">
      {message}
    </p>
  );
}
