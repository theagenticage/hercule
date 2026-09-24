import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { EmptyState, Group, LaneLabel } from "@hercule/ui";
import { resolveDisplayTimezone } from "@hercule/client-core";
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
 * The Secrets screen: the secrets the controller stores, without their
 * values. The API returns only references, so the screen lists each secret's
 * owner and name with the time it was last written. The form to set a secret
 * is on the same screen, because setting and rotating are the same call.
 */
function Secrets(): JSX.Element {
  const { client } = Route.useRouteContext();

  const secrets = useSuspenseQuery(secretsQuery(client)).data.items;
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );

  return (
    <div className="flex flex-col gap-7">
      {secrets.length === 0 ? (
        <EmptyState
          headline="No secrets are stored."
          lead="Secrets are the tokens and keys connections and workflows use. Hercule keeps their values out of every read and shows only where each one is used."
        />
      ) : (
        <section>
          <LaneLabel>Stored</LaneLabel>
          {/* The settings screens are a column of 520px cards, so the list
              uses the same width. */}
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
