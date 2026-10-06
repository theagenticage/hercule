import { assert, describe, it } from "vitest";
import { buildSession } from "../threads/workspaces.testing";
import { buildConversationSessionKeys, queryKeys } from "./keys";

/** A thread: a session in no conversation. */
const THREAD = buildSession({ id: "thread-1", conversationId: null });
/** The current sessions of two assistants' conversations. */
const ADA_CURRENT = buildSession({ id: "ada-current", conversationId: "ada-conversation" });
const MILO_CURRENT = buildSession({ id: "milo-current", conversationId: "milo-conversation" });
const KNOWN = [THREAD, ADA_CURRENT, MILO_CURRENT];

describe("buildConversationSessionKeys", () => {
  it("makes nothing stale for a push that names only threads", () => {
    assert.deepStrictEqual(buildConversationSessionKeys([THREAD.id], KNOWN), []);
  });

  it("makes one conversation stale for a push that names its current session", () => {
    assert.deepStrictEqual(buildConversationSessionKeys([ADA_CURRENT.id, THREAD.id], KNOWN), [
      queryKeys.conversationSession("ada-conversation"),
    ]);
  });

  it("lists each stale conversation once", () => {
    assert.deepStrictEqual(
      buildConversationSessionKeys([ADA_CURRENT.id, MILO_CURRENT.id, ADA_CURRENT.id], KNOWN),
      [
        queryKeys.conversationSession("ada-conversation"),
        queryKeys.conversationSession("milo-conversation"),
      ],
    );
  });

  it("makes every conversation stale for a push that names a session the cache does not hold", () => {
    // A new session may have started in any conversation, including one
    // that had no session before, and the push does not say which.
    assert.deepStrictEqual(buildConversationSessionKeys([THREAD.id, "new-session"], KNOWN), [
      queryKeys.conversationSession(),
    ]);
    assert.deepStrictEqual(buildConversationSessionKeys(["new-session"], []), [
      ["conversation-session"],
    ]);
  });

  it("makes every conversation stale for a push that names no ids", () => {
    assert.deepStrictEqual(buildConversationSessionKeys([], KNOWN), [
      queryKeys.conversationSession(),
    ]);
  });

  it("keeps the keys out of the `sessions` prefix, so a session push reaches them only through this rule", () => {
    assert.notStrictEqual(queryKeys.conversationSession("c1")[0], queryKeys.sessions()[0]);
  });
});
