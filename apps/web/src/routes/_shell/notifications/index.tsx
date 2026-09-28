import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useSuspenseQuery } from "@tanstack/react-query";
import {
  formatTimeContext,
  isNotificationMuted,
  parseSincePin,
  resolveDisplayTimezone,
  splitBySince,
  toggleMuteKey,
} from "@hercule/client-core";
import type { MuteKey, Notification } from "@hercule/contract";
import { Button, EmptyState, cn, useMinuteClock } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { notificationsQuery, settingsQuery } from "../../../app/queries";
import { useSinceMarker } from "../../../app/since-marker";
import { NotificationRow } from "../../../screens/notifications/notification-row";
import { readErrorMessage } from "../../../screens/save-status";
import { NoNotifications } from "./-no-notifications";

export const Route = createFileRoute("/_shell/notifications/")({
  staticData: { title: "Notifications", sinceMarker: "lastChecked.notifications" },
  // `since` pins the previous "last checked" instant for the whole visit, so
  // a refresh keeps the same notifications new (see `useSinceMarker`).
  validateSearch: (search: Record<string, unknown>): { readonly since?: string } => {
    const since = parseSincePin(search["since"]);
    return since === undefined ? {} : { since };
  },
  // Loads the first page before the screen shows, so it never renders empty
  // and then fills in. The shell has already read the settings.
  loader: ({ context }) =>
    context.queryClient.ensureInfiniteQueryData(notificationsQuery(context.client)),
  component: Notifications,
});

/**
 * Renders every notification, newest first, paging with Load more. The ones
 * created since the user last opened this screen sit above a "new" divider,
 * and the older ones recede below it. The list follows the `notification`
 * topic, so a new notification or a resolution shows without a reload.
 */
function Notifications(): JSX.Element | null {
  const { client, queryClient, live } = Route.useRouteContext();
  const navigate = Route.useNavigate();

  useLiveInvalidation(live, queryClient, "notification");

  const { since, advanceError } = useSinceMarker({
    client,
    queryClient,
    marker: "lastChecked.notifications",
    pin: Route.useSearch().since,
    pinInUrl: (pin) => navigate({ search: { since: pin }, replace: true }),
  });
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const setMuted = useMutation({
    mutationFn: (muted: MuteKey[]) =>
      client.settings.update({ payload: { user: { "notifications.muted": muted } } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(settingsQuery(client).queryKey, updated);
    },
  });
  const muted = setMuted.isPending
    ? setMuted.variables
    : (settings.user["notifications.muted"] ?? []);
  const listing = useInfiniteQuery(notificationsQuery(client));
  const now = useMinuteClock();

  if (listing.isError) {
    return (
      <EmptyState headline="The notifications could not be read." lead={listing.error.message} />
    );
  }
  if (listing.isPending) return null;

  const notifications = listing.data.pages.flatMap((page) => page.items);
  if (notifications.length === 0) return <NoNotifications />;

  const { fresh, seen } = splitBySince(notifications, since);
  const renderList = (items: ReadonlyArray<Notification>, receded: boolean): JSX.Element => (
    <ul
      className={cn(
        "rounded-card border border-line-soft bg-surface px-1.5 py-1",
        receded && "opacity-82",
      )}
    >
      {items.map((notification) => (
        <NotificationRow
          key={notification.id}
          notification={notification}
          now={now}
          muted={isNotificationMuted(notification, muted)}
          isMuting={setMuted.isPending}
          onToggleMute={() => {
            if (notification.muteKey !== undefined) {
              setMuted.mutate(toggleMuteKey(muted, notification.muteKey));
            }
          }}
        />
      ))}
    </ul>
  );
  const lastCheckedLabel =
    since === undefined
      ? undefined
      : formatTimeContext(new Date(since), resolveDisplayTimezone(settings.user.timezone));

  return (
    <div className="flex max-w-[940px] flex-col gap-3">
      {advanceError === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {`This visit could not be recorded, so the same notifications will show as new next time: ${advanceError.message}`}
        </p>
      )}
      {setMuted.error === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {`The mute list could not be saved: ${readErrorMessage(setMuted.error)}`}
        </p>
      )}
      {fresh.length === 0 ? null : renderList(fresh, false)}
      {fresh.length === 0 || seen.length === 0 ? null : (
        // The hairlines on both sides are drawn by the pseudo-elements.
        <div className="flex items-center gap-2.5 font-mono text-[11px] text-faint before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
          {lastCheckedLabel === undefined
            ? "new above"
            : `new above · last checked ${lastCheckedLabel}`}
        </div>
      )}
      {seen.length === 0 ? null : renderList(seen, fresh.length > 0)}
      {listing.hasNextPage ? (
        <Button
          className="self-start"
          disabled={listing.isFetchingNextPage}
          onClick={() => void listing.fetchNextPage()}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}
