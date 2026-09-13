import { useState, type JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Button, EmptyState, Group, LaneLabel } from "@hydra/ui";
import { connectionTypes, type ConnectionType } from "@hydra/client-core";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { connectionsQuery, pluginsQuery } from "../../../app/queries";
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

/** How a type is set up, in the few words a row has for it. */
const gistOf = (type: ConnectionType): string => {
  if (type.setup.some((step) => step.kind === "oauth")) return "sign in with the provider";
  if (type.setup.some((step) => step.kind === "credentials")) return "paste a token";
  return "pair a chat account";
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
  const oauth = Route.useSearch().oauth;

  useLiveInvalidation(live, queryClient, "connection");

  const connections = useSuspenseQuery(connectionsQuery(client)).data.items;
  const types = connectionTypes(useSuspenseQuery(pluginsQuery(client)).data);

  const [connecting, setConnecting] = useState<string | null>(null);
  const chosen = types.find((type) => type.type === connecting);

  const offers =
    chosen === undefined ? (
      <Group>
        {types.map((type) => (
          <div
            key={type.type}
            className="flex items-center gap-2.5 rounded-control px-2.5 py-[7px] text-row"
          >
            <span className="min-w-0 flex-1">
              <b className="block font-emph text-ink">{type.displayName}</b>
              <small className="block text-fine text-muted">{gistOf(type)}</small>
            </span>
            <Button
              variant="primary"
              onClick={() => {
                setConnecting(type.type);
              }}
            >
              Connect
            </Button>
          </div>
        ))}
      </Group>
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
      {oauth === undefined ? null : oauth === "ok" ? (
        <p className="text-row text-live" role="status">
          The account is connected.
        </p>
      ) : (
        <p className="text-row text-fail" role="alert">
          {OAUTH_FAILURES[oauth] ?? `The setup did not finish: ${oauth}.`}
        </p>
      )}

      {connections.length === 0 ? (
        <EmptyState
          headline="Nothing connected yet."
          lead="Connections are the accounts Hydra reads and speaks through. Each files its work into a topic you pick at setup."
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
          <section>
            <LaneLabel>Connect another</LaneLabel>
            {offers}
          </section>
        </>
      )}
    </div>
  );
}
