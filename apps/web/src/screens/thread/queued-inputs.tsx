import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  canSteerOrCancelQueuedInputs,
  canSteerQueuedInputs,
  queryKeys,
  type HerculeClient,
  readErrorMessage,
  readInputSender,
  splitQueuedInputs,
} from "@hercule/client-core";
import type { Input } from "@hercule/contract";
import { Button, useBlobImageSource, type LightboxImage } from "@hercule/ui";
import { inputsQuery, sessionQuery } from "../../app/queries";
import { ActorLink } from "../actor-link";
import { useAttachmentImages } from "../use-attachment-images";
import { useSenderReading } from "./use-sender-reading";

/**
 * The list of waiting messages above the composer, each with Cancel, and
 * with Steer while a turn runs (`canSteerQueuedInputs`), and with small
 * thumbnails of its images before its text. A message another session's
 * agent queued starts with "From" and its sender, set apart from the message
 * by a "·", so it never looks like one the owner queued; the owner can steer
 * or cancel it all the same.
 * The query returns the session's whole input history; this component shows
 * only the queued inputs that wait (`splitQueuedInputs`). One on its way into
 * the session shows under the transcript instead (`SendingMessages`), and
 * sent, delivered or cancelled ones can no longer be acted on.
 *
 * On a session that answers an assistant's conversation, the rows have no
 * Steer and no Cancel: each queued input is a message the conversation
 * already shows as the owner's, and the controller refuses to change it.
 */
export function QueuedInputs({
  client,
  sessionId,
}: {
  readonly client: HerculeClient;
  readonly sessionId: string;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const rows = useQuery(inputsQuery(client, sessionId)).data?.items ?? [];
  const { waiting } = splitQueuedInputs(session, rows);

  const reread = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sessionId) });

  if (waiting.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {waiting.map((row) => (
        <QueuedRow
          key={row.id}
          client={client}
          sessionId={sessionId}
          row={row}
          offersSteer={canSteerQueuedInputs(session)}
          offersCancel={canSteerOrCancelQueuedInputs(session)}
          onDone={reread}
        />
      ))}
    </div>
  );
}

function QueuedRow({
  client,
  sessionId,
  row,
  offersSteer,
  offersCancel,
  onDone,
}: {
  readonly client: HerculeClient;
  readonly sessionId: string;
  readonly row: Input;
  /** Whether the row offers Steer. */
  readonly offersSteer: boolean;
  /** Whether the row offers Cancel. */
  readonly offersCancel: boolean;
  readonly onDone: () => Promise<void>;
}): JSX.Element {
  const steer = useMutation({
    mutationFn: () => client.input.steer({ params: { id: sessionId, inputId: row.id } }),
    onSuccess: onDone,
  });
  const cancel = useMutation({
    mutationFn: () => client.input.cancel({ params: { id: sessionId, inputId: row.id } }),
    onSuccess: onDone,
  });
  const failure = steer.error ?? cancel.error;
  const { images, observe } = useAttachmentImages(row.attachments);
  const senderSessionId = readInputSender(row);

  return (
    <div className="flex flex-col gap-1 rounded-control border border-line-soft bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        {senderSessionId === undefined ? null : <QueuedSender senderSessionId={senderSessionId} />}
        {images.length === 0 ? null : (
          <span
            ref={observe}
            className="flex shrink-0 gap-1"
            aria-label={`${String(images.length)} ${images.length === 1 ? "image" : "images"}`}
          >
            {images.map((image) => (
              <QueuedThumbnail key={image.key} image={image} />
            ))}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-row text-ink">{row.text}</span>
        {offersSteer ? (
          <Button disabled={steer.isPending || cancel.isPending} onClick={() => steer.mutate()}>
            Steer
          </Button>
        ) : null}
        {offersCancel ? (
          <Button disabled={steer.isPending || cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        ) : null}
      </div>
      {row.reason === null ? null : <p className="text-fine text-faint">{row.reason}</p>}
      {failure === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {readErrorMessage(failure)}
        </p>
      )}
    </div>
  );
}

/**
 * Shows "From", the sender of a message another session's agent queued, and
 * a "·" that parts the sender from the message, so the name never reads as
 * the message's first words. A long name is cut with an ellipsis and shows
 * whole as a tooltip. Every row from one sender shares one cached read, so a
 * long queue reads each sender once.
 *
 * While the sender is still being read, a faint "…" holds the name's place,
 * rather than a name that may be wrong. "From" shows from the first paint,
 * so the row never looks like one the owner queued, and the row keeps its
 * height when the name arrives.
 */
function QueuedSender({ senderSessionId }: { readonly senderSessionId: string }): JSX.Element {
  const sender = useSenderReading(senderSessionId);
  return (
    <>
      <span className="flex min-w-0 max-w-[40%] shrink-0 gap-1 text-row text-muted">
        {/* The space keeps "From" apart from the name in the text a screen
            reader reads; on screen, the gap does that. */}
        <span className="shrink-0">{"From "}</span>
        {sender === "loading" ? (
          <span className="text-faint">…</span>
        ) : (
          <ActorLink actor={sender} plainClassName="text-muted" truncates />
        )}
      </span>
      <span aria-hidden="true" className="shrink-0 text-row text-faint">
        {" · "}
      </span>
    </>
  );
}

/** Shows one image of a queued message at 24px; the name is its tooltip. */
function QueuedThumbnail({ image }: { readonly image: LightboxImage }): JSX.Element {
  const source = useBlobImageSource(image.blob);
  return (
    <img
      ref={source}
      alt={image.name}
      title={image.name}
      decoding="async"
      className="size-6 rounded-control border border-line bg-raised object-cover"
    />
  );
}
