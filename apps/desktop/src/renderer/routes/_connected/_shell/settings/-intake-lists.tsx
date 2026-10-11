import type { JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import {
  canResetIntakeRow,
  describeIntakeSource,
  type IntakeChange,
  type IntakeKindList,
  type IntakeKindValue,
} from "@hercule/client-core";
import { IntakeKindRow } from "../../../../screens/settings/intake/intake-kind-row";
import { useIntakeEditor } from "./-intake-editor";

/**
 * Renders the Signals list and the Events available to triage list of one
 * level of a plugin: all its Connections, or the Connection `connectionId`
 * names. A list with no kind is not drawn. While a Connection's settings are
 * being read, a line says so instead of the lists; when the read fails, the
 * line gives the error.
 *
 * Each toggle saves as soon as it is pressed, and a row whose value is a
 * choice of this level can be reset (see `useIntakeEditor`). `pointedKind` is
 * the kind a link asks for, whose row scrolls into view and is highlighted.
 */
export function IntakeLists({
  pluginId,
  connectionId,
  pluginName,
  pointedKind,
}: {
  readonly pluginId: string;
  readonly connectionId: string | undefined;
  readonly pluginName: string;
  readonly pointedKind: string | undefined;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const editor = useIntakeEditor(client, pluginId, connectionId);
  if (editor.status === "reading") {
    return <p className="intake-status">{"Reading this Connection's settings…"}</p>;
  }
  if (editor.status === "unreadable") {
    return (
      <p className="set-err intake-status" role="alert">
        {`Could not read this Connection: ${editor.message}`}
      </p>
    );
  }
  const { settings, level, findRowSave, save } = editor;

  const renderRow = (
    list: IntakeKindList,
    row: IntakeKindValue,
    label: string,
    hint: string,
  ): JSX.Element => {
    const change = (on: boolean | null): IntakeChange => ({ list, kind: row.kind, on });
    const { error, resetting } = findRowSave(list, row.kind);
    return (
      <IntakeKindRow
        key={row.kind}
        label={label}
        hint={hint}
        hintIsCode={list === "eventKinds"}
        on={row.on}
        source={describeIntakeSource(row, pluginName)}
        canReset={canResetIntakeRow(row, level)}
        resetting={resetting}
        pointed={pointedKind === row.kind}
        error={error}
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
