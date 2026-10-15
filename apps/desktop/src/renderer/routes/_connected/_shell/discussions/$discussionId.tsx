import { useId, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { isNotFound, readActorSessionId, resolveDisplayTimezone } from "@hercule/client-core";
import { throwScreenNotFound } from "../../../../app/last-screen";
import { discussionQuery, readSenders, settingsQuery } from "../../../../app/queries";
import { DiscussionLead } from "../../../../screens/discussions/open-discussion";
import { Posts } from "../../../../screens/discussions/posts";
import { SharedFiles } from "../../../../screens/discussions/shared-files";
import { readFullSearch } from "../../../../screens/list-pane/list-with-open-pane";
import { NotFound } from "../../../../screens/not-found";

/**
 * The search params of an open Discussion (spec 19 section 8.2): `full`
 * makes the open Discussion fill the pane, and hides the list.
 */
interface DiscussionSearch {
  readonly full?: true | undefined;
}

/**
 * Returns an open Discussion's search params from the URL's. A `full` that is
 * not `true` is dropped, so the page shows its default.
 *
 * A dropped param is returned as `undefined` rather than left out, because
 * the router lays the returned params over the URL's: a param left out would
 * keep the URL's value.
 */
const validateDiscussionSearch = (search: Record<string, unknown>): DiscussionSearch => ({
  full: readFullSearch(search),
});

/**
 * An open Discussion (spec 19 section 8.2). A row of the Discussion list
 * links here, and its row is selected while the Discussion is open.
 *
 * Its loader reads the Discussion with its Posts, then the sessions of the
 * agents that wrote a Post or edited a shared file, so their faces and names
 * are drawn at the first paint. When no Discussion has the id, the route shows
 * `DiscussionNotFound`. The settings are read by the Discussions layout and
 * are cached already.
 *
 * Opening another Discussion runs the loader again, and it reads only what
 * is not cached.
 */
export const Route = createFileRoute("/_connected/_shell/discussions/$discussionId")({
  staticData: { title: "Discussions" },
  validateSearch: validateDiscussionSearch,
  loader: async ({ context: { controller, queryClient }, params: { discussionId }, location }) => {
    const { client } = controller;
    try {
      const { discussion, posts } = await queryClient.ensureQueryData(
        discussionQuery(client, discussionId),
      );
      const senderSessionIds = new Set([
        ...discussion.sharedFiles.flatMap((file) => file.sessionIds),
        ...posts.flatMap((post) => readActorSessionId(post.actor) ?? []),
      ]);
      await readSenders(queryClient, client, [...senderSessionIds]);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      throwScreenNotFound(location);
    }
  },
  component: OpenDiscussionRoute,
  notFoundComponent: DiscussionNotFound,
});

/** Renders the screen of a Discussion that does not exist, with a link back to the list. */
function DiscussionNotFound(): JSX.Element {
  return (
    <NotFound headline="This discussion was not found.">
      <Link to="/discussions" className="btn btn--accent">
        Discussions
      </Link>
    </NotFound>
  );
}

/**
 * Draws the open Discussion afresh for each Discussion, so its pane starts at
 * the top instead of keeping the scroll position of the one opened before. A
 * push for the Discussion, or widening it to fill the pane, keeps the pane
 * and its position.
 */
function OpenDiscussionRoute(): JSX.Element {
  const { discussionId } = Route.useParams();
  return <OpenDiscussion key={discussionId} discussionId={discussionId} />;
}

/**
 * Reads the Discussion `discussionId` and draws it: the lead, the shared
 * files, and the Posts. The Discussion is a section named by its subject.
 */
function OpenDiscussion({ discussionId }: { readonly discussionId: string }): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { client } = controller;
  const headingId = useId();
  const { data } = useSuspenseQuery(discussionQuery(client, discussionId));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const { discussion, posts } = data;

  return (
    <section className="open-pane" aria-labelledby={headingId}>
      <div className="pill-room" />
      <DiscussionLead headingId={headingId} discussion={discussion} />
      <SharedFiles files={discussion.sharedFiles} timezone={timezone} />
      <Posts posts={posts} timezone={timezone} />
    </section>
  );
}
