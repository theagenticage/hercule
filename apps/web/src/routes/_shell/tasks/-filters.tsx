import { useEffect, useState, type JSX } from "react";
import { TASK_STATUSES, type Project, type TaskFilter, type TaskStatus } from "@hercule/contract";
import { Button, Field, Input, Select } from "@hercule/ui";

/** The value every filter starts on, which means no filter. */
export const ANY = "";

/** How long the search box waits after typing stops, so a whole word is one request. */
const SEARCH_SETTLE_MS = 200;

/** The filter bar's values as the user typed them, before debouncing. */
export interface FilterState {
  readonly text: string;
  readonly status: TaskStatus | typeof ANY;
  readonly labels: string;
  readonly projectId: string;
}

/** The filter bar's starting state: every filter on Any. */
export const NO_FILTERS: FilterState = {
  text: ANY,
  status: ANY,
  labels: ANY,
  projectId: ANY,
};

/** Returns `value` once it has not changed for `delay` ms, so typing sends one request. */
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

/** Parses the comma-separated labels the user typed, dropping empty entries. */
const parseLabels = (typed: string): readonly string[] =>
  typed
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");

/**
 * Returns the task filter to send to the controller. The two select filters
 * apply at once; the two text filters apply once the user stops typing.
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
 * The filter bar above the task list, with the button that opens the form for
 * writing a task by hand.
 *
 * Every filter starts on Any, so the screen shows all tasks until the user
 * narrows it.
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
            // Hide the browser's own clear button: it is drawn in a color the
            // design system does not use.
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
