/**
 * A Provider Account's row, with the sign-in that runs on the row's runner.
 * The first run's providers step lists one per account, and the draft's Sign
 * in button opens one in a dialog (spec 17, The first run, step 2).
 */
import { useEffect, useEffectEvent, useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  decideDeviceLoginStep,
  describeDeviceLoginWait,
  isLoginCodeRejected,
  isWebLink,
  queryKeys,
  readErrorMessage,
  startProviderLogin,
  type DeviceLogin,
  type HerculeClient,
  type ProviderRow,
  type CredentialFieldOffer,
} from "@hercule/client-core";
import { useMinutesLeft } from "../../app/age-clock";
import { providerAccountsQuery } from "../../app/queries";
import { ExternalIcon } from "../../icons/external";
import { DeviceCodeSteps, DoneMark, FormField, MarkedRow, NumberedStep, WaitLine } from "../step";
import { HarnessLogo } from "../thread/harness-logo";

/**
 * Renders `row`, the account as its runner `runnerId` sees it: the mark of
 * its harness, its name, the harness and where it is on the runner, and the
 * action it offers at the end:
 *
 * - "Signed in" once the account is signed in;
 * - Install, when the runner can install the harness (`runner.installHarness`);
 * - Sign in, which starts the vendor's sign-in on the runner
 *   (`providerAccount.signIn`);
 * - a button per credential field, for an account whose credential is typed
 *   in, such as a Z.ai API key.
 *
 * While a sign-in runs, its steps show under the row and the action is
 * Cancel. Cancel only clears the steps: the sign-in on the runner ends by
 * itself when its code expires.
 *
 * A sign-in takes one of two forms, which the vendor's tool decides:
 *
 * - Paste-back (Claude Code): the vendor's page shows a code, which the user
 *   pastes here. The sign-in ends when the controller accepts the code.
 * - Device code (Codex): the user copies a code here and enters it on the
 *   vendor's page. Nothing comes back through the app. The controller probes
 *   the account when the vendor's sign-in ends and announces the new
 *   snapshot on the `provider` live topic, and the sign-in ends when a fresh
 *   snapshot shows the account signed in. The screen does not poll, so
 *   whoever mounts this row must keep the live connection open.
 *
 * `onSignedIn` is called once when a sign-in started here ends with the
 * account signed in, and when a credential is saved.
 *
 * With `startOnOpen`, the sign-in starts as soon as the row mounts, when the
 * row offers one. The sign-in dialog uses it because the user opened the
 * dialog with a Sign in button already, and a second Sign in would be one
 * click too many.
 *
 * `client` is the client of the controller the runner belongs to. It is
 * passed in because the first run renders the row outside the routes that
 * hold a saved controller.
 */
export function ProviderLogin({
  client,
  row,
  runnerId,
  startOnOpen = false,
  onSignedIn,
}: {
  readonly client: HerculeClient;
  readonly row: ProviderRow;
  readonly runnerId: string;
  readonly startOnOpen?: boolean;
  readonly onSignedIn?: () => void;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [credentialField, setCredentialField] = useState<CredentialFieldOffer | null>(null);

  const start = useMutation({
    mutationFn: () => startProviderLogin(client, row.id, runnerId),
  });
  const submit = useMutation({
    mutationFn: () =>
      client.providerAccount.submitSignInCode({
        params: { id: row.id },
        // A pasted code often has a stray space or newline, and the vendor
        // would treat it as a different code.
        payload: { runnerId, code: code.trim() },
      }),
    // The row stays on its steps until the accounts are read again, so it
    // goes straight to "Signed in" without showing Sign in for a moment.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.providerAccounts() });
      endLogin();
    },
  });
  const install = useMutation({
    mutationFn: () =>
      client.runner.installHarness({
        params: { id: runnerId },
        payload: { harnessId: row.harnessId },
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.runners() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.harnesses() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providerAccounts() }),
      ]),
  });

  /** Clears the steps of a sign-in or a credential field, and any error they showed. */
  const clearLoginSteps = (): void => {
    setCode("");
    setCredentialField(null);
    start.reset();
    submit.reset();
  };
  /** Ends a sign-in that signed the account in. */
  const endLogin = (): void => {
    clearLoginSteps();
    onSignedIn?.();
  };

  // React runs a mount effect twice in development. A second login would
  // stop the first on the runner, so the first run of the effect is marked.
  const startedOnOpenRef = useRef(false);
  useEffect(() => {
    if (!startOnOpen || startedOnOpenRef.current || !row.signIn || row.signedIn) return;
    startedOnOpenRef.current = true;
    start.mutate();
  }, [startOnOpen, row.signIn, row.signedIn, start]);

  const started = start.data;
  const busy = started !== undefined || credentialField !== null;

  return (
    <MarkedRow
      mark={<HarnessLogo harnessId={row.harnessId} size={18} />}
      name={row.name}
      detail={`${row.harnessName} · ${row.location}`}
      detailMono={row.path !== null}
      end={
        busy ? (
          <button type="button" className="btn btn--sm btn--quiet" onClick={clearLoginSteps}>
            Cancel
          </button>
        ) : row.signedIn ? (
          <DoneMark>Signed in</DoneMark>
        ) : row.install === "offered" ? (
          <button
            type="button"
            className="btn btn--sm"
            disabled={install.isPending}
            onClick={() => install.mutate()}
          >
            {install.isPending ? "Installing…" : "Install"}
          </button>
        ) : row.signIn ? (
          <button
            type="button"
            className="btn btn--sm"
            // Starting a second sign-in would stop the first one on the runner.
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {row.signInLabel}
          </button>
        ) : row.credentialFields.length > 0 ? (
          <span className="row">
            {row.credentialFields.map((field) => (
              <button
                key={field.name}
                type="button"
                className="btn btn--sm"
                onClick={() => setCredentialField(field)}
              >
                {field.label}
              </button>
            ))}
          </span>
        ) : null
      }
    >
      {started !== undefined ? (
        started.deviceLogin === null ? (
          <PasteCodeSteps
            url={started.url}
            code={code}
            error={submit.error}
            submitting={submit.isPending}
            onOpen={() => void bridge.link.open({ url: started.url })}
            onCodeChange={setCode}
            onSubmit={() => submit.mutate()}
          />
        ) : (
          <DeviceCodeSteps
            code={started.deviceLogin.userCode}
            openText="Open the sign-in page and enter it."
            openLabel="Open sign-in page"
            onOpen={() => void bridge.link.open({ url: started.url })}
            end={
              <DeviceLoginWait
                client={client}
                login={started.deviceLogin}
                onDone={endLogin}
                onRestart={() => start.mutate()}
              />
            }
          />
        )
      ) : credentialField !== null ? (
        <CredentialFieldEntry
          client={client}
          providerAccountId={row.id}
          field={credentialField}
          onSaved={endLogin}
        />
      ) : start.error !== null ? (
        <span className="fl-err" role="alert">
          {readErrorMessage(start.error)}
        </span>
      ) : install.error !== null ? (
        <span className="fl-err" role="alert">
          {readErrorMessage(install.error)}
        </span>
      ) : null}
    </MarkedRow>
  );
}

/**
 * Renders the two steps of a paste-back login: open the sign-in page, then
 * paste the code it shows. `error` is the last submit's failure, if any. A
 * code the vendor refused marks the field and shows why, in the book's words;
 * any other failure shows its own message.
 *
 * The code field is drawn by hand rather than with `FormField`: the book sets
 * it inside the numbered step, beside its Submit button and with no label of
 * its own, where `FormField` would add a label row above it.
 */
function PasteCodeSteps({
  url,
  code,
  error,
  submitting,
  onOpen,
  onCodeChange,
  onSubmit,
}: {
  readonly url: string;
  readonly code: string;
  readonly error: Error | null;
  readonly submitting: boolean;
  readonly onOpen: () => void;
  readonly onCodeChange: (code: string) => void;
  readonly onSubmit: () => void;
}): JSX.Element {
  const rejected = isLoginCodeRejected(error);
  const canSubmit = code.trim() !== "" && !submitting;
  return (
    <>
      <NumberedStep number={1}>
        Open the sign-in page and approve Hercule.
        <br />
        <SignInPageButton url={url} onOpen={onOpen} />
      </NumberedStep>
      <NumberedStep number={2}>
        Paste the code it shows you.
        <span className="row">
          <span className={rejected ? "field is-bad" : "field"}>
            <input
              className="mono"
              aria-label="Code"
              placeholder="Paste the code"
              value={code}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => onCodeChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSubmit) onSubmit();
              }}
            />
          </span>
          <button
            type="button"
            className="btn btn--sm btn--accent"
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            Submit
          </button>
        </span>
        {error === null ? null : (
          <span className="fl-err" role="alert">
            {rejected
              ? "That code wasn’t accepted. A code works once; open the sign-in page for a new one."
              : readErrorMessage(error)}
          </span>
        )}
      </NumberedStep>
    </>
  );
}

/**
 * Renders the button that opens the vendor's sign-in page at `url` in the
 * default browser. The address comes from the vendor's tool on the runner,
 * and main opens only web addresses, so any other address is shown for the
 * user to open by hand.
 */
function SignInPageButton({
  url,
  onOpen,
}: {
  readonly url: string;
  readonly onOpen: () => void;
}): JSX.Element {
  if (!isWebLink(url)) return <span className="mono">{url}</span>;
  return (
    <button type="button" className="btn btn--sm" onClick={onOpen}>
      <ExternalIcon size={14} />
      Open sign-in page
    </button>
  );
}

/**
 * Renders the end of a device login: the wait line with the minutes
 * the code has left, or, once the code has expired, that line and Start
 * again. Calls `onDone` once when a fresh snapshot shows the account
 * signed in, which never happens for an account that was signed in when the
 * sign-in started (`DeviceLogin.signedInAtStart`); the user presses Cancel.
 *
 * It reads the accounts from the cache, which the `provider` live topic
 * keeps current. The minutes move on with the age clock.
 */
function DeviceLoginWait({
  client,
  login,
  onDone,
  onRestart,
}: {
  readonly client: HerculeClient;
  readonly login: DeviceLogin;
  readonly onDone: () => void;
  readonly onRestart: () => void;
}): JSX.Element {
  const accounts = useQuery(providerAccountsQuery(client)).data ?? [];
  const step = decideDeviceLoginStep(login, accounts, useMinutesLeft(login.expiresAt));

  const endLogin = useEffectEvent(onDone);
  useEffect(() => {
    if (step.kind === "done") endLogin();
  }, [step.kind]);

  if (step.kind === "expired") {
    return (
      <span className="fl-err" role="alert">
        The code expired before the sign-in finished.
        <br />
        <button type="button" className="btn btn--sm" onClick={onRestart}>
          Start again
        </button>
      </span>
    );
  }
  // A login that is done shows so until `onDone` clears the steps.
  return <WaitLine text={step.kind === "done" ? "Signed in." : describeDeviceLoginWait(step)} />;
}

/**
 * Renders the entry of a credential field of the account's kind, such as the
 * Z.ai API key: the field's description, a password field and Save. The value
 * is sent with `providerAccount.update` and never read back. Calls `onSaved`
 * once it is stored.
 */
function CredentialFieldEntry({
  client,
  providerAccountId,
  field,
  onSaved,
}: {
  readonly client: HerculeClient;
  readonly providerAccountId: string;
  readonly field: CredentialFieldOffer;
  readonly onSaved: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () =>
      client.providerAccount.update({
        params: { id: providerAccountId },
        // A pasted credential often has a stray space or newline, and the
        // vendor would treat it as a different credential.
        payload: { credentials: { [field.name]: value.trim() } },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.providerAccounts() });
      onSaved();
    },
  });
  const canSave = value.trim() !== "" && !save.isPending;
  return (
    <>
      <FormField
        label={field.title}
        hint={field.description}
        error={save.error === null ? null : readErrorMessage(save.error)}
      >
        <input
          type="password"
          value={value}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSave) save.mutate();
          }}
        />
      </FormField>
      <span className="row">
        <button
          type="button"
          className="btn btn--sm btn--accent"
          disabled={!canSave}
          onClick={() => save.mutate()}
        >
          Save
        </button>
      </span>
    </>
  );
}
