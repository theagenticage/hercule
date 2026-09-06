import { useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, FormCard, cn } from "@hydra/ui";
import {
  configFields,
  configIssues,
  queryKeys,
  refusalReason,
  type ConfigJson,
  type HydraClient,
} from "@hydra/client-core";
import type { PluginDetail, PluginStatus } from "@hydra/contract";
import { ConfigForm } from "../../../screens/plugins/config-form";
import { SaveStatus, messageOf } from "./-form";

/**
 * Only `errored` is something gone wrong; `refused` is the attention hue
 * because it is the one state nothing on this screen can move - it takes
 * another binary - and `inactive` is the user's own choice, in no hue at all.
 */
const STATUS_HUE: Record<PluginStatus["_tag"], string> = {
  active: "text-live",
  inactive: "text-muted",
  errored: "text-fail",
  refused: "text-attn",
};

/**
 * One plugin: what it contributes, whether it is running, and the four things
 * that can be done to it.
 *
 * A plugin cannot be installed or removed - the binary decides that - so the
 * card is about the two facts the user does own, the switch and the config,
 * and about reading back what this boot made of them. A plugin that was turned
 * away has neither: it was never loaded, so there is nothing to switch on and
 * no schema to generate a form from.
 */
export function PluginCard({
  client,
  plugin,
}: {
  readonly client: HydraClient;
  readonly plugin: PluginDetail;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [confirmingReset, setConfirmingReset] = useState(false);

  const refused = plugin.status._tag === "refused";
  const fields = configFields(plugin.configSchema);

  // Every move answers with the plugin as it now stands, but a move can change
  // more than the plugin it names - deactivating one invalidates what it
  // contributed - so the listing is reread rather than patched in place.
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

  const issues = configIssues(configure.error, fields);
  // A move that failed leaves the card exactly as it was, so the card is the
  // only thing that can say it failed. A refusal shown under the field it
  // blamed has already been said.
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
        <p className="text-fine text-muted">{refusalReason(plugin.status.reason)}</p>
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
          // A config changed elsewhere arrives as a fresh listing; the form is
          // built again from it rather than holding values nobody stored.
          key={JSON.stringify(plugin.config)}
          id={plugin.id}
          fields={fields}
          config={plugin.config}
          issues={issues.perField}
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
        failure={failed === null ? null : messageOf(failed)}
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

      {/* Wiping is not undoable and nothing else on this screen is, so the
          question is asked in place rather than behind a browser dialog. */}
      {confirmingReset ? (
        <div className="flex flex-wrap items-center gap-1.5 text-row text-muted">
          <span>Wipe everything this plugin has stored?</span>
          <Button
            variant="primary"
            onClick={() => {
              setConfirmingReset(false);
              reset.mutate();
            }}
          >
            Confirm
          </Button>
          <Button
            onClick={() => {
              setConfirmingReset(false);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </FormCard>
  );
}
