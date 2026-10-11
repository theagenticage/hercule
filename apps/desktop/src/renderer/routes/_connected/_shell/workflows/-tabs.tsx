import { Suspense, useId, useState, type JSX } from "react";
import type { HerculeClient } from "@hercule/client-core";
import { MAX_TIMELINE_DAYS_BACK } from "@hercule/client-core/timeline-limit";
import { buildInputRows, buildTriggerRows } from "@hercule/client-core/workflow-detail-rows";
import type { WorkflowDefinition } from "@hercule/contract";
import {
  RunsViewPicker,
  TimelineDayStepper,
  type RunsView,
} from "../../../../screens/workflows/run-timeline-board";
import {
  InputTable,
  InputTableHeads,
  RunTableHeads,
  TriggerTable,
  TriggerTableHeads,
  WorkflowTabBar,
  buildTabElementId,
  type WorkflowTab,
} from "../../../../screens/workflows/workflow-detail";
import { RunDayLanes, RunList, RunTimelineAxis, useRunsNavigation, useShownDay } from "./-runs";
import type { TriggerSwitches } from "./-switches";

/**
 * Renders the open workflow's four tabs (spec 17 §Workflows, "The open
 * workflow"): the tab band, with each tab's tools and column heads, and the
 * open tab's panel. It holds the open tab, which starts on Runs.
 *
 * - `source` is the workflow's saved source, which `definition` parses from;
 *   the Source tab shows it.
 * - `isEnabled` is the workflow's switch as shown, and `switches` are its
 *   start triggers' pause switches.
 * - `runsView` and `daysBack` come from the URL: how the Runs tab shows its
 *   runs, and the day the timeline shows, counted back from today.
 * - `pane` is the open workflow's pane, which the Runs list scrolls in, or
 *   null until it is mounted.
 *
 * A panel with nothing in it that takes focus is in the tab order itself, so
 * the keyboard can reach and scroll it.
 */
export function WorkflowTabs({
  client,
  workflowId,
  source,
  definition,
  isEnabled,
  switches,
  runsView,
  daysBack,
  timezone,
  pane,
}: {
  readonly client: HerculeClient;
  readonly workflowId: string;
  readonly source: string;
  readonly definition: WorkflowDefinition;
  readonly isEnabled: boolean;
  readonly switches: TriggerSwitches;
  readonly runsView: RunsView;
  readonly daysBack: number;
  readonly timezone: string;
  readonly pane: HTMLElement | null;
}): JSX.Element {
  const [tab, setTab] = useState<WorkflowTab>("runs");
  const baseId = useId();
  const isTimelineShown = tab === "runs" && runsView === "timeline";
  const shown = useShownDay(daysBack, timezone, isTimelineShown);
  const { pickView, showDay } = useRunsNavigation();
  const { triggers } = switches;
  const triggerRows = buildTriggerRows(definition, isEnabled, triggers);
  const inputRows = buildInputRows(definition);

  const panelProps = {
    role: "tabpanel",
    id: buildTabElementId(baseId, tab, "panel"),
    "aria-labelledby": buildTabElementId(baseId, tab, "tab"),
  } as const;

  return (
    <>
      <div className="tab-band">
        <WorkflowTabBar
          baseId={baseId}
          tab={tab}
          triggerCount={triggerRows.length}
          inputCount={inputRows.length}
          onSelect={setTab}
          tools={
            tab === "runs" ? (
              <>
                {runsView === "timeline" ? (
                  <TimelineDayStepper
                    dayText={shown.dayText}
                    isToday={shown.day.isToday}
                    isOldest={daysBack >= MAX_TIMELINE_DAYS_BACK}
                    onStepBack={() => {
                      showDay(Math.min(daysBack + 1, MAX_TIMELINE_DAYS_BACK));
                    }}
                    onStepOn={() => {
                      showDay(daysBack - 1);
                    }}
                    onShowToday={() => {
                      showDay(0);
                    }}
                  />
                ) : null}
                <RunsViewPicker view={runsView} onPick={pickView} />
              </>
            ) : null
          }
        />
        {tab === "runs" && runsView === "list" ? <RunTableHeads /> : null}
        {isTimelineShown ? <RunTimelineAxis day={shown.day} timezone={timezone} /> : null}
        {tab === "triggers" ? <TriggerTableHeads /> : null}
        {tab === "inputs" ? <InputTableHeads /> : null}
      </div>
      {tab === "runs" ? (
        <div {...panelProps} tabIndex={0}>
          {runsView === "list" ? (
            <RunList
              client={client}
              workflowId={workflowId}
              definition={definition}
              timezone={timezone}
              pane={pane}
            />
          ) : (
            // The loader reads the day before it shows. Only when the day
            // turns at midnight is the new day read here, and the lanes
            // stay empty until it answers.
            <Suspense fallback={<div className="lanes" style={{ "--tracks": 1 }} />}>
              <RunDayLanes
                client={client}
                workflowId={workflowId}
                definition={definition}
                isEnabled={isEnabled}
                triggers={triggers}
                shown={shown}
                timezone={timezone}
              />
            </Suspense>
          )}
        </div>
      ) : null}
      {tab === "triggers" ? (
        // Each trigger row holds a switch, so only an empty tab needs to take focus.
        <div {...panelProps} tabIndex={triggerRows.length === 0 ? 0 : undefined}>
          <TriggerTable
            rows={triggerRows}
            errors={switches.errors}
            timezone={timezone}
            onToggle={switches.toggle}
          />
        </div>
      ) : null}
      {tab === "inputs" ? (
        <div {...panelProps} tabIndex={0}>
          <InputTable rows={inputRows} />
        </div>
      ) : null}
      {tab === "source" ? (
        <pre className="codeblock" {...panelProps} tabIndex={0}>
          {source}
        </pre>
      ) : null}
    </>
  );
}
