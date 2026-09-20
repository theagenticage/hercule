import { useEffect, useState, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { EmptyState, Group, LaneLabel } from "@hercule/ui";
import { connectionTypes, setupFlowOf, type ConnectionType } from "@hercule/client-core";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { connectionsQuery, pluginsQuery } from "../../../app/queries";
import { ConnectRows } from "../../../screens/connect-rows";
import { ConnectionRow } from "./-row";
import { ConnectionSetup } from "./-setup";

export const Route = createFileRoute("/_shell/connections/")({
  staticData: { title: "Connections" },
  // Where the browser lands after a provider redirect: the controller has
  // already decided, and says which way it went in the address it sends back.
  validateSearch: (search: Record<string, unknown>): { readonly oauth?: string } =>
    typeof search["oauth"] === "string" ? { oauth: search["oauth"] } : {},
  // Answered before it is shown: the connections and the catalog the offers are
  // read from, so the screen never renders as a frame around nothing.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(connectionsQuery(context.client)),
      context.queryClient.ensureQueryData(pluginsQuery(context.client)),
    ]);
  },
  component: Connections,
});

/** What a redirect that did not finish went wrong at, in one sentence each. */
const OAUTH_FAILURES: Readonly<Record<string, string>> = {
  denied: "The provider denied the request, so nothing was connected.",
  expired: "That setup expired before the provider came back. Start it again.",
  "exchange-failed": "The provider refused to hand over a token, so nothing was connected.",
  rejected: "The provider signed in, but the account was turned down.",
};

/** What each way of setting a type up is called, in the few words a row has. */
const GISTS = {
  oauth: "sign in with the provider",
  credentials: "paste a token",
  pairing: "pair a chat account",
} as const;

/**
 * The quiet line under a type's name: the plugin that declares it, then what
 * setting it up takes. The plugin comes first because two plugins may each
 * declare a type called Gmail, and the name above says nothing about which.
 */
const gistOf = (type: ConnectionType): string => {
  const flow = setupFlowOf(type);
  // A step kind this build does not know: the type names itself rather than
  // being described as something it may not be.
  return `${type.pluginName} · ${flow === "unknown" ? type.type : GISTS[flow]}`;
};

/**
 * The accounts Hydra acts through, and everything that can be connected.
 *
 * Nothing about a particular account is written here: the types, their setup
 * steps and their settings all come from the plugin catalog, so a plugin added
 * to the binary shows up on this screen without it being touched.
 */
function Connections(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const navigate = useNavigate();
  // Read once, at the first render: the address is cleared below, and the
  // notice is about the trip that just happened, not about this screen.
  const [notice] = useState(Route.useSearch().oauth);

  useLiveInvalidation(live, queryClient, "connection");

  // Replacing the entry that carried the outcome takes it out of the address
  // bar and out of the back button at once, so a reload does not say it again.
  useEffect(() => {
    if (notice !== undefined) void navigate({ to: "/connections", search: {}, replace: true });
  }, [notice, navigate]);

  const connections = useSuspenseQuery(connectionsQuery(client)).data.items;
  const types = connectionTypes(useSuspenseQuery(pluginsQuery(client)).data);

  const [connecting, setConnecting] = useState<string | null>(null);
  const chosen = types.find((type) => type.type === connecting);

  const offers =
    chosen === undefined ? (
      <ConnectRows
        offers={types.map((type) => ({
          name: type.displayName,
          gist: gistOf(type),
          onConnect: () => {
            setConnecting(type.type);
          },
        }))}
      />
    ) : (
      <ConnectionSetup
        client={client}
        type={chosen}
        onDone={() => {
          setConnecting(null);
        }}
      />
    );

  return (
    <div className="flex flex-col gap-7">
      {notice === undefined ? null : notice === "ok" ? (
        <p className="text-row text-live" role="status">
          The account is connected.
        </p>
      ) : (
        <p className="text-row text-fail" role="alert">
          {/* A word this build does not know is not echoed back: whatever is in
              the address bar is not ours to put on the screen. */}
          {OAUTH_FAILURES[notice] ?? "The setup did not finish."}
        </p>
      )}

      {connections.length === 0 ? (
        <EmptyState
          headline="Nothing connected yet."
          lead="Connections are the accounts Hydra reads and speaks through. Events come from GitHub and Gmail; chat comes from Discord and Slack."
        >
          {offers}
        </EmptyState>
      ) : (
        <>
          <section>
            <LaneLabel>Connected</LaneLabel>
            <Group>
              <ul className="flex flex-col">
                {connections.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    client={client}
                    connection={connection}
                    type={types.find((type) => type.type === connection.type)}
                  />
                ))}
              </ul>
            </Group>
          </section>
          {/* While a setup is open it carries its own label, naming the type. */}
          <section>
            {chosen === undefined ? <LaneLabel>Connect another</LaneLabel> : null}
            {offers}
          </section>
        </>
      )}
    </div>
  );
}
