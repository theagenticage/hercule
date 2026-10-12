import { useEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildRedirectUri,
  countMinutesLeft,
  describeCodeExpiry,
  describeDeviceFlowWait,
  describeSignInEnding,
  describeSignInFailure,
  findOAuthConnection,
  listCredentialFields,
  listSetupFlows,
  queryKeys,
  readConfigIssues,
  readErrorMessage,
  waitForDeviceFlow,
  type ConnectionType,
  type SetupFlow,
  type SignInEnding,
} from "@hercule/client-core";
import type { Connection, ConnectionDeviceStart } from "@hercule/contract";
import { useMinutesLeft } from "../../../../app/age-clock";
import { connectionsQuery, pluginsQuery } from "../../../../app/queries";
import {
  ConnectionSetup,
  type ConnectionSetupState,
} from "../../../../screens/settings/connections";

/**
 * Where a sign-in, by device code or by OAuth, stands:
 *
 * - `form`: nothing started, or the last sign-in was cancelled;
 * - `starting`: the dialog waits for the controller's answer to the start
 *   numbered `request`;
 * - `code`: the user enters the code of `deviceStart` at the provider, which
 *   the dialog polls for; `codeMinutes` is how long the code lasted when it
 *   was handed out, and `wait` the line under it;
 * - `ended`: the sign-in with a code ended without a Connection;
 * - `browser`: the provider's page is open in the browser, and the dialog
 *   waits for the Connection; `before` holds the Connections read when the
 *   sign-in started.
 */
type SignInProgress =
  | { readonly kind: "form" }
  | { readonly kind: "starting"; readonly request: number }
  | {
      readonly kind: "code";
      readonly deviceStart: ConnectionDeviceStart;
      readonly codeMinutes: number;
      readonly wait: string;
    }
  | SignInEnding
  | {
      readonly kind: "browser";
      readonly authorizationUrl: string;
      readonly before: readonly Connection[];
    };

/**
 * Renders the setup of a Connection of `type` in a glass dialog, or, with
 * `connection`, a fresh credential for that Connection (Reconnect). The
 * dialog starts with the first flow the type declares and offers the others
 * as links (spec 17 §Settings, Connections):
 *
 * - credentials: the pasted secrets go to `connection.create`, or to
 *   `connection.setCredentials` on a reconnect;
 * - device: the user enters a code at the provider, as in the first run's
 *   GitHub step. The dialog polls for the flow's end only while the code is
 *   on screen, and stops on Cancel, on a switch of flow, and when it closes;
 * - OAuth: the provider's page opens in the default browser, and the dialog
 *   closes once the Connection the sign-in writes arrives on the
 *   `connection` live topic, which the shell holds.
 *
 * The dialog closes once the Connection is set up. `onClose` is called
 * whenever it closes, set up or not; the caller then unmounts it.
 */
export function ConnectionSetupDialog({
  type,
  connection,
  onClose,
}: {
  readonly type: ConnectionType;
  /** The Connection being reconnected; absent when this sets up a new one. */
  readonly connection?: Connection;
  /** Called when the dialog closes, set up or not. The caller then unmounts it. */
  readonly onClose: () => void;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const queryClient = useQueryClient();
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fields = listCredentialFields(type);
  // The OAuth redirect goes to the controller, as from the web app, so the
  // redirect URI the provider has registered matches either way.
  const origin = new URL(controller.url).origin;
  const target = connection === undefined ? {} : { connectionId: connection.id };

  // Undefined when the type offers no flow this version can show.
  const [flow, setFlow] = useState<SetupFlow | undefined>(listSetupFlows(type)[0]);
  const [progress, setProgress] = useState<SignInProgress>({ kind: "form" });
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  // Numbers each start, so an answer that arrives after the user cancelled
  // or switched flow is dropped rather than shown.
  const lastRequest = useRef(0);

  const close = (): void => dialogRef.current?.close();

  const saveCredentials = useMutation({
    mutationFn: () =>
      connection === undefined
        ? client.connection.create({ payload: { type: type.type, credentials: values } })
        : client.connection.setCredentials({
            params: { id: connection.id },
            payload: { credentials: values },
          }),
    // The Connection exists from this answer on, even when the dialog is
    // gone, so the list is read again either way.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.connections() }),
  });
  const startDeviceFlow = useMutation({
    mutationFn: () =>
      client.connection.startDeviceFlow({ payload: { type: type.type, ...target } }),
  });
  const startOAuth = useMutation({
    mutationFn: () =>
      client.connection.startOAuth({ payload: { type: type.type, origin, ...target } }),
  });

  /** Applies `next` only while the dialog still waits for the answer to start `request`. */
  const settleStart = (request: number, next: SignInProgress): void => {
    setProgress((current) =>
      current.kind === "starting" && current.request === request ? next : current,
    );
  };
  /** Starts the sign-in of the flow on screen, by device code or by OAuth. */
  const startSignIn = (): void => {
    lastRequest.current += 1;
    const request = lastRequest.current;
    setProgress({ kind: "starting", request });
    if (flow === "device") {
      startDeviceFlow.mutate(undefined, {
        onSuccess: (deviceStart) => {
          settleStart(request, {
            kind: "code",
            deviceStart,
            codeMinutes: countMinutesLeft(deviceStart.expiresAt, Date.now()),
            wait: describeDeviceFlowWait("pending", type.displayName),
          });
        },
        onError: (error) => {
          settleStart(request, describeSignInFailure(readErrorMessage(error)));
        },
      });
      return;
    }
    // Read before the sign-in starts, so a Connection it writes is never
    // taken for one that was there already.
    const before = connections;
    startOAuth.mutate(undefined, {
      onSuccess: ({ authorizationUrl }) => {
        settleStart(request, { kind: "browser", authorizationUrl, before });
        openLink(authorizationUrl);
      },
      // The failure shows under the form, from the mutation's error.
      onError: () => {
        settleStart(request, { kind: "form" });
      },
    });
  };
  const openLink = (url: string): void => {
    bridge.link.open({ url }).catch((error: unknown) => {
      console.error("Could not open the link:", error);
    });
  };

  const deviceStart = progress.kind === "code" ? progress.deviceStart : null;
  useEffect(() => {
    if (deviceStart === null) return;
    const stop = new AbortController();
    const showWait = (wait: string): void => {
      setProgress((current) => (current.kind === "code" ? { ...current, wait } : current));
    };
    void waitForDeviceFlow(client, deviceStart, {
      signal: stop.signal,
      onStep: (step) => {
        if (step.kind === "waiting")
          showWait(describeDeviceFlowWait(step.status, type.displayName));
        if (step.kind === "ended") {
          setProgress((current) =>
            current.kind === "code"
              ? describeSignInEnding(step, current.codeMinutes, type.displayName)
              : current,
          );
        }
      },
      onRequestFailure: () => {
        showWait(describeDeviceFlowWait("request-failed", type.displayName));
      },
    }).then(async (last) => {
      // The Connection exists from a `done` answer on, even when the user
      // cancelled since, so the list is read again either way.
      if (last.kind !== "done") return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
      if (!stop.signal.aborted) dialogRef.current?.close();
    });
    return () => {
      stop.abort();
    };
  }, [client, deviceStart, queryClient, type.displayName]);

  // An OAuth sign-in ends in the browser. The controller announces the
  // Connection it writes on the `connection` topic, and the shell reads the
  // list again, so the dialog learns of it here.
  const oauthConnection =
    progress.kind === "browser"
      ? findOAuthConnection(progress.before, connections, { type: type.type, ...target })
      : undefined;
  useEffect(() => {
    if (oauthConnection !== undefined) dialogRef.current?.close();
  }, [oauthConnection]);

  // The age clock draws the dialog again each time the code loses a minute.
  const minutesLeft = useMinutesLeft(deviceStart?.expiresAt);

  const issues = readConfigIssues(saveCredentials.error, fields, "credentials");
  const formError =
    flow === "oauth" && startOAuth.error !== null
      ? readErrorMessage(startOAuth.error)
      : flow === "credentials" && issues.rest
        ? readErrorMessage(saveCredentials.error)
        : null;

  return (
    <ConnectionSetup
      dialogRef={dialogRef}
      heading={
        connection === undefined ? `Connect ${type.displayName}` : `Reconnect ${connection.label}`
      }
      type={type}
      plugins={plugins}
      state={decideSetupState(flow, progress, minutesLeft, {
        busy: saveCredentials.isPending,
        fieldErrors: issues.perField,
        error: formError,
      })}
      values={values}
      redirectUri={buildRedirectUri(origin)}
      actions={{
        onFieldChange: (name, value) => {
          // The last attempt's error was about the old value, not this one.
          saveCredentials.reset();
          setValues((current) => ({ ...current, [name]: value }));
        },
        onSubmit: () => {
          // React Query calls a callback passed to `mutate` only while the
          // dialog is on screen, so a late answer cannot close another dialog.
          if (flow === "credentials") saveCredentials.mutate(undefined, { onSuccess: close });
          else if (progress.kind !== "starting") startSignIn();
        },
        onSwitchFlow: (next) => {
          saveCredentials.reset();
          startOAuth.reset();
          setProgress({ kind: "form" });
          setFlow(next);
        },
        onCancelCode: () => {
          setProgress({ kind: "form" });
        },
        onStartAgain: startSignIn,
        onOpen: openLink,
      }}
      onClose={onClose}
    />
  );
}

/**
 * Decides what the setup shows for `flow`, from where the sign-in stands and
 * the credential form's own state. `minutesLeft` is how long the code on
 * screen still works, or null when no code is on screen.
 */
const decideSetupState = (
  flow: SetupFlow | undefined,
  progress: SignInProgress,
  minutesLeft: number | null,
  form: Omit<Extract<ConnectionSetupState, { kind: "form" }>, "kind" | "flow">,
): ConnectionSetupState => {
  if (flow === undefined) return { kind: "unsupported" };
  if (flow === "pairing") return { kind: "unsupported", flow: "pairing" };
  if (flow === "credentials") return { kind: "form", flow, ...form };
  switch (progress.kind) {
    case "form":
      return { kind: "form", flow, ...form, busy: false };
    case "starting":
      return { kind: "form", flow, ...form, busy: true };
    case "code":
      return {
        kind: "code",
        code: progress.deviceStart.userCode,
        verificationUri: progress.deviceStart.verificationUri,
        wait:
          minutesLeft === null
            ? progress.wait
            : `${progress.wait} ${describeCodeExpiry(minutesLeft)}`,
      };
    case "ended":
      return progress;
    case "browser":
      return { kind: "browser", authorizationUrl: progress.authorizationUrl };
  }
};
