import { useId, useState, type JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Drawer, Field, Input, type ButtonVariant } from "@hydra/ui";
import type { HydraClient } from "@hydra/client-core";
import { messageOf } from "./save-status";

/**
 * Logging one provider instance in on one machine, in the vendor's own
 * paste-a-code exchange.
 *
 * The URL is shown rather than opened, because the machine running the harness
 * may have no browser at all - and the browser reading this is very often not
 * on it. A code the vendor refuses leaves the exchange standing, so the panel
 * stays open with the vendor's own words in it and the user pastes again.
 *
 * It lives here rather than beside either screen because Sessions and the
 * runner page both offer this exact action.
 */
export function ProviderLogin({
  client,
  instanceId,
  runnerId,
  subject,
  label,
  variant = "quiet",
  onLoggedIn,
}: {
  readonly client: HydraClient;
  readonly instanceId: string;
  /** The machine the credential lands on, and the only one it works on. */
  readonly runnerId: string;
  /** What is being logged in and where, as a name: "Claude Code on moss". */
  readonly subject: string;
  readonly label: string;
  /** Quiet on a monitoring surface; the ink primary where it is the way on. */
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
        // Trimmed once, here: a code copied out of a browser very often
        // arrives with a space or a newline on it, and the vendor reads that
        // as a different code.
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

  const url = start.data?.url;

  return (
    <>
      <Button
        variant={variant}
        disabled={start.isPending}
        onClick={() => {
          start.mutate();
        }}
      >
        {label}
      </Button>
      {start.error === null ? null : (
        // Full width: this sits among the row's other actions, and beside them
        // it would read as a fourth one.
        <p className="w-full pl-2 text-fine text-fail" role="alert">
          {messageOf(start.error)}
        </p>
      )}

      <Drawer open={url !== undefined} onClose={close} title={`Log in to ${subject}`}>
        <div className="flex flex-col gap-3.5">
          <p className="text-row text-muted">
            Open this address in any browser, sign in, and paste the code it gives you back here.
          </p>
          <div className="flex flex-col items-start gap-1.5">
            {/* Named rather than left to be picked out of the address: the
                site is the one part of a long opaque URL a reader can check,
                and it is worth nothing if they do not know to check it. */}
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
                // Absent over plain HTTP on anything but localhost, which is a
                // way Hydra is really reached; the address is on screen either
                // way, so this is a convenience and never the only route.
                void navigator.clipboard?.writeText(url ?? "");
              }}
            >
              Copy address
            </Button>
          </div>

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

/** Where the address goes, in the form a reader can recognise. */
const siteOf = (url: string | undefined): string => {
  try {
    return new URL(url ?? "").host;
  } catch {
    return "an address this browser cannot read";
  }
};
