import type { JSX } from "react";
import {
  chooseNotificationMark,
  describeProducer,
  describeResolution,
  formatAge,
  parseMuteKind,
  type NotificationMark,
} from "@hercule/client-core";
import type { Notification } from "@hercule/contract";
import { Button, CancelledMark, DecisionMark, DoneMark, FailedMark, cn } from "@hercule/ui";
import { Markdown } from "../markdown";

/** Renders the mark for a notification's row, or nothing for an informational one. */
function NotificationMarkGlyph({ mark }: { readonly mark: NotificationMark }): JSX.Element | null {
  switch (mark) {
    case "decision":
      return <DecisionMark />;
    case "failed":
      return <FailedMark />;
    case "done":
      return <DoneMark />;
    case "withdrawn":
      return <CancelledMark />;
    case "none":
      return null;
  }
}

/**
 * Renders one notification in the notification center: its mark, its title,
 * who produced it and, for a resolved decision, how it was resolved, then its
 * body as markdown and its age. A notification whose producer can be muted
 * has a button that mutes or unmutes that producer, and a muted one says so.
 *
 * An open decision lists its answers as a ledger (spec 14 §Answers as a
 * ledger): one full-width row per answer, the label in the left column and
 * the producer's description beside it. The rows are disabled, with the reason
 * below them, because answering from this screen is not built yet. They are
 * shown rather than hidden so the user can see what the decision offers.
 */
export function NotificationRow({
  notification,
  now,
  muted,
  isMuting,
  onToggleMute,
}: {
  readonly notification: Notification;
  /** The time the age counts to. */
  readonly now: Date;
  /** Whether the notification's producer is in the user's mute list. */
  readonly muted: boolean;
  /** Whether a change to the mute list is being saved; the button waits for it. */
  readonly isMuting: boolean;
  readonly onToggleMute: () => void;
}): JSX.Element {
  const facts = [describeProducer(notification.producer)];
  if (notification.resolution !== undefined) {
    facts.push(describeResolution(notification.resolution));
  }

  return (
    <li className="flex items-start gap-3 rounded-control px-2.5 py-2 text-row">
      <span className="flex h-5 w-3 shrink-0 items-center justify-center">
        <NotificationMarkGlyph mark={chooseNotificationMark(notification)} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="leading-5 font-emph text-ink">{notification.title}</p>
        <p className="text-meta text-muted">{facts.join(" · ")}</p>
        {notification.body === undefined ? null : (
          <div className="mt-1.5 text-meta text-muted">
            <Markdown text={notification.body} />
          </div>
        )}
        {notification.status === "open" && notification.actions.length > 0 ? (
          <div className="mt-2">
            {/* Each row extends 8px past this column on both sides, so the
                label stays on the title's left edge. */}
            <div className="flex flex-col divide-y divide-line-soft">
              {notification.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  disabled
                  className="-mx-2 grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-3 rounded-control px-2 py-[5px] text-left disabled:cursor-not-allowed"
                >
                  <span
                    className={cn(
                      "text-meta font-emph",
                      action.primary === true ? "text-ink" : "text-muted",
                    )}
                  >
                    {action.label}
                  </span>
                  {/* `--muted`, not `--faint`: 12px `--faint` text is too low
                      in contrast to read, as on the permission card. */}
                  <span className="text-fine text-muted">{action.description}</span>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-fine text-muted">Answering from here is not built yet.</p>
          </div>
        ) : null}
      </div>
      {muted ? <span className="shrink-0 text-meta leading-5 text-faint">muted</span> : null}
      {notification.muteKey === undefined ? null : (
        <Button
          // The label sits on the title's 20px line, like the age and the
          // "muted" label; the negative margin keeps the hover box from
          // pushing the row down.
          className="-my-0.5 shrink-0 py-0.5 text-meta leading-5"
          // Muting is about delivery only, which the word alone does not say.
          title={`Muting stops sending this ${parseMuteKind(notification.muteKey)}'s notifications to your chat channels. They still show here.`}
          aria-disabled={isMuting}
          onClick={onToggleMute}
        >
          {`${muted ? "Unmute" : "Mute"} ${parseMuteKind(notification.muteKey)}`}
        </Button>
      )}
      <span className="w-8 shrink-0 text-right font-mono text-fine leading-5 text-faint tabular-nums">
        {formatAge(notification.createdAt, now)}
      </span>
    </li>
  );
}
