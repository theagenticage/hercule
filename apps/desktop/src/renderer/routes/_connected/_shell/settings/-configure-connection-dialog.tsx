import { useId, useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildConfigDraft,
  buildConfigFields,
  buildConfigPayload,
  buildFeedIntervalsDraft,
  buildFeedIntervalsPayload,
  buildTopicsUpdate,
  decideFieldChoices,
  describeConnectionTypeName,
  queryKeys,
  readConfigHeading,
  readConnectionIssues,
  readErrorMessage,
  type ConfigDraft,
  type ConfigField,
  type ConfigJson,
  type ConfigValue,
  type ConnectionType,
  type FeedIntervalsDraft,
  type HerculeClient,
} from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import { connectionChoicesQuery } from "../../../../app/queries";
import { GlassDialog } from "../../../../screens/glass-dialog";
import { ConfigFieldRow, ConfigureConnection } from "../../../../screens/settings/connections";

/** The message under Name when the user saves an empty name, which the controller refuses. */
const NAME_REQUIRED = "Name the Connection.";

/**
 * Renders Configure for `connection` in a glass dialog (spec 17 §Settings,
 * Connections): its name, its topic, the settings its type declares, and how
 * often each of its feeds is polled. The account and the credential are
 * fixed at setup, so the dialog does not edit them.
 *
 * Save sends every field at once with `connection.update` and closes the
 * dialog when the controller accepts it. A dialog of several fields saves on
 * Save rather than on each change, because a half-typed setting is not a
 * value to store. Before anything is sent:
 *
 * - an empty name is refused under Name;
 * - a number setting or a poll interval whose text cannot be read as a
 *   number is refused under its field.
 *
 * The controller's errors about one setting or one feed show under that
 * field, and any other error at the foot of the dialog. While the save is on
 * its way every field is disabled, so nothing typed after Save is lost when
 * the dialog closes.
 *
 * `type` is `undefined` when the plugin that declared the type is no longer
 * in the binary. There is then no schema to read the settings against, so
 * the settings and the poll intervals are kept exactly as stored, only the
 * name and the topic can be changed, and a line says why.
 *
 * `onClose` is called whenever the dialog closes, saved or not.
 */
export function ConfigureConnectionDialog({
  connection,
  type,
  onClose,
}: {
  readonly connection: Connection;
  /** Absent when the plugin that declared the type is no longer in the binary. */
  readonly type: ConnectionType | undefined;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = useId();
  const fields = buildConfigFields(type?.configSchema);
  const feeds = type?.feeds ?? [];

  const [label, setLabel] = useState(connection.label);
  // The dialog shows only the first topic. Any topics after it, set through
  // the CLI or the API, are kept when the user saves.
  const [topic, setTopic] = useState(connection.labels[0] ?? "");
  const [draft, setDraft] = useState<ConfigDraft>(() =>
    buildConfigDraft(fields, connection.config),
  );
  const [intervals, setIntervals] = useState<FeedIntervalsDraft>(() =>
    buildFeedIntervalsDraft(feeds, connection.feedIntervals),
  );
  // The errors found when the user pressed Save, before anything was sent.
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [unreadableConfig, setUnreadableConfig] = useState<Readonly<Record<string, string>>>({});
  const [unreadableIntervals, setUnreadableIntervals] = useState<Readonly<Record<string, string>>>(
    {},
  );

  const save = useMutation({
    mutationFn: ({
      config,
      feedIntervals,
    }: {
      /** The settings to save, or `undefined` to keep the stored ones as they are. */
      readonly config: Readonly<Record<string, ConfigJson>> | undefined;
      readonly feedIntervals: Connection["feedIntervals"];
    }) => {
      const labels = buildTopicsUpdate(connection.labels, topic);
      return client.connection.update({
        params: { id: connection.id },
        payload: {
          label: label.trim(),
          ...(labels === undefined ? {} : { labels }),
          ...(config === undefined ? {} : { config }),
          // With no feeds on screen, which includes a type no longer in the
          // binary, the stored intervals are kept exactly as they are.
          ...(feeds.length === 0 ? {} : { feedIntervals }),
        },
      });
    },
    onSuccess: async () => {
      dialogRef.current?.close();
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
    },
  });

  const issues = readConnectionIssues(save.error, fields, feeds);
  const failure = issues.rest && save.error !== null ? readErrorMessage(save.error) : null;

  // Clears the last save's errors on any edit, because those errors were
  // about the values the fields held then. Only a failed save is reset: a
  // save on its way must still close the dialog when it lands.
  const edit = (): void => {
    if (save.isError) save.reset();
    setNameError(undefined);
    setUnreadableConfig({});
    setUnreadableIntervals({});
  };

  const send = (): void => {
    if (save.isPending) return;
    const settings =
      type === undefined
        ? { config: undefined }
        : buildConfigPayload(fields, draft, connection.config);
    const polling = buildFeedIntervalsPayload(feeds, intervals);
    const named = label.trim() !== "";
    if (!named || "errors" in settings || "errors" in polling) {
      setNameError(named ? undefined : NAME_REQUIRED);
      setUnreadableConfig("errors" in settings ? settings.errors : {});
      setUnreadableIntervals("errors" in polling ? polling.errors : {});
      return;
    }
    save.mutate({ config: settings.config, feedIntervals: polling.feedIntervals });
  };

  const typeName = describeConnectionTypeName(connection, type);
  const title = `Configure ${typeName} · ${connection.label}`;

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="configure-connection-dialog"
      label={title}
      onClose={onClose}
    >
      <ConfigureConnection
        title={title}
        name={label}
        nameError={nameError}
        topic={topic}
        missingType={type === undefined ? connection.type : undefined}
        settings={
          fields.length === 0
            ? undefined
            : {
                heading: readConfigHeading(type?.configSchema),
                rows: fields.map((field) => (
                  <ConnectionConfigField
                    key={field.name}
                    client={client}
                    connectionId={connection.id}
                    inputId={`${id}-config-${field.name}`}
                    field={field}
                    value={draft[field.name] ?? ""}
                    error={unreadableConfig[field.name] ?? issues.config[field.name]}
                    entryErrors={issues.configEntries[field.name]}
                    onChange={(value) => {
                      edit();
                      setDraft((current) => ({ ...current, [field.name]: value }));
                    }}
                  />
                )),
              }
        }
        feeds={feeds}
        typeName={typeName}
        intervals={intervals}
        intervalErrors={Object.fromEntries(
          feeds.map((feed) => [
            feed.name,
            unreadableIntervals[feed.name] ?? issues.feedIntervals[feed.name],
          ]),
        )}
        failure={failure}
        saving={save.isPending}
        onNameChange={(text) => {
          edit();
          setLabel(text);
        }}
        onTopicChange={(text) => {
          edit();
          setTopic(text);
        }}
        onIntervalChange={(feedName, text) => {
          edit();
          setIntervals((current) => ({ ...current, [feedName]: text }));
        }}
        onSave={send}
        onCancel={() => dialogRef.current?.close()}
      />
    </GlassDialog>
  );
}

/**
 * Renders one setting of the Connection. A setting that loads its choices
 * from the account reads them here, where they are drawn, when the dialog
 * opens: the Connections table does not need the account's data. The read
 * is never tried again, and the setting falls back to its plain widget when
 * the read fails.
 */
function ConnectionConfigField({
  client,
  connectionId,
  field,
  ...row
}: {
  readonly client: HerculeClient;
  readonly connectionId: string;
  readonly inputId: string;
  readonly field: ConfigField;
  readonly value: ConfigValue;
  readonly error: string | undefined;
  readonly entryErrors: Readonly<Record<number, string>> | undefined;
  readonly onChange: (value: ConfigValue) => void;
}): JSX.Element {
  const loadsChoices = field.loadsChoices === true;
  const read = useQuery({
    ...connectionChoicesQuery(client, connectionId, field.name),
    enabled: loadsChoices,
  });
  return (
    <ConfigFieldRow
      field={field}
      choices={loadsChoices ? decideFieldChoices(read) : undefined}
      {...row}
    />
  );
}
