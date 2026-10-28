/**
 * Tests that every kind of adapter failure maps to the reaction the
 * controller promises for it: the groups are the ones in the docs of
 * `decideRefusedInputReaction`.
 */
import { describe, expect, it } from "vitest";
import {
  AdapterFailed,
  HarnessLoginMissing,
  HarnessNotInstalled,
  HarnessProtocolError,
  InputNotDelivered,
  ModelChangeRefused,
  ResumeTranscriptMissing,
  SessionAlreadyRunning,
  SessionNotRunning,
  SteerRefused,
  type AdapterError,
} from "@hercule/protocol";
import { decideRefusedInputReaction, type RefusedInputReaction } from "./refused-input";

const message = "a message";

const REACTIONS: ReadonlyArray<{
  readonly error: AdapterError;
  readonly reaction: RefusedInputReaction;
}> = [
  { error: new SessionNotRunning({ message }), reaction: "requeue" },
  { error: new InputNotDelivered({ message }), reaction: "requeue" },
  { error: new SessionAlreadyRunning({ message }), reaction: "requeue" },
  { error: new AdapterFailed({ message }), reaction: "requeue" },
  { error: new SteerRefused({ message }), reaction: "requeueSteer" },
  { error: new ModelChangeRefused({ message }), reaction: "fail" },
  { error: new HarnessNotInstalled({ message }), reaction: "fail" },
  { error: new HarnessLoginMissing({ message }), reaction: "fail" },
  { error: new ResumeTranscriptMissing({ message }), reaction: "fail" },
  { error: new HarnessProtocolError({ message }), reaction: "fail" },
];

describe("decideRefusedInputReaction", () => {
  it.each(REACTIONS)("reacts to $error._tag with $reaction", ({ error, reaction }) => {
    expect(decideRefusedInputReaction(error)).toBe(reaction);
  });
});
