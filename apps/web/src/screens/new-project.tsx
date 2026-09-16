import { useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  githubConnections,
  isClonableRemote,
  queryKeys,
  REMOTE_REFUSAL,
  type HydraClient,
} from "@hydra/client-core";
import type { ResourceCreateInput } from "@hydra/contract";
import { connectionsQuery } from "../app/queries";
import { NewProjectDialog, type SourceDraft } from "./new-project-dialog";
import { messageOf } from "./save-status";

/**
 * Creating a project and the sources it works with (D-20b): the project first,
 * then one resource per source under it, and the draft composer in it once
 * everything stands.
 *
 * Neither write is undone when a later one is refused - a project that exists
 * exists - so what already stands is remembered and skipped on the next
 * submission, and only what was refused is sent again.
 *
 * Which is also what leaving does (R4): once the project has been made, Cancel
 * and Esc open the draft in it rather than dropping the user back where they
 * started with a project they were never shown. What was refused was named on
 * its own row and is simply not made.
 */
export function NewProject({
  client,
  onClose,
}: {
  readonly client: HydraClient;
  readonly onClose: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accounts = githubConnections(useQuery(connectionsQuery(client)).data?.items ?? []).map(
    (connection) => ({ id: connection.id, label: connection.label }),
  );

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

  const patch = (key: string, next: Partial<SourceDraft>): void => {
    setSources((current) =>
      current.map((source) => (source.key === key ? { ...source, ...next } : source)),
    );
  };

  const pending = createProject.isPending || createResource.isPending;

  /**
   * The way out. A project that stands is where the user is taken, so nothing
   * is left made-but-unseen; a request in flight is not something to walk out
   * of, so while one is the dialog holds.
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
    // Refused before anything is sent: a remote git would not take is a
    // spelling the user can fix without a round trip.
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
        setFailure(messageOf(error));
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
        patch(source.key, { createdId: resource.id, message: null });
      } catch (error) {
        refused = true;
        patch(source.key, { message: messageOf(error) });
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
      onChangeSource={patch}
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
