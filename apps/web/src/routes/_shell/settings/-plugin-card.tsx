import { useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, FormCard, cn } from "@hercule/ui";
import {
  buildConfigFields,
  readConfigIssues,
  queryKeys,
  describeRefusalReason,
  type ConfigJson,
  type HerculeClient,
  readErrorMessage,
} from "@hercule/client-core";
import type { PluginDetail, PluginStatus } from "@hercule/contract";
import { ConfigForm } from "../../../screens/plugins/config-form";
import { InPlaceQuestion } from "../../../screens/in-place-question";
import { SaveStatus } from "../../../screens/save-status";

/**
 * The text colour of each plugin status.
 *
 * - Only `errored` means something went wrong, so only it uses the failure colour.
 * - `refused` uses the attention colour, because nothing on this screen can
 *   change it: it needs a different binary.
 * - `inactive` is the user's own choice, so it is not coloured.
 */
const STATUS_HUE: Record<PluginStatus["_tag"], string> = {
  active: "text-live",
  inactive: "text-muted",
  errored: "text-fail",
  refused: "text-attn",
};

/**
 * The card for one plugin. The binary decides which plugins exist, so the user
 * cannot install or remove one here. The card covers what the user controls:
 * whether the plugin is enabled, and its config. A refused plugin has neither,
 * because it was never loaded: there is nothing to enable and no schema to
 * build a form from.
 */
export function PluginCard({
  client,
  plugin,
}: {
  readonly client: HerculeClient;
  readonly plugin: PluginDetail;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [confirmingReset, setConfirmingReset] = useState(false);

  const refused = plugin.status._tag === "refused";
  const fields = buildConfigFields(plugin.configSchema);

  // Every action responds with the updated plugin, but an action can change
  // more than that plugin (disabling one also removes its contributions), so
  // the whole list is fetched again rather than patched in place.
  const reread = () => queryClient.invalidateQueries({ queryKey: queryKeys.plugins() });

  const params = { id: plugin.id };
  const toggle = useMutation({
    mutationFn: () =>
      plugin.enabled ? client.plugin.disable({ params }) : client.plugin.enable({ params }),
    onSuccess: reread,
  });
  const retry = useMutation({
    mutationFn: () => client.plugin.retry({ params }),
    onSuccess: reread,
  });
  const reset = useMutation({
    mutationFn: () => client.plugin.resetState({ params }),
    onSuccess: reread,
  });
  const configure = useMutation({
    mutationFn: (config: ConfigJson) => client.plugin.configure({ params, payload: { config } }),
    onSuccess: reread,
  });

  const issues = readConfigIssues(configure.error, fields);
  // A failed action leaves the card unchanged, so the card must show the error
  // itself. A config error already shown under its field is not repeated here.
  const failed =
    (issues.rest ? configure.error : null) ?? toggle.error ?? retry.error ?? reset.error;

  return (
    <FormCard
      label={
        <div className="flex items-baseline gap-2.5 text-row">
          <b className="font-emph text-ink">{plugin.displayName}</b>
          <code className="min-w-0 truncate font-mono text-fine text-faint">{plugin.id}</code>
          <span className={cn("ml-auto text-fine", STATUS_HUE[plugin.status._tag])}>
            {plugin.status._tag}
          </span>
        </div>
      }
    >
      {plugin.status._tag === "errored" ? (
        <p className="text-fine text-muted">{plugin.status.message}</p>
      ) : null}
      {plugin.status._tag === "refused" ? (
        <p className="text-fine text-muted">{describeRefusalReason(plugin.status.reason)}</p>
      ) : null}

      <div className="flex flex-col gap-px text-fine text-muted">
        {plugin.contributions.length === 0 ? (
          <span className="text-faint">Contributes nothing.</span>
        ) : (
          plugin.contributions.map((contribution) => (
            <span key={`${contribution.extensionPoint}/${contribution.id}`}>
              {contribution.extensionPoint} · <span className="text-ink">{contribution.id}</span>
            </span>
          ))
        )}
      </div>

      {fields.length === 0 ? null : (
        <ConfigForm
          // A config changed elsewhere arrives in a refetched list. The key
          // rebuilds the form from it, rather than keeping values nobody stored.
          key={JSON.stringify(plugin.config)}
          id={plugin.id}
          fields={fields}
          config={plugin.config}
          issues={issues}
          saving={configure.isPending}
          onEdit={() => {
            if (!configure.isIdle) configure.reset();
          }}
          onSave={(config) => {
            configure.mutate(config);
          }}
        />
      )}
      <SaveStatus
        saved={configure.isSuccess}
        failure={failed === null ? null : readErrorMessage(failed)}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          className="-ml-2"
          disabled={refused || toggle.isPending}
          onClick={() => {
            toggle.mutate();
          }}
        >
          {plugin.enabled ? "Disable" : "Enable"}
        </Button>
        {plugin.status._tag === "errored" ? (
          <Button
            disabled={retry.isPending}
            onClick={() => {
              retry.mutate();
            }}
          >
            Retry
          </Button>
        ) : null}
        {refused ? null : (
          <Button
            disabled={confirmingReset || reset.isPending}
            onClick={() => {
              setConfirmingReset(true);
            }}
          >
            Reset plugin state
          </Button>
        )}
      </div>

      {/* Unlike everything else on this screen, a reset cannot be undone, so
          the button asks for confirmation first. */}
      {confirmingReset ? (
        <InPlaceQuestion
          question="Wipe everything this plugin has stored?"
          declineLabel="Cancel"
          acceptLabel="Confirm"
          onDecline={() => {
            setConfirmingReset(false);
          }}
          onAccept={() => {
            setConfirmingReset(false);
            reset.mutate();
          }}
        />
      ) : null}
    </FormCard>
  );
}
