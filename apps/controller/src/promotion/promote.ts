/**
 * `hercule promote` on the new machine (spec 03 section 8.2): previews the old
 * controller, pulls its data into this machine's empty Hercule Home, asks the
 * old controller to switch, and installs the Service Unit.
 *
 * The transfer spends the promotion token, so every refusal that needs no
 * answer from the old controller runs before it. From the moment the transfer
 * is requested, anything that stops the promotion before the old controller
 * seals, an interrupt included, is undone on both machines when it can be:
 * the old controller is asked to cancel, so it serves again, and this Home is
 * emptied, so a retry starts from scratch.
 */
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  ControllerSealed,
  Internal,
  InvalidState,
  PromotionInProgress,
  Unauthenticated,
  Validation,
} from "@hercule/contract";
import {
  buildControllerOrigin,
  isLoopbackHost,
  isWildcardHost,
  type HomePaths,
} from "@hercule/home";
import {
  describeStatus,
  installService,
  prepareServiceInstall,
  type ServiceError,
  type ServiceInstallRequest,
  type Supervisor,
} from "@hercule/service";
import { buildAttachmentsDirectory } from "../attachments";
import { openKeyStore, type MasterKeyBackend } from "../secrets";
import { decodePromotionToken } from "./crypto";
import { PROMOTION_TOKEN_LIFETIME_MS } from "./tokens";
import {
  canonicalizeAnnounceAddress,
  PromotionPreview,
  SWITCH_PATH,
  SwitchAnswer,
  TRANSFER_PATH,
} from "./exchange";
import { readErrorMessage, receiveTransfer, reserveHome } from "./receive";

export class PromoteError extends Schema.TaggedError<PromoteError>()("PromoteError", {
  message: Schema.String,
}) {}

/** What `hercule promote` was asked to do, and where its output goes. */
export interface PromoteOptions {
  /** The old controller's URL, as the user typed it. */
  readonly from: string;
  readonly token: string;
  /** The address runners will be told, as the user typed it with `--address`. */
  readonly address: string | undefined;
  readonly paths: HomePaths;
  readonly bindHost: string;
  readonly bindPort: number;
  readonly backend: MasterKeyBackend;
  /**
   * Asks the user to confirm once the preview is shown, and returns the
   * answer; `undefined` with `--yes`.
   */
  readonly confirm: Effect.Effect<boolean> | undefined;
  /**
   * The service unit to install once the old controller has switched, and the
   * Supervisor that installs it, or `undefined` with `--no-service`.
   */
  readonly service:
    | {
        readonly request: ServiceInstallRequest;
        readonly supervisor: Layer.Layer<Supervisor, ServiceError>;
      }
    | undefined;
  /** Writes one line for the person running the command. */
  readonly out: (line: string) => void;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * How long the old controller gets to answer a preview, a switch or a cancel.
 * Each answers at once, so one that does not is treated as unreachable.
 */
const ANSWER_TIMEOUT_SECONDS = 10;

/** How often, and how long, the switch is tried again when the old controller cannot be reached. */
const SWITCH_RETRY = { schedule: Schedule.spaced(Duration.seconds(1)), times: 4 };

/** The refusals the old controller answers the promotion paths with. */
const Refusal = Schema.Union([
  Unauthenticated,
  Validation,
  InvalidState,
  PromotionInProgress,
  ControllerSealed,
  Internal,
]);

const decodeRefusal = Schema.decodeUnknownEffect(Schema.fromJsonString(Refusal));

/** Returns `text` with a full stop at the end, unless it already ends a sentence. */
const endSentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Returns the address runners will be told: `address` when it is given, or
 * the origin of this machine's bind address. Fails when `address` is not an
 * http(s) origin, or when it is missing and the bind host is loopback or a
 * wildcard, which runners on other machines cannot reach.
 */
export const resolveAnnounceAddress = (
  address: string | undefined,
  bindHost: string,
  bindPort: number,
): Effect.Effect<string, PromoteError> => {
  if (address !== undefined) {
    const canonical = canonicalizeAnnounceAddress(address);
    return canonical === undefined
      ? Effect.fail(
          new PromoteError({
            message: `--address ${address} is not a controller URL: it must be an http or https origin with no user name or password`,
          }),
        )
      : Effect.succeed(canonical);
  }
  if (isWildcardHost(bindHost) || isLoopbackHost(bindHost)) {
    return Effect.fail(
      new PromoteError({
        message:
          `This machine's bind.host is ${bindHost}, which runners on other machines cannot ` +
          `reach. Pass --address with a URL they can open.`,
      }),
    );
  }
  return Effect.succeed(buildControllerOrigin(bindHost, bindPort));
};

/**
 * Fails when `port` on `host` is already taken. Checked before the transfer:
 * once the old controller has switched, a controller here that cannot listen
 * leaves every runner pointing at nothing.
 */
const refusePortInUse = (host: string, port: number): Effect.Effect<void, PromoteError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(port, host, () => {
          server.close(() => resolve());
        });
      }),
    catch: (cause) =>
      new PromoteError({
        message:
          (cause as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? `Port ${String(port)} is already in use on this machine. Stop what listens there, or set another bind.port.`
            : `Cannot listen on ${host}:${String(port)}: ${readErrorMessage(cause)}`,
      }),
  });

/** What the old controller answered a switch with. */
type SwitchOutcome =
  | { readonly _tag: "Sealed" }
  | { readonly _tag: "SealedElsewhere"; readonly newAddress: string }
  | { readonly _tag: "Refused"; readonly message: string }
  | { readonly _tag: "Unreachable"; readonly message: string };

/**
 * What the old controller answered a cancel with. `NotSpent` means it never
 * spent the token, so this promotion never froze it.
 */
type CancelOutcome =
  | { readonly _tag: "Serving" }
  | { readonly _tag: "NotSpent" }
  | { readonly _tag: "Sealed"; readonly newAddress: string }
  | { readonly _tag: "Unknown" };

/** The whole answer of the old controller to one request, body included. */
interface Answer {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

/**
 * The old controller refused the transfer request. It did not freeze for this
 * promotion's token, so there is nothing to cancel.
 */
class TransferRefused extends Schema.TaggedError<TransferRefused>()("TransferRefused", {
  message: Schema.String,
}) {}

/**
 * Runs `hercule promote`. Prints what it does, and fails with a
 * `PromoteError` whose message says what happened to both machines and what
 * to do next. When it is interrupted after the transfer was requested, it
 * settles both machines before it stops, and prints what each was left with.
 */
export const promote = (options: PromoteOptions): Effect.Effect<void, PromoteError> =>
  Effect.gen(function* () {
    const call = options.fetch ?? fetch;
    const { paths, token, backend, out } = options;
    const refuse = (message: string) => new PromoteError({ message });

    // Every refusal that needs no answer from the old controller comes first.
    const tokenBytes = decodePromotionToken(token);
    if (tokenBytes === undefined) {
      return yield* refuse(
        "--token is not a promotion token. Copy the command `hercule controller promotion-token create` printed on the old controller.",
      );
    }
    const from = canonicalizeAnnounceAddress(options.from);
    if (from === undefined) {
      return yield* refuse(
        `--from ${options.from} is not a controller URL: it must be an http or https origin`,
      );
    }
    const announceAddress = yield* resolveAnnounceAddress(
      options.address,
      options.bindHost,
      options.bindPort,
    );

    /**
     * Sends a request with the token, and `body` as JSON, to `path` on the old
     * controller, and returns the response once its headers arrive. Aborting
     * `signal` aborts the request and the reading of its body.
     */
    const sendRequest = (
      method: "GET" | "POST" | "DELETE",
      path: string,
      signal: AbortSignal,
      body?: unknown,
    ): Promise<Response> =>
      call(new URL(path, from).toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });

    /**
     * Sends a request like `sendRequest` and reads the whole answer. Fails as
     * if the old controller cannot be reached when it cannot be, or when the
     * whole answer has not arrived within `ANSWER_TIMEOUT_SECONDS`. The
     * deadline covers the body too, because a proxy or a broken listener can
     * send the headers and then stall. An interrupt aborts the request.
     */
    const fetchAnswer = (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) =>
      Effect.tryPromise({
        try: async (signal): Promise<Answer> => {
          const response = await sendRequest(method, path, signal, body);
          return { ok: response.ok, status: response.status, text: await response.text() };
        },
        catch: (cause) => refuse(`Cannot reach ${from}: ${readErrorMessage(cause)}`),
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(ANSWER_TIMEOUT_SECONDS),
          orElse: () =>
            Effect.fail(
              refuse(
                `${from} did not answer within ${String(ANSWER_TIMEOUT_SECONDS)} seconds, so it cannot be reached`,
              ),
            ),
        }),
      );

    /** Reads a refusal from the old controller, or says what else answered. */
    const readRefusal = (answer: Answer) =>
      decodeRefusal(answer.text).pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.map((refusal) => ({
          refusal,
          message:
            refusal?.error.message ??
            `${from} answered HTTP ${String(answer.status)}, which is not a Hercule controller's answer`,
        })),
      );

    /** Reads a JSON answer from the old controller with `schema`. */
    const readAnswer = <S extends Schema.Top>(answer: Answer, schema: S) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(answer.text).pipe(
        Effect.mapError(() => refuse(`${from} sent an answer this version of Hercule cannot read`)),
      );

    /**
     * Asks the old controller to end the freeze of this transfer, and returns
     * what it answered. A controller that has already sealed answers with the
     * address it sealed to, which is how this machine learns that a switch it
     * never heard the answer to went through.
     */
    const cancelTransfer: Effect.Effect<CancelOutcome> = Effect.gen(function* () {
      const answer = yield* fetchAnswer("DELETE", TRANSFER_PATH);
      if (answer.ok) return { _tag: "Serving" } as const;
      const { refusal } = yield* readRefusal(answer);
      if (refusal instanceof Unauthenticated) return { _tag: "NotSpent" } as const;
      return refusal instanceof ControllerSealed
        ? ({ _tag: "Sealed", newAddress: refusal.error.details.newAddress } as const)
        : ({ _tag: "Unknown" } as const);
    }).pipe(Effect.orElseSucceed(() => ({ _tag: "Unknown" }) as const));

    /** Describes, for an error message, what a cancel did to the old controller. */
    const describeCancel = (outcome: CancelOutcome): string => {
      switch (outcome._tag) {
        case "Serving":
          return `${from} serves again.`;
        case "NotSpent":
          return `${from} did not spend the token, so it still serves.`;
        case "Sealed":
          return `${from} has moved to ${outcome.newAddress}.`;
        case "Unknown":
          return `${from} could not be told to end the transfer, so if it froze for it, it stays read-only until the token expires, at most ${String(PROMOTION_TOKEN_LIFETIME_MS / 60_000)} minutes from when the token was created.`;
      }
    };

    const requestSwitch: Effect.Effect<SwitchOutcome> = Effect.gen(function* () {
      const answer = yield* fetchAnswer("POST", SWITCH_PATH, { newAddress: announceAddress });
      if (answer.ok) {
        // A switch repeated with the same token gets the seal of the first
        // one, which may have come from another machine with another address.
        const { newAddress } = yield* readAnswer(answer, SwitchAnswer);
        return newAddress === announceAddress
          ? ({ _tag: "Sealed" } as const)
          : ({ _tag: "SealedElsewhere", newAddress } as const);
      }
      const { refusal, message } = yield* readRefusal(answer);
      // Anything but a controller's own refusal, such as a proxy's error page,
      // says nothing about whether the switch happened.
      return refusal === undefined || refusal instanceof Internal
        ? ({ _tag: "Unreachable", message } as const)
        : ({ _tag: "Refused", message } as const);
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({ _tag: "Unreachable", message: error.message } as const),
      ),
    );

    /**
     * Pulls the transfer from the old controller into a new file at `file`.
     * Fails with `TransferRefused` when the old controller refuses it, and
     * with `PromoteError` when it cannot be reached or the transfer breaks
     * off.
     *
     * There is no deadline: the answer starts only once the old controller's
     * freeze has let its running work finish and its database is copied,
     * which takes longer the more data there is. An interrupt aborts it.
     */
    const downloadTransfer = (file: string) =>
      Effect.tryPromise({
        try: async (signal): Promise<Answer> => {
          const response = await sendRequest("POST", TRANSFER_PATH, signal).catch(
            (cause: unknown) => {
              throw refuse(`Cannot reach ${from}: ${readErrorMessage(cause)}`);
            },
          );
          if (!response.ok || response.body === null) {
            return { ok: false, status: response.status, text: await response.text() };
          }
          await pipeline(
            Readable.fromWeb(response.body),
            createWriteStream(file, { flags: "wx", mode: 0o600 }),
            { signal },
          );
          return { ok: true, status: response.status, text: "" };
        },
        catch: (cause) =>
          cause instanceof PromoteError
            ? cause
            : refuse(`The transfer broke off: ${readErrorMessage(cause)}`),
      }).pipe(
        Effect.flatMap((answer) =>
          answer.ok
            ? Effect.void
            : readRefusal(answer).pipe(
                Effect.flatMap(({ message }) => new TransferRefused({ message })),
              ),
        ),
      );

    // This Home is reserved from here until the old controller has switched,
    // so no controller can start in it while the promotion writes it. When
    // `homeScope` closes with a failure, the Home is emptied; with a success,
    // the received data stays. Either way the reservation ends before this
    // machine's own controller starts.
    const homeScope = yield* Scope.make();
    /** Ends the reservation and keeps the received data, even if the promotion then fails. */
    const keepReceivedHome = Scope.close(homeScope, Exit.void);

    yield* Effect.gen(function* () {
      const home = yield* reserveHome(paths, backend).pipe(
        Effect.mapError((error) => refuse(error.message)),
      );
      const service = options.service;
      if (service !== undefined) {
        yield* prepareServiceInstall(service.request).pipe(
          Effect.provide(service.supervisor),
          Effect.mapError((error) =>
            refuse(
              `${endSentence(error.message)} To promote without installing the service, add --no-service.`,
            ),
          ),
        );
      }
      yield* refusePortInUse(options.bindHost, options.bindPort);

      out(`Contacting ${from}...`);
      const previewed = yield* fetchAnswer("GET", TRANSFER_PATH);
      if (!previewed.ok) return yield* refuse((yield* readRefusal(previewed)).message);
      const preview = yield* readAnswer(previewed, PromotionPreview);
      out(`Controller ${preview.controllerId} at ${from}.`);
      if (preview.runners.length === 0) out("It has no runners.");
      else {
        out("Its runners:");
        for (const runner of preview.runners) out(`  ${runner.name}  ${runner.connectivity}`);
      }
      out(`They will be told to reconnect to ${announceAddress}.`);
      out(`The data will be written into ${paths.home}.`);
      if (options.confirm !== undefined && !(yield* options.confirm)) {
        return yield* refuse(`Promotion cancelled. ${from} still serves, and the token is unused.`);
      }

      // True from the first switch request until the old controller refuses
      // it: a switch whose answer was lost may have sealed the old
      // controller, and then its runners point here.
      let switchSent = false;

      /**
       * Settles both machines once the promotion stopped before this machine
       * heard that the old controller sealed. Asks the old controller to
       * cancel the transfer; the answer also tells whether it sealed after
       * all.
       *
       * - Sealed to this machine: the promotion went through, so this
       *   succeeds and this Home keeps the data.
       * - Sealed to another address, after a switch from this machine:
       *   another machine switched first with the same token, so it holds no
       *   data. This Home keeps the data, the only fresh copy outside the
       *   sealed old controller, and the error says how to recover.
       * - Cannot be reached, after a switch that may have sealed it: this
       *   Home keeps the data, and the error says how to find out what
       *   happened.
       * - Anything else: the data is not needed here. The error leaves the
       *   scope of the reservation, which empties this Home for a retry.
       *
       * Every error starts with `reason` and says what each machine was left with.
       */
      const settleUnsealed = (reason: string): Effect.Effect<void, PromoteError> =>
        Effect.gen(function* () {
          const cancelled = yield* cancelTransfer;
          if (cancelled._tag === "Sealed" && cancelled.newAddress === announceAddress) {
            yield* keepReceivedHome;
            out("The switch went through, although its answer was lost.");
            return;
          }
          const keyStore = openKeyStore(paths, backend).describe;
          const receivedFiles = `${paths.databaseFile}, ${buildAttachmentsDirectory(paths.dataDir)} and the master key in ${keyStore}`;
          if (switchSent && cancelled._tag === "Sealed") {
            yield* keepReceivedHome;
            return yield* refuse(
              `${endSentence(reason)} ${from} is sealed and has moved to ${cancelled.newAddress}, ` +
                `so its runners now follow that address. Another machine switched first with ` +
                `this promotion token, which may have leaked. That machine received no data, ` +
                `because the transfer came here, so this Home keeps the received data. Start ` +
                `this controller with \`hercule service install\` or \`hercule serve\`, then run ` +
                `\`hercule runner set-controller ${announceAddress}\` on each runner.`,
            );
          }
          if (switchSent && cancelled._tag === "Unknown") {
            yield* keepReceivedHome;
            return yield* refuse(
              `${endSentence(reason)} This machine cannot tell whether the old controller ` +
                `sealed, so this Home keeps the received data. When ${from} answers again, ` +
                `open ${from}/api/v1/controller:\n` +
                `  - if it says the controller moved to ${announceAddress}, start this controller ` +
                `with \`hercule service install\` or \`hercule serve\`;\n` +
                `  - if it still serves, this promotion did not happen: delete ${receivedFiles}, ` +
                `then promote again with a new token.`,
            );
          }
          return yield* refuse(
            `${endSentence(reason)} ${describeCancel(cancelled)} Nothing from this promotion was kept in this Home. Create a new promotion token and try again.`,
          );
        });

      /**
       * Pulls the transfer into this Home, receives it, then asks the old
       * controller to switch to this machine.
       *
       * The transfer is saved whole in the reservation's own directory
       * inside the Home before it is unpacked, so it sits on the same disk
       * as the database it becomes. The reservation created that directory
       * and removes it when it ends.
       */
      const pullReceiveAndSwitch = Effect.gen(function* () {
        // From here on the token is spent.
        out("Pulling the data...");
        const file = join(home.transferDirectory, "transfer");
        yield* downloadTransfer(file);
        const received = yield* receiveTransfer(home, tokenBytes, preview.controllerId, file).pipe(
          Effect.mapError((error) => refuse(error.message)),
        );
        out(
          `Received controller ${received.controllerId}; its secrets are now encrypted under this machine's Master Key.`,
        );

        out(`Asking ${from} to switch to ${announceAddress}...`);
        switchSent = true;
        // The switch can be repeated with the same token, and gets the same answer.
        // The predicate returns a plain boolean on purpose: as a type predicate it
        // would hide that the retries can run out with the switch still unreachable.
        const switched = yield* requestSwitch.pipe(
          Effect.repeat({
            ...SWITCH_RETRY,
            while: (outcome): boolean => outcome._tag === "Unreachable",
          }),
        );
        if (switched._tag === "Refused") {
          switchSent = false;
          return yield* refuse(`The switch failed: ${switched.message}`);
        }
        if (switched._tag === "Unreachable") {
          return yield* refuse(`${from} could not be reached to switch (${switched.message})`);
        }
        if (switched._tag === "SealedElsewhere") {
          return yield* refuse("The switch did not move the controller to this machine.");
        }
      });

      // Whatever stops the promotion once the transfer is requested settles
      // both machines: a refusal, a defect, or an interrupt such as Ctrl-C.
      // The settling is attached before the request is sent, so an interrupt
      // while the old controller prepares the transfer still cancels it. An
      // interrupt cannot be caught, only finalized, so its settling reports
      // through `out`.
      yield* pullReceiveAndSwitch.pipe(
        Effect.catchCause((cause) => {
          const failure = Cause.squash(cause);
          if (failure instanceof TransferRefused) return Effect.fail(refuse(failure.message));
          return settleUnsealed(
            failure instanceof PromoteError
              ? failure.message
              : `Something unexpected went wrong: ${readErrorMessage(failure)}`,
          );
        }),
        Effect.onInterrupt(() =>
          settleUnsealed("The promotion was interrupted.").pipe(
            Effect.match({
              onSuccess: () =>
                out(
                  `The promotion was interrupted after ${from} sealed. Start this controller with \`hercule service install\` or \`hercule serve\`.`,
                ),
              onFailure: (error) => out(error.message),
            }),
          ),
        ),
      );
    }).pipe(Scope.use(homeScope));

    out(`${from} is sealed. Its runners reconnect to ${announceAddress}.`);
    const service = options.service;
    if (service === undefined) return;

    out("Installing the service unit for `hercule serve`.");
    const status = yield* installService(service.request).pipe(
      Effect.provide(service.supervisor),
      Effect.mapError((error) =>
        refuse(
          `The service was not installed. ${endSentence(error.message)} The controller has moved here, so once that is fixed, run \`hercule service install\` rather than promoting again.`,
        ),
      ),
    );
    out(describeStatus(status));
  });
