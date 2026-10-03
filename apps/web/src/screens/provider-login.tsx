import { useEffect, useEffectEvent, useId, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Field, Input, type ButtonVariant } from "@hercule/ui";
import {
  computeNextMinuteTick,
  countMinutesLeft,
  decideDeviceLoginStep,
  describeDeviceLoginWait,
  isWebLink,
  queryKeys,
  startProviderLogin,
  type DeviceLogin,
  type HerculeClient,
  type Live,
  type SecretFieldOffer,
  readErrorMessage,
} from "@hercule/client-core";
import { useLiveInvalidation } from "../app/live-invalidation";
import { providersQuery } from "../app/queries";
import { DeviceCode } from "./device-code";

/**
 * The Log in button for a provider, with the drawer that walks the user
 * through the vendor's browser login. It lives in `screens/` because
 * Sessions and the runner page both offer this exact action.
 *
 * The login URL is shown rather than opened: the machine running the harness
 * may have no browser, and it is often not the machine the user is on. If a
 * pasted code is rejected, the login is still in progress, so the drawer stays
 * open for another try.
 *
 * There are two flows:
 *
 * - Paste-back: the vendor gives the user a code in the browser, and the user
 *   pastes it here.
 * - One-time code: the vendor printed a code, the user enters it in the
 *   browser, and the browser completes the login with the vendor. Hercule has
 *   nothing to send. When the vendor's login ends, the controller probes the
 *   instance again and announces the new snapshot, and the drawer closes by
 *   itself once that snapshot shows the harness logged in. When the user
 *   logs in again, the harness was logged in before the login started, so no
 *   snapshot shows that the login ended: the drawer stays open until the
 *   user closes it.
 */
export function ProviderLogin({
  client,
  live,
  instanceId,
  runnerId,
  subject,
  label,
  variant = "quiet",
  className,
  onLoggedIn,
}: {
  readonly className?: string;
  readonly client: HerculeClient;
  /** Delivers the instance's new snapshots, which end a device login. */
  readonly live: Live;
  readonly instanceId: string;
  /** The machine the credential is stored on, and the only one it works on. */
  readonly runnerId: string;
  /** What is being logged in and on which machine, such as "Claude Code on moss". */
  readonly subject: string;
  readonly label: string;
  readonly variant?: ButtonVariant;
  readonly onLoggedIn: () => void;
}): JSX.Element {
  const codeField = useId();
  const [code, setCode] = useState("");

  const start = useMutation({
    mutationFn: () => startProviderLogin(client, instanceId, runnerId),
  });
  const submit = useMutation({
    mutationFn: () =>
      client.provider.submitLoginCode({
        params: { id: instanceId },
        // A pasted code often has a stray space or newline, and the vendor
        // would treat it as a different code.
        payload: { runnerId, code: code.trim() },
      }),
    onSuccess: () => {
      close();
      onLoggedIn();
    },
  });

  /** Closes the drawer by clearing the started login, which is what keeps the drawer open. */
  const close = (): void => {
    setCode("");
    submit.reset();
    start.reset();
  };

  /**
   * Finishes a device login once a fresh snapshot shows the harness
   * logged in: closes the drawer and notifies the caller.
   */
  const finishLogin = (): void => {
    close();
    onLoggedIn();
  };

  const url = start.data?.url;
  const deviceLogin = start.data?.deviceLogin ?? null;

  return (
    <>
      <Button
        variant={variant}
        className={className}
        // Starting a second login would kill the process of the first one,
        // whose code is on screen, so only one login can run at a time.
        disabled={start.isPending || url !== undefined}
        onClick={() => {
          start.mutate();
        }}
      >
        {label}
      </Button>
      {start.error === null ? null : (
        // Full width, so the error does not look like another action in the row.
        <p className="w-full pl-2 text-fine text-fail" role="alert">
          {readErrorMessage(start.error)}
        </p>
      )}

      <Drawer open={url !== undefined} onClose={close} title={`Log in to ${subject}`}>
        <div className="flex flex-col gap-3.5">
          <p className="text-row text-muted">
            {deviceLogin === null
              ? "Open this address in any browser, sign in, and paste the code it gives you back here."
              : "Open this address in any browser, sign in, and enter this one-time code there. Nothing is typed back here."}
          </p>
          <div className="flex flex-col items-start gap-1.5">
            {/* The host is the only part of a long, opaque URL the user can
                check, so it is named here to prompt them to check it. */}
            <p className="text-row text-muted">
              You will sign in at <b className="font-emph text-ink">{parseSiteHost(url)}</b>.
            </p>
            {/* The address comes from the vendor's login tool on the runner,
                so it is a link only when it is a web address. Any other
                text, such as a `data:` address, is shown to copy. */}
            {url !== undefined && isWebLink(url) ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="max-w-full break-all font-mono text-fine text-live hover:underline"
              >
                {url}
              </a>
            ) : (
              <p className="max-w-full break-all font-mono text-fine text-ink">{url}</p>
            )}
            <Button
              className="-ml-2"
              onClick={() => {
                // `clipboard` is undefined over plain HTTP except on
                // localhost. The address is on screen anyway.
                void navigator.clipboard?.writeText(url ?? "");
              }}
            >
              Copy address
            </Button>
          </div>

          {deviceLogin === null ? (
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
                <Button onClick={close}>Cancel</Button>
                <Button
                  variant="primary"
                  disabled={code.trim() === "" || submit.isPending}
                  onClick={() => {
                    submit.mutate();
                  }}
                >
                  Submit
                </Button>
              </div>
            </>
          ) : (
            <>
              <DeviceCode code={deviceLogin.userCode} />
              <p className="text-fine text-muted">
                If the code does not work, log in on the machine itself: forward its login port with{" "}
                <code className="font-mono text-ink">ssh -L 1455:localhost:1455</code> and run{" "}
                <code className="font-mono text-ink">codex login</code> over that connection, or
                copy an authorized <code className="font-mono text-ink">auth.json</code> into the
                instance&apos;s <code className="font-mono text-ink">$CODEX_HOME</code>.
              </p>
              <DeviceLoginWait
                client={client}
                live={live}
                login={deviceLogin}
                onDone={finishLogin}
                onRestart={() => {
                  start.mutate();
                }}
              />
            </>
          )}
          {submit.error === null ? null : (
            <p className="text-fine text-fail" role="alert">
              {readErrorMessage(submit.error)}
            </p>
          )}
        </div>
      </Drawer>
    </>
  );
}

/**
 * The end of a device login: waits until a fresh snapshot shows the
 * harness logged in, then calls `onDone` once, or shows that the code
 * expired. A login of a harness that was logged in already never calls
 * `onDone`, and the line asks the user to close the drawer instead. It keeps
 * the instances current through the live connection while it is on screen,
 * because the screen that hosts the login may not.
 */
function DeviceLoginWait({
  client,
  live,
  login,
  onDone,
  onRestart,
}: {
  readonly client: HerculeClient;
  readonly live: Live;
  readonly login: DeviceLogin;
  readonly onDone: () => void;
  readonly onRestart: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  useLiveInvalidation(live, queryClient, "provider");
  const instances = useQuery(providersQuery(client)).data ?? [];
  const [now, setNow] = useState(() => Date.now());
  const minutesLeft = login.expiresAt === undefined ? null : countMinutesLeft(login.expiresAt, now);
  const step = decideDeviceLoginStep(login, instances, minutesLeft);

  // Draws the line again each time the code loses a minute.
  useEffect(() => {
    if (login.expiresAt === undefined) return;
    const tick = computeNextMinuteTick(login.expiresAt, now);
    if (tick === null) return;
    const timer = setTimeout(() => {
      setNow(Date.now());
    }, tick - now);
    return () => {
      clearTimeout(timer);
    };
  }, [login.expiresAt, now]);

  const finish = useEffectEvent(onDone);
  useEffect(() => {
    if (step.kind === "done") finish();
  }, [step.kind]);

  if (step.kind === "expired") {
    return (
      <>
        <p className="text-row text-fail" role="alert">
          The code expired before the login finished.
        </p>
        <div className="-ml-2">
          <Button variant="primary" onClick={onRestart}>
            Start again
          </Button>
        </div>
      </>
    );
  }

  return (
    <p className="text-row text-muted" role="status">
      {step.kind === "done"
        ? "Logged in."
        : `${describeDeviceLoginWait(step)} ${step.endsByItself ? "This closes by itself once you have." : "Close this once you have."}`}
    </p>
  );
}

const parseSiteHost = (url: string | undefined): string => {
  try {
    return new URL(url ?? "").host;
  } catch {
    return "an address this browser cannot read";
  }
};

/**
 * The other way to log in: for a provider whose credential is typed in,
 * such as an API key, rather than obtained through a vendor's browser login.
 * The plugin defines the field: its title is the drawer's title and the
 * input's label, and its description explains where to get the credential. So
 * this component does not know which provider it serves.
 *
 * The value is stored as a secret owned by the provider instance and is never
 * read back: the drawer can replace the stored value, never show it. The
 * caller is notified after saving, because the screen keeps showing the
 * credential as missing until the machine has been asked about it again.
 */
export function ProviderKeyEntry({
  client,
  instanceId,
  field,
  variant = "quiet",
  className,
  onSaved,
}: {
  readonly className?: string;
  readonly client: HerculeClient;
  readonly instanceId: string;
  readonly field: SecretFieldOffer;
  readonly variant?: ButtonVariant;
  readonly onSaved: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const valueField = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  /** Clears the typed value and closes the drawer. */
  const close = (): void => {
    setValue("");
    save.reset();
    setOpen(false);
  };

  const save = useMutation({
    mutationFn: () =>
      client.secret.set({
        params: { ownerKind: "provider-instance", ownerId: instanceId, name: field.name },
        // A pasted credential often has a stray space or newline, and the
        // vendor would treat it as a different credential.
        payload: { value: value.trim() },
      }),
    onSuccess: () => {
      close();
      // Refresh the providers before notifying the caller: the value is stored,
      // so the row should show it even if the machine cannot be reached.
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers() });
      onSaved();
    },
  });

  return (
    <>
      <Button
        variant={variant}
        className={className}
        onClick={() => {
          setOpen(true);
        }}
      >
        {field.label}
      </Button>

      <Drawer open={open} onClose={close} title={field.title}>
        <div className="flex flex-col gap-3.5">
          <p className="text-row text-muted">{field.description}</p>
          <Field id={valueField} label={field.title}>
            <Input
              id={valueField}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          </Field>
          <div className="-ml-2 flex flex-wrap items-center gap-1.5">
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              // An empty value is blocked here, without a round trip to the server.
              disabled={value.trim() === "" || save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              Save
            </Button>
          </div>
          {save.error === null ? null : (
            <p className="text-fine text-fail" role="alert">
              {readErrorMessage(save.error)}
            </p>
          )}
        </div>
      </Drawer>
    </>
  );
}
