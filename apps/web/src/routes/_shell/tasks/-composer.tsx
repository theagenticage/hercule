import { useState, type FormEvent, type JSX } from "react";
import {
  TASK_PRIORITIES,
  TaskCreateForm,
  type Project,
  type TaskCreateInput,
} from "@hydra/contract";
import { Button, Field, Input, Select, Textarea } from "@hydra/ui";
import { validate, type FieldErrors } from "../../../app/form";

const NO_PROJECT = "";

/**
 * A task written by hand.
 *
 * The form is checked against the very schema the controller checks it with,
 * so a title that is too long is refused here in the same words rather than
 * after a round trip.
 */
export function TaskComposer({
  projects,
  pending,
  failure,
  onCreate,
  onCancel,
}: {
  readonly projects: readonly Project[];
  readonly pending: boolean;
  /** What the controller answered, when it refused the last attempt. */
  readonly failure: string | undefined;
  readonly onCreate: (input: TaskCreateInput) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskCreateInput["priority"]>("normal");
  const [projectId, setProjectId] = useState(NO_PROJECT);
  const [errors, setErrors] = useState<FieldErrors>({});

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const checked = validate(TaskCreateForm, {
      title,
      description,
      priority,
      ...(projectId === NO_PROJECT ? {} : { projectId }),
    });
    setErrors(checked.errors ?? {});
    if (checked.errors !== undefined) return;
    onCreate(checked.value);
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-card border border-line bg-raised px-4.5 py-4 shadow-card"
    >
      <Field id="new-title" label="Title" error={errors.title}>
        <Input
          id="new-title"
          autoFocus
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </Field>
      <Field id="new-description" label="Description" error={errors.description}>
        <Textarea
          id="new-description"
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="new-priority" label="Priority">
          <Select
            id="new-priority"
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value as TaskCreateInput["priority"]);
            }}
          >
            {TASK_PRIORITIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="new-project" label="Project">
          <Select
            id="new-project"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
            }}
          >
            <option value={NO_PROJECT}>No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {failure === undefined ? null : (
        <p className="text-fine text-fail" role="alert">
          {failure}
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" variant="form" disabled={pending}>
          Create
        </Button>
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
