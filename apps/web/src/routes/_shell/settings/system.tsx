import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  buildTextGenerationField,
  describeTextGenerationFailure,
  formatAccessMode,
} from "@hercule/client-core";
import { ACCESS_MODE_CHAIN } from "@hercule/contract";
import { EmptyState, FormCard, Row, Select } from "@hercule/ui";
import { controllerQuery, providersQuery, settingsQuery } from "../../../app/queries";
import { SaveStatus } from "../../../screens/save-status";
import { useSaveSettings } from "./-form";

export const Route = createFileRoute("/_shell/settings/system")({
  staticData: { title: "System" },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(controllerQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
    ]);
  },
  component: System,
});

/**
 * Renders the System screen: the controller's operational settings, and one
 * policy that is not a setting. Only the text generation model is editable so
 * far; the other settings are still an empty state.
 *
 * The access-mode fallback policy is a property of the system, not a setting:
 * a thread only ever falls back to a less permissive mode, so there is nothing
 * to choose. The screen describes the policy and offers no way to change it.
 * Spec 06 §8.4 and spec 13 §7 own the policy.
 */
function System(): JSX.Element {
  const { client } = Route.useRouteContext();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const controller = useSuspenseQuery(controllerQuery(client)).data;
  const { save, saved, failure } = useSaveSettings(client);

  const stored = settings.controller["textGeneration.model"];
  const field = buildTextGenerationField(stored, instances, controller.textGeneration);
  const lastFailure = describeTextGenerationFailure(stored, controller.textGeneration, new Date());

  return (
    <div className="flex flex-col gap-4">
      <FormCard
        label="Text generation"
        fine="The model that does short jobs for Hercule, such as naming a thread."
      >
        <Row label="Model" htmlFor="text-generation-model">
          <Select
            id="text-generation-model"
            value={field.selectedKey}
            onChange={(event) => {
              const choice = field.choices.find((each) => each.key === event.target.value);
              if (choice !== undefined) {
                save({ controller: { "textGeneration.model": choice.setting } });
              }
            }}
          >
            {field.choices.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </Select>
        </Row>
        {lastFailure === null ? null : <p className="text-fine text-muted">{lastFailure}</p>}
        <SaveStatus saved={saved} failure={failure} />
      </FormCard>
      <FormCard
        label="Access-mode fallback"
        fine="It is fixed: nothing on this screen or anywhere else changes it."
      >
        <p className="text-row text-muted">
          The four access modes run from least to most permissive:
        </p>
        {/* On its own line and never wrapped: a break between a mode and its
            `<` would make the order read differently. */}
        <span className="block overflow-x-auto text-row whitespace-nowrap text-ink">
          {ACCESS_MODE_CHAIN.map(formatAccessMode).join(" < ")}
        </span>
        <p className="text-row text-muted">
          A thread asking for a mode its harness does not support runs at the nearest less
          permissive mode that harness does support. The substitution never goes the other way: a
          thread never runs more permissively than it asked for.
        </p>
      </FormCard>
      <EmptyState
        headline="The rest of the controller's settings are not editable yet."
        lead="Retention windows, the daily backup and HTTPS will appear here."
      />
    </div>
  );
}
