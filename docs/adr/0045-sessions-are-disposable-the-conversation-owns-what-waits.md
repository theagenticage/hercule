# 45. Sessions are disposable; the conversation owns what waits

Date: 2026-10-16

## Status

Accepted by [Assistant rotation, heartbeat and reminders (#94)](https://github.com/theagenticage/hercule/issues/94). Builds on [ADR 0014](./0014-assistants-remember-through-distilled-memory-not-merged-sessions.md): a conversation is a lineage of finite sessions. Amends spec 12 sections 5.1, 5.3 and 8, spec 02, spec 08 and spec 11, which carry dated notes.

## Context

An assistant's conversation lives far longer than any one of its sessions. A session ends for many reasons: a rotation, a crash the session cannot be resumed from, a runner that was retired, an idle unload. Before this decision, the things that wait for an assistant belonged to its session:

- **Subscriptions** were held by the session. A rotation moved them to the successor, so a second code path had to find the successor and rewrite the holder. A session that could never be resumed lost them.
- **Waiting input** belonged to the session. A rotation moved it to the successor with a separate move. A session that could never be resumed had its waiting input cancelled, and the conversation got a "can't be reached" notice asking the owner to send the message again.
- **Rotation** had no state of its own. Whether a session was "rotating" was inferred from its waiting flush input and from which turn last opened. Each reader of that inference had to agree with the others, and several edge cases (a flush that never ran, a resume that failed, a turn that ended without a flush) needed their own handling.
- **Scheduled Wakes** asked the runner to keep a session unloaded through its wake turns, a runner rule with a protocol field of its own, while every wake loaded the session again anyway.

Each piece worked, but each moved state from one session to the next, and each move was a place for a message, a subscription or a reminder to go missing.

## Decision

**A session is disposable. What waits for an assistant belongs to its conversation, and the conversation's newest session that can still take input is where it goes.**

- **One write retires a session.** A rotation sets `sessions.retired_at` when it is asked for, in the transaction that queues the flush. From then on the session gets only its flush, is ended by its runner when the flush turn ends, and is never resumed. A session that cannot be resumed for its flush is retired without one.
- **One rule says where input goes.** A session can still take input when it is not retired and is live, or exited and resumable. The conversation's input goes to its newest session when that session can still take input. When the newest session is retired and still live, the input is stored on it and waits. Otherwise a new session is placed with the input.
- **The next session takes over what waits.** Input still waiting on any of the conversation's sessions that can no longer take input belongs to the conversation. The next session takes all of it over when it is placed, oldest first, ahead of its own input. When such input waits and no session can take it, the controller places the next session with no new input of its own.
- **The conversation holds its Subscriptions.** A session in a conversation that subscribes makes the conversation the holder. A rotation moves nothing, and a subscription ends when its conversation is deleted. A `request:` subscription stays session-held, because a Permission Request belongs to the session that asked.
- **A wake is ordinary input.** A heartbeat or a reminder is given to the conversation's current session by the rule above, and its prompt is not a Conversation Message. Its turn is ordinary activity on the runner. A heartbeat that finds the newest session retired and still live is skipped, because the next heartbeat reaches the successor. A reminder is stored and waits, because a reminder is a promise.

Example: the owner writes "also check the Acme invoice" while a 04:00 rotation's flush is running. The message is stored on the retired session and is never delivered there. When the flush turn ends, the runner ends the session. The controller sees the waiting message when the session exits, and places the next session, which starts with that message.

## Considered options

- **A nullable `session_id` on waiting input, meaning "for the conversation".** Rejected: the input table is a session's queue in name and in every one of its readers, and about twenty queries would have to learn a second shape. Moving the input to the next session when it is placed keeps one shape.
- **Keep moving subscriptions at rotation.** Rejected: a move at rotation does not cover a session that ends unresumably, and the holder that outlives every session is the conversation.
- **Keep the runner's wake idle rule.** Rejected: keeping a session unloaded through its wake turns saves nothing, because every wake loads it again, and the hourly default heartbeat is well past the 15-minute idle wait.

## Consequences

- No owner message, subscription match or reminder is lost when a session ends, and no notice asks the owner to send a message again because a session could not be resumed.
- The rotation code shrinks to one write and one stop. "Is this session rotating" becomes a column read.
- The protocol loses `TurnInput.wake`, and the runner loses its wake idle rule.
- `subscription.query`, `subscription.cancel`, the CLI `--holder` form and an event's `knownBy` gain a `conversation` holder kind. Migration 0084 makes the live subscriptions of conversation sessions conversation-held.
- A Thread is unaffected: it has no conversation, so its input and subscriptions stay its session's.
