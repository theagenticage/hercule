import { Suspense, useEffect, useState, type JSX } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { isNotFound, queryKeys, readErrorMessage } from "@hercule/client-core";
import {
  buildMcpServerViews,
  describeSignInRow,
  type SignInEntry,
} from "@hercule/client-core/mcp-servers";
import { useLiveInvalidation } from "../../../../app/live-invalidation";
import {
  connectionsQuery,
  mcpServerQuery,
  mcpServersQuery,
  pluginsQuery,
  projectsQuery,
  settingsQuery,
} from "../../../../app/queries";
import { LazyTokenDialog } from "../../../../screens/mcp-url-server/lazy-dialogs";
import { Projects } from "./-projects";
import { Remove } from "./-remove";
import { ServerHeading } from "./-server-heading";
import { ServerSection } from "./-server-section";
import { StatusBand } from "./-status-band";
import { Tools } from "./-tools";

export const Route = createFileRoute("/_shell/settings/mcp-servers/$id")({
  staticData: { title: "MCP server" },
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(mcpServerQuery(context.client, params.id));
    } catch (error) {
      // An address that names no server goes to the list, replacing its entry
      // in the history so Back does not return to the missing page. The router
      // redirects when a `redirect` is thrown, a plain descriptor rather than
      // an Error.
      // oxlint-disable-next-line typescript/only-throw-error
      if (isNotFound(error)) throw redirect({ to: "/settings/mcp-servers", replace: true });
      throw error;
    }
    await Promise.all([
      context.queryClient.ensureQueryData(mcpServersQuery(context.client)),
      context.queryClient.ensureQueryData(connectionsQuery(context.client)),
      context.queryClient.ensureQueryData(pluginsQuery(context.client)),
      context.queryClient.ensureQueryData(projectsQuery(context.client)),
      // The page's box for the threads without a project edits the default
      // list, so it starts from the settings as they are now, as the list does.
      context.queryClient.fetchQuery({ ...settingsQuery(context.client), staleTime: 0 }),
    ]);
  },
  component: McpServerPage,
});

/**
 * The page of one MCP server: what it is, its status and what to do about
 * it, how it is reached, its tools, the projects that name it, and Remove.
 *
 * The page holds the `mcpServer` live topic while it is open. A server that is
 * deleted meanwhile, from another window or by an agent, answers the page's
 * read with not found, and the page goes back to the list.
 */
function McpServerPage(): JSX.Element | null {
  const { client, queryClient, live } = Route.useRouteContext();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  // The button that opened the token dialog of a server added by URL ("Sign in…" of the band,
  // "Replace token…" or "Sign in again…" of the Sign-in row), or `null` while it is closed.
  const [signingIn, setSigningIn] = useState<SignInEntry | null>(null);

  useLiveInvalidation(live, queryClient, "mcpServer");

  // The loader has read the server, so `data` is there from the first render.
  // A read that fails later keeps the last data, which is why `gone` is a
  // separate check.
  const read = useQuery(mcpServerQuery(client, id));
  const gone = isNotFound(read.error);
  useEffect(() => {
    if (gone) void navigate({ to: "/settings/mcp-servers", replace: true });
  }, [gone, navigate]);

  const connections = useSuspenseQuery(connectionsQuery(client)).data.items;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;

  const check = useMutation({
    mutationFn: () => client.mcpServer.check({ params: { id } }),
    // The answer comes on the live topic. The reads are fetched again so the
    // page shows `checking` at once, and the button stays unavailable until then.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpServer(id) }),
      ]),
  });

  const server = read.data;
  if (server === undefined || gone) return null;

  const view = buildMcpServerViews([server], connections, plugins)[0]!;

  return (
    <div className="flex flex-col gap-4">
      <ServerHeading view={view} plugins={plugins} />

      <StatusBand
        view={view}
        onCheck={() => {
          if (!check.isPending) check.mutate();
        }}
        onSignIn={() => {
          setSigningIn("sign-in");
        }}
        checkPending={check.isPending}
      />
      {check.error === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {readErrorMessage(check.error)}
        </p>
      )}

      <ServerSection
        client={client}
        view={view}
        plugins={plugins}
        onCheck={() => {
          if (!check.isPending) check.mutate();
        }}
        onOpenSignIn={() => {
          setSigningIn(describeSignInRow(view)?.action?.kind ?? "sign-in");
        }}
        checkPending={check.isPending}
      />
      <Tools tools={server.tools} />
      <Projects client={client} view={view} />
      <Remove client={client} view={view} />
      {signingIn === null ? null : (
        <Suspense fallback={null}>
          <LazyTokenDialog
            client={client}
            server={server}
            openedOn="server-page"
            entry={signingIn}
            onClose={() => {
              setSigningIn(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
