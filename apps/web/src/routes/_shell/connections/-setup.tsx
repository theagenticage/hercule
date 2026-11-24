import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Field, Input, LaneLabel } from "@hercule/ui";
import {
  readConfigIssues,
  listCredentialFields,
  queryKeys,
  buildRedirectUriToRegister,
  decideOAuthReturnPath,
  isWebLink,
  listSetupFlows,
  listFlowSwitches,
  readClientValues,
  startLocalReturnSignIn,
  type ConnectionType,
  type HerculeClient,
  type LocalReturnSignIn,
  type SetupFlow,
  readErrorMessage,
} from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import { SaveStatus } from "../../../screens/save-status";
import { Checklist } from "./-checklist";
import { DeviceSignIn } from "./-device";
import { PasteReturnSignIn } from "./-paste-return";

/**
 * The form that sets up a connection: either a new one, or a fresh credential
 * for an existing one (a reconnect). Both show the same steps because they ask
 * the user for the same thing; only the request they send differs.
 *
 * A type can offer several flows. The form starts with the first one the type
 * declares, and offers the others as quieter buttons under it.
 *
 * A type whose plugin creates its OAuth client at setup (Slack) also asks for
 * the values to create it from, and returns to the user's machine, where the
 * user pastes the address the browser ends on (see `decideOAuthReturnPath`).
 * A reconnect asks for no values, and offers to set the client up again.
 *
 * Every flow asks only for the credential or the sign-in, never for a name or
 * a topic, so that connecting an account is as short as it can be. A new
 * connection is named after its account and has no topic; a reconnect keeps
 * the connection's own. Both are edited under Configure.
 */
export function ConnectionSetup({
  client,
  type,
  connection,
  onDone,
}: {
  readonly client: HerculeClient;
  readonly type: ConnectionType;
  /** The connection being reconnected; absent when this is a first setup. */
  readonly connection?: Connection;
  readonly onDone: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const flows = listSetupFlows(type);
  const fields = listCredentialFields(type);

  // Undefined when the type offers no flow this build can show.
  const [flow, setFlow] = useState<SetupFlow | undefined>(flows[0]);
  const [pasted, setPasted] = useState<Readonly<Record<string, string>>>({});
  // A reconnect signs in with the client the connection has, and asks for the
  // values to make the client again only when the user chooses to.
  const [clientSetupAsked, setClientSetupAsked] = useState(connection === undefined);
  const asksClientSetup = flow === "oauth" && type.clientSetupFields.length > 0 && clientSetupAsked;
  const clientValues = readClientValues(type, pasted);
  const returnPath = decideOAuthReturnPath(type, "web");
  // The redirect flow is no mutation: its start holds the values pasted for
  // the type's client, which would stay in the mutation cache otherwise.
  const [oauthStart, setOauthStart] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  // The sign-in that returns to the user's machine, once its start was answered.
  const [pasteSignIn, setPasteSignIn] = useState<LocalReturnSignIn | null>(null);
  // The attempt of the sign-in that is starting or running. It aborts when the
  // form goes, so an answer that comes later opens nothing.
  const attemptRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      attemptRef.current?.abort();
    },
    [],
  );

  const submit = useMutation({
    mutationFn: async () => {
      if (connection !== undefined) {
        await client.connection.setCredentials({
          params: { id: connection.id },
          payload: { credentials: pasted },
        });
        return;
      }
      await client.connection.create({
        payload: { type: type.type, credentials: pasted },
      });
    },
    // The connection exists from this reply on, even when the form is gone, so
    // the list is fetched again either way. Closing the form is left to the
    // `mutate` call below.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.connections() }),
  });

  // The device flow finishes in its own panel, which polls until the user
  // approves the code, so starting it only fetches the code.
  const startDeviceFlow = useMutation({
    mutationFn: () =>
      client.connection.startDeviceFlow({
        payload: {
          type: type.type,
          ...(connection === undefined ? {} : { connectionId: connection.id }),
        },
      }),
  });

  /** Ends the sign-in that starts or runs, and shows the form again. */
  const abandonSignIn = (): void => {
    attemptRef.current?.abort();
    attemptRef.current = null;
    setPasteSignIn(null);
    setOauthStart({ busy: false, error: null });
  };
  /**
   * Starts the redirect flow. The values pasted for the type's client leave
   * the form as the request starts. Either the provider's page opens in a new
   * tab beside a panel that takes the address the browser ends on, or the
   * browser goes to the provider and the controller finishes the sign-in. An
   * answer that comes after the form went, or the user started again, opens
   * nothing.
   */
  const startOAuthSignIn = async (): Promise<void> => {
    abandonSignIn();
    const attempt = new AbortController();
    attemptRef.current = attempt;
    const sent = asksClientSetup ? clientValues : undefined;
    setPasted({});
    setOauthStart({ busy: true, error: null });
    const start = {
      type: type.type,
      ...(connection === undefined ? {} : { connectionId: connection.id }),
      ...(sent === undefined ? {} : { clientValues: sent }),
    };
    try {
      if (returnPath === "pasted-address") {
        const signIn = await startLocalReturnSignIn(
          { client, port: undefined },
          start,
          attempt.signal,
        );
        setOauthStart({ busy: false, error: null });
        setPasteSignIn(signIn);
        // A popup blocker may stop this, so the panel has a link as well.
        if (isWebLink(signIn.authorizationUrl)) {
          window.open(signIn.authorizationUrl, "_blank", "noopener,noreferrer");
        }
        return;
      }
      const { authorizationUrl } = await client.connection.startOAuth({
        payload: { ...start, origin: window.location.origin },
      });
      if (attempt.signal.aborted) return;
      if (!isWebLink(authorizationUrl)) {
        setOauthStart({
          busy: false,
          error: `The sign-in page is not a web address, so it was not opened: ${authorizationUrl}`,
        });
        return;
      }
      // The rest of the setup happens at the provider, which sends the
      // browser back to the callback route, so the browser leaves this page.
      window.location.assign(authorizationUrl);
    } catch (error) {
      if (!attempt.signal.aborted) setOauthStart({ busy: false, error: readErrorMessage(error) });
    }
  };

  // An error about one credential field is shown under that field; any other
  // error is shown at the bottom of the form.
  const issues = readConfigIssues(submit.error, fields, "credentials");
  const failureCause = startDeviceFlow.error ?? (issues.rest ? submit.error : null);
  const failure =
    oauthStart.error ?? (failureCause === null ? null : readErrorMessage(failureCause));

  // The same column width as the rows and the offers, so the form does not
  // stretch across the whole content width when nothing else does.
  const column = "max-w-[560px]";
  const heading = `${connection === undefined ? "Connect" : "Reconnect"} ${type.displayName}`;

  if (flow === undefined || flow === "pairing") {
    return (
      <div className={`flex flex-col items-start gap-1.5 text-row text-muted ${column}`}>
        <LaneLabel>{heading}</LaneLabel>
        <p>
          {flow === "pairing"
            ? "Pairing a chat account is not built yet."
            : `Setting up ${type.displayName} takes a step this version of Hercule does not know.`}
        </p>
        <Button className="-ml-2" onClick={onDone}>
          Back
        </Button>
      </div>
    );
  }

  // The panel replaces the form from the moment a code is asked for, and stays
  // while a new code is asked for after the last one ran out.
  if (flow === "device" && (startDeviceFlow.isPending || startDeviceFlow.data !== undefined)) {
    return (
      <div className={`flex flex-col gap-3 ${column}`}>
        <div className="-mb-2.5">
          <LaneLabel>{heading}</LaneLabel>
        </div>
        {startDeviceFlow.data === undefined ? (
          <p className="text-row text-muted" role="status">
            Asking {type.displayName} for a code.
          </p>
        ) : (
          <DeviceSignIn
            // A new code is a new flow, so its panel starts with no polls.
            key={startDeviceFlow.data.setupId}
            client={client}
            providerName={type.displayName}
            deviceStart={startDeviceFlow.data}
            onRestart={() => {
              startDeviceFlow.mutate();
            }}
            onCancel={onDone}
            onDone={onDone}
          />
        )}
      </div>
    );
  }

  if (flow === "oauth" && pasteSignIn !== null) {
    return (
      <div className={`flex flex-col gap-3 ${column}`}>
        <div className="-mb-2.5">
          <LaneLabel>{heading}</LaneLabel>
        </div>
        <PasteReturnSignIn
          client={client}
          providerName={type.displayName}
          authorizationUrl={pasteSignIn.authorizationUrl}
          onRestart={abandonSignIn}
          onCancel={onDone}
          onDone={onDone}
        />
      </div>
    );
  }

  const idPrefix = connection?.id ?? type.type;
  const redirectUri = buildRedirectUriToRegister(type, window.location.origin);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (flow === "device") startDeviceFlow.mutate();
    else if (flow === "oauth") void startOAuthSignIn();
    // React Query calls a callback passed to `mutate` only while this form is
    // on screen, so a reply that arrives after Cancel cannot close another panel.
    else submit.mutate(undefined, { onSuccess: onDone });
  };

  /** Switches the form to another flow, dropping the last attempt's error. */
  const switchFlow = (next: SetupFlow): void => {
    submit.reset();
    startDeviceFlow.reset();
    abandonSignIn();
    setFlow(next);
  };

  return (
    <form className={`flex flex-col gap-3 ${column}`} onSubmit={send}>
      {/* The form replaces the offers, so this heading names what is being set
          up, styled like the lane labels around it. */}
      <div className="-mb-2.5">
        <LaneLabel>{heading}</LaneLabel>
      </div>
      {flow === "oauth" && !asksClientSetup ? (
        <p className="max-w-[52ch] text-row text-muted">
          {`You sign in to ${type.displayName} in your browser.`}
        </p>
      ) : null}
      {asksClientSetup && connection !== undefined ? (
        <p className="max-w-[52ch] text-row text-muted">
          {`Use this when the app named Hercule was deleted in ${type.displayName}.`}
        </p>
      ) : null}
      {/* A reconnect that signs in with the existing client needs no instructions for making one. */}
      {type.clientSetupFields.length === 0 || asksClientSetup
        ? type.setup.map((step, index) =>
            step.kind === "checklist" ? (
              // A checklist step holds the plugin's own instructions, written in Markdown.
              <Checklist key={index} markdown={step.markdown} />
            ) : null,
          )
        : null}

      {flow === "oauth" && redirectUri !== undefined ? (
        <p className="max-w-[52ch] text-row text-muted">
          Register this redirect URI with {type.displayName}:{" "}
          <code className="font-mono text-fine wrap-break-word text-ink">{redirectUri}</code>
        </p>
      ) : null}

      {flow === "credentials"
        ? fields.map((field) => (
            <Field
              key={field.name}
              id={`${idPrefix}-${field.name}`}
              label={field.label}
              error={issues.perField[field.name]}
            >
              {field.help === undefined ? null : (
                <p className="text-fine text-faint">{field.help}</p>
              )}
              <Input
                id={`${idPrefix}-${field.name}`}
                // A pasted credential is never read back, so it is never prefilled.
                type="password"
                autoComplete="off"
                required
                value={pasted[field.name] ?? ""}
                onChange={(event) => {
                  // Clears the last attempt's error, because that error was about
                  // the old value, not the one being typed now.
                  if (!submit.isIdle) submit.reset();
                  const value = event.target.value;
                  setPasted((current) => ({ ...current, [field.name]: value }));
                }}
              />
            </Field>
          ))
        : null}

      {asksClientSetup
        ? type.clientSetupFields.map((field) => (
            <Field
              key={field.name}
              id={`${idPrefix}-${field.name}`}
              label={field.label}
              error={undefined}
            >
              {field.help === undefined ? null : (
                <p className="text-fine text-faint">{field.help}</p>
              )}
              <Input
                id={`${idPrefix}-${field.name}`}
                // The form changed under the user's hands, as when the app is set up again, so the field takes the focus.
                autoFocus
                // A pasted value is never read back, so it is never prefilled.
                type="password"
                autoComplete="off"
                value={pasted[field.name] ?? ""}
                onChange={(event) => {
                  // The refusal of a start was about the value that has left the form.
                  if (oauthStart.error !== null) setOauthStart({ busy: false, error: null });
                  const value = event.target.value;
                  setPasted((current) => ({ ...current, [field.name]: value }));
                }}
              />
            </Field>
          ))
        : null}

      <div className="flex items-center gap-2">
        {/* A quiet button's text is pulled back to line up with the fields above it. */}
        <Button type="button" className="-ml-2" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="form"
          disabled={
            submit.isPending ||
            startDeviceFlow.isPending ||
            oauthStart.busy ||
            (asksClientSetup && clientValues === undefined)
          }
        >
          {describeSubmit(type, flow, {
            asksClientSetup,
            reconnect: connection !== undefined,
            busy: oauthStart.busy,
          })}
        </Button>
      </div>

      {type.clientSetupFields.length > 0 && !clientSetupAsked ? (
        <Button
          type="button"
          className="-mt-1.5 -ml-2 self-start"
          onClick={() => {
            setClientSetupAsked(true);
          }}
        >
          {`Set up the ${type.displayName} app again`}
        </Button>
      ) : null}

      {listFlowSwitches(type, flow).map((flowSwitch) => (
        <Button
          key={flowSwitch.flow}
          type="button"
          className="-mt-1.5 -ml-2 self-start"
          onClick={() => {
            switchFlow(flowSwitch.flow);
          }}
        >
          {flowSwitch.label}
        </Button>
      ))}

      {/* A successful setup closes the form and its row appears, so only a
          failure is shown here. The wrapper sets the row text size only so
          that 52ch is the same width as the setup text above, which a long
          refusal would otherwise run past. */}
      <div className="max-w-[52ch] text-row">
        <SaveStatus saved={false} failure={failure} />
      </div>
    </form>
  );
}

/**
 * Returns the label of the setup form's button. A type that creates its OAuth
 * client at setup says what comes next, and what it is doing while it makes
 * the client. Every other flow keeps its label: "Sign in with GitHub" for a
 * device flow, "Connect" for the rest.
 */
const describeSubmit = (
  type: ConnectionType,
  flow: SetupFlow,
  state: { readonly asksClientSetup: boolean; readonly reconnect: boolean; readonly busy: boolean },
): string => {
  if (state.asksClientSetup) {
    return state.busy ? `Creating the ${type.displayName} app…` : `Continue in ${type.displayName}`;
  }
  if (flow === "oauth" && type.clientSetupFields.length > 0 && state.reconnect) {
    return `Sign in to ${type.displayName} again`;
  }
  return flow === "device" ? `Sign in with ${type.displayName}` : "Connect";
};
