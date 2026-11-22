/**
 * What the MCP Gateway does with a `tools/call` (spec 21 sections 3.5 to 3.9):
 * decides whether the call may go on, sends it through the catalogue, tells the
 * Thread about a refusal, and writes the audit entry. It answers every call
 * with a tool result. A refusal is a tool result with `isError: true`.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpSchema } from "effect/ai";
import { ControllerSealed, PromotionInProgress } from "@hercule/contract";
import { absorbFailures } from "../absorbing";
import { buildSessionStamp, type SessionActor } from "../actor";
import { withTransaction } from "../db";
import { AuditLog } from "../events";
import { buildErrorResult, McpCallRefused, McpServerCalls } from "../mcp-servers";
import { PromotionState } from "../promotion";
import { SessionService } from "../sessions";
import type { JsonObject } from "./protocol";
import { makeFreshReads } from "./reads";
import {
  buildMissingGrantRefusal,
  buildNotInListRefusal,
  buildRefusalWarning,
  buildToolNotListedRefusal,
  buildUnknownToolRefusal,
  claimWarning,
  type Refusal,
} from "./refusals";
import { holdsMcpUse } from "./served";
import { findOriginalToolName } from "./tool-names";
import { findOffer, notifyListChanged, type McpSession, type TokenState } from "./tokens";

/**
 * Where an admitted call goes: the server of the called name in the session's
 * list now, and the tool of that server the name stands for. This can be
 * another server than the one the name was offered for (`OfferedTool`), when
 * the offered one was replaced by a server of the same name. An early refusal
 * names the offer, and a refusal after the call is sent names this target.
 */
interface DispatchTarget {
  readonly serverId: string;
  readonly serverName: string;
  readonly tool: string;
}

/** What a call turned out to be, before anything is sent. */
type CallDecision =
  | { readonly _tag: "refused"; readonly refusal: Refusal }
  | { readonly _tag: "call"; readonly target: DispatchTarget };

/** How an audited call ended. */
type CallOutcome =
  | { readonly _tag: "answered" }
  | { readonly _tag: "refused"; readonly reason: string }
  | { readonly _tag: "failed" };

const isPromotionRefusal = (error: unknown): error is ControllerSealed | PromotionInProgress =>
  error instanceof ControllerSealed || error instanceof PromotionInProgress;

/** Builds the policy every `tools/call` goes through. */
export const makeCallPolicy = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reads = yield* makeFreshReads;
  const sessionService = yield* SessionService;
  const catalogue = yield* McpServerCalls;
  const audit = yield* AuditLog;
  const promotion = yield* PromotionState;

  /**
   * Reads what a call means and whether it may go on, without sending anything.
   * This is the one place that admits a call by its name. `session` is the MCP
   * session the call arrives on, or `undefined` in the stateless era.
   */
  const decideCall = (
    state: TokenState,
    session: McpSession | undefined,
    actor: SessionActor,
    toolName: string,
  ): Effect.Effect<CallDecision> =>
    Effect.gen(function* () {
      if (!holdsMcpUse(actor)) return { _tag: "refused", refusal: buildMissingGrantRefusal() };
      // A call is accepted only under a name `tools/list` offered on the MCP
      // session it arrives on (to the token, in the stateless era). That proves
      // this client was offered the name and saw what it stands for now. A name
      // a client remembers from before a restart or an upgrade is refused
      // once, and the streams are told to list again. The refusal names what
      // the name was offered for, whatever the records say today.
      const offered = findOffer(state, session, toolName);
      if (offered === undefined) {
        yield* notifyListChanged(state);
        return { _tag: "refused", refusal: buildUnknownToolRefusal(toolName) };
      }
      // The server the name reaches is the one of that name in the session's
      // list now, which may be another account than the one the name was
      // offered for. Whether it is ready is the catalogue's decision, made
      // when the call is sent.
      const listed = yield* reads.readListedServerNamed(actor.sessionId, offered.serverName);
      if (listed === undefined) {
        return { _tag: "refused", refusal: buildNotInListRefusal(offered) };
      }
      const tool = findOriginalToolName(offered.serverName, listed.toolNames, toolName);
      if (tool === undefined) {
        return { _tag: "refused", refusal: buildToolNotListedRefusal(offered) };
      }
      // Two tools of one server whose names clash by the 24-bit hash can trade
      // a name when the server's list changes. The offer holds what the name
      // was offered for, so this one comparison stops the call from reaching
      // the other tool before the client lists again.
      if (tool !== offered.tool) {
        yield* notifyListChanged(state);
        return { _tag: "refused", refusal: buildUnknownToolRefusal(toolName) };
      }
      return {
        _tag: "call",
        target: { serverId: listed.id, serverName: offered.serverName, tool },
      };
    });

  /**
   * Checks again, from the database and not from the token cache, right
   * before the catalogue sends a request upstream, that the call is still
   * allowed: the token still resolves, the profile still holds `mcp.use`, and
   * the server is still in the session's list.
   */
  const authorizeCall = (
    tokenHash: string,
    serverId: string,
  ): Effect.Effect<void, McpCallRefused> =>
    Effect.gen(function* () {
      const actor = yield* reads.resolveActor(tokenHash);
      if (Option.isNone(actor)) {
        return yield* new McpCallRefused({
          reason: "error",
          message: "This session has ended, so the MCP tool call was not sent.",
        });
      }
      if (!holdsMcpUse(actor.value)) {
        return yield* new McpCallRefused({
          reason: "missing-grant",
          message: buildMissingGrantRefusal().message,
        });
      }
      const listed = yield* reads.readListedServerIds(actor.value.sessionId);
      if (!listed.includes(serverId)) {
        return yield* new McpCallRefused({
          reason: "not-in-list",
          message:
            "The MCP server is not in this Thread's list any more, so the tool call was not sent.",
        });
      }
    });

  /**
   * Tells the Thread about a refusal, unless it was told already in this turn
   * (or this minute, outside a turn). A failed write is logged and changes
   * nothing for the agent.
   */
  const warnThread = (state: TokenState, refusal: Refusal): Effect.Effect<void> => {
    const warnings = state.warnings;
    return absorbFailures(
      "Writing the warning about a refused MCP tool call failed",
      warnings.writing.withPermits(1)(
        Effect.gen(function* () {
          const turnId = yield* sessionService.readOpenTurnId(state.sessionId);
          if (!claimWarning(warnings.seen, refusal, turnId, Date.now())) return;
          // `unknown-tool` names a reason only a tool name can have, so such a
          // line names no server.
          yield* sessionService.writeRuntimeWarning(
            state.sessionId,
            buildRefusalWarning(refusal),
            refusal.reason === "unknown-tool" || refusal.server === undefined
              ? undefined
              : [{ mcpServerId: refusal.server.id, reason: refusal.reason }],
          );
        }),
      ),
    );
  };

  /** Writes the audit entry of one call. Never holds the arguments or the result. */
  const auditCall = (
    actor: SessionActor,
    server: { readonly id: string; readonly name: string } | undefined,
    tool: string | undefined,
    outcome: CallOutcome,
    durationMs: number,
  ): Effect.Effect<void> =>
    absorbFailures(
      "Writing the audit entry of an MCP tool call failed",
      withTransaction(
        sql,
        audit.append({
          kind: "mcpTool.called",
          actor: buildSessionStamp(actor.sessionId),
          payload: {
            sessionId: actor.sessionId,
            mcpServerId: server?.id ?? null,
            tool: tool ?? null,
            outcome: outcome._tag,
            ...(outcome._tag === "refused" ? { reason: outcome.reason } : {}),
            durationMs,
          },
        }),
      ),
    );

  /**
   * Handles a call the controller is frozen or sealed for: writes one line to
   * the controller's log and answers with the gate's message. Nothing is
   * written to the database, so there is no audit entry and no Thread line.
   * The one place that decision lives (spec 21 section 3.9).
   */
  const refuseWhileNotServing = (
    sessionId: string,
    serverName: string | undefined,
    tool: string | undefined,
    gateMessage: string,
  ): Effect.Effect<McpSchema.CallToolResult> =>
    Effect.as(
      Effect.logInfo(
        `MCP gateway: refused a tool call while the controller does not serve. session ${sessionId}, ` +
          `server ${serverName ?? "-"}, tool ${tool ?? "-"}, reason: ${gateMessage}`,
      ),
      buildErrorResult(gateMessage),
    );

  const executeCall = (
    state: TokenState,
    actor: SessionActor,
    call: { readonly arguments: JsonObject | undefined },
    decision: CallDecision,
  ): Effect.Effect<McpSchema.CallToolResult> => {
    const startedAt = Date.now();
    let server: { readonly id: string; readonly name: string } | undefined;
    let tool: string | undefined;
    // Whatever happens after the call is accepted, one entry is written: a
    // call that is interrupted or dies ends as `failed`.
    let outcome: CallOutcome = { _tag: "failed" };
    // The catalogue found the controller frozen or sealed after all: that
    // refusal is logged and answered, never audited (spec 21 section 3.9).
    let notServing = false;

    const refuse = (refusal: Refusal): Effect.Effect<McpSchema.CallToolResult> => {
      server = refusal.server;
      tool = refusal.tool;
      outcome = { _tag: "refused", reason: refusal.reason };
      return Effect.as(warnThread(state, refusal), buildErrorResult(refusal.message));
    };

    const run =
      decision._tag === "refused"
        ? refuse(decision.refusal)
        : Effect.suspend(() => {
            const { target } = decision;
            server = { id: target.serverId, name: target.serverName };
            tool = target.tool;
            return catalogue
              .callTool({
                upstreamScope: state.tokenHash,
                serverId: target.serverId,
                tool: target.tool,
                arguments: call.arguments,
                authorize: authorizeCall(state.tokenHash, target.serverId),
              })
              .pipe(
                Effect.map((result) => {
                  outcome = { _tag: "answered" };
                  return result;
                }),
                Effect.catchTag("McpCallRefused", (refused) => {
                  if (refused.controllerNotServing === true) {
                    notServing = true;
                    return refuseWhileNotServing(
                      actor.sessionId,
                      target.serverName,
                      target.tool,
                      refused.message,
                    );
                  }
                  return refuse({
                    reason: refused.reason,
                    server: { id: target.serverId, name: target.serverName },
                    tool: target.tool,
                    message: refused.message,
                  });
                }),
              );
          });

    return run.pipe(
      Effect.onExit(() =>
        notServing
          ? Effect.void
          : Effect.uninterruptible(auditCall(actor, server, tool, outcome, Date.now() - startedAt)),
      ),
    );
  };

  /**
   * Runs `executeCall` admitted, so that a freeze waits for the call and its
   * audit entry, and so that nothing here writes once the database stops
   * accepting writes. Answers with the gate's message instead, and writes
   * nothing, when the controller is frozen or sealed.
   */
  const admitExecution = (
    state: TokenState,
    actor: SessionActor,
    call: { readonly arguments: JsonObject | undefined },
    decision: CallDecision,
  ): Effect.Effect<McpSchema.CallToolResult> =>
    promotion
      .admit(executeCall(state, actor, call, decision))
      .pipe(
        Effect.catchIf(isPromotionRefusal, (gate) =>
          refuseWhileNotServing(
            actor.sessionId,
            decision._tag === "call" ? decision.target.serverName : decision.refusal.server?.name,
            decision._tag === "call" ? decision.target.tool : undefined,
            gate.error.message,
          ),
        ),
      );

  return {
    /**
     * Refuses a call that was never started, because its token already runs
     * the most calls it may. Audits the refusal and tells the Thread like every
     * other refusal, and returns the tool result with `isError: true`. Never
     * fails.
     */
    refuseCall: (
      state: TokenState,
      actor: SessionActor,
      refusal: Refusal,
    ): Effect.Effect<McpSchema.CallToolResult> =>
      admitExecution(state, actor, { arguments: undefined }, { _tag: "refused", refusal }),

    /**
     * Runs one `tools/call` that arrives on `session` (`undefined` in the
     * stateless era) and returns its tool result: the
     * server's answer, or a refusal with `isError: true`. Never fails: a
     * defect is left to the caller.
     */
    runToolCall: (
      state: TokenState,
      session: McpSession | undefined,
      actor: SessionActor,
      call: { readonly name: string; readonly arguments: JsonObject | undefined },
    ): Effect.Effect<McpSchema.CallToolResult> =>
      Effect.gen(function* () {
        const startedAt = Date.now();
        // A call interrupted or killed while it is being decided still gets
        // its entry, as `failed`. While the controller is frozen or sealed the
        // gate refuses the write, and then the call goes unaudited as spec 21
        // section 3.9 says of every call in that window.
        const decision = yield* decideCall(state, session, actor, call.name).pipe(
          Effect.onError(() =>
            Effect.uninterruptible(
              promotion
                .admit(
                  auditCall(
                    actor,
                    undefined,
                    undefined,
                    { _tag: "failed" },
                    Date.now() - startedAt,
                  ),
                )
                .pipe(Effect.catchIf(isPromotionRefusal, () => Effect.void)),
            ),
          ),
        );
        return yield* admitExecution(state, actor, call, decision);
      }),
  };
});
