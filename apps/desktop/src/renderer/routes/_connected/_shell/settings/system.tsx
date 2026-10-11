import { Fragment, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  buildTextGenerationField,
  describeTextGenerationFailure,
  formatAccessMode,
  formatRunnerLabel,
} from "@hercule/client-core";
import { ACCESS_MODE_CHAIN, type TextGenerationModel } from "@hercule/contract";
import { rememberSettingsSection } from "../../../../app/last-settings-section";
import {
  controllerQuery,
  providersQuery,
  readOnOpen,
  runnersQuery,
  settingsQuery,
} from "../../../../app/queries";
import { SettingRow } from "../../../../screens/settings/setting-row";
import { useSavedSetting } from "./-saved-setting";

/**
 * Settings > System: the controller's record, the model that makes text
 * generations, and the access-mode fallback policy, which is read-only
 * (spec 17 §Settings, System). The text generation model saves as soon as it
 * is picked.
 *
 * The loader reads the controller's record and the settings each time the
 * section opens, because no live topic keeps them current: its default
 * runner can change from the CLI while the app runs, and so can the model
 * Automatic resolves to. The runners and the providers are the shell's
 * reads, which the live connection keeps current.
 */
export const Route = createFileRoute("/_connected/_shell/settings/system")({
  staticData: { title: "System" },
  loader: ({ context: { controller, queryClient } }) =>
    Promise.all([
      readOnOpen(queryClient, controllerQuery(controller.client)),
      readOnOpen(queryClient, settingsQuery(controller.client)),
    ]),
  onEnter: () => {
    rememberSettingsSection("/settings/system");
  },
  component: System,
});

function System(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const controllerRecord = useSuspenseQuery(controllerQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  return (
    <>
      <section className="set-sec">
        <h2>Controller</h2>
        <ValueRow label="Version" hint="The version of Hercule the controller runs.">
          {controllerRecord.version}
        </ValueRow>
        <ValueRow
          label="Controller id"
          hint="The id runners know the controller by. It stays the same when the controller moves to another machine."
          mono
        >
          {controllerRecord.id}
        </ValueRow>
        <ValueRow label="Default runner" hint="Where work runs when it names no runner.">
          {formatRunnerLabel(controllerRecord.defaultRunnerId, runners)}
        </ValueRow>
        <ValueRow label="Local runner" hint="The runner the controller started on its own machine.">
          {formatRunnerLabel(controllerRecord.localRunnerId, runners)}
        </ValueRow>
        <TextGenerationRow />
      </section>
      <section className="set-sec">
        <h2>Access-mode fallback</h2>
        <p>It is fixed: nothing on this screen or anywhere else changes it.</p>
        <p>The four access modes run from least to most permissive:</p>
        <p className="set-chain">
          {ACCESS_MODE_CHAIN.map((mode, index) => (
            <Fragment key={mode}>
              <span>{formatAccessMode(mode)}</span>
              {index < ACCESS_MODE_CHAIN.length - 1 && " < "}
            </Fragment>
          ))}
        </p>
        <p>
          A thread asking for a mode its provider does not support runs at the nearest less
          permissive mode that provider does support. The substitution never goes the other way: a
          thread never runs more permissively than it asked for.
        </p>
      </section>
    </>
  );
}

/**
 * Renders the row that picks the model that makes text generations, such as
 * a thread's title. Under it, a quiet line gives the last failure, unless
 * text generation is off or has not failed.
 */
function TextGenerationRow(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { textGeneration } = useSuspenseQuery(controllerQuery(client)).data;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const model = useSavedSetting(
    client,
    settings.controller["textGeneration.model"] ?? "automatic",
    (value: TextGenerationModel) => ({ controller: { "textGeneration.model": value } }),
  );
  const { choices, selectedKey } = buildTextGenerationField(model.value, instances, textGeneration);
  const failure = describeTextGenerationFailure(model.value, textGeneration, new Date());
  return (
    <>
      <SettingRow
        label="Text generation"
        hint="The model that does short jobs for Hercule, such as naming a thread."
        error={model.error}
        control={(labels) => (
          <span className="field field--select">
            <select
              {...labels}
              value={selectedKey}
              onChange={(event) => {
                const choice = choices.find(({ key }) => key === event.target.value);
                if (choice !== undefined) model.save(choice.setting);
              }}
            >
              {choices.map(({ key, label }) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </span>
        )}
      />
      {failure === null ? null : <p className="set-note">{failure}</p>}
    </>
  );
}

/**
 * Renders a read-only row: a label and its hint, and a value the user can
 * select and copy.
 *
 * The value is plain text, not a control, so it takes none of the row's
 * labelling attributes: ARIA does not let a plain element be named by them.
 * A screen reader reads the label, the hint and the value in the row's order.
 */
function ValueRow({
  label,
  hint,
  mono = false,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly mono?: boolean;
  readonly children: string;
}): JSX.Element {
  return (
    <SettingRow
      label={label}
      hint={hint}
      control={() => <span className={mono ? "set-value mono" : "set-value"}>{children}</span>}
    />
  );
}
