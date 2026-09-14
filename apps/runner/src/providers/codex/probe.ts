/**
 * What the runner learns about a Codex installation without hosting anything on
 * it: the harness version, which account it is logged in as, and the models it
 * offers - plus the install that puts one there. A probe runs on an app-server
 * of its own and kills it, so nothing here touches a thread.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CODEX_VERSION, VERSION } from "@hydra/home/version";
import {
  MAX_FACT_ITEMS,
  MAX_FACT_LENGTH,
  type ModelDescriptor,
  type ModelOption,
  type ProbeResult,
} from "@hydra/protocol";
import type { InstallOutcome, ProviderRunnerContext } from "../index";
import { installing } from "../install";
import { PROBE_DEADLINE, probeFailed } from "../probe";
import type { Run } from "../process";
import { fact } from "../text";
import type { Rpc, RpcError } from "./rpc";
import type {
  GetAccountResponse,
  InitializeParams,
  InitializeResponse,
  Model,
  ModelListResponse,
} from "./types";

/** What a probe needs of an app-server: what to ask it, what it said, and how to end it. */
export interface AppServer {
  readonly rpc: Rpc;
  readonly kill: () => void;
  /** What the child wrote that was not a frame, which is where a start failure is said. */
  readonly complaint: () => string;
}

/**
 * Attestation is declined here rather than left to a request nobody answers,
 * and the experimental surface is off because this build talks the methods the
 * pinned release declares.
 */
const INITIALIZE: InitializeParams = {
  clientInfo: { name: "hydra", title: "Hydra", version: VERSION },
  capabilities: { experimentalApi: false, requestAttestation: false },
};

/** Nothing else may be asked of an app-server until this has been answered. */
export const handshake = (host: AppServer): Effect.Effect<InitializeResponse, RpcError> =>
  Effect.map(host.rpc.request("initialize", INITIALIZE), (answer) => {
    host.rpc.notify("initialized");
    return answer as InitializeResponse;
  });

/** What the app-server said, in preference to what the codec made of it. */
export const saidBy = (host: AppServer, error: RpcError): string => {
  const said = host.complaint();
  return said === "" ? error.message : said;
};

/**
 * `initialize` carries no version field, so the version is the token after the
 * first `/` of the user agent, which reads `<client>/<version> (os; arch) ...`.
 * A user agent that does not read as one reports nothing rather than a guess,
 * which `versionVerdict` already takes as "unknown".
 */
const USER_AGENT = /^[^/\s]+\/(\S+)/;

const versionOf = (userAgent: string): string | null =>
  USER_AGENT.exec(userAgent)?.[1]?.slice(0, MAX_FACT_LENGTH) ?? null;

const authOf = ({ account }: GetAccountResponse): ProbeResult["auth"] => {
  if (account === null) return { status: "unauthenticated" };
  if (account.type !== "chatgpt") return { status: "ok", backend: account.type };
  return {
    status: "ok",
    ...(account.email === null ? {} : { identity: fact(account.email) }),
    planLabel: account.planType,
    backend: account.type,
  };
};

const selecting = (
  id: string,
  label: string,
  choices: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  preferred: string | null,
): ModelOption => ({
  id,
  label,
  kind: "select",
  choices,
  default: preferred ?? choices[0]!.value,
});

/**
 * Only what the model itself lists: an empty select is a control the composer
 * shows and nothing can be chosen in.
 */
const optionsFor = (model: Model): ReadonlyArray<ModelOption> => {
  const options: Array<ModelOption> = [];
  const efforts = model.supportedReasoningEfforts ?? [];
  if (efforts.length > 0) {
    options.push(
      selecting(
        // The well-known option id (spec 06 section 3.3): the composer labels and
        // recognises reasoning effort under `effort`, whatever the harness calls it.
        "effort",
        "Effort",
        efforts.map(({ reasoningEffort }) => ({
          value: fact(reasoningEffort),
          label: fact(`${reasoningEffort.slice(0, 1).toUpperCase()}${reasoningEffort.slice(1)}`),
        })),
        model.defaultReasoningEffort ?? null,
      ),
    );
  }
  const tiers = model.serviceTiers ?? [];
  if (tiers.length > 0) {
    options.push(
      selecting(
        "serviceTier",
        "Service tier",
        // An unnamed tier is still a tier, and the protocol will not carry an
        // empty label.
        tiers.map((tier) => ({
          value: fact(tier.id),
          label: fact(tier.name === "" || tier.name === undefined ? tier.id : tier.name),
        })),
        model.defaultServiceTier ?? null,
      ),
    );
  }
  return options;
};

const catalogOf = (models: ReadonlyArray<Model>): ReadonlyArray<ModelDescriptor> =>
  models
    // The protocol will not carry an empty slug or name.
    .filter((model) => model.id !== "" && model.displayName !== "")
    .slice(0, MAX_FACT_ITEMS)
    .map((model) => ({
      slug: fact(model.id),
      name: fact(model.displayName),
      ...(model.isDefault === true ? { isDefault: true } : {}),
      options: optionsFor(model),
    }));

/**
 * The probe, over the adapter's own way of opening an app-server. It is passed
 * in rather than made here because opening one is what the adapter does for a
 * session too, and a probe that opened its own differently would report on a
 * connection no session will ever run on.
 */
export const probing =
  (openHost: (ctx: ProviderRunnerContext, binary: string) => Effect.Effect<AppServer, string>) =>
  (ctx: ProviderRunnerContext, binary: string): Effect.Effect<ProbeResult> => {
    // A probe runs on a process of its own and kills it: sharing the connection
    // a session runs on would keep an app-server alive for a Fleet page nobody
    // is looking at any more.
    const gather = Effect.acquireUseRelease(
      openHost(ctx, binary),
      (host) =>
        Effect.matchEffect(handshake(host), {
          onFailure: (error) => Effect.succeed(probeFailed(null, saidBy(host, error))),
          onSuccess: (initialized) =>
            Effect.match(
              Effect.all([
                host.rpc.request("account/read", {}),
                host.rpc.request("model/list", {}),
              ]),
              {
                onFailure: (error) =>
                  probeFailed(versionOf(initialized.userAgent), saidBy(host, error)),
                onSuccess: ([account, models]) => ({
                  harnessVersion: versionOf(initialized.userAgent),
                  auth: authOf(account as GetAccountResponse),
                  models: catalogOf((models as ModelListResponse).data),
                }),
              },
            ),
        }),
      (host) => Effect.sync(() => host.kill()),
    ).pipe(Effect.catch((message) => Effect.succeed(probeFailed(null, message))));
    return Effect.map(
      Effect.timeoutOption(gather, PROBE_DEADLINE),
      Option.getOrElse(() =>
        probeFailed(
          null,
          `the app-server did not answer within ${Duration.format(PROBE_DEADLINE)}`,
        ),
      ),
    );
  };

/** The script URL is pinned to the tag, so it and the release it fetches move together. */
export const codexInstall = (
  run: Run,
): ((env: Readonly<Record<string, string | undefined>>) => Effect.Effect<InstallOutcome>) =>
  installing(run, [
    "bash",
    "-c",
    `curl -fsSL https://raw.githubusercontent.com/openai/codex/rust-v${CODEX_VERSION}/scripts/install/install.sh | CODEX_RELEASE=${CODEX_VERSION} CODEX_NON_INTERACTIVE=1 sh`,
  ]);
