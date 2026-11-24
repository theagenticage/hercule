import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, buildButtonClassName, Field, Input } from "@hercule/ui";
import {
  describeSignInFailure,
  isWebLink,
  queryKeys,
  readFinishFailure,
  readPastedReturn,
  type HerculeClient,
} from "@hercule/client-core";

/**
 * The second half of a redirect flow that returns to the user's machine: the
 * link to the provider's approval page, and the field where the user pastes
 * the address the browser ends on. The page the browser ends on does not load,
 * because nothing listens at that address, and its address holds the one-time
 * code that `connection.finishOAuth` needs.
 *
 * The address must belong to this sign-in (`readPastedReturn` compares its
 * `state` with `authorizationUrl`'s), because the controller would complete
 * the sign-in the address belongs to and this form would show a success it
 * did not make. The pasted address leaves the field when it is sent, and the
 * request is no mutation, so the code is kept nowhere but in the request.
 *
 * `onDone` is called once the controller finished the sign-in, and only while
 * this panel is on screen. When the controller refuses, the panel shows why
 * and focuses "Start again".
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
  const [finishing, setFinishing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The panel may be gone when the controller answers, and then it must close nothing.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);

  if (refusal !== null) {
    const ending = describeSignInFailure(refusal);
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
          <Button type="button" variant="form" onClick={onRestart} autoFocus>
            Start again
          </Button>
        </div>
      </>
    );
  }

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (finishing) return;
    const reading = readPastedReturn(authorizationUrl, pasted);
    if (reading.kind === "refused") {
      setProblem(reading.message);
      return;
    }
    setProblem(null);
    setPasted("");
    setFinishing(true);
    // Kept in this request only, and put back in the field when the controller
    // could not be reached, so the user can press Finish again.
    const address = pasted;
    client.connection.finishOAuth({ payload: { callbackQuery: reading.callbackQuery } }).then(
      () => {
        // The connection exists from this reply on, even when the panel is gone.
        void queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
        if (shown.current) onDone();
      },
      (error: unknown) => {
        if (!shown.current) return;
        setFinishing(false);
        const failure = readFinishFailure(error);
        if (failure.kind === "retry") {
          setPasted(address);
          setProblem(failure.message);
        } else {
          setRefusal(failure.message);
        }
      },
    );
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
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="http://127.0.0.1:…/callback?code=…"
          value={pasted}
          readOnly={finishing}
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
        <Button type="submit" variant="form" disabled={finishing || pasted.trim() === ""}>
          Finish
        </Button>
      </div>
    </form>
  );
}
