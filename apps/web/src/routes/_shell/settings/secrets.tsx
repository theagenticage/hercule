import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { EmptyState, Group, LaneLabel } from "@hercule/ui";
import { FALLBACK_TIMEZONE, isSupportedTimezone } from "@hercule/client-core";
import { secretsQuery, settingsQuery } from "../../../app/queries";
import { SecretRow } from "./-secret-row";
import { SetSecret } from "./-set-secret";

export const Route = createFileRoute("/_shell/settings/secrets")({
  staticData: { title: "Secrets" },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(secretsQuery(context.client));
  },
  component: Secrets,
});

/**
 * What the controller holds, and nothing of what it holds: every read here is
 * a reference, so the screen is a list of owners and names with the times they
 * were last written. The way to set one is on the same screen, because setting
 * and rotating are the same call.
 */
function Secrets(): JSX.Element {
  const { client } = Route.useRouteContext();

  const secrets = useSuspenseQuery(secretsQuery(client)).data.items;
  const stored = useSuspenseQuery(settingsQuery(client)).data.user.timezone ?? FALLBACK_TIMEZONE;
  const timezone = isSupportedTimezone(stored) ? stored : FALLBACK_TIMEZONE;

  return (
    <div className="flex flex-col gap-7">
      {secrets.length === 0 ? (
        <EmptyState
          headline="No secrets are stored."
          lead="Secrets are the tokens and keys connections and workflows use. Hydra keeps their values out of every read and shows only where each one is used."
        />
      ) : (
        <section>
          <LaneLabel>Stored</LaneLabel>
          {/* Settings is a column of 520px cards, which a list of rows sits
              in rather than beside. */}
          <div className="max-w-[520px]">
            <Group>
              <ul className="flex flex-col">
                {secrets.map((secret) => (
                  <SecretRow
                    key={`${secret.ownerKind}/${secret.ownerId}/${secret.name}`}
                    client={client}
                    secret={secret}
                    timezone={timezone}
                  />
                ))}
              </ul>
            </Group>
          </div>
        </section>
      )}

      <SetSecret client={client} />
    </div>
  );
}
