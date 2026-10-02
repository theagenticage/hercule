import { useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createProjectWithRepositories,
  filterGitHubConnections,
  isNewProjectCreated,
  queryKeys,
  type HerculeClient,
  type NewProjectForm,
} from "@hercule/client-core";
import { connectionsQuery } from "../app/queries";
import { NewProjectDialog, type SourceSubmission } from "./new-project-dialog";

/**
 * Creates a project and its sources with `createProjectWithRepositories`, and
 * then opens a draft thread in the project.
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
  const [sources, setSources] = useState<readonly SourceSubmission[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (form: NewProjectForm<SourceSubmission>) =>
      createProjectWithRepositories(client, form),
    // Only what this submission created is read again.
    onSuccess: async (next, form) => {
      const created = next.repositories.some(
        (source, index) => source.createdId !== form.repositories[index]?.createdId,
      );
      await Promise.all([
        next.projectId === form.projectId
          ? undefined
          : queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
        created ? queryClient.invalidateQueries({ queryKey: queryKeys.resources() }) : undefined,
      ]);
    },
  });

  const patchSource = (key: string, next: Partial<SourceSubmission>): void => {
    setSources((current) =>
      current.map((source) => (source.key === key ? { ...source, ...next } : source)),
    );
  };

  const pending = create.isPending;

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
    const next = await create.mutateAsync({ name, projectId, repositories: sources });
    setFailure(next.failure);
    setProjectId(next.projectId);
    const sent = new Map(next.repositories.map((source) => [source.key, source]));
    // Only what the submission decided is copied back, so a source keeps
    // anything else it holds now.
    setSources((current) =>
      current.map((source) => {
        const after = sent.get(source.key);
        return after === undefined
          ? source
          : { ...source, createdId: after.createdId, message: after.message };
      }),
    );
    if (!isNewProjectCreated(next)) return;

    onClose();
    await navigate({ to: "/threads/new", search: { project: next.projectId } });
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
            connectionId: null,
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
