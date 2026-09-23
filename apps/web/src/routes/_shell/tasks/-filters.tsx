import { useEffect, useState, type JSX } from "react";
import { TASK_STATUSES, type Project, type TaskFilter, type TaskStatus } from "@hercule/contract";
import { Button, Field, Input, Select } from "@hercule/ui";

/** The value every filter opens on: no filter at all. */
export const ANY = "";

/** How long the search box waits before it asks, so a word is one question. */
const SEARCH_SETTLE_MS = 200;

/** What the bar holds, as the user has typed it and before it has settled. */
export interface FilterState {
  readonly text: string;
  readonly status: TaskStatus | typeof ANY;
  readonly labels: string;
  readonly projectId: string;
}

/** The bar as it opens: every filter on Any. */
export const NO_FILTERS: FilterState = {
  text: ANY,
  status: ANY,
  labels: ANY,
  projectId: ANY,
};

/** A value once it has stopped changing, so typing asks one question. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}

/** The labels the user typed as a comma-separated line. */
const parseLabels = (typed: string): readonly string[] =>
  typed
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");

/**
 * The question the controller is asked, once the typed filters have stopped
 * moving. The two picked filters ask at once; the two typed ones settle first.
 */
export function useSettledFilter(state: FilterState): TaskFilter {
  const searched = useSettled(state.text.trim(), SEARCH_SETTLE_MS);
  const wanted = parseLabels(useSettled(state.labels, SEARCH_SETTLE_MS));
  return {
    ...(searched === "" ? {} : { text: searched }),
    ...(state.status === ANY ? {} : { status: [state.status] }),
    ...(wanted.length === 0 ? {} : { labels: wanted }),
    ...(state.projectId === ANY ? {} : { projectId: state.projectId }),
  };
}

/**
 * The pinned filters over the list, and the way in to writing a task by hand.
 *
 * Each one opens on Any: the screen shows everything until it is asked not to.
 */
export function TaskFilterBar({
  value,
  projects,
  onChange,
  onCompose,
}: {
  readonly value: FilterState;
  readonly projects: readonly Project[];
  readonly onChange: (next: FilterState) => void;
  readonly onCompose: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-[248px]">
        <Field id="filter-text" label="Search">
          <Input
            id="filter-text"
            type="search"
            placeholder="Title and description"
            // The platform draws its own clear button in its own colour,
            // which is the one hue this system has no place for.
            className="[&::-webkit-search-cancel-button]:appearance-none"
            value={value.text}
            onChange={(event) => {
              onChange({ ...value, text: event.target.value });
            }}
          />
        </Field>
      </div>
      <div className="w-[150px]">
        <Field id="filter-status" label="Status">
          <Select
            id="filter-status"
            value={value.status}
            onChange={(event) => {
              onChange({ ...value, status: event.target.value as TaskStatus | typeof ANY });
            }}
          >
            <option value={ANY}>Any status</option>
            {TASK_STATUSES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="w-[190px]">
        <Field id="filter-labels" label="Labels">
          <Input
            id="filter-labels"
            placeholder="comma separated"
            value={value.labels}
            onChange={(event) => {
              onChange({ ...value, labels: event.target.value });
            }}
          />
        </Field>
      </div>
      <div className="w-[170px]">
        <Field id="filter-project" label="Project">
          <Select
            id="filter-project"
            value={value.projectId}
            onChange={(event) => {
              onChange({ ...value, projectId: event.target.value });
            }}
          >
            <option value={ANY}>Any project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="ml-auto pb-1">
        <Button variant="form" onClick={onCompose}>
          New task
        </Button>
      </div>
    </div>
  );
}
