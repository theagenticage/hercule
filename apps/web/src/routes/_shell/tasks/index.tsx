import { useEffect, useState, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { FALLBACK_TIMEZONE, idTail, isSupportedTimezone } from "@hydra/client-core";
import {
  TASK_STATUSES,
  type TaskCreateInput,
  type TaskFilter,
  type TaskStatus,
  type TaskUpdateInput,
} from "@hydra/contract";
import { Button, Drawer, EmptyState, Field, Input, Select } from "@hydra/ui";
import { projectsQuery, settingsQuery, taskQuery, tasksQuery } from "../../../app/queries";
import { TaskComposer } from "./-composer";
import { TaskDetail } from "./-detail";
import { TaskRow } from "./-row";

const ANY = "";

/** How long the search box waits before it asks, so a word is one question. */
const SEARCH_SETTLE_MS = 200;

export const Route = createFileRoute("/_shell/tasks/")({
  staticData: { title: "Tasks" },
  // Detail is a drawer over this screen and never a page of its own, so the
  // task being read is a parameter of the list's own address.
  validateSearch: (search: Record<string, unknown>): { readonly task?: string } =>
    typeof search["task"] === "string" ? { task: search["task"] } : {},
  // The screen is answered before it is shown: the first page of tasks and the
  // projects that name them, so it never renders as a frame around nothing and
  // never grows entries under the reader a moment later.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureInfiniteQueryData(tasksQuery(context.client, {})),
      context.queryClient.ensureQueryData(projectsQuery(context.client)),
    ]);
  },
  component: Tasks,
});

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

/** What a failed write says, or nothing when there was none. */
const failureOf = (error: Error | null): string | undefined => error?.message;

/** The labels the user typed as a comma-separated line. */
const labelsOf = (typed: string): readonly string[] =>
  typed
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");

function Tasks(): JSX.Element {
  const { client, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();
  const openId = Route.useSearch().task;

  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const stored = settings.user.timezone ?? FALLBACK_TIMEZONE;
  const timezone = isSupportedTimezone(stored) ? stored : FALLBACK_TIMEZONE;

  const [text, setText] = useState("");
  const [status, setStatus] = useState<TaskStatus | typeof ANY>(ANY);
  const [labels, setLabels] = useState("");
  const [projectId, setProjectId] = useState(ANY);
  const [composing, setComposing] = useState(false);

  const searched = useSettled(text.trim(), SEARCH_SETTLE_MS);
  const wanted = labelsOf(useSettled(labels, SEARCH_SETTLE_MS));
  const filter: TaskFilter = {
    ...(searched === "" ? {} : { text: searched }),
    ...(status === ANY ? {} : { status: [status] }),
    ...(wanted.length === 0 ? {} : { labels: wanted }),
    ...(projectId === ANY ? {} : { projectId }),
  };
  const filtering = Object.keys(filter).length > 0;

  const listing = useInfiniteQuery(tasksQuery(client, filter));
  const projects = useQuery(projectsQuery(client));
  const tasks = listing.data?.pages.flatMap((page) => page.items) ?? [];
  const known = projects.data?.items ?? [];
  const nameOf = (id: string): string =>
    known.find((project) => project.id === id)?.name ?? idTail(id);

  const reread = async (id?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      id === undefined
        ? Promise.resolve()
        : queryClient.invalidateQueries({ queryKey: ["task", id] }),
    ]);
  };

  const create = useMutation({
    mutationFn: (input: TaskCreateInput) => client.task.create({ payload: input }),
    onSuccess: async () => {
      setComposing(false);
      await reread();
    },
  });

  // A refused edit belongs to the task it was made on. The mutation's own error
  // cannot say that: every field of the drawer shares one mutation, so a second
  // edit issued before the first answers clears the first one's error before it
  // is ever rendered, and an error that does survive is rendered inside
  // whichever task's drawer is open next. So the refusal is held here, named by
  // the task it refused, and shown only there.
  const [refusal, setRefusal] = useState<
    { readonly taskId: string; readonly message: string } | undefined
  >(undefined);

  const edit = useMutation({
    mutationFn: ({ id, patch }: { readonly id: string; readonly patch: TaskUpdateInput }) =>
      client.task.update({ params: { id }, payload: patch }),
    onSuccess: (_, variables) => reread(variables.id),
    onError: (error, variables) => {
      setRefusal({ taskId: variables.id, message: error.message });
    },
  });

  // Opening another task, or closing the drawer, puts the refusal behind us.
  const openTask = (id: string) => {
    setRefusal(undefined);
    return navigate({ to: "/tasks", search: { task: id } });
  };
  const closeTask = () => {
    setRefusal(undefined);
    return navigate({ to: "/tasks", search: {} });
  };

  // The listing answers the panel instantly and the read keeps it right: a task
  // reached by address may be on no page fetched, and one the user has just
  // edited may have left the filter the listing is under.
  const listed = tasks.find((task) => task.id === openId);
  // A read that is being refetched keeps the answer it had, so an edit that
  // takes the task out of the filter does not take the panel with it.
  const opened = useQuery({ ...taskQuery(client, openId ?? ""), enabled: openId !== undefined });
  const selected = opened.data ?? listed;

  return (
    <div className="flex max-w-[940px] flex-col gap-4">
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
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
          </Field>
        </div>
        <div className="w-[150px]">
          <Field id="filter-status" label="Status">
            <Select
              id="filter-status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as TaskStatus | typeof ANY);
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
              value={labels}
              onChange={(event) => {
                setLabels(event.target.value);
              }}
            />
          </Field>
        </div>
        <div className="w-[170px]">
          <Field id="filter-project" label="Project">
            <Select
              id="filter-project"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
              }}
            >
              <option value={ANY}>Any project</option>
              {known.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="ml-auto pb-1">
          <Button
            variant="form"
            onClick={() => {
              create.reset();
              setComposing((open) => !open);
            }}
          >
            New task
          </Button>
        </div>
      </div>

      {composing ? (
        <div className="max-w-[560px]">
          <TaskComposer
            projects={known}
            pending={create.isPending}
            failure={failureOf(create.error)}
            onCreate={(input) => {
              create.mutate(input);
            }}
            // A refusal is answered for the attempt that drew it and no other,
            // so it goes when the form does.
            onCancel={() => {
              create.reset();
              setComposing(false);
            }}
          />
        </div>
      ) : null}

      {listing.isError ? (
        <EmptyState
          headline="The tasks could not be read."
          lead={listing.error instanceof Error ? listing.error.message : String(listing.error)}
        />
      ) : listing.isPending ? null : tasks.length === 0 ? (
        filtering ? (
          <EmptyState headline="Nothing matches these filters." />
        ) : (
          <EmptyState
            headline="No tasks yet."
            lead="Triage proposes tasks from what comes in, and you can add one by hand. A task is intent; a run or a thread does the work."
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-card border border-line-soft bg-surface px-1.5 py-1">
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                project={task.projectId === undefined ? "" : nameOf(task.projectId)}
                timezone={timezone}
                selected={task.id === openId}
                onOpen={() => void openTask(task.id)}
              />
            ))}
          </div>
          {listing.hasNextPage ? (
            <Button
              disabled={listing.isFetchingNextPage}
              onClick={() => {
                void listing.fetchNextPage();
              }}
            >
              Show more
            </Button>
          ) : null}
        </div>
      )}

      {selected === undefined ? (
        // A task named in the address that the controller will not answer for -
        // deleted, or never there - is not silence: the drawer opens and says
        // what the controller said.
        openId === undefined || !opened.isError ? null : (
          <Drawer open onClose={() => void closeTask()} title="The task could not be read.">
            <p className="text-row leading-relaxed text-muted">{failureOf(opened.error)}</p>
          </Drawer>
        )
      ) : (
        <TaskDetail
          task={selected}
          projects={known}
          timezone={timezone}
          failure={refusal?.taskId === selected.id ? refusal.message : undefined}
          onEdit={(patch) => {
            edit.mutate({ id: selected.id, patch });
          }}
          onClose={() => void closeTask()}
        />
      )}
    </div>
  );
}
