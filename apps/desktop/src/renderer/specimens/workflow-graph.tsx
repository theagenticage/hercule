/**
 * PROTOTYPE. The workflow graph specimen: Ship release drawn with no run and
 * with three of its runs, and two smaller workflows, each on the page's
 * surface as the detail page would show it.
 *
 * The page takes two options from its URL:
 * - `?theme=` names the theme, Whitehaven by default;
 * - `?motion=completed` or `?motion=failed` plays one run of Ship release
 *   from its start to that ending, a frame every 1.2 seconds, instead of the
 *   sheet.
 */
import "./fixed-clock";
import "../styles/base-layer.css";
import { useEffect, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Run, Session, WorkflowDefinition } from "@hercule/contract";
import { buildGraphDrawing } from "../screens/workflows/graph-model";
import { buildNodeDetails } from "../screens/workflows/node-details";
import { WorkflowGraph } from "../screens/workflows/workflow-graph";
import { applySheetTheme, markSheetReady } from "./sheet-page";
import { SPECIMEN_INSTANCES } from "./sidebar-fixture";
import { buildShipReleaseFrames, SHIP_RELEASE_ID, WORKFLOWS_RECORDS } from "./workflows-fixture";

const { definitions, triggers, runs, runSessions, agents, workflowActions } = WORKFLOWS_RECORDS;

/** Returns the definition of the workflow named `name`. */
const findDefinition = (name: string) =>
  definitions.find((workflow) => workflow.definition.name === name)!.definition;

const shipRelease = definitions.find((workflow) => workflow.id === SHIP_RELEASE_ID)!.definition;
const shipReleaseRuns = runs.filter((run) => run.workflowId === SHIP_RELEASE_ID);

/**
 * Draws `definition` with `run` on it, as the detail page does: a click on a
 * node opens its card, and the card's links to a transcript do nothing.
 */
function Graph({
  definition,
  run,
  sessions,
  label,
}: {
  readonly definition: WorkflowDefinition;
  readonly run: Run | undefined;
  readonly sessions: ReadonlyArray<Session>;
  readonly label: string;
}): JSX.Element {
  const drawing = buildGraphDrawing(definition, run, sessions, agents, workflowActions);
  return (
    <WorkflowGraph
      drawing={drawing}
      details={buildNodeDetails(
        drawing,
        { definition, run, sessions, triggers, agents, instances: SPECIMEN_INSTANCES },
        "UTC",
        new Date(),
      )}
      label={label}
      onOpenSession={() => undefined}
    />
  );
}

/** One graph on the sheet, with a caption above it. */
function Cell({
  caption,
  name,
  run,
}: {
  readonly caption: string;
  readonly name: string;
  readonly run: Run | undefined;
}): JSX.Element {
  const definition = name === "Ship release" ? shipRelease : findDefinition(name);
  return (
    <section style={{ width: 900, padding: "20px 24px", background: "var(--surface)" }}>
      <p className="fine" style={{ margin: "0 0 8px" }}>
        {caption}
      </p>
      <Graph
        definition={definition}
        run={run}
        sessions={runSessions}
        label={`${name}, ${caption}`}
      />
    </section>
  );
}

/** Plays one run of Ship release, frame by frame. */
function Motion({ ending }: { readonly ending: "completed" | "failed" }): JSX.Element {
  const frames = buildShipReleaseFrames(ending);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % frames.length);
    }, 1200);
    return () => {
      clearInterval(timer);
    };
  }, [frames.length]);
  const frame = frames[index]!;
  return (
    <section style={{ width: 900, padding: "20px 24px", background: "var(--surface)" }}>
      <p className="fine" style={{ margin: "0 0 8px" }}>
        {`Frame ${String(index + 1)} of ${String(frames.length)}: ${frame.run.status}`}
      </p>
      <Graph
        definition={shipRelease}
        run={frame.run}
        sessions={frame.sessions}
        label="Ship release"
      />
    </section>
  );
}

applySheetTheme();
const motion = new URLSearchParams(location.search).get("motion");
const root = createRoot(document.getElementById("root")!);
root.render(
  motion === "completed" || motion === "failed" ? (
    <Motion ending={motion} />
  ) : (
    <div style={{ display: "grid", gap: 1 }}>
      <Cell caption="No run picked" name="Ship release" run={undefined} />
      <Cell caption="Newest run: security asks you" name="Ship release" run={shipReleaseRuns[0]} />
      <Cell
        caption="Waiting for the pull request to merge"
        name="Ship release"
        run={shipReleaseRuns[1]}
      />
      <Cell
        caption="Failed on the review loop's limit"
        name="Ship release"
        run={shipReleaseRuns[2]}
      />
      <Cell caption="No run picked" name="Fix bug" run={undefined} />
      <Cell caption="No run picked" name="Investigate" run={undefined} />
    </div>
  ),
);
void markSheetReady();
