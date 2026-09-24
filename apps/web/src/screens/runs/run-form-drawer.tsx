import { useState, type FormEvent, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  hasConnectionField,
  queryKeys,
  buildRunForm,
  decideRunFormIssues,
  type HerculeClient,
} from "@hercule/client-core";
import type { RunInputs } from "@hercule/contract";
import { Drawer, Field, Select } from "@hercule/ui";
import { connectionsQuery, workflowQuery, workflowsQuery } from "../../app/queries";
import { RunFormButtons, RunFormFields, RunFormSummary } from "./run-form";

/**
 * Renders the run form in a drawer. It reads the workflow's inputs and the
 * Connections they can use, starts the run, and then goes to the run's page.
 *
 * - Given a `workflowId`, as on a workflow's page, the form runs that workflow.
 * - Without one, as on the run list, the form first shows a select for the
 *   workflow to run, and shows that workflow's inputs once it is picked.
 *
 * A run uses the saved workflow, so the inputs come from the stored source.
 * Until the fields can be shown, Start cannot be pressed, and the error of a
 * failed read shows where the error of a refused start would.
 */
export function RunFormDrawer({
  client,
  workflowId: fixedId,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly workflowId: string | undefined;
  readonly onClose: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pickedId, setPickedId] = useState("");
  const workflowId = fixedId ?? pickedId;

  const workflows = useQuery({ ...workflowsQuery(client), enabled: fixedId === undefined });
  const workflow = useQuery({ ...workflowQuery(client, workflowId), enabled: workflowId !== "" });
  const connections = useQuery(connectionsQuery(client));

  const start = useMutation({
    mutationFn: (inputs: RunInputs) => client.run.start({ payload: { workflowId, inputs } }),
    onSuccess: async ({ runId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs() });
      await navigate({ to: "/runs/$runId", params: { runId } });
    },
  });

  const form =
    workflow.data === undefined
      ? undefined
      : buildRunForm(workflow.data.source, connections.data?.items ?? []);
  const readFields = form !== undefined && "fields" in form ? form.fields : undefined;
  // Only a form with a Connection field needs the Connections, and it waits
  // for them, so its choice never shows empty and then fills in.
  const needsConnections = readFields !== undefined && hasConnectionField(readFields);
  const fields = needsConnections && connections.data === undefined ? undefined : readFields;
  const loadError =
    workflows.error ?? workflow.error ?? (needsConnections ? connections.error : null);
  const issues = decideRunFormIssues({ startError: start.error, loadError, form });

  const title = fixedId === undefined ? "Run a workflow" : "Run this workflow";

  return (
    <Drawer open title={title} onClose={onClose}>
      <form
        aria-label={title}
        className="flex flex-col gap-4"
        // Start starts the run itself, as its click, which pressing Enter
        // in a field also makes.
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
        }}
      >
        {fixedId === undefined ? (
          <Field id="run-workflow" label="Workflow">
            <Select
              id="run-workflow"
              autoFocus
              value={pickedId}
              onChange={(event) => {
                start.reset();
                setPickedId(event.target.value);
              }}
            >
              <option value="">Choose a workflow</option>
              {(workflows.data?.items ?? []).map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {fields === undefined || workflowId === "" ? (
          <>
            <RunFormSummary issues={issues} />
            <RunFormButtons isStartDisabled onStart={() => {}} onCancel={onClose} />
          </>
        ) : (
          <RunFormFields
            key={workflowId}
            fields={fields}
            issues={issues}
            isStarting={start.isPending}
            isFirstFieldFocused={fixedId !== undefined}
            onStart={(inputs) => {
              start.mutate(inputs);
            }}
            onCancel={onClose}
          />
        )}
      </form>
    </Drawer>
  );
}
