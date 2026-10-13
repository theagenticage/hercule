import { useEffect, useState, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { EmptyState, Group, LaneLabel } from "@hercule/ui";
import { listConnectionTypes, summarizeConnectionType } from "@hercule/client-core";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { connectionsQuery, pluginsQuery } from "../../../app/queries";
import { ConnectRows } from "../../../screens/connect-rows";
import { ConnectionRow } from "./-row";
import { ConnectionSetup } from "./-setup";

export const Route = createFileRoute("/_shell/connections/")({
  staticData: { title: "Connections" },
  // The browser lands here after a provider redirect. The controller has
  // already finished the setup and puts the outcome in the `oauth` parameter.
  // An invalid param is returned as `undefined` rather than left out: the
  // router lays the returned params over the URL's, so a param left out would
  // keep the URL's value.
  validateSearch: (search: Record<string, unknown>): { readonly oauth?: string | undefined } => ({
    oauth: typeof search["oauth"] === "string" ? search["oauth"] : undefined,
  }),
  // Loads the connections and the plugin catalog (which the offers are built
  // from) before the screen renders, so it never renders empty.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(connectionsQuery(context.client)),
      context.queryClient.ensureQueryData(pluginsQuery(context.client)),
    ]);
  },
  component: Connections,
});

/** The message shown for each way a provider redirect can fail. */
const OAUTH_FAILURES: Readonly<Record<string, string>> = {
  denied: "The provider denied the request, so nothing changed.",
  expired: "That setup expired before the provider came back. Start it again.",
  "exchange-failed": "The provider refused to hand over a token, so nothing changed.",
  rejected: "The provider signed in, but the account was turned down.",
  // The redirect lands on the list with no connection named, so the message
  // cannot say which connection was reconnected or which account signed in.
  "other-account":
    "That sign-in was for a different account than the connection you reconnected, so nothing changed. To add that account, create a new connection for it.",
};

/**
 * The Connections screen: the accounts Hercule acts through, and every type
 * that can be connected.
 *
 * Nothing here is specific to one kind of account. The types, their setup
 * steps and their settings all come from the plugin catalog, so a plugin added
 * to the binary shows up on this screen without changes here.
 */
function Connections(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const navigate = useNavigate();
  // Read once, on the first render: the effect below clears the parameter from
  // the address, and the notice is only about the redirect that just happened.
  const [notice] = useState(Route.useSearch().oauth);

  useLiveInvalidation(live, queryClient, "connection");

  // Replacing the history entry removes the outcome from both the address bar
  // and the back button, so a reload does not show the notice again.
  useEffect(() => {
    if (notice !== undefined) void navigate({ to: "/connections", search: {}, replace: true });
  }, [notice, navigate]);

  const connections = useSuspenseQuery(connectionsQuery(client)).data.items;
  const types = listConnectionTypes(useSuspenseQuery(pluginsQuery(client)).data);

  const [connecting, setConnecting] = useState<string | null>(null);
  const chosen = types.find((type) => type.type === connecting);

  const offers =
    chosen === undefined ? (
      <ConnectRows
        offers={types.map((type) => ({
          name: type.displayName,
          gist: summarizeConnectionType(type),
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
          {/* An unknown value is not shown as-is, because anyone can put any
              text in the address bar. */}
          {OAUTH_FAILURES[notice] ?? "The setup did not finish."}
        </p>
      )}

      {connections.length === 0 ? (
        <EmptyState
          headline="Nothing connected yet."
          lead="Connections are the accounts Hercule reads and speaks through."
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
          {/* An open setup form has its own heading that names the type. */}
          <section>
            {chosen === undefined ? <LaneLabel>Connect another</LaneLabel> : null}
            {offers}
          </section>
        </>
      )}
    </div>
  );
}
