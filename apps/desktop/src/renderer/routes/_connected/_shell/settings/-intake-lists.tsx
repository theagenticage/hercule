import type { JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import {
  canResetIntakeRow,
  describeIntakeSource,
  type IntakeChange,
  type IntakeKindList,
} from "@hercule/client-core";
import type { IntakeSettingLevel, IntakeSettings } from "@hercule/contract";
import { IntakeKindRow } from "../../../../screens/settings/intake/intake-kind-row";
import { buildIntakeRowKey, useSavedIntake, type IntakeTarget } from "./-saved-intake";

/**
 * Renders the Signals list and the Events available to triage list of one
 * level of a plugin: all its Connections, or one Connection. A list with no
 * kind is not drawn.
 *
 * Each toggle saves as soon as it is pressed, and a row whose value is a
 * choice of this level can be reset (see `useSavedIntake`). `pointedKind` is
 * the kind a link asks for, whose row scrolls into view and is highlighted.
 *
 * The component holds the saves of one level, so the section draws one for
 * each level it shows, with a key of its own.
 */
export function IntakeLists({
  target,
  stored,
  pluginName,
  pointedKind,
}: {
  readonly target: IntakeTarget;
  /** The saved settings of this level, as the cache holds them. */
  readonly stored: IntakeSettings;
  readonly pluginName: string;
  readonly pointedKind: string | undefined;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { settings, errors, save } = useSavedIntake(client, target, stored);

  const renderRow = (
    list: IntakeKindList,
    row: { kind: string; on: boolean; level: IntakeSettingLevel },
    label: string,
    hint: string,
  ): JSX.Element => {
    const change = (on: boolean | null): IntakeChange => ({ list, kind: row.kind, on });
    return (
      <IntakeKindRow
        key={row.kind}
        label={label}
        hint={hint}
        hintIsCode={list === "eventKinds"}
        on={row.on}
        source={describeIntakeSource(row, pluginName)}
        canReset={canResetIntakeRow(row, target.level)}
        pointed={pointedKind === row.kind}
        error={errors.get(buildIntakeRowKey({ list, kind: row.kind })) ?? null}
        onToggle={(on) => {
          save(change(on));
        }}
        onReset={() => {
          save(change(null));
        }}
      />
    );
  };

  return (
    <>
      {settings.signalKinds.length > 0 && (
        <>
          <h3 className="intake-list-head">Signals</h3>
          {settings.signalKinds.map((row) =>
            renderRow("signalKinds", row, row.label, row.description),
          )}
        </>
      )}
      {settings.eventKinds.length > 0 && (
        <>
          <h3 className="intake-list-head">Events available to triage</h3>
          {settings.eventKinds.map((row) =>
            renderRow("eventKinds", row, row.description, row.kind),
          )}
        </>
      )}
    </>
  );
}
