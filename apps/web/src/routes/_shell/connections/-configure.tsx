import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Field, FormSection, Input } from "@hercule/ui";
import {
  buildConfigDraft,
  buildConfigFields,
  buildFeedIntervalsDraft,
  buildFeedIntervalsPayload,
  buildTopicsUpdate,
  readConfigHeading,
  readConnectionIssues,
  buildConfigPayload,
  queryKeys,
  type ConfigDraft,
  type ConnectionType,
  type FeedIntervalsDraft,
  type HerculeClient,
  readErrorMessage,
} from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import { ConfigFieldRow } from "../../../screens/plugins/config-form";
import { SaveStatus } from "../../../screens/save-status";
import { FeedIntervalFields } from "./-feed-intervals";

/**
 * Suggested topics for a connection. They are suggestions, not a closed list:
 * a topic is an ordinary label, so the user can type any other topic.
 */
const TOPICS = ["Code", "Business", "Personal", "Ops"];

/**
 * The form that edits an existing connection: its name, its topic, the
 * settings its type declares, and how often each of its feeds is polled. The
 * account and the credential are fixed at setup, so this form does not edit
 * them.
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
  const feeds = type?.feeds ?? [];

  const [draft, setDraft] = useState<ConfigDraft>(() =>
    buildConfigDraft(fields, connection.config),
  );
  const [intervals, setIntervals] = useState<FeedIntervalsDraft>(() =>
    buildFeedIntervalsDraft(feeds, connection.feedIntervals),
  );
  const [label, setLabel] = useState(connection.label);
  // The form shows only the first topic. Any topics after it, set through the
  // CLI or the API, are kept when the user saves.
  const [topic, setTopic] = useState(connection.labels[0] ?? "");

  const save = useMutation({
    mutationFn: () => {
      const labels = buildTopicsUpdate(connection.labels, topic);
      return client.connection.update({
        params: { id: connection.id },
        payload: {
          label,
          ...(labels === undefined ? {} : { labels }),
          // A type no longer in the binary has no schema to read its settings
          // against, so they are left exactly as they are stored.
          ...(type === undefined
            ? {}
            : { config: buildConfigPayload(fields, draft, connection.config) }),
          // With no feeds on screen, which includes a type no longer in the
          // binary, the stored intervals are left exactly as they are.
          ...(feeds.length === 0
            ? {}
            : { feedIntervals: buildFeedIntervalsPayload(feeds, intervals) }),
        },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.connections() }),
  });

  // An error about one setting or one feed is shown under its field; any
  // other error is shown at the bottom of the form.
  const issues = readConnectionIssues(save.error, fields, feeds);
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
    // The sections sit twice as far apart as the fields inside them, so each
    // section heading starts a group instead of ending the one above it.
    <form className="flex flex-col gap-6 border-t border-line-soft pt-3" onSubmit={send}>
      <div className="flex flex-col gap-3">
        <Field id={`${connection.id}-label`} label="Name">
          <Input
            id={`${connection.id}-label`}
            // The controller refuses an empty name, so the browser stops the
            // save before it sends a request that would fail.
            required
            placeholder="work"
            value={label}
            onChange={(event) => {
              edit();
              setLabel(event.target.value);
            }}
          />
        </Field>
        <Field id={`${connection.id}-topic`} label="Topic">
          <Input
            id={`${connection.id}-topic`}
            list={`${connection.id}-topics`}
            value={topic}
            onChange={(event) => {
              edit();
              setTopic(event.target.value);
            }}
          />
          <datalist id={`${connection.id}-topics`}>
            {TOPICS.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </Field>
      </div>

      {fields.length === 0 ? null : (
        <FormSection heading={readConfigHeading(type?.configSchema)}>
          {fields.map((field) => (
            <ConfigFieldRow
              key={field.name}
              inputId={`${connection.id}-${field.name}`}
              field={field}
              value={draft[field.name] ?? ""}
              error={issues.config[field.name]}
              entryErrors={issues.configEntries[field.name]}
              onChange={(value) => {
                edit();
                setDraft((current) => ({ ...current, [field.name]: value }));
              }}
            />
          ))}
        </FormSection>
      )}

      {/* A type no longer in the binary polls no feeds, so it has no Polling section. */}
      {type === undefined ? null : (
        <FeedIntervalFields
          idPrefix={connection.id}
          typeName={type.displayName}
          feeds={feeds}
          draft={intervals}
          errors={issues.feedIntervals}
          onChange={(feed, seconds) => {
            edit();
            setIntervals((current) => ({ ...current, [feed]: seconds }));
          }}
        />
      )}

      <div className="flex flex-col gap-3">
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
      </div>
    </form>
  );
}
