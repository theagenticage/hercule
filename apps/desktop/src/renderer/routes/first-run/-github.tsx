import { useEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  countMinutesLeft,
  describeCodeExpiry,
  describeDeviceFlowWait,
  describeGitHubSignInEnding,
  describeGitHubSignInFailure,
  findGitHubAccount,
  queryKeys,
  readErrorMessage,
  waitForDeviceFlow,
  type HerculeClient,
} from "@hercule/client-core";
import { GITHUB_CONNECTION_TYPE, type ConnectionDeviceStart } from "@hercule/contract";
import { useMinutesLeft } from "../../app/age-clock";
import { connectionsQuery } from "../../app/queries";
import { GitHubStep, type GitHubStepState } from "../../screens/first-run";

/**
 * Where the GitHub sign-in stands:
 *
 * - `start`: nothing started yet;
 * - `starting`: the step waits for the controller's code, asked for by the
 *   sign-in numbered `request`;
 * - `code`: the user enters the code of `deviceStart` on GitHub, which the
 *   step polls for; `codeMinutes` is how long the code lasted when it was
 *   handed out, and `wait` the line under it;
 * - `ended`: the sign-in ended without a Connection;
 * - `token`: the user chose to paste a token instead.
 */
type GitHubFlow =
  | { readonly kind: "start" }
  | { readonly kind: "starting"; readonly request: number }
  | {
      readonly kind: "code";
      readonly deviceStart: ConnectionDeviceStart;
      readonly codeMinutes: number;
      readonly wait: string;
    }
  | Extract<GitHubStepState, { kind: "ended" }>
  | { readonly kind: "token" };

/**
 * Renders the GitHub step, which makes the GitHub Connection, by GitHub's
 * device flow or with a pasted token. Once a GitHub Connection exists, made
 * here or anywhere else, the step shows it as connected.
 *
 * While a code is on screen, the step polls the controller for the flow's
 * end, and it stops polling when the code goes: on Cancel, on Skip for now,
 * or when the user leaves the step.
 */
export function GitHubCard({
  client,
  onPutOff,
  onContinue,
}: {
  readonly client: HerculeClient;
  readonly onPutOff: () => void;
  readonly onContinue: () => void;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const queryClient = useQueryClient();
  const account = findGitHubAccount(useSuspenseQuery(connectionsQuery(client)).data);
  const [flow, setFlow] = useState<GitHubFlow>({ kind: "start" });
  const [token, setToken] = useState("");
  // Numbers each sign-in, so a code that arrives after the user moved on,
  // with Paste a token instead, is dropped rather than shown.
  const lastRequest = useRef(0);

  /** Applies `next` only while the step still waits for the code of sign-in `request`. */
  const settleStart = (request: number, next: GitHubFlow): void => {
    setFlow((current) =>
      current.kind === "starting" && current.request === request ? next : current,
    );
  };
  const start = useMutation({
    mutationFn: () =>
      client.connection.startDeviceFlow({ payload: { type: GITHUB_CONNECTION_TYPE } }),
  });
  const startSignIn = (): void => {
    lastRequest.current += 1;
    const request = lastRequest.current;
    setFlow({ kind: "starting", request });
    start.mutate(undefined, {
      onSuccess: (deviceStart) => {
        settleStart(request, {
          kind: "code",
          deviceStart,
          codeMinutes: countMinutesLeft(deviceStart.expiresAt, Date.now()),
          wait: describeDeviceFlowWait("pending", "GitHub"),
        });
      },
      onError: (error) => {
        settleStart(request, describeGitHubSignInFailure(readErrorMessage(error)));
      },
    });
  };

  const connect = useMutation({
    mutationFn: (pat: string) =>
      client.connection.create({
        payload: { type: GITHUB_CONNECTION_TYPE, credentials: { pat } },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.connections() }),
  });

  const deviceStart = flow.kind === "code" ? flow.deviceStart : null;
  useEffect(() => {
    if (deviceStart === null) return;
    const stop = new AbortController();
    const showWait = (wait: string): void => {
      setFlow((current) => (current.kind === "code" ? { ...current, wait } : current));
    };
    void waitForDeviceFlow(client, deviceStart, {
      signal: stop.signal,
      onStep: (step) => {
        if (step.kind === "waiting") showWait(describeDeviceFlowWait(step.status, "GitHub"));
        if (step.kind === "ended") {
          setFlow((current) =>
            current.kind === "code"
              ? describeGitHubSignInEnding(step, current.codeMinutes)
              : current,
          );
        }
      },
      onRequestFailure: () => {
        showWait(describeDeviceFlowWait("request-failed", "GitHub"));
      },
    }).then(async (last) => {
      // The Connection exists from a `done` reply on, even when the user has
      // left the step, so the list is read again either way.
      if (last.kind === "done") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
      }
    });
    return () => {
      stop.abort();
    };
  }, [client, deviceStart, queryClient]);

  // The age clock draws the step again each time the code loses a minute.
  const minutesLeft = useMinutesLeft(deviceStart?.expiresAt);

  return (
    <GitHubStep
      state={decideStepState(account, flow, minutesLeft, connect)}
      token={token}
      actions={{
        onSignIn: () => {
          // A second sign-in would replace the code the first one shows.
          if (flow.kind !== "starting") startSignIn();
        },
        onCancel: () => {
          setFlow({ kind: "start" });
        },
        onOpen: (url) => {
          bridge.link.open({ url }).catch((error: unknown) => {
            console.error("Could not open the link:", error);
          });
        },
        onUseToken: () => {
          setFlow({ kind: "token" });
        },
        onTokenChange: (next) => {
          setToken(next);
          connect.reset();
        },
        onConnectToken: () => {
          connect.mutate(token.trim());
        },
        onPutOff,
        onContinue,
      }}
    />
  );
}

/**
 * Decides what the GitHub step shows. A GitHub Connection, once there, wins
 * over whatever the sign-in was doing. `minutesLeft` is how long the code on
 * screen still works, or null when no code is on screen.
 */
const decideStepState = (
  account: string | null,
  flow: GitHubFlow,
  minutesLeft: number | null,
  connect: {
    readonly isPending: boolean;
    readonly isSuccess: boolean;
    readonly error: Error | null;
  },
): GitHubStepState => {
  if (account !== null) return { kind: "connected", account };
  switch (flow.kind) {
    case "start":
      return { kind: "start", starting: false };
    case "starting":
      return { kind: "start", starting: true };
    case "code":
      return {
        kind: "code",
        code: flow.deviceStart.userCode,
        verificationUri: flow.deviceStart.verificationUri,
        wait: minutesLeft === null ? flow.wait : `${flow.wait} ${describeCodeExpiry(minutesLeft)}`,
      };
    case "ended":
      return flow;
    case "token":
      return {
        kind: "token",
        // The Connection is made, and the step shows it once the list is read again.
        checking: connect.isPending || connect.isSuccess,
        error: connect.error === null ? null : readErrorMessage(connect.error),
      };
  }
};
