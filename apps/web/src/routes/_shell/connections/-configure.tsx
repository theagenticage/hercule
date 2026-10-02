import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@hercule/ui";
import {
  buildConfigDraft,
  buildConfigFields,
  readConfigIssues,
  buildConfigPayload,
  queryKeys,
  type ConfigDraft,
  type ConnectionType,
  type HerculeClient,
  readErrorMessage,
} from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import { ConfigFieldRow } from "../../../screens/plugins/config-form";
import { SaveStatus } from "../../../screens/save-status";
import { Naming } from "./-naming";

/**
 * The form that edits an existing connection: its label, its topic, and the
 * settings its type declares. The account and the credential are fixed at
 * setup, so this form does not edit them.
 */
export function ConfigureConnection({
  client,
  connection,
  type,
  onDone,
}: {
  readonly client: HerculeClient;
  readonly connection: Connection;
  /** Absent when the plugin that declared the type is no longer in the binary. */
  readonly type: ConnectionType | undefined;
  readonly onDone: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const fields = buildConfigFields(type?.configSchema);

  const [draft, setDraft] = useState<ConfigDraft>(() =>
    buildConfigDraft(fields, connection.config),
  );
  const [label, setLabel] = useState(connection.label);
  const [topic, setTopic] = useState(connection.labels[0] ?? "");

  const save = useMutation({
    mutationFn: () =>
      client.connection.update({
        params: { id: connection.id },
        payload: {
          label,
          labels: [topic],
          // A type no longer in the binary has no schema to read its settings
          // against, so they are left exactly as they are stored.
          ...(type === undefined
            ? {}
            : { config: buildConfigPayload(fields, draft, connection.config) }),
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.connections() }),
  });

  // An error about one setting is shown under that setting; any other error
  // is shown at the bottom of the form.
  const issues = readConfigIssues(save.error, fields, "config");
  const failure = issues.rest ? save.error : null;

  // Clears the last save's error on any edit, because that error was about
  // the values the fields held then.
  const edit = (): void => {
    if (!save.isIdle) save.reset();
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    // React Query calls a callback passed to `mutate` only while this form is
    // on screen, so a reply that arrives after Cancel cannot close another panel.
    save.mutate(undefined, { onSuccess: onDone });
  };

  return (
    <form className="flex flex-col gap-3 border-t border-line-soft pt-3" onSubmit={send}>
      <Naming
        idPrefix={connection.id}
        label={label}
        topic={topic}
        onLabel={(next) => {
          edit();
          setLabel(next);
        }}
        onTopic={(next) => {
          edit();
          setTopic(next);
        }}
      />
      {fields.map((field) => (
        <ConfigFieldRow
          key={field.name}
          inputId={`${connection.id}-${field.name}`}
          field={field}
          value={draft[field.name] ?? ""}
          error={issues.perField[field.name]}
          onChange={(value) => {
            edit();
            setDraft((current) => ({ ...current, [field.name]: value }));
          }}
        />
      ))}

      <div className="flex items-center gap-2">
        {/* A quiet button's text is pulled back to line up with the fields above it. */}
        <Button type="button" className="-ml-2" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="form" disabled={save.isPending}>
          Save
        </Button>
      </div>

      {/* The form closes after a successful save, so only a failure is shown here. */}
      <SaveStatus saved={false} failure={failure === null ? null : readErrorMessage(failure)} />
    </form>
  );
}
