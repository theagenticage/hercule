# 54. External Entities are durable records kept true by polls

Date: 2026-11-07

## Status

Accepted by [Work overview: the design and its tickets (#1026)](https://github.com/theagenticage/hercule/issues/1026), built first by [#1032](https://github.com/theagenticage/hercule/issues/1032). Amends [ADR 0019](./0019-the-task-model-is-thin-workflows-own-task-semantics.md), which kept a Task's outside things only as provenance, and [ADR 0046](./0046-handing-a-signal-off-tracks-the-work-on-a-task.md), which picked the Task a hand-off continues by its latest update. Keeps [ADR 0006](./0006-plugins-request-capabilities-and-register-contributions-in-code.md) (a plugin registers data in the catalog), [ADR 0009](./0009-all-events-flow-through-one-persisted-pipeline.md) (what happens is an event) and [ADR 0040](./0040-intake-holds-signals-notifications-are-hercules-own-messages.md) (a Signal is its own record). The rules are in [spec 20](../spec/20-external-entities.md).

## Context

Hercule knows outside things only through events. A pull request that asks for the user's review is known because an event once said so. That gives the Inbox three problems:

- **A missed event is a missed item.** Nothing lists the current state of a thing. A poll returns no data (`PollResult` is only a wait), so a pull request merged an hour ago and a pull request that still waits look the same to Hercule once the event is old.
- **Two accounts see one pull request.** Events are per Connection. The user would see two cards, and removing one Connection would remove the card.
- **Work wants to group by where things live.** A Task is linked to a pull request by a ref in its provenance. Provenance is history. It cannot say that the pull request is part of a repository, or that a project is part of an initiative.

The Inbox needs a record of the outside thing that stays true by itself, belongs to no Connection, and survives losing the token.

## Decision

**An External Entity is a durable record of one outside thing, kept true by polls, not by events.**

- **Identity.** There is one record per canonical External Ref, `UNIQUE (ref)`. The ref excludes the Connection, so two accounts see one entity. This is about entities only: a ref stays non-unique across Tasks.
- **Observations.** What one Connection says about one ref (its concerns, whether it can read the ref, when it last tried) is an observation row, keyed by the ref and the Connection. It keys on the ref, not on the entity, so a Connection can hold state for a ref nobody has read yet. What the entity concerns, whether it can be read, and how fresh it is are worked out on read from the observations. One account's 403 never hides another account's good read.
- **Lifecycle.** A complete read that no longer lists a thing empties that Connection's concerns and nothing else. The record stays. A missing answer is `inaccessible`, never "deleted" or "closed". A lost token, a disabled Connection and a disabled plugin change nothing but how old the facts are. A record with no concern, no Task link and no open signal is pruned after 30 days.
- **`reconcile` is one call per kind, after the whole inventory was read.** A plugin pages through its source, and only when every page succeeded does it call `reconcile` with the complete list. The core validates all of it before the first write, then replaces what this Connection said, in one transaction. So a failed page, a rate limit or a restart reports nothing and removes nothing, and the next poll starts again. `complete: false` adds and updates but never removes. It emits no event and raises no signal, so 300 existing pull requests never become 300 proposals.
- **Relation claims, and `part of` is a graph.** A relation between two refs is a claim by one reporter: a source (a Connection), a person, or a piece of text. Two reporters of one edge make two claims, and the pair is shown once under its firmest claim. `part of` points from a child to a parent. A thing can have many parents, a team is one more path, and a project can sit in two initiatives, so nothing is drawn as if a thing had one parent. It stays acyclic: a claim that would close a loop is stored as `conflicted` and shown, and the rest of the inventory still applies. A `linked` claim is between peers and may loop. A claim grants nothing and creates no concern.
- **A plugin reports; the core renders.** A plugin reports raw `fields` and a status key. The core applies the kind's table once and stores the result (identifier, person, status, facts, and copies of the kind's noun, card, pace and patience) on the row. So a card draws from its row, with no plugin running and no kind in the catalog.
- **A kind is declared on an event source.** A kind is a facet of the plugin's event source, as a signal kind is. It is data in the catalog and survives the plugin being disabled.
- **Recognition, search and resolution are three steps with different rights.** Recognizing text is pure: a plugin parses its own link and identifier forms and fetches nothing. Searching is live and goes to the source. Resolving a thing reads it with the target plugin's own Connection, never with the Connection of the thing that mentioned it.
- **A Task links refs through its own table.** `task_entity_links` has one row per Task and ref, keyed on the ref so a link outlives pruning. Provenance stays the history and the link is the relation. The **active Task of a ref** is the live Task with the oldest link, `(linked_at, task_id)`, so a later update can never change the answer. This replaces the most-recently-updated rule of Intake's hand-off, which now continues the oldest live link.
- **Following lives on the link.** Adding a thing to Work from nothing that concerned the user sets `following` on the Task's link. The entity's `following` concern is worked out on read: a live Task has such a link. So there is nothing to clear, and a plugin that reports `following` is refused.
- **The Inbox is a read, not a table.** A card is a full record of a work kind, not dismissed, with a current concern, an open signal or a live Task. Membership is one definition in one place, so the counts and the cards agree.

## Considered options

- **Build the Inbox from events and Signals only.** Rejected. A missed event is a missed item, and nothing says that a merged pull request is merged. Signals ask for a move. They say nothing about the state of the thing.
- **A copy of the ticket or the pull request.** Rejected. It goes stale and grows. A record holds what a card draws and no more.
- **Scan generations: stamp each row with the poll that saw it, and sweep what a poll did not see.** Rejected. A poll that fails between two pages would leave a half-stamped table to repair. One `reconcile` call with the whole list needs no repair, and 2,000 observations of a few hundred bytes fit one short transaction.
- **Mark a thing deleted when a read returns nothing.** Rejected. A 403, a 404 and a null answer all look alike on some sources, GitHub among them. Reading them as "deleted" would remove a card that only lost access. No plugin in this map can say "deleted" for certain.
- **A `parent` string on the entity, such as a repository name.** Rejected. A pull request that rides on two tickets, a project in two initiatives and a purchase order in two delivery rounds all have more than one parent. A string cannot say who claims the parent, or be corrected by a person without overwriting the source.
- **One claim row per pair, last writer wins.** Rejected. A person's correction would pass as the source's word, and one account would rewrite another's. Claims stay separate, and the core stamps who made each one.
- **A new extension point for entity kinds.** Rejected. A kind belongs to one event source, as a signal kind does, and a plugin update can add one without registering anything new.
- **Let a plugin draw its cards, with a render function.** Rejected. The desktop must not import a plugin, and a card must still draw after its plugin is gone. A table of fixed shapes, tones and fact forms keeps every plugin looking like the others, and a new plugin looks right with no code in the app.
- **Read a pasted link with the Connection of the thing that mentioned it.** Rejected. That Connection may belong to another system or another account. A resolution uses the eligible Connections of the plugin that owns the link.
- **A plugin reports `following` as a concern.** Rejected. It would have to be cleared when the Task ended. As a property of the link it follows the Task by itself.
- **One unique ref on `task_entity_links`.** Rejected. Many Tasks may link one ref over time, and the finished ones stay as history.
- **Prune everything with no concern after 30 days, dismissed records too.** Rejected. A record that came back without its dismissal would undo "only Undo brings it back".

## Consequences

- New tables `external_entities`, `external_entity_observations`, `external_entity_scans`, `external_entity_relation_claims`, `external_entity_arrival_counter` and, in the tasks domain, `task_entity_links`. The migration backfills links from the provenance of Tasks that are not deleted.
- A new `entities` capability and optional additions to the event source: `entityKinds`, `entityLookup` and `IngestContext.entities`. All are additive, so `hostApi` stays 8 ([spec 05 section 9](../spec/05-plugins.md#9-versioning)).
- A poll that changes nothing writes one scan row for the members of a complete inventory, and announces nothing. A quiet Inbox costs no read.
- A domain graph rule: no domain imports `external-entities` except through a port. `ExternalEntityService` requires `TaskService`, so nothing `TaskService` needs may require `ExternalEntityService`. A port the tasks domain declares is answered from the repository.
- Tasks for entities are made through `TaskService`, in the caller's transaction, by two user-only methods. The entity domain never inserts a Task itself.
- Intake's hand-off and the Describe Line now name the Task of the oldest live link. A Task that was only the most recently touched no longer wins.
- The Connection's `warning` is shared with account setup. Entity ingest writes it only when it is empty or one of its own fixed sentences, and clears it only when it is one of them.
- Hercule can read and group by outside structure (repositories now, Linear projects and initiatives later) without ever turning it into a core Project or Initiative.
- Not decided here, and left for later slices: ~~signals inside cards and person links (slice 5)~~ *(decided in the note below)*, handing a card to an agent (slice 6), moving cards on facts and linking a Thread's pull request to its Task (slice 7), triage clusters as Hercule's own kind, and writing anything back to the source.

## Note: signals inside their entity, links, and what changed outside

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033), slice 5 of the Work overview map [#1026](https://github.com/theagenticage/hercule/issues/1026).)* The Decision above left signals, links and Linear for this slice. The rules are in [spec 20](../spec/20-external-entities.md). These are the choices behind them.

- **A signal finds its entity on read, by exact ref.** The join is `signals.thread_ref = external_entities.ref`. Neither side stores the other. A signal can come before its entity (a mention of an issue that no inventory lists), and an entity can be pruned and come back. A stored key would need a backfill and a rule to keep it true. With the join on read, every signal attaches the moment its entity appears, an old signal needs no migration, and the two can never disagree. A ref is never parsed or changed to make it match. Only a full record of a work kind can have a card, so a signal on a place, a document or a notification stays on its own, on Intake.
- **Acting never ends a signal it did not answer.** Taking on a card and dismissing it end no signal. The user marks each one done from its line. A signal is a question put to the user, and taking on the thing is not an answer to it. Spec 10 section 9.6 already bars ending a signal by judgment. A later hand-off from a card follows the same rule. A signal has one record and one resolution, so answering it on a card also answers it on Intake.
- **A reference found in text is a hint.** A description that says `SHOP-123` proves nothing: it may quote, compare or give an example. So a `text` claim never joins, groups or rides. Only a claim from a source (the system the thing lives in says so) or from a person joins. The core stores no text, only the claims it found, with the name of the text they came from.
- **An outside change is shown and never acted on.** Rogier, 2026-11-07: "the system should show that something happened in the external system (someone else assigned the ticket, someone else created a pr, etc.), but not really act on it." So a change at the source is a line on the thing's timeline. No stage moves, no run stops, no signal ends, no card changes place, and no event or signal is raised. Two pull requests for one ticket are fine: each is linked, and each says so.
- **Recognition and resolution live in different places.** Recognizing a text is pure and runs in the plugins domain, beside the poll, over the lookups of the plugins that are active at that moment. Resolving a reference reads a source and takes seconds, so a loop in the controller daemon does it, outside any transaction. The plugin host cannot do the second: it requires the ingest loops, and the lookups require the host, so a host that resolved would be a construction cycle. A claim that waits for a read holds a pending target, which is not an External Ref and never reaches a client.
- **Signals and entities form one edge in the domain graph.** `external-entities` imports `signals`. The signals domain imports nothing of it and declares a port, `SignalEntities`, that the controller daemon answers from the entity records.

Rejected here:

- **A stored `entity_id` on the signal.** It needs a backfill, and goes stale when an entity is pruned and comes back.
- **Taking on a card ends its signals.** It would answer a question the user did not answer, and would end a review request the moment the user made a Task.
- **A text reference joins like a link.** A quoted ticket id would pull two unrelated things together.
- **An outside change moves the card or closes the Task.** Two people can work on one ticket. Whether to act is the user's call.
