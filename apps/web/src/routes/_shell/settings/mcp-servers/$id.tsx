import { useEffect, useState, type JSX } from "react";
import { Link, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { isNotFound, queryKeys, readErrorMessage } from "@hercule/client-core";
import {
  buildMcpServerViews,
  describeOfferAddress,
  describeSourceChip,
  readMcpServerOffers,
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
import { McpServerMark } from "../../../../screens/mcp-server-mark";
import { TokenDialog } from "../../../../screens/mcp-url-server/token-dialog";
import { Projects } from "./-projects";
import { Remove } from "./-remove";
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
  // Whether the token dialog of a server added by URL is open: "Sign in…" of the band and "Replace token…" and "Sign in again…" of the Sign-in row open it.
  const [signingIn, setSigningIn] = useState(false);

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
  const { source } = server;
  // The second chip: a plugin's server shows its host, a server added by URL its whole address.
  const offerOrigin =
    source.kind === "plugin"
      ? readMcpServerOffers(plugins).find((offer) => offer.contributionId === source.contributionId)
          ?.origin
      : undefined;
  const address =
    source.kind === "url"
      ? source.url
      : offerOrigin === undefined
        ? undefined
        : describeOfferAddress(offerOrigin);
  const pluginName = plugins.find((plugin) => plugin.id === view.pluginId)?.displayName;
  const chip = "rounded-full border border-line px-2 py-0.5 text-fine text-muted";

  return (
    <div className="flex flex-col gap-4">
      <Link to="/settings/mcp-servers" className="text-fine text-muted hover:text-ink">
        ← MCP servers
      </Link>

      <div className="flex flex-col gap-2.5">
        <h2 className="flex items-center gap-2.5 text-[17px] font-emph tracking-[-0.01em] text-ink">
          <McpServerMark view={view} plugins={plugins} className="size-5" />
          <span>
            {server.name}
            {/* A server added by URL has its address for an account, which its chip shows. */}
            {view.account === undefined || source.kind === "url" ? null : (
              <>
                {" "}
                <span className="text-row font-normal text-muted">{view.account}</span>
              </>
            )}
          </span>
        </h2>
        <div className="flex flex-wrap gap-1.5">
          <span className={chip}>{describeSourceChip(view, pluginName)}</span>
          {address === undefined ? null : <span className={chip}>{address}</span>}
        </div>
      </div>

      <StatusBand
        view={view}
        onCheck={() => {
          if (!check.isPending) check.mutate();
        }}
        onSignIn={() => {
          setSigningIn(true);
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
          setSigningIn(true);
        }}
        checkPending={check.isPending}
      />
      <Tools tools={server.tools} />
      <Projects client={client} view={view} />
      <Remove client={client} view={view} />
      {signingIn ? (
        <TokenDialog
          client={client}
          server={server}
          onClose={() => {
            setSigningIn(false);
          }}
        />
      ) : null}
    </div>
  );
}
