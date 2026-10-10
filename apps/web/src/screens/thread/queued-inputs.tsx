import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  canSteerOrCancelQueuedInputs,
  queryKeys,
  type HerculeClient,
  readErrorMessage,
  readInputSender,
} from "@hercule/client-core";
import type { Input } from "@hercule/contract";
import { Button, useBlobImageSource, type LightboxImage } from "@hercule/ui";
import { inputsQuery, sessionQuery } from "../../app/queries";
import { SenderName } from "../actor-link";
import { useAttachmentImages } from "../use-attachment-images";
import { useSenderReading } from "./use-sender-reading";

/**
 * The list of queued messages above the composer, each with Steer and Cancel,
 * and with small thumbnails of its images before its text. A message another
 * session's agent queued starts with "From" and its sender, so it never looks
 * like one the owner queued; the owner can steer or cancel it all the same.
 * The query returns the session's whole input history; this component shows
 * only the inputs still `queued`, because sent, delivered or cancelled ones
 * can no longer be acted on.
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
  const queued = rows.filter((row) => row.status === "queued");

  const reread = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sessionId) });

  if (queued.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {queued.map((row) => (
        <QueuedRow
          key={row.id}
          client={client}
          sessionId={sessionId}
          row={row}
          actionable={canSteerOrCancelQueuedInputs(session)}
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
  actionable,
  onDone,
}: {
  readonly client: HerculeClient;
  readonly sessionId: string;
  readonly row: Input;
  /** Whether the row offers Steer and Cancel. */
  readonly actionable: boolean;
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
        {actionable ? (
          <>
            <Button disabled={steer.isPending || cancel.isPending} onClick={() => steer.mutate()}>
              Steer
            </Button>
            <Button disabled={steer.isPending || cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel
            </Button>
          </>
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
 * Shows "From" and the sender of a message another session's agent queued.
 * Every row from one sender shares one cached read, so a long queue reads
 * each sender once. While the sender is still being read, it shows nothing
 * rather than a name that may be wrong.
 */
function QueuedSender({
  senderSessionId,
}: {
  readonly senderSessionId: string;
}): JSX.Element | null {
  const sender = useSenderReading(senderSessionId);
  if (sender === undefined) return null;
  return (
    <span className="max-w-[40%] shrink-0 truncate text-row text-muted">
      From <SenderName sender={sender} plainClassName="text-muted" />
    </span>
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
