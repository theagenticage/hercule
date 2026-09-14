import { useId, useState, type JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Drawer, Field, Input, type ButtonVariant } from "@hydra/ui";
import type { HydraClient } from "@hydra/client-core";
import { messageOf } from "./save-status";

/**
 * A screen rather than a part of one, because Sessions and the runner page both
 * offer this exact action.
 *
 * The URL is shown rather than opened: the machine running the harness may have
 * no browser, and this one is often not it. A refused code leaves the exchange
 * standing, so the panel stays open for another paste.
 *
 * Two flows end up here. A vendor that reads a code back asks the user to paste
 * one. A vendor that printed a one-time code reads nothing at all: the user
 * types that code into their browser and the browser finishes the exchange with
 * the vendor, so the panel only shows what to do and is dismissed when it is
 * done - there is nothing for Hydra to relay and nothing to wait for.
 */
export function ProviderLogin({
  client,
  instanceId,
  runnerId,
  subject,
  label,
  variant = "quiet",
  className,
  onLoggedIn,
}: {
  readonly className?: string;
  readonly client: HydraClient;
  readonly instanceId: string;
  /** The machine the credential lands on, and the only one it works on. */
  readonly runnerId: string;
  /** What is being logged in and where, as a name: "Claude Code on moss". */
  readonly subject: string;
  readonly label: string;
  readonly variant?: ButtonVariant;
  readonly onLoggedIn: () => void;
}): JSX.Element {
  const codeField = useId();
  const [code, setCode] = useState("");

  const start = useMutation({
    mutationFn: () => client.provider.login({ params: { id: instanceId }, payload: { runnerId } }),
  });
  const submit = useMutation({
    mutationFn: () =>
      client.provider.submitLoginCode({
        params: { id: instanceId },
        // A pasted code often carries a stray space or newline, which the
        // vendor reads as a different code.
        payload: { runnerId, code: code.trim() },
      }),
    onSuccess: () => {
      close();
      onLoggedIn();
    },
  });

  /** The started login is the whole of this panel's state, so dropping it closes. */
  const close = (): void => {
    setCode("");
    submit.reset();
    start.reset();
  };

  /** Nothing was relayed, so all that is left is to stop showing the code. */
  const done = (): void => {
    close();
    onLoggedIn();
  };

  const url = start.data?.url;
  const userCode = start.data?.userCode;

  return (
    <>
      <Button
        variant={variant}
        className={className}
        // A second login would kill the child the first one is showing a code
        // for, so the one on screen is the only one.
        disabled={start.isPending || url !== undefined}
        onClick={() => {
          start.mutate();
        }}
      >
        {label}
      </Button>
      {start.error === null ? null : (
        // Full width, so the error does not read as a fourth action in the row.
        <p className="w-full pl-2 text-fine text-fail" role="alert">
          {messageOf(start.error)}
        </p>
      )}

      <Drawer open={url !== undefined} onClose={close} title={`Log in to ${subject}`}>
        <div className="flex flex-col gap-3.5">
          <p className="text-row text-muted">
            {userCode === undefined
              ? "Open this address in any browser, sign in, and paste the code it gives you back here."
              : "Open this address in any browser, sign in, and enter this one-time code there. Nothing is typed back here."}
          </p>
          <div className="flex flex-col items-start gap-1.5">
            {/* The site is the one part of a long opaque URL a reader can
                check, and naming it is what tells them to. */}
            <p className="text-row text-muted">
              You will sign in at <b className="font-emph text-ink">{siteOf(url)}</b>.
            </p>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="max-w-full break-all font-mono text-fine text-live hover:underline"
            >
              {url}
            </a>
            <Button
              className="-ml-2"
              onClick={() => {
                // `clipboard` is absent over plain HTTP off localhost; the
                // address is on screen anyway.
                void navigator.clipboard?.writeText(url ?? "");
              }}
            >
              Copy address
            </Button>
          </div>

          {userCode === undefined ? (
            <>
              <Field id={codeField} label="Code">
                <Input
                  id={codeField}
                  value={code}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setCode(event.target.value);
                  }}
                />
              </Field>

              <div className="-ml-2 flex flex-wrap items-center gap-1.5">
                <Button
                  variant="primary"
                  disabled={code.trim() === "" || submit.isPending}
                  onClick={() => {
                    submit.mutate();
                  }}
                >
                  Submit
                </Button>
                <Button onClick={close}>Cancel</Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col items-start gap-1.5">
                <p className="font-mono text-title tracking-widest text-ink">{userCode}</p>
                <Button
                  className="-ml-2"
                  onClick={() => {
                    void navigator.clipboard?.writeText(userCode);
                  }}
                >
                  Copy code
                </Button>
              </div>
              <p className="text-fine text-muted">
                If the code will not do, reach the machine itself: forward its login port with{" "}
                <code className="font-mono text-ink">ssh -L 1455:localhost:1455</code> and run{" "}
                <code className="font-mono text-ink">codex login</code> over that connection, or
                copy an authorized <code className="font-mono text-ink">auth.json</code> into the
                instance&apos;s <code className="font-mono text-ink">$CODEX_HOME</code>.
              </p>
              <div className="-ml-2">
                <Button variant="primary" onClick={done}>
                  Done
                </Button>
              </div>
            </>
          )}
          {submit.error === null ? null : (
            <p className="text-fine text-fail" role="alert">
              {messageOf(submit.error)}
            </p>
          )}
        </div>
      </Drawer>
    </>
  );
}

const siteOf = (url: string | undefined): string => {
  try {
    return new URL(url ?? "").host;
  } catch {
    return "an address this browser cannot read";
  }
};
