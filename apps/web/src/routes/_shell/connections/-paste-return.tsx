import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, buildButtonClassName, Field, Input } from "@hercule/ui";
import {
  describePasteRefusal,
  describeSignInFailure,
  isWebLink,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import { parseCallbackQuery } from "@hercule/contract";

/**
 * The second half of a redirect flow that returns to the user's machine: the
 * link to the provider's approval page, and the field where the user pastes
 * the address the browser ends on. The page the browser ends on does not load,
 * because nothing listens at that address, and its address holds the one-time
 * code that `connection.finishOAuth` needs.
 *
 * `onDone` is called once the controller finished the sign-in. When it
 * refuses, the component shows why and offers to start again.
 */
export function PasteReturnSignIn({
  client,
  providerName,
  authorizationUrl,
  onRestart,
  onCancel,
  onDone,
}: {
  readonly client: HerculeClient;
  /** The connection type's display name, such as "Slack". */
  readonly providerName: string;
  readonly authorizationUrl: string;
  readonly onRestart: () => void;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const finish = useMutation({
    mutationFn: (callbackQuery: string) =>
      client.connection.finishOAuth({ payload: { callbackQuery } }),
    // The connection exists from this reply on, even when the panel is gone,
    // so the list is fetched again either way.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.connections() }),
  });

  if (finish.isError) {
    const ending = describeSignInFailure(readErrorMessage(finish.error));
    return (
      <>
        <div className="flex max-w-[52ch] flex-col gap-0.5" role="alert">
          <p className="text-row text-fail">{ending.line}</p>
          <p className="text-fine text-muted">{ending.next}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" className="-ml-2" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="form" onClick={onRestart}>
            Start again
          </Button>
        </div>
      </>
    );
  }

  const send = (event: FormEvent): void => {
    event.preventDefault();
    const parsed = parseCallbackQuery(pasted);
    if (parsed._tag === "Refused") {
      setProblem(describePasteRefusal(parsed.reason));
      return;
    }
    setProblem(null);
    // React Query calls a callback passed to `mutate` only while this panel is
    // on screen, so a reply that arrives after Cancel cannot close another form.
    finish.mutate(pasted.trim(), { onSuccess: onDone });
  };

  return (
    <form className="flex max-w-[52ch] flex-col gap-3" onSubmit={send}>
      <p className="text-row text-muted">
        Approve Hercule in {providerName}. The page opens in a new tab.
      </p>
      {/* The address comes from the controller, so it is a link only when it is a web address. */}
      {isWebLink(authorizationUrl) ? (
        <a
          href={authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`${buildButtonClassName("form", undefined)} self-start`}
        >
          Open {providerName}
        </a>
      ) : null}
      <p className="text-row text-muted">
        After you approve, your browser shows a page that does not load. Copy its address and paste
        it here.
      </p>
      <Field id="oauth-return-address" label="Address" error={problem ?? undefined}>
        <Input
          id="oauth-return-address"
          spellCheck={false}
          autoComplete="off"
          placeholder="http://127.0.0.1:…/callback?code=…"
          value={pasted}
          onChange={(event) => {
            setPasted(event.target.value);
            setProblem(null);
          }}
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button type="button" className="-ml-2" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="form" disabled={finish.isPending || pasted.trim() === ""}>
          Finish
        </Button>
      </div>
    </form>
  );
}
