import { useState, type FormEvent, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  buildIdOptions,
  FALLBACK_TIMEZONE,
  filterGitHubConnections,
  readErrorMessage,
} from "@hercule/client-core";
import { Button, FormCard, Row, Select } from "@hercule/ui";
import { LOGIN_PATH } from "../../../app/entry-guard";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { connectionsQuery, settingsQuery } from "../../../app/queries";
import { TimezoneField } from "../../../screens/timezone-field";
import { SaveStatus } from "../../../screens/save-status";
import { useSaveSettings } from "./-form";

export const Route = createFileRoute("/_shell/settings/profile")({
  staticData: { title: "Profile" },
  loader: ({ context }) =>
    // Prefetched rather than ensured, so if the controller cannot list the
    // connections only the GitHub card says so, instead of the whole screen
    // failing to load.
    context.queryClient.prefetchQuery(connectionsQuery(context.client)),
  component: Profile,
});

/**
 * The Profile screen: the user's timezone, their default GitHub account, and
 * signing out.
 *
 * The whole system shows times in this one timezone. Onboarding sets it from
 * the browser, so there is always one to show; the user changes it here.
 */
function Profile(): JSX.Element {
  const { client, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const { save, saving, saved, failure } = useSaveSettings(client);

  const storedTimezone = settings.user.timezone ?? FALLBACK_TIMEZONE;
  const [timezone, setTimezone] = useState(storedTimezone);
  // Save is off while the field holds the stored zone, as on Settings >
  // Assistants: there is nothing to send.
  const hasChanges = timezone !== storedTimezone;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save({ user: { timezone } });
  };

  /**
   * Signs out: revokes the bearer token at the controller, then forgets it in
   * this browser whatever the controller returned.
   *
   * - The local part runs when the mutation settles, not only when it
   *   succeeds. A failed revocation must not leave the user signed in, and a
   *   token this browser has discarded cannot be sent again anyway.
   * - The query cache is cleared only after the login screen is showing.
   *   Clearing it first would evict a query this screen still uses; that
   *   query would refetch without a token, and its failure screen would race
   *   the navigation.
   * - The navigation also closes the live connection, because the entry guard
   *   keeps it open only while there is a token.
   */
  const signOut = useMutation({
    mutationFn: () => client.auth.logout(),
    onSettled: async () => {
      client.setToken(null);
      await navigate({ to: LOGIN_PATH });
      queryClient.clear();
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit}>
        {/* The note sits under the field it explains and Save ends the card,
            as on Settings > Assistants. */}
        <FormCard label="Profile">
          <Row label="Timezone" htmlFor="timezone">
            <TimezoneField value={timezone} onChange={setTimezone} />
          </Row>
          <p className="text-fine text-faint">
            Schedules, ages and every time on screen are read in this zone.
          </p>
          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" variant="form" disabled={saving || !hasChanges}>
              Save
            </Button>
            {/* "Saved." describes the last save, so it goes once the field is
                edited again. */}
            <SaveStatus saved={saved && !hasChanges} failure={failure} />
          </div>
        </FormCard>
      </form>

      <DefaultGitHubAccount />

      <FormCard
        label="Session"
        fine="This browser keeps you signed in until you sign out or the login expires."
      >
        <div className="pt-1">
          <Button
            type="button"
            variant="form"
            disabled={signOut.isPending}
            onClick={() => {
              signOut.mutate();
            }}
          >
            Sign out
          </Button>
        </div>
      </FormCard>
    </div>
  );
}

/**
 * Renders the card that picks the user's default GitHub account: the
 * Connection a thread or an assistant's session acts through when its
 * workspace designates no Connection. The choice saves as soon as it is
 * picked, with its own save status, so it never mixes with the timezone
 * form's Save.
 */
function DefaultGitHubAccount(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  // A GitHub Connection added, renamed or removed elsewhere shows in the
  // select without a reload.
  useLiveInvalidation(live, queryClient, "connection");
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const connections = useQuery(connectionsQuery(client));
  const githubs =
    connections.data === undefined ? null : filterGitHubConnections(connections.data.items);
  const { save, saved, failure } = useSaveSettings(client);
  const stored = settings.user["github.defaultConnectionId"] ?? null;

  return (
    <FormCard
      label="GitHub"
      fine="A thread working in a checkout acts through that repo's own Connection. Every other thread, and every assistant, acts through this account."
    >
      <Row label="Default GitHub account" htmlFor="github-default">
        <Select
          id="github-default"
          value={stored ?? ""}
          onChange={(event) => {
            // The setting is nullable, so "None" clears it rather than storing
            // an empty string, which the contract's `Id` rejects.
            const picked = event.target.value;
            save({ user: { "github.defaultConnectionId": picked === "" ? null : picked } });
          }}
        >
          <option value="">None</option>
          {buildIdOptions(
            githubs?.map((connection) => ({ id: connection.id, label: connection.label })) ?? null,
            stored,
          ).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      </Row>
      <SaveStatus
        saved={false}
        failure={
          connections.error === null
            ? null
            : `Could not load the GitHub accounts: ${readErrorMessage(connections.error)}`
        }
      />
      <SaveStatus saved={saved} failure={failure} />
    </FormCard>
  );
}
