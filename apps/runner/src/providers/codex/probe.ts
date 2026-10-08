/**
 * Probes a Codex installation without running a session on it: the harness
 * version, the account it is logged in as, and the models it offers. Also
 * installs Codex. A probe starts its own app-server and kills it afterwards,
 * so nothing here touches a thread.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CODEX_VERSION, VERSION } from "@hercule/home/version";
import {
  MAX_FACT_ITEMS,
  MAX_FACT_LENGTH,
  type ModelDescriptor,
  type ModelOption,
  type ProbeResult,
} from "@hercule/protocol";
import type { InstallOutcome, ProviderRunnerContext } from "../index";
import { makeInstall } from "../install";
import { PROBE_DEADLINE, buildFailedProbe } from "../probe";
import type { Run } from "../process";
import { truncateFact } from "../text";
import type { Rpc, RpcError } from "./rpc";
import type {
  GetAccountResponse,
  InitializeParams,
  InitializeResponse,
  Model,
  ModelListResponse,
} from "./types";

/** What a probe needs from an app-server: its connection, its output, and a way to kill it. */
export interface AppServer {
  readonly rpc: Rpc;
  readonly kill: () => void;
  /**
   * Returns the last lines the child wrote that were not frames. When the
   * app-server fails to start, the reason is in these lines.
   */
  readonly complaint: () => string;
}

/**
 * Attestation is turned off here, so Codex never sends an attestation request
 * that nothing would reply to. The experimental API is off because this build
 * uses only the methods the pinned release declares.
 */
const INITIALIZE: InitializeParams = {
  clientInfo: { name: "hercule", title: "Hercule", version: VERSION },
  capabilities: { experimentalApi: false, requestAttestation: false },
};

/**
 * Sends the `initialize` handshake and then the `initialized` notification.
 * Returns the app-server's reply, or fails with its error. No other request
 * may be sent to an app-server until this succeeds.
 */
export const initializeAppServer = (host: AppServer): Effect.Effect<InitializeResponse, RpcError> =>
  Effect.map(host.rpc.request("initialize", INITIALIZE), (answer) => {
    host.rpc.notify("initialized");
    return answer as InitializeResponse;
  });

/**
 * Returns a message for a failed request. The app-server's own recent output
 * is preferred, because it usually explains the failure better than the
 * codec's error message.
 */
export const describeRpcError = (host: AppServer, error: RpcError): string => {
  const said = host.complaint();
  return said === "" ? error.message : said;
};

/**
 * The `initialize` reply has no version field, so the version is parsed from
 * the user agent, which has the form `<client>/<version> (os; arch) ...`. A
 * user agent in any other form gives `null` rather than a guess, and
 * `computeVersionVerdict` already treats `null` as "unknown".
 */
const USER_AGENT = /^[^/\s]+\/(\S+)/;

const parseVersion = (userAgent: string): string | null =>
  USER_AGENT.exec(userAgent)?.[1]?.slice(0, MAX_FACT_LENGTH) ?? null;

const buildAuth = ({ account }: GetAccountResponse): ProbeResult["auth"] => {
  if (account === null) return { status: "unauthenticated" };
  if (account.type !== "chatgpt") return { status: "ok", backend: account.type };
  return {
    status: "ok",
    ...(account.email === null ? {} : { identity: truncateFact(account.email) }),
    planLabel: account.planType,
    backend: account.type,
  };
};

const buildSelectOption = (
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
 * Hercule's name for the tier Codex uses when no tier is given. Codex has no
 * id for it: `serviceTiers` lists only the extra tiers, and a
 * `defaultServiceTier` of `null` means the standard one. Without this choice
 * the only selectable values would be paid tiers nobody asked for. So the
 * standard tier is offered under this name, and a request with it selected
 * sends no `serviceTier`.
 */
export const STANDARD_TIER = "standard";

/**
 * Builds the options a model supports. An option is added only when the model
 * lists values for it, because an empty select would show in the composer with
 * nothing to choose.
 */
const buildModelOptions = (model: Model): ReadonlyArray<ModelOption> => {
  const options: Array<ModelOption> = [];
  const efforts = model.supportedReasoningEfforts ?? [];
  if (efforts.length > 0) {
    options.push(
      buildSelectOption(
        // A well-known option id: the composer recognises reasoning effort by
        // the id `effort`, whatever the harness calls it (spec 06 section 3.3).
        "effort",
        "Effort",
        efforts.map(({ reasoningEffort }) => ({
          value: truncateFact(reasoningEffort),
          label: truncateFact(
            `${reasoningEffort.slice(0, 1).toUpperCase()}${reasoningEffort.slice(1)}`,
          ),
        })),
        model.defaultReasoningEffort ?? null,
      ),
    );
  }
  const tiers = model.serviceTiers ?? [];
  if (tiers.length > 0) {
    options.push(
      buildSelectOption(
        "serviceTier",
        "Service tier",
        [
          { value: STANDARD_TIER, label: "Standard" },
          // A tier with no name is still offered, labelled with its id, because
          // the protocol does not allow an empty label.
          ...tiers.map((tier) => ({
            value: truncateFact(tier.id),
            label: truncateFact(tier.name === "" || tier.name === undefined ? tier.id : tier.name),
          })),
        ],
        model.defaultServiceTier ?? STANDARD_TIER,
      ),
    );
  }
  return options;
};

const buildCatalog = (models: ReadonlyArray<Model>): ReadonlyArray<ModelDescriptor> =>
  models
    // The protocol does not allow an empty slug or name.
    .filter((model) => model.id !== "" && model.displayName !== "")
    .slice(0, MAX_FACT_ITEMS)
    .map((model) => ({
      slug: truncateFact(model.id),
      name: truncateFact(model.displayName),
      ...(model.isDefault === true ? { isDefault: true } : {}),
      // An app-server too old to list input types is read as text only, so a
      // missing list never lets images through.
      imageInput: (model.inputModalities ?? []).includes("image") ? { maxBytes: null } : null,
      options: buildModelOptions(model),
    }));

/**
 * Builds the probe function from the adapter's way of opening an app-server.
 * The probe never fails: every error becomes a failed `ProbeResult`. `openHost`
 * is passed in because sessions use the same function. A probe that opened
 * its app-server differently would test a connection no session runs on.
 */
export const makeProbe =
  (openHost: (ctx: ProviderRunnerContext, binary: string) => Effect.Effect<AppServer, string>) =>
  (ctx: ProviderRunnerContext, binary: string): Effect.Effect<ProbeResult> => {
    // A probe starts its own process and kills it when done. Sharing a
    // session's connection would keep an app-server alive for a Fleet page
    // nobody is looking at any more.
    const gather = Effect.acquireUseRelease(
      openHost(ctx, binary),
      (host) =>
        Effect.matchEffect(initializeAppServer(host), {
          onFailure: (error) =>
            Effect.succeed(buildFailedProbe(null, describeRpcError(host, error))),
          onSuccess: (initialized) =>
            Effect.match(
              Effect.all([
                host.rpc.request("account/read", {}),
                host.rpc.request("model/list", {}),
              ]),
              {
                onFailure: (error) =>
                  buildFailedProbe(
                    parseVersion(initialized.userAgent),
                    describeRpcError(host, error),
                  ),
                onSuccess: ([account, models]) => ({
                  harnessVersion: parseVersion(initialized.userAgent),
                  auth: buildAuth(account as GetAccountResponse),
                  models: buildCatalog((models as ModelListResponse).data),
                }),
              },
            ),
        }),
      (host) => Effect.sync(() => host.kill()),
    ).pipe(Effect.catch((message) => Effect.succeed(buildFailedProbe(null, message))));
    return Effect.map(
      Effect.timeoutOption(gather, PROBE_DEADLINE),
      Option.getOrElse(() =>
        buildFailedProbe(
          null,
          `the app-server did not reply within ${Duration.format(PROBE_DEADLINE)}`,
        ),
      ),
    );
  };

/**
 * Builds the Codex installer. The script URL is pinned to the release tag, so
 * the script and the release it installs always match.
 */
export const makeCodexInstall = (
  run: Run,
): ((env: Readonly<Record<string, string | undefined>>) => Effect.Effect<InstallOutcome>) =>
  makeInstall(run, [
    "bash",
    "-c",
    `curl -fsSL https://raw.githubusercontent.com/openai/codex/rust-v${CODEX_VERSION}/scripts/install/install.sh | CODEX_RELEASE=${CODEX_VERSION} CODEX_NON_INTERACTIVE=1 sh`,
  ]);
