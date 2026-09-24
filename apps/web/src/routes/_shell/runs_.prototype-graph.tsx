/**
 * PROTOTYPE - throwaway (P021 run graph, branch prototype/P021-run-graph).
 * Four variants of the live run graph on a run's detail page, on fake data.
 * Start it with `pnpm prototype:run-graph`; it is not reachable in a
 * production build.
 */
import type { JSX } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { SCENARIOS, type Scenario } from "../../prototype-run-graph/run-data";
import {
  RunDetailPrototype,
  type PrototypeSearch,
} from "../../prototype-run-graph/run-detail-prototype";
import type { Variant } from "../../prototype-run-graph/run-graph-view";

// Written out here rather than imported: the search validation stays in the
// entry bundle, and the variants' module pulls in the graph library.
const VARIANTS: ReadonlyArray<Variant> = ["A", "B", "C", "D"];

export const Route = createFileRoute("/_shell/runs_/prototype-graph")({
  staticData: { title: "Run", ownsTopBar: true },
  validateSearch: (search: Record<string, unknown>): PrototypeSearch => ({
    variant: VARIANTS.includes(search.variant as Variant) ? (search.variant as Variant) : "A",
    scenario: SCENARIOS.includes(search.scenario as Scenario)
      ? (search.scenario as Scenario)
      : "success",
    frame: typeof search.frame === "number" ? search.frame : 3,
  }),
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (import.meta.env.PROD) throw notFound();
  },
  component: RunGraphPrototype,
});

function RunGraphPrototype(): JSX.Element {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <RunDetailPrototype
      search={search}
      onSearchChange={(next) => void navigate({ search: next, replace: true })}
    />
  );
}
