# Research: Discord and Slack platform facts for the channel contribution

**Question:** which gateway intents, OAuth scopes, event subscriptions, message limits, typing-indicator options and click-delivery mechanics do the Discord and Slack channel plugins rely on, given an outbound-only connection (Discord gateway, Slack Socket Mode)?

**Context:** [Channel contribution interface and conversation ingress (Discord, Slack)](https://github.com/rogierpennink/hydra/issues/39); consumed by `docs/spec/12-assistants.md` section 11.4.

**Verified:** 2026-08-30 against docs.discord.com/developers and docs.slack.dev (both doc sites moved from their old URLs).


## Discord

1. Intents. OK: GUILDS (also covers THREAD_CREATE/UPDATE/DELETE/LIST_SYNC/MEMBER_UPDATE), GUILD_MESSAGES (MESSAGE_CREATE/UPDATE/DELETE), DIRECT_MESSAGES, MESSAGE_CONTENT (privileged).
   FIX: threshold is no longer "100 guilds". Since June 2026 it is 10,000 unique users across all guilds; below that, toggle in Developer Portal, no application.
   NOTE: without MESSAGE_CONTENT you still get content for DMs with the app and messages that @mention the app - so a mention/DM-only bot can skip the privileged intent. Replies-to-bot without a mention need MESSAGE_CONTENT.
   GUILD_MESSAGE_REACTIONS not needed for reply/thread detection. INTERACTION_CREATE is intent-less ("Any events not listed ... will always be sent to your app").
   Reply detection: message.type 19 (REPLY), message_reference {message_id, channel_id, guild_id}, referenced_message (null if deleted). Check referenced_message.author.id == bot user id.
   Thread detection: MESSAGE_CREATE carries channel_id (= thread id) and, per the gateway-events doc, a channel_type field; thread channel types 10/11/12; thread channel object has parent_id (parent text channel). GUILD_CREATE includes a threads[] array; THREAD_CREATE/THREAD_LIST_SYNC keep it current. Bots must use API v9+ for thread events.
   https://docs.discord.com/developers/events/gateway  https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review  https://docs.discord.com/developers/events/gateway-events  https://docs.discord.com/developers/topics/threads

2. Limits. OK: content 2000; embed description 4096, title 256, field value 1024, 6000 combined across embeds. Markdown: docs only say "a subset of markdown"; in practice bold/italic/strike/code/code blocks/headers (# ## ###)/lists/quotes render in content. Masked links [text](url): FIX - they DO render in app/bot/webhook-authored message content (users typing them do not get rendering; Discord shows a warning if text looks like a different URL). Embeds also support them. Not stated in official API docs; from support/community sources - treat as "works, low risk".
   https://docs.discord.com/developers/resources/message  https://docs.discord.com/developers/reference#message-formatting

3. Typing. OK: POST /channels/{id}/typing "expires after 10 seconds", 204 on success; doc says bots should generally not use it except when "responding to a command and expects the computation to take a few seconds". Re-send every ~8s while working.
   https://docs.discord.com/developers/resources/channel (Trigger Typing Indicator)

4. Buttons/interactions. OK: Action Row type 1, Button type 2, custom_id 1-100 chars (unique per message), label max 80; 5 buttons per row, 5 rows per message (legacy; components v2 = 40 components). INTERACTION_CREATE type 3 MESSAGE_COMPONENT. Must respond within 3s or token invalidates; type 6 DEFERRED_UPDATE_MESSAGE, 7 UPDATE_MESSAGE, 4/5 for new message. Ephemeral flag 64. Follow-up edit: PATCH /webhooks/{app_id}/{token}/messages/@original; token valid 15 min. Interaction carries member (guild) or user (DM), channel_id, message (the message the button was on).
   OK: gateway vs Interactions Endpoint URL are "mutually exclusive"; with no URL set, interactions arrive over the gateway.
   https://docs.discord.com/developers/interactions/receiving-and-responding  https://docs.discord.com/developers/components/reference

5. DMs. OK: bot opens DM via POST /users/@me/channels (recipient must share a guild; docs warn "DMs should generally be initiated by a user action"). OK: "Bots cannot have friends or be added to or join Group DMs." Group DM creation needs user tokens with gdm.join.
   https://docs.discord.com/developers/resources/user#create-dm  https://docs.discord.com/developers/topics/oauth2

12. Threads. OK: POST /channels/{channel.id}/messages/{message.id}/threads creates a thread from a message (GUILD_TEXT -> PUBLIC_THREAD, GUILD_ANNOUNCEMENT -> ANNOUNCEMENT_THREAD; thread id == message id; not for forum/media channels).
   https://docs.discord.com/developers/resources/channel

## Slack

6. Socket Mode. OK: two tokens - app-level xapp- with connections:write ("Grants permission to generate websocket URIs and connect to Socket Mode", used by apps.connections.open) plus bot xoxb- for Web API. Socket Mode apps not allowed in public Marketplace. Event subs OK: message.channels/groups/im/mpim + app_mention (app_mention does NOT fire in DMs - use message.im). Scopes OK as listed; thread replies arrive as ordinary message events (no extra scope); conversations.replies to fetch a thread uses the same *:history scopes. NOTE: bot must be a member of a channel to receive its messages.
   https://docs.slack.dev/apis/events-api/using-socket-mode  https://docs.slack.dev/reference/scopes/connections.write  https://docs.slack.dev/reference/events/app_mention  https://docs.slack.dev/reference/methods/conversations.replies

7. Limits. OK: text truncated above 40,000 chars (Slack recommends <= 4,000); 50 blocks per message; section text 3000 (fields: 10 x 2000); header 150; actions block max 25 elements. mrkdwn OK (*bold*, _italic_, ~strike~, <url|text>, no # headings, escape & < >). NOTE: there is now a `markdown` block that renders standard markdown (**bold**, [text](url), headings, lists, tables, code); cumulative 12,000 chars per payload; messages surface only; docs say "for apps that use platform AI features".
   https://docs.slack.dev/reference/methods/chat.postMessage  https://docs.slack.dev/reference/block-kit/blocks  https://docs.slack.dev/reference/block-kit/blocks/markdown-block  https://docs.slack.dev/messaging/formatting-message-text

8. Typing. FIX/NOTE: assistant.threads.setStatus is being superseded by agents.sessions.setStatus (scope chat:write; assistant:write still accepted for the old one). agents.sessions.setStatus works in three contexts: session channels (no thread_ts), "thread-based sessions in regular channels" (thread_ts required), and DM threads (thread_ts required). So a "thinking" status IS available in ordinary channel threads via agents.sessions.setStatus, but requires the Agents feature toggled on (which adds assistant:write and makes every DM a thread; workspace guests cannot use Agents-enabled apps). Status does not clear automatically: set status "active" when done or it times out after 1 hour. assistant.threads.setStatus errors with method_not_supported_for_channel_type outside supported conversation types. Streaming (chat.startStream/appendStream/stopStream, chat:write) works in channels, threads and DMs. Fallback: reactions.add (reactions:write; channel, name, timestamp) on the inbound message - works everywhere.
   https://docs.slack.dev/reference/methods/agents.sessions.setStatus  https://docs.slack.dev/reference/methods/assistant.threads.setStatus  https://docs.slack.dev/ai/developing-ai-apps  https://docs.slack.dev/reference/methods/chat.startStream  https://docs.slack.dev/reference/methods/reactions.add

9. Buttons. OK: actions block; button text max 75, action_id max 255, value max 2000, url max 3000; block_actions payload with user.id, user.team_id, team.id, channel.id, message, actions[].action_id/value/block_id, response_url, trigger_id. Socket Mode envelope type "interactive"; ack by sending {"envelope_id": ...}. NOTE: Socket Mode doc only says "acknowledge each event so Slack knows whether to retry"; the 3-second figure is stated for HTTP delivery (Events API + interactivity) - safe to apply the same. response_url: replace_original / delete_original / ephemeral default, max 5 uses in 30 min; chat.update for later edits.
   https://docs.slack.dev/interactivity/handling-user-interaction  https://docs.slack.dev/reference/block-kit/block-elements/button-element  https://docs.slack.dev/apis/events-api

10. Detection. OK: thread_ts present => in a thread; thread_ts == ts => parent, != ts => reply (message_replied subtype is missing over Events API - rely on thread_ts). DMs: channel_type "im" (channel ids start with D); "mpim" for group DMs. Bot-authored: presence of bot_id (and bot_profile/app_id); subtype bot_message only for legacy integrations without a user. Own messages: compare bot_id / user with auth.test response (user_id, bot_id, team_id).
   https://docs.slack.dev/reference/events/message  https://docs.slack.dev/reference/events/message/message_replied  https://docs.slack.dev/messaging/retrieving-messages  https://docs.slack.dev/reference/methods/auth.test

11. IDs. OK with nuance: legacy "U" ids are per-workspace; in Enterprise Grid, "W"/"U" enterprise ids represent the user across all workspaces of the org. Always key on (team_id, user_id) (or enterprise_id). A non-distributed app is installed per workspace. Discord user ids (snowflakes) are global.
   https://docs.slack.dev/enterprise-grid/

12. Threads. OK: reply in thread = chat.postMessage with thread_ts = parent's ts (never a reply's ts); reply_broadcast optional. ~1 message/sec per channel.
   https://docs.slack.dev/reference/methods/chat.postMessage
