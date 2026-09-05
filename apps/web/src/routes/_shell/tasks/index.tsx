import { useState, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { FALLBACK_TIMEZONE, idTail, isSupportedTimezone, queryKeys } from "@hydra/client-core";
import type { TaskCreateInput } from "@hydra/contract";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { projectsQuery, settingsQuery, tasksQuery } from "../../../app/queries";
import { TaskComposer } from "./-composer";
import { TaskDrawer } from "./-drawer";
import { NO_FILTERS, TaskFilterBar, useSettledFilter } from "./-filters";
import { TaskList } from "./-list";

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
  const nameOf = (id: string): string =>
    known.find((project) => project.id === id)?.name ?? idTail(id);

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
        // A refusal is answered for the attempt that drew it and no other, so
        // opening the form again opens it clean.
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
        nameOf={nameOf}
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
        // What the drawer holds belongs to the task it is open on: keying it on
        // the address leaves a refusal behind with the task it refused,
        // whether the reader left by a row, by Close, or by Back.
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
