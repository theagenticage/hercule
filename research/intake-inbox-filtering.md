# Research: how inboxes decide what reaches you

Ticket: [#382](https://github.com/theagenticage/hercule/issues/382), part of [#380](https://github.com/theagenticage/hercule/issues/380).

Sources are the products' own docs, help centers, changelogs and blogs, read on 2026-10-04. Inbox Zero is read from its own source code at commit `ed5f8de1`. Superhuman's help pages refuse web fetches, so they were read through Zendesk's public article API; the text is the same. Anything a primary source did not confirm is marked **unconfirmed**.

## The short answer

- **Nobody shows the whole stream.** Every product has a bulk tier (newsletters, promotions, receipts, automated updates) that is routed away before the user sees it. A fixed rule, the user's per-sender choice, or a model does the routing. The user never sorts the raw stream by hand.
- **Developer tools use fixed rules; mail clients use models.** GitHub, Linear and Slack decide by fixed rules plus the user's settings: you are subscribed because you were assigned, mentioned, asked to review, or you watch the thing. Gmail, Outlook, Apple Mail and Superhuman use a model to sort mail. HEY is the outlier: the user decides once per sender, and nothing is automatic.
- **The LLM products converge on one small set of outcomes.** Respond (someone asked something of you), Waiting (you asked, no answer yet), FYI, and a few bulk kinds (newsletter, marketing, notification, receipt). Superhuman, Fyxer, Lindy and Inbox Zero all land on nearly the same list.
- **Rules first, model second.** Where both exist, fixed checks and the user's explicit rules run first and the model decides only what is left. Inbox Zero's code states this order outright.
- **Corrections become visible rules, not hidden retraining.** Most products turn "this was wrong" into a per-sender or per-domain rule, or into an edited instruction. Superhuman says outright that removing a wrong label "does not create a rule or teach" the assistant. Only Gmail's importance model (and Outlook's Focused Inbox) document learning per user from corrections.
- **Hidden, not deleted.** Held-back items go to a tab, folder or label and stay findable. Deleting is opt-in where it exists at all.
- **Almost nothing leaves on its own when the work is done elsewhere.** GitHub, Linear and Slack document no auto-clear when the PR merges or the issue closes. Lindy's "Remove on reply" is the one documented case of an item leaving because the user answered.

## Summary table

| Product | Lands in the to-do list | Held elsewhere | Who decides | How the user corrects | Learns from corrections |
|---|---|---|---|---|---|
| GitHub | notifications on threads you are subscribed to | nothing held; filters only change the view | fixed rules + your watch settings | unsubscribe, unwatch, custom watch, ignore | no (no model) |
| Linear inbox | events on issues you are subscribed to | new Priority tab splits "needs attention" from "can wait" | fixed rules; Priority default unconfirmed | unsubscribe, channel settings, Priority filter | no (no model documented) |
| Linear Triage | team-level holding area for issues from integrations and outsiders | the whole Triage view is held away from normal views | fixed rule (where it came from); a model suggests fields | accept, decline, plain-English guidance | not documented |
| Slack | DMs, mentions, thread replies, reactions, app notifications | muted channels; channels set to "Just mentions" | your settings + fixed rules; AI sorting "the next phase" | mute, per-channel level, keywords, VIPs | no (no model in Activity) |
| Gmail tabs | Primary | Social, Promotions, Updates, Forums | a model | drag to another tab; a filter per sender | unclear (Google's pages disagree) |
| Gmail importance | Important and unread (Priority Inbox) | Everything else | a per-user model | click the importance marker | yes, per user |
| HEY | the Imbox | Screener, The Feed, Paper Trail, Screened Out | you, once per sender | change the sender's destination; all past mail moves too | no (no model) |
| Superhuman | Important split (and custom splits) | Other split; Auto Archived folder | Gmail's model + AI Auto Labels + your rules | move this thread, this sender, or this domain | no, says so explicitly |
| Apple Mail | Primary, Priority Messages on top | Transactions, Updates, Promotions | a model | Categorize Sender (per sender) | not documented |
| Outlook Focused | Focused | Other | a model | move between tabs; "Always move" per sender | yes |
| Outlook Copilot Prioritize | high-priority arrow | low-priority arrow; nothing moves | an LLM steered by your instructions | edit the instructions | no; old mail is not re-evaluated |
| Inbox Zero | To Reply, FYI, Awaiting Reply (labels) | Newsletter, Marketing, Cold Email: label and archive | fixed checks, learned sender patterns, static rules, then an LLM | Fix in History; label changes; remove a learned pattern | yes, as visible sender patterns |

## GitHub

**What lands.** "All of the notifications that you haven't unsubscribed to or marked as **Done**" ([inbox](https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox)). You get subscribed to a thread when you are assigned, open it, comment, are @mentioned, change its state, a team of yours is @mentioned, or you click Watch or Subscribe ([about](https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications)).

Every notification carries a `reason` ([REST](https://docs.github.com/en/rest/activity/notifications)): `assign`, `author`, `comment`, `ci_activity`, `invitation`, `manual`, `mention`, `review_requested`, `security_alert`, `state_change`, `subscribed` (you watch the repo), `team_mention`, `approval_requested`, `member_feature_requested`, `security_advisory_credit`. The reason is the "why am I seeing this" for every item.

**What is held back.** Nothing goes to a second place. Instead, scope is set up front: "participating" (you commented or were mentioned) versus "watching" (everything in a repo), with Custom watch to pick event kinds and Ignore to drop a repo ([configuring](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications)). Default filters - Assigned, Participating, Mentioned, Team mentioned, Review requested - and up to 15 custom filters (`reason:`, `repo:`, `is:`, `author:`, `org:`) only change the view ([filters](https://docs.github.com/en/subscriptions-and-notifications/reference/inbox-filters)).

**Who decides.** Fixed rules plus your settings. No model.

**Correcting.** Unsubscribe "removes the notification from your inbox and unsubscribes you from the conversation until you are @mentioned, a team you're on is @mentioned, or you're requested for review." So the direct asks always break back through. Per thread, you can choose to hear only when a PR merges or a thread closes ([single notification](https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/triaging-a-single-notification)).

**Leaving.** Done removes the item. Read keeps it. Anything not saved expires after 3 months ([changelog 2026-04-24](https://github.blog/changelog/2026-04-24-changes-to-notification-retention-and-archived-repository-watches/)). No auto-removal when a PR merges is documented.

## Linear

**Inbox.** "Key events on your subscribed issues." You are auto-subscribed when you create an issue, are assigned it, or are mentioned. "You cannot choose which notifications go to your Inbox. All notifications will arrive there" ([inbox](https://linear.app/docs/inbox)). Event kinds are toggled per channel (desktop, mobile, Slack, email) in groups only ([notifications](https://linear.app/docs/notifications)). Email can be a digest, and is "only sent if you haven't already read the Linear inbox notification."

A new Priority tab "separates what needs your attention from what can wait." "Linear selects what appears in Priority by default, with the option to customize it by choosing notification sources or creating a filter" ([changelog 2026-09-03](https://linear.app/changelog/2026-09-03-priority-inbox)). Whether that default is a rule or a model is **unconfirmed**.

**Triage** is a separate team-level holding area, "a special inbox for your team" ([triage](https://linear.app/docs/triage)). Issues land there when an integration creates them (Slack, Sentry, Intercom, Zendesk and others) or someone outside the team files them. Triage issues are hidden from all other views. A person then accepts (moves it to the team's default status), declines, marks it a duplicate, or snoozes it until a time "or when there's new activity on that issue: whichever comes first." Triage Rules are fixed rules that set fields, running "top down."

**Triage Intelligence** is the model part ([docs](https://linear.app/docs/triage-intelligence)). It suggests team, project, assignee and labels, and spots duplicates and related issues. It does not decide whether something reaches anyone. Each suggestion can be shown, hidden or auto-applied, and auto-applied values are "clearly marked" ([changelog](https://linear.app/changelog/2025-09-19-auto-apply-triage-suggestions)). Hovering shows the reasoning. The user steers it with plain-English "additional guidance" at workspace or team level. It runs on GPT-5 and Gemini 2.5 Pro, and the UI keeps "what came from the system and what came from your team" visibly apart ([blog](https://linear.app/now/how-we-built-triage-intelligence)).

**Leaving.** Delete, mark read, or snooze. Past 2,000 open notifications, older ones are archived. No auto-clear when the issue is completed is documented.

## Slack

**What lands.** The Activity view (it replaced "Mentions & reactions" in April 2026) collects DMs, mentions, thread replies, reactions, invitations, app notifications, reminders, and posts from channels set to "All new posts" ([help](https://slack.com/help/articles/46751260742035-Introducing-the-new-Activity-view-in-Slack)). Filters include VIP and Cleared ([help](https://slack.com/help/articles/19693583638803-Get-your-work-done-from-the-Activity-view)).

**What is held back.** The global setting is "Everything" or "Mentions and direct messages" ([configure](https://slack.com/help/articles/201355156-Configure-your-Slack-notifications)). Per channel: "All new posts", "Just mentions", or Mute ([per-channel](https://slack.com/help/articles/360056534254-Manage-notifications-for-specific-channels-and-direct-messages)). Keywords match exactly. You auto-follow threads you started, replied to, or were mentioned in.

**Who decides.** Your settings plus fixed rules. AI sorting is not shipped: "The next phase is intelligent prioritization... a feed that learns what's important to you" ([blog, May 2026](https://slack.com/blog/news/slack-activity-triage-for-notifications)). AI lives beside Activity instead: Today, a daily briefing in beta ([help](https://slack.com/help/articles/51262305668371-Start-your-day-with-Today)), and Recaps of channels "you visit often, but don't tend to participate in" ([AI guide](https://slack.com/help/articles/25076892548883-Guide-to-AI-features-in-Slack)). AI-generated action items for mentions with "a follow-up, deadline, or request" were announced as coming soon in July 2025 ([blog](https://slack.com/blog/news/ai-productivity-tools-slack)); whether they shipped is **unconfirmed**.

**Leaving.** Read keeps an item in the feed; Clear hides it ([legacy article](https://slack.com/help/articles/45573197224467-Triage-notifications-from-the-Activity-tab--legacy-)). No auto-clear on resolution is documented.

## Gmail

**What lands.** Primary: "Emails from people you know and messages that don't appear in other tabs" ([tabs](https://support.google.com/mail/answer/3094499)). Social, Promotions, Updates ("may not need immediate attention") and Forums hold the rest. Users cannot add categories ([categories](https://support.google.com/mail/answer/3055016)). Priority Inbox is a separate layout: "Important and unread", "Starred", "Everything else" ([Priority Inbox](https://support.google.com/mail/answer/186531)).

**Who decides.** A model. Tabs use "a combination of neural network-based machine learning and heuristic algorithms" ([blog, 2023](https://blog.google/products-and-platforms/products/gmail/gmail-ai-features/)). Importance uses whom you email and how often, which mails you open, reply to, star, archive or delete, and keywords in mail you usually read ([importance](https://support.google.com/mail/answer/186543)).

**Correcting.** Drag a mail to another tab, or write a filter that sends a sender to a category. Click the importance marker: it "helps Gmail learn which emails you think are important." A "do this for future messages" prompt when moving between tabs is **unconfirmed** on current Google pages. Google's pages disagree on whether tabs learn per user.

**The Priority Inbox paper** ([Aberdeen, Pacovsky, Slater, 2010](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/36955.pdf)) is the clearest public account of an importance model:

- It ranks mail "by the probability that the user will perform an action on that mail" (open, reply, manual correction) within a window of days.
- Features fall into four groups: social (how much sender and user interact), content, thread (the user's history with the thread), and labels the user's own filters apply.
- Each score is a global model plus a small per-user model. A manual correction weighs more than ordinary use.
- Each user has their own threshold, nudged in real time when they correct in one direction.
- Users spent "13% less time reading unimportant mail."

**AI Inbox** (announced January 2026, beta, US English, paid plan) shows "Suggested to-dos" and "Topics to catch up on" ([help](https://support.google.com/mail/answer/16845247), [blog](https://blog.google/products-and-platforms/products/gmail/gmail-is-entering-the-gemini-era/)). It "Only surfaces information from messages in your 'Primary' tab", so it runs on top of the bulk filter, not instead of it. Users can mark done, remove a to-do, or give thumbs up or down. Whether that feedback changes future results is not stated.

## HEY

**What lands.** The Imbox: "important, immediate emails... from people or services you care about" ([help](https://help.hey.com/article/759-imbox)).

**What is held back.** "When someone emails your @hey.com address for the very first time, they don't get straight through, they land in The Screener" ([how it works](https://www.hey.com/how-it-works/)). The user screens each sender in or out once. Screened-in senders go to one of three places: the Imbox, The Feed ("newsletters, promotional emails, and long-reads"), or the Paper Trail (receipts and "transactional email clutter"). Screened-out mail never reaches you and is deleted after 90 days ([Screener](https://help.hey.com/article/722-the-screener)). Contacts skip the Screener, and whole domains can be set to screen in or out.

**Who decides.** The user, per sender: "HEY doesn't decide, you do. HEY won't move anything anywhere until you tell it to... For every sender, you get to pick where their emails should go" ([The Feed](https://www.hey.com/features/the-feed/)).

**Correcting.** Change where a sender lands "whenever you'd like. HEY will move all existing emails from that contact to the new destination as well" ([Paper Trail](https://www.hey.com/features/paper-trail/)).

**The agent angle.** HEY now offers "AI Agents & CLI", which lets the user's own agent (Claude, Codex and others) "Review your Screener, mark stuff as spam, draft up replies, label things" ([agents](https://www.hey.com/agents/)). HEY does no AI sorting itself, but it hands the Screener decision to the user's agent. This is the closest match to the ticket's "what is left for an agent."

## Superhuman

**What lands.** The default Split Inbox is Important and Other. Important holds "all person-to-person and high-priority messages"; Other holds "emails sent to mailing lists, and automated messages such as marketing, social, and automatic updates" ([default split](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox)). Rule-based splits add VIP, Team (your domain), News, Calendar and Shared. Custom splits use search queries or Auto Labels ([custom split](https://help.superhuman.com/hc/en-us/articles/46005636204941-Custom-Split-Inbox)).

**Who decides.** A mix. Important versus Other leans on Gmail's own sorting ([moving](https://help.superhuman.com/hc/en-us/articles/46005707869965-Moving-Conversations-Between-Important-and-Other)). Auto Labels are AI: built-in Marketing, News, Pitch, Social (sent to Other by default), plus Respond, Meeting, Travel ([Auto Labels](https://help.superhuman.com/hc/en-us/articles/46005657758861-Auto-Labels)). The Gmail add-on gives each mail exactly one of Respond, Waiting, FYI, Notifications, Promotions, News ([Email Assistant](https://help.superhuman.com/hc/en-us/articles/46005854346893-Email-Assistant-by-Superhuman-Mail-Gmail)). Custom labels can be a plain-English prompt, up to 10. Auto Archive sends chosen labels to an "Auto Archived" folder, but never archives mail from someone you have written to before, or from your own domain ([Auto Archive](https://help.superhuman.com/hc/en-us/articles/46005662460813-Auto-Archive)).

**Correcting.** Moving a mail between Important and Other offers three scopes: this conversation only, this sender, or this whole domain, the last two for "all existing and future conversations." Removing a wrong Auto Label "applies only to that thread. It does not create a rule or teach Email Assistant to categorize similar messages differently in the future." When building a custom label, you tick or cross preview results to tune it.

## Products that use an LLM to decide "does this ask something of me"

**Inbox Zero** (open source) is the most detailed design found, because its code is public ([docs](https://docs.getinboxzero.com/essentials/email-ai-personal-assistant), [repo](https://github.com/elie222/inbox-zero)).

- Default rules include To Reply ("someone asked me a question or requested something from me, or I promised to send something and haven't yet"), FYI ("information, updates or announcements sent to me, with no question or request anywhere in the thread"), Awaiting Reply, Newsletter, Marketing, Receipt, Notification, Cold Email (`apps/web/utils/rule/consts.ts`).
- Order of evaluation (`apps/web/utils/ai/choose-rule/match-rules.ts`): fixed cold-email checks first; then learned sender patterns, which "short-circuit" the rule; then static conditions (from, to, subject, body); then the LLM decides what is left. "If ANY learned pattern matches were found → ignore all potentialAiMatches."
- Corrections: "Fix" in the History tab lets you explain a wrong match and edit the rule. Label changes per sender are fed back into the prompt as hints. Senders that keep matching one rule become a visible "learned pattern" you can remove. The reply-status rules (To Reply, FYI and the like) set `shouldLearn: false`, so a sender is never pinned to "needs a reply": that call stays per message.
- Held-back mail is labelled, and archived only if the rule says so. Replies are drafted, never sent unasked.

**Shortwave.** "AI filters" written in natural language, search queries, or both, with pre-built Needs Action, Cold Outreach and FYI. Actions: label, archive, mark important, star, update the to-do list, delete. "Reapply filters" shows what the AI did and why. No learning from corrections is documented ([settings](https://www.shortwave.com/docs/guides/customize-your-shortwave-settings/)).

**Outlook.** Focused Inbox is classic machine learning: it "filters out noisy sources like automatically generated or bulk email" into Other, learns from moves, and "Always move to" creates a per-sender override ([Focused](https://support.microsoft.com/en-us/outlook/mail/focused-inbox-for-outlook)). Copilot "Prioritize my inbox" is an LLM that marks mail high, normal or low, and "will lean towards marking emails where action is required from you as more important." It needs at least one user instruction ("It's from my manager"), shows its reasoning in the reading pane, moves nothing, and does not re-evaluate old mail when instructions change ([Prioritize](https://support.microsoft.com/en-us/outlook/copilot-outlook/prioritize-my-inbox)).

**Apple Mail.** Categories Primary, Transactions, Updates, Promotions. "When an email in Transactions, Updates, or Promotions includes time-sensitive information, it's also included in the Primary email list" ([categories](https://support.apple.com/guide/mail/use-categories-mlhl64d76621/mac)). So the model can promote a bulk item back to the main list. Priority Messages show "the most urgent emails, like a same-day invitation to lunch or a boarding pass" at the top ([newsroom](https://www.apple.com/newsroom/2024/10/apple-intelligence-is-available-today-on-iphone-ipad-and-mac/)). The only correction is per sender: "Categorize Sender" ([sorting](https://support.apple.com/guide/mail/automatically-sort-incoming-emails-mlhlp1190/mac)).

**Fyxer and Lindy.** Both put each mail in one fixed category: To Respond, FYI, Notifications, Marketing and a few more ([Fyxer](https://www.fyxer.com/blog/how-fyxer-organizes-your-inbox-by-priority), [Lindy](https://docs.lindy.ai/features/inbox-management/email-triage)). The user picks which categories stay in the inbox and which go to folders. Lindy's "Remove on reply" clears To Respond once you have answered. Fyxer's own pages contradict each other: its FAQ says relabeling "doesn't train Fyxer" ([FAQ](https://docs.fyxer.com/resources/support/faqs)), its July 2026 blog says it will "improve over time."

**GitHub.** No built-in AI ranking of notifications was found.

## Patterns

1. **There is always a bulk tier, and it is never shown first.** Every product routes newsletters, promotions, receipts and automated updates away before the user sees them. GitHub and Linear do it by never subscribing you in the first place.
2. **The to-do tier is "someone wants something from you."** Developer tools express that as reasons (assigned, review requested, mentioned). Mail tools express it as a Respond label. Both are the same idea.
3. **Rules first, model second.** Explicit rules and fixed checks run first; the model decides only what is left.
4. **Every call is shown with its reason.** GitHub's `reason`, Copilot's explanation, Linear's hover, Shortwave's "Reapply filters". A user can only correct a call they can see.
5. **Two sizes of correction.** Per item (GitHub Done, Linear decline, Superhuman "this conversation only") and per sender or kind (HEY screen out, Superhuman domain rule, Apple Categorize Sender, Outlook "Always move"). Per-sender corrections become visible rules.
6. **Implicit learning is rare.** Gmail importance and Outlook Focused learn. Superhuman and Fyxer's FAQ refuse to. Inbox Zero learns only as visible, removable sender patterns, and never for "needs a reply."
7. **Hide, never delete; draft, never send.** Held-back items stay findable. Every product that writes replies leaves them as drafts.
8. **Direct asks break through.** GitHub's Unsubscribe still lets mentions and review requests in. Superhuman never auto-archives mail from people you have written to. Apple promotes time-sensitive bulk mail into Primary.
9. **Leaving on resolution is rare.** No auto-clear in GitHub, Linear or Slack. Lindy's "Remove on reply" and Linear's snooze "or when there's new activity" are the nearest precedents for NOTES' "the ask leaves Intake when answered on its own system."

## What this means for Hercule's ask decision

These are options, not a decision. Each names the precedent behind it.

- **A. Keep two tiers, as NOTES draws them.** A plugin rule raises an ask at once from one event (GitHub reasons, Slack mentions). Triage, an agent working on a batch, raises findings later (Gmail importance, Superhuman labels, Inbox Zero). Everything else is never shown on its own.
- **B. Let each source declare its tier.** Some sources are rule-only (a GitHub review request is always an ask). Some are agent-only: email never raises an ask straight from an event, so a newsletter can only reach triage as material. Inbox Zero's order (fixed checks, then the user's rules, then the model) shows how to mix the two in one source.
- **C. Choose the size of "Stop asking."** Per item (dismiss this one), per kind (no more `github/review-requested` from this repo), or per sender (HEY, Superhuman domain rule). NOTES' "Stop asking" needs this choice made.
- **D. Decide whether the agent tier may promote into asks.** Apple says yes: time-sensitive bulk mail is promoted to Primary. HEY says no: "HEY doesn't decide, you do." Hercule could allow it only for findings triage marks as urgent, or never.
- **E. Show the reason on every ask.** Every product that lets you correct a call first shows why it was made. For a plugin ask, the reason is the plugin rule and the event; for a triage finding, the agent's one-line reasoning.
- **F. Turn corrections into visible rules, not retraining.** Most products do this. Hercule could store a correction as a rule the user can see and remove (Inbox Zero's learned patterns), and never pin "needs you" to a sender (Inbox Zero's `shouldLearn: false`).
- **G. Prefer leaving on resolution.** NOTES already has the ask leave when the poll sees the answer on its own system. Few products do this, so it is a real differentiator, and each plugin needs a way to say "resolved."
- **H. Give the user's agent the Screener job.** HEY hands its Screener to the user's own agent. Hercule's triage could own the same per-sender in-or-out call for email-like sources, with the user able to see and reverse it.
