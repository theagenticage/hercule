/**
 * Intake's source tabs, which every view draws in its bar.
 */
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildIntakeTabs, type IntakeTab, type PluginIdentity } from "@hercule/client-core";
import { pluginsQuery, signalsToDoQuery } from "../../app/queries";

/**
 * Returns the tabs of Intake's bar and the plugins they name. The tabs come
 * from the plugins' Intake settings and the To do signals, which every view
 * reads, so a switch between views keeps the same tabs (see
 * `buildIntakeTabs`).
 *
 * `pressedPluginId` is the tab pressed. Its tab is drawn even when no setting
 * or signal asks for it.
 */
export function useIntakeTabs(pressedPluginId: string | null): {
  readonly tabs: ReadonlyArray<IntakeTab>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
} {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: toDo } = useSuspenseQuery(signalsToDoQuery(client));
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  return { tabs: buildIntakeTabs(toDo, plugins, pressedPluginId), plugins };
}
