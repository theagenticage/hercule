import { useState, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { FALLBACK_TIMEZONE, toIdTail, isSupportedTimezone, queryKeys } from "@hercule/client-core";
import type { TaskCreateInput } from "@hercule/contract";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { projectsQuery, settingsQuery, tasksQuery } from "../../../app/queries";
import { TaskComposer } from "./-composer";
import { TaskDrawer } from "./-drawer";
import { NO_FILTERS, TaskFilterBar, useSettledFilter } from "./-filters";
import { TaskList } from "./-list";

export const Route = createFileRoute("/_shell/tasks/")({
  staticData: { title: "Tasks" },
  // Task detail is a drawer over this screen, never a page of its own, so the
  // open task is a search parameter of the list's URL.
  validateSearch: (search: Record<string, unknown>): { readonly task?: string } =>
    typeof search["task"] === "string" ? { task: search["task"] } : {},
  // Load the first page of tasks and the projects before the screen shows, so
  // it never renders empty and then fills in a moment later.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureInfiniteQueryData(tasksQuery(context.client, {})),
      context.queryClient.ensureQueryData(projectsQuery(context.client)),
    ]);
  },
  component: Tasks,
});

function Tasks(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const navigate = useNavigate();
  const openId = Route.useSearch().task;

  useLiveInvalidation(live, queryClient, "task");

  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const stored = settings.user.timezone ?? FALLBACK_TIMEZONE;
  const timezone = isSupportedTimezone(stored) ? stored : FALLBACK_TIMEZONE;

  const [filters, setFilters] = useState(NO_FILTERS);
  const [composing, setComposing] = useState(false);

  const filter = useSettledFilter(filters);
  const filtering = Object.keys(filter).length > 0;

  const listing = useInfiniteQuery(tasksQuery(client, filter));
  const projects = useQuery(projectsQuery(client));
  const tasks = listing.data?.pages.flatMap((page) => page.items) ?? [];
  const known = projects.data?.items ?? [];
  const readProjectName = (id: string): string =>
    known.find((project) => project.id === id)?.name ?? toIdTail(id);

  const reread = async (id?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks() }),
      id === undefined
        ? Promise.resolve()
        : queryClient.invalidateQueries({ queryKey: queryKeys.task(id) }),
    ]);
  };

  const create = useMutation({
    mutationFn: (input: TaskCreateInput) => client.task.create({ payload: input }),
    onSuccess: async () => {
      setComposing(false);
      await reread();
    },
  });

  return (
    <div className="flex max-w-[940px] flex-col gap-4">
      <TaskFilterBar
        value={filters}
        projects={known}
        onChange={setFilters}
        // An error belongs to the attempt that caused it, so reopening the
        // form clears it.
        onCompose={() => {
          create.reset();
          setComposing((open) => !open);
        }}
      />

      {composing ? (
        <div className="max-w-[560px]">
          <TaskComposer
            projects={known}
            pending={create.isPending}
            failure={create.error?.message}
            onCreate={(input) => {
              create.mutate(input);
            }}
            onCancel={() => {
              setComposing(false);
            }}
          />
        </div>
      ) : null}

      <TaskList
        tasks={tasks}
        failure={
          listing.isError
            ? listing.error instanceof Error
              ? listing.error.message
              : String(listing.error)
            : undefined
        }
        pending={listing.isPending}
        filtering={filtering}
        timezone={timezone}
        nameOf={readProjectName}
        openId={openId}
        onOpen={(id) => void navigate({ to: "/tasks", search: { task: id } })}
        more={
          listing.hasNextPage
            ? {
                pending: listing.isFetchingNextPage,
                fetch: () => void listing.fetchNextPage(),
              }
            : undefined
        }
      />

      <TaskDrawer
        // The drawer's state belongs to the task it shows. Keying it on the
        // open task id discards an edit error along with its task, whether the
        // user left by clicking a row, Close, or Back.
        key={openId ?? "none"}
        client={client}
        openId={openId}
        listed={tasks.find((task) => task.id === openId)}
        projects={known}
        timezone={timezone}
        reread={reread}
        onClose={() => void navigate({ to: "/tasks", search: {} })}
      />
    </div>
  );
}
