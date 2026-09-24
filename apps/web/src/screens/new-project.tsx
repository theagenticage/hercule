import { useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  filterGitHubConnections,
  isClonableRemote,
  queryKeys,
  REMOTE_REFUSAL,
  type HerculeClient,
} from "@hercule/client-core";
import type { ResourceCreateInput } from "@hercule/contract";
import { connectionsQuery } from "../app/queries";
import { NewProjectDialog, type SourceDraft } from "./new-project-dialog";
import { readErrorMessage } from "./save-status";

/**
 * Creates a project and its sources. It creates the project first, then one
 * resource per source, and then opens a draft thread in the project.
 *
 * A write that succeeded is not undone when a later one fails. Instead, what
 * was already created is remembered and skipped on the next submission, so
 * only the failed writes are sent again.
 *
 * Leaving follows the same idea. Once the project exists, Cancel and Esc
 * open a draft thread in it, rather than returning the user to where they
 * started with a project they never saw. A source that failed already shows
 * its error on its own row, and is simply not created.
 */
export function NewProject({
  client,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly onClose: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accounts = filterGitHubConnections(
    useQuery(connectionsQuery(client)).data?.items ?? [],
  ).map((connection) => ({ id: connection.id, label: connection.label }));

  const [name, setName] = useState("");
  const [sources, setSources] = useState<readonly SourceDraft[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  const createProject = useMutation({
    mutationFn: (value: string) => client.project.create({ payload: { name: value } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
  });
  const createResource = useMutation({
    mutationFn: (payload: ResourceCreateInput) => client.resource.create({ payload }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.resources() }),
  });

  const patchSource = (key: string, next: Partial<SourceDraft>): void => {
    setSources((current) =>
      current.map((source) => (source.key === key ? { ...source, ...next } : source)),
    );
  };

  const pending = createProject.isPending || createResource.isPending;

  /**
   * Closes the dialog. If the project was already created, it opens a draft
   * thread in it, so the user always sees what was created. Does nothing while
   * a request is in progress.
   */
  const leave = (): void => {
    if (pending) return;
    onClose();
    if (projectId !== null) void navigate({ to: "/threads/new", search: { project: projectId } });
  };

  const submit = async (): Promise<void> => {
    if (name.trim() === "") {
      setFailure("Name the project");
      return;
    }
    // Check the remotes before sending anything: a remote that git cannot
    // clone is a typo the user can fix without a round trip to the server.
    const written = sources.map((source) => ({
      ...source,
      message: source.createdId !== null || isClonableRemote(source.remote) ? null : REMOTE_REFUSAL,
    }));
    setSources(written);
    if (written.some((source) => source.message !== null)) return;

    setFailure(null);
    let id = projectId;
    if (id === null) {
      try {
        id = (await createProject.mutateAsync(name.trim())).id;
        setProjectId(id);
      } catch (error) {
        setFailure(readErrorMessage(error));
        return;
      }
    }

    let refused = false;
    for (const source of written) {
      if (source.createdId !== null) continue;
      try {
        const resource = await createResource.mutateAsync({
          kind: "repo",
          remote: source.remote.trim(),
          ...(source.connectionId === "" ? {} : { connectionId: source.connectionId }),
          ...(source.setupCommand.trim() === ""
            ? {}
            : { setupCommand: source.setupCommand.trim() }),
          projectIds: [id],
        });
        patchSource(source.key, { createdId: resource.id, message: null });
      } catch (error) {
        refused = true;
        patchSource(source.key, { message: readErrorMessage(error) });
      }
    }
    if (refused) return;

    onClose();
    await navigate({ to: "/threads/new", search: { project: id } });
  };

  return (
    <NewProjectDialog
      name={name}
      sources={sources}
      accounts={accounts}
      pending={pending}
      failure={failure}
      onName={setName}
      onAddSource={() => {
        setSources((current) => [
          ...current,
          {
            key: `source-${String(current.length + 1)}-${String(Date.now())}`,
            remote: "",
            connectionId: "",
            setupCommand: "",
            message: null,
            createdId: null,
          },
        ]);
      }}
      onChangeSource={patchSource}
      onRemoveSource={(key) => {
        setSources((current) => current.filter((source) => source.key !== key));
      }}
      onSubmit={() => {
        void submit();
      }}
      onClose={leave}
    />
  );
}
