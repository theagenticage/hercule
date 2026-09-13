import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@hydra/ui";
import {
  configDraft,
  configFields,
  configIssues,
  configPayload,
  queryKeys,
  type ConfigDraft,
  type ConnectionType,
  type HydraClient,
} from "@hydra/client-core";
import type { Connection } from "@hydra/contract";
import { ConfigFieldRow } from "../../../screens/plugins/config-form";
import { SaveStatus, messageOf } from "../../../screens/save-status";
import { Naming } from "./-naming";

/**
 * What the user decides about a connection after it exists: its label, its
 * topic, and whatever settings its type declares. Never the account and never
 * the credential - those are the type's answer and the setup's, and neither is
 * editable here.
 */
export function ConfigureConnection({
  client,
  connection,
  type,
  onDone,
}: {
  readonly client: HydraClient;
  readonly connection: Connection;
  /** Absent when the plugin that declared the type is no longer in the binary. */
  readonly type: ConnectionType | undefined;
  readonly onDone: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const fields = configFields(type?.configSchema);

  const [draft, setDraft] = useState<ConfigDraft>(() => configDraft(fields, connection.config));
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
            : { config: configPayload(fields, draft, connection.config) }),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
      onDone();
    },
  });

  // A setting the type refused belongs under the setting it named; anything
  // else refused is the form's own to say.
  const issues = configIssues(save.error, fields, "config");
  const failure = issues.rest ? save.error : null;

  // What the last save was refused for is about what was in the fields then.
  const edit = (): void => {
    if (!save.isIdle) save.reset();
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate();
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

      <div className="flex items-center gap-1.5">
        <Button type="submit" variant="form" disabled={save.isPending}>
          Save
        </Button>
        <Button type="button" variant="form" onClick={onDone}>
          Cancel
        </Button>
      </div>

      {/* The form closes on a save that worked, so only a refusal is shown. */}
      <SaveStatus saved={false} failure={failure === null ? null : messageOf(failure)} />
    </form>
  );
}
