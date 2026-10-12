import { useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  findGitHubAccount,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import { GITHUB_CONNECTION_TYPE } from "@hercule/contract";
import { useDeviceSignIn, type DeviceSignInProgress } from "../../app/device-sign-in";
import { connectionsQuery } from "../../app/queries";
import { GitHubStep, type GitHubStepState } from "../../screens/first-run";

/**
 * Renders the GitHub step, which makes the GitHub Connection, by GitHub's
 * device flow or with a pasted token. Once a GitHub Connection exists, made
 * here or anywhere else, the step shows it as connected.
 *
 * While a code is on screen, the step polls the controller for the flow's
 * end, and it stops polling when the code goes: on Cancel, on Paste a token
 * instead, on Skip for now, or when the user leaves the step.
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
  const signIn = useDeviceSignIn({ client, type: GITHUB_CONNECTION_TYPE, providerName: "GitHub" });
  // Whether the user chose to paste a token instead of signing in.
  const [pastesToken, setPastesToken] = useState(false);
  const [token, setToken] = useState("");

  const connect = useMutation({
    mutationFn: (pat: string) =>
      client.connection.create({
        payload: { type: GITHUB_CONNECTION_TYPE, credentials: { pat } },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.connections() }),
  });

  return (
    <GitHubStep
      state={decideStepState(account, pastesToken, signIn.progress, connect)}
      token={token}
      actions={{
        onSignIn: () => {
          setPastesToken(false);
          signIn.start();
        },
        onCancel: signIn.cancel,
        onOpen: (url) => {
          bridge.link.open({ url }).catch((error: unknown) => {
            console.error("Could not open the link:", error);
          });
        },
        onUseToken: () => {
          signIn.cancel();
          setPastesToken(true);
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
 * over whatever the sign-in was doing, and the token form wins over the
 * sign-in while `pastesToken`.
 */
const decideStepState = (
  account: string | null,
  pastesToken: boolean,
  signIn: DeviceSignInProgress,
  connect: {
    readonly isPending: boolean;
    readonly isSuccess: boolean;
    readonly error: Error | null;
  },
): GitHubStepState => {
  if (account !== null) return { kind: "connected", account };
  if (pastesToken) {
    return {
      kind: "token",
      // The Connection is made, and the step shows it once the list is read again.
      checking: connect.isPending || connect.isSuccess,
      error: connect.error === null ? null : readErrorMessage(connect.error),
    };
  }
  switch (signIn.kind) {
    case "idle":
      return { kind: "start", starting: false };
    case "starting":
      return { kind: "start", starting: true };
    case "code":
    case "ended":
      return signIn;
  }
};
