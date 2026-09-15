import { useState, type FormEvent, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import {
  actorReading,
  formatStamp,
  idTail,
  priorityGlyph,
  provenanceTarget,
} from "@hydra/client-core";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Project,
  type Task,
  type TaskUpdateInput,
} from "@hydra/contract";
import { Button, Drawer, Input, LaneLabel, PriorityGlyph, Row, Select } from "@hydra/ui";

const NO_PROJECT = "";

/**
 * One task in full, in the drawer over the list.
 *
 * Every edit here is one field, sent the moment it is made: there is no save
 * button, because a status the user has already moved is a status a triage
 * agent reading the same task should already see. Labels move one at a time for
 * the same reason. Provenance is the one thing that is only ever read - it is
 * the record of what made this task, and it is appended to, never edited.
 */
export function TaskDetail({
  task,
  projects,
  timezone,
  failure,
  onEdit,
  onClose,
}: {
  readonly task: Task;
  readonly projects: readonly Project[];
  readonly timezone: string;
  /** What the controller answered, when it refused the last edit. */
  readonly failure: string | undefined;
  readonly onEdit: (patch: TaskUpdateInput) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const [label, setLabel] = useState("");
  const glyph = priorityGlyph(task.priority);

  // A task keeps its project past that project's deletion, and the picker holds
  // one page. Either way the task names a project the list does not, and the
  // select must say so rather than fall through to "No project".
  const offered =
    task.projectId === undefined || projects.some((project) => project.id === task.projectId)
      ? projects
      : [...projects, { id: task.projectId, name: idTail(task.projectId) }];

  const addLabel = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed === "" || task.labels.includes(trimmed)) return;
    onEdit({ addLabels: [trimmed] });
    setLabel("");
  };

  return (
    <Drawer open onClose={onClose} title={task.title}>
      <div className="flex flex-col gap-5">
        {failure === undefined ? null : (
          <p className="text-fine text-fail" role="alert">
            {failure}
          </p>
        )}
        {task.description === "" ? null : (
          <p className="text-row leading-relaxed whitespace-pre-wrap text-muted">
            {task.description}
          </p>
        )}

        <div className="flex flex-col gap-2.5">
          <Row label="Status" htmlFor="detail-status">
            <Select
              id="detail-status"
              value={task.status}
              onChange={(event) => {
                onEdit({ status: event.target.value as Task["status"] });
              }}
            >
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
          </Row>

          <Row label="Priority" htmlFor="detail-priority">
            <div className="flex items-center gap-2.5">
              <Select
                id="detail-priority"
                value={task.priority}
                onChange={(event) => {
                  onEdit({ priority: event.target.value as Task["priority"] });
                }}
              >
                {TASK_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </Select>
              <PriorityGlyph
                filled={glyph.filled}
                tone={glyph.tone}
                label={`${task.priority} priority`}
              />
            </div>
          </Row>

          <Row label="Project" htmlFor="detail-project">
            <Select
              id="detail-project"
              value={task.projectId ?? NO_PROJECT}
              onChange={(event) => {
                onEdit({
                  projectId: event.target.value === NO_PROJECT ? null : event.target.value,
                });
              }}
            >
              <option value={NO_PROJECT}>No project</option>
              {offered.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Row>

          <Row label="Labels" htmlFor="detail-label">
            <div className="flex flex-col gap-2">
              {task.labels.length === 0 ? null : (
                <div className="flex flex-wrap gap-1.5">
                  {task.labels.map((name) => (
                    <span
                      key={name}
                      className="inline-flex items-center gap-1 rounded-control bg-line-soft py-0.5 pr-1 pl-2 font-mono text-fine text-muted"
                    >
                      {name}
                      <Button
                        aria-label={`Remove ${name}`}
                        onClick={() => {
                          onEdit({ removeLabels: [name] });
                        }}
                        className="px-1 py-0 text-faint"
                      >
                        <svg viewBox="0 0 12 12" width={10} height={10} aria-hidden="true">
                          <path
                            d="m3.5 3.5 5 5M8.5 3.5l-5 5"
                            stroke="currentColor"
                            strokeWidth={1.15}
                            strokeLinecap="round"
                            fill="none"
                          />
                        </svg>
                      </Button>
                    </span>
                  ))}
                </div>
              )}
              <form onSubmit={addLabel}>
                <Input
                  id="detail-label"
                  value={label}
                  placeholder="Add a label"
                  onChange={(event) => {
                    setLabel(event.target.value);
                  }}
                />
              </form>
            </div>
          </Row>
        </div>

        <section>
          <LaneLabel>Provenance</LaneLabel>
          {task.provenance.length === 0 ? (
            <p className="text-fine text-faint">Nothing has been recorded against this task.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {task.provenance.map((entry) => {
                const actor = actorReading(entry.actor);
                return (
                  <li
                    key={`${entry.at}-${provenanceTarget(entry)}`}
                    className="flex flex-col gap-0.5"
                  >
                    <span className="font-mono text-fine break-all text-muted">
                      {provenanceTarget(entry)}
                    </span>
                    <span className="flex items-baseline gap-2 font-mono text-fine">
                      {actor.sessionId === undefined ? (
                        <span className="text-faint">{actor.label}</span>
                      ) : (
                        <Link
                          to="/threads/$sessionId"
                          params={{ sessionId: actor.sessionId }}
                          className="text-muted underline underline-offset-2 hover:text-ink"
                        >
                          {actor.label}
                        </Link>
                      )}
                      <span className="shrink-0 text-faint tabular-nums">
                        {formatStamp(new Date(entry.at), timezone) ?? entry.at}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </Drawer>
  );
}
