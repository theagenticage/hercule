# External Entities

*(Added 2026-11-07, [#1032](https://github.com/theagenticage/hercule/issues/1032), slice 4 of the Work overview map [#1026](https://github.com/theagenticage/hercule/issues/1026); [ADR 0054](../adr/0054-external-entities-are-durable-records-kept-true-by-polls.md). Amended 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033), slice 5: signals inside their entity, links, hints and the timeline. Amended 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035), slice 7: Facts, links by hand and the branch join, [ADR 0055](../adr/0055-facts-move-cards-through-editable-workflows.md). Amended 2026-11-12, [#1121](https://github.com/theagenticage/hercule/issues/1121), Inbox slice 1: typed fields and Card Faces, [ADR 0058](../adr/0058-the-inbox-is-a-list-queried-on-the-controller-over-fields-plugins-declare.md).)*

An **External Entity** is a durable record of an outside thing, such as a pull request, a ticket or an error. It is never a copy of the thing: it holds what a card needs to draw, and a poll keeps it true. The Inbox is the page that lists the ones that concern the user. "External Entity" is a word for code and docs. The UI says the kind's noun, "Pull request", and the word "entity" never reaches a screen.

This document owns the records, their rules, the operations and the Inbox's reads. Other documents link here and do not restate it:

- the plugin interfaces (`EntityKindDeclaration`, `EntityObservation`, `IngestContext.entities`, `EntityLookup`) are pinned in [./05-plugins.md](./05-plugins.md) section 4.3. This document owns what the core does with them;
- the GitHub plugin's feed is in [./08-events-and-connections.md](./08-events-and-connections.md) section 5.1, and the Linear plugin's in section 5.7;
- the Signal record and how it leaves are in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#9-signals);
- the Task side (links, the active Task) is in [./09-tasks.md](./09-tasks.md#entity-links);
- the desktop Inbox and Work's additions are in [./17-desktop-app.md](./17-desktop-app.md#inbox).

Terms are [GLOSSARY.md](../../GLOSSARY.md)'s: **External Entity**, **Entity Kind**, **Observation**, **Concern**, **Relation Claim**, **Inbox**.

## 1. The model

Keep these questions apart. They are different facts, stored differently.

| Question | Where | Notes |
|---|---|---|
| What is it? | `external_entities`, one row per canonical External Ref | title, status, person, owner, facts, repository, lifecycle |
| Does it concern you, and why? | `external_entity_observations`, one row per ref and Connection, and `following` on a Task's link | the concerns that Connection reported. The entity's concern is their union, plus `following` |
| Can each account read it? | the same observation row: `access`, `last_attempted_at`, `last_refreshed_at`, `next_attempt_at`, `attempt_count` | per Connection, so one account's failure never touches another's |
| Was the inventory read? | `external_entity_scans`, one row per Connection and kind | `last_complete_at`: one write per poll, however many rows it covers |
| What is it part of, and what is it linked to? | `external_entity_relation_claims`, one row per claim | who claims it, and on what evidence ([section 6](#6-relation-claims)) |
| Which Tasks link it? | `task_entity_links`, in the tasks domain | one row per Task and ref ([./09-tasks.md](./09-tasks.md#entity-links)) |
| Which signals are about it? | `signals`, joined on read by `thread_ref = ref` | nothing is stored on either side ([section 8.5](#85-signals-inside-a-card)) |
| What changed at the source? | `external_entity_timeline`, one row per change | `reassigned`, `moved` or `linked`, put into words on read ([section 8.7](#87-what-changed-outside)) |
| Is it on the Inbox? | worked out on read ([section 8](#8-the-inbox)) | |

Observations and claims key on the ref, not on the entity's id. A Connection can hold state for a ref that has no entity yet, and a claim can point at a ref nobody has read. Task links, signals and claims key on the ref too, so pruning an entity leaves them readable.

### 1.1 Records

**Entity** (`external_entities`). One row per canonical External Ref, `UNIQUE (ref)`. The External Ref excludes the Connection ([./09-tasks.md](./09-tasks.md#external-ref-canonical-form)), so two accounts that see one thing share one row. This uniqueness is about entities only: a ref stays non-unique across Tasks.

| Field | Notes |
|---|---|
| `id` | Hercule id |
| `ref`, `kind` | `kind` is qualified: `github/pull-request` |
| `noun`, `card`, `pace`, `patience`, `caption`, `home`, `section` | Copied from the kind table when the entity is observed, so a card reads well after its plugin is gone. `home` and `section` are qualified kinds. `caption` is the kind's `groupable.caption` |
| `completeness` | `full` or `partial` ([section 1.2](#12-three-shapes-of-record)) |
| `identifier`, `status`, `person`, `owner`, `facts`, `reason` | Rendered by the core from the plugin's raw fields and the kind table ([section 5.2](#52-the-core-renders-the-plugin-reports-fields)). `status`, `person`, `facts`, `reason` are JSON |
| `title`, `url`, `lifecycle` | `lifecycle` is `open`, `completed` or `abandoned` |
| `repository` | `{ target: { remote }, head?: { remote, branch } }`, remotes in canonical form ([GLOSSARY.md](../../GLOSSARY.md), Canonical remote) |
| `progress`, `target_date` | Only what the source reports. Progress is never worked out from what Hercule can see |
| `waiting_since`, `concerned_since` | `waiting_since` is the source's word on when the wait began. `concerned_since` is when the entity last went from no concern to some concern |
| `source_updated_at`, `source_revision` | The source's own time and revision of the shared fields ([section 3](#3-shared-fields-and-presented_by)) |
| `source_created_at` | *(Added 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035).)* When the source created the thing, from the observation's `sourceCreatedAt`. It never changes, unlike `source_updated_at`. The branch join reads it ([section 14.4](#144-finding-a-threads-pull-request-the-branch-join)). A shared field that no screen shows |
| `first_observed_at`, `updated_at` | |
| `status_key` | *(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* The status key the plugin reported, such as `in_review`. `status` holds the word the user sees, which a plugin may rename, so the timeline compares keys to tell a real move from a renamed word. Null when the thing has no status. A shared field |
| `reason_templates` | *(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* A JSON copy of the kind's raw `reasons` table, `{ key: { say, tone } }`, made when the thing is observed as `concern_reasons` is. The sentence of a signal and the words of the timeline are built from it, so they read well after the plugin is gone. A shared field: only the accepted shared write sets it |
| `presented_by` | The Connection whose observation wrote the shared fields. Null when that Connection is deleted |
| `dismissed_at`, `dismissed_by` | [Section 4.2](#42-dismissal) |
| `arrival_sequence` | [Section 8.4](#84-counts-the-outline-and-the-new-mark) |

**Field value** (`external_entity_fields`). *(Added 2026-11-12, [#1121](https://github.com/theagenticage/hercule/issues/1121).)* One row per (`ref`, `key`), the primary key, holding the value of one declared field of a thing ([./05-plugins.md](./05-plugins.md#43-event-source)). It is a `WITHOUT ROWID` table with two columns for the value, and exactly one of them is set:

| Declared type | Column | Encoding |
|---|---|---|
| `text`, `person`, `enum` | `text_value` | the string |
| `number`, `money` | `number_value` | the number (a `money` amount in major units) |
| `age` | `number_value` | the epoch milliseconds of the timestamp |
| `bool` | `number_value` | 1 or 0 |

Two partial indexes serve search and counts: (`key`, `text_value`) where `text_value` is not null, and (`key`, `number_value`) where `number_value` is not null. The table stores no type, because the declaration in memory knows it. It keys on the ref, not on the entity's id, like the timeline. The prune sweep deletes the rows of refs that have no entity ([section 4.3](#43-pruning)). A row is a shared field: [section 3](#3-shared-fields-and-presented_by).

**Observation** (`external_entity_observations`). One row per (ref, Connection), the primary key. `concerns` (JSON array), `owned_by_you`, `access` (`ok`, `inaccessible`, `deleted`), `last_attempted_at`, `last_refreshed_at`, `next_attempt_at`, `attempt_count`. Deleting a Connection deletes its rows.

**Scan** (`external_entity_scans`). One row per (Connection, kind): `last_complete_at` and the writing `actor` (`plugin:<id>`). It moves only when a complete inventory was reconciled.

**Ingest warning** (`external_entity_ingest_warnings`). One row per (Connection, kind) whose latest inventory left something unresolved, such as a partial read or a refused relationship: `warning`, the sentence. The Connection has one warning, shared with account setup, so these rows keep it in place until every kind has resolved its own. Deleting a Connection deletes its rows.

**Claim** (`external_entity_relation_claims`). Section 6.

**Arrival counter** (`external_entity_arrival_counter`). One row holding the last number given. A table of its own, so a number is never given twice, even after pruning removes the entity that held the highest one.

**Task link** (`task_entity_links`). `task_id`, `ref`, `linked_at`, `linked_by`, `following`; the primary key is (`task_id`, `ref`), with an index on `ref`. Owned by the tasks domain.

**Task revision** (`tasks.revision`, tasks domain). A count of the edits to a Task, 0 for a Task nobody has edited. Taking back a Task made for an outside thing asks whether it is still 0, which `updated_at` cannot answer when an edit lands in the same millisecond as the creation or the clock steps back.

**Timeline** (`external_entity_timeline`). *(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* `id`, `ref`, `reason` (`reassigned`, `moved` or `linked`), `person` (the new owner, null when the owner was cleared), `value` (the new status word of a `moved` change, null for the others), `target_ref` (for `linked`, the thing that was linked) and `observed_at`, with an index on (`ref`, `id`). It keys on the ref, not on the entity's id. The prune sweep deletes the rows of refs that have no entity.

### 1.2 Three shapes of record

- **A full record of a work kind.** Has a card: `card` is `rich` or `compact`, `pace` is `fast` or `slow`, and `url` and `lifecycle` are set. Only this shape can be on the Inbox, be read by `externalEntity.read`, or be taken on.
- **A context record.** A record of a kind with `pace: context`, such as a repository. It is a place: no card, no pace, no lifecycle, no moves, and it can never be taken on. Its observations carry `concerns: []`, so it never concerns the user by itself. If a place later concerns the user, it is the same record. Progress is optional and shows only when the source reports it.
- **A partial record.** What a read of something else happened to give, such as a parent issue's id and title. A partial observation (`partial: true`) needs only `kind`, `ref` and `title`. This is allowed for work kinds too. The entity then has `completeness: partial` and draws as a place, with no card and no moves, until a full observation arrives. A partial observation fills in what it carries and never clears a known field: an absent field is unknown, not removed. So a partial read of a thing already known in full changes nothing else.

The work-only columns (`card`, `pace`, `patience`, `identifier`, `url`, `lifecycle` and the rest) are nullable, because a partial or context record has none of them. `externalEntity.read` reads a full record of a work kind only. A partial or context record answers `NotFound` there. It travels in other replies as an `EntityPlace`, by ref. *(Amended 2026-11-10, [#1105](https://github.com/theagenticage/hercule/issues/1105).)* An `EntityPlace` carries the thing's `url` when the source reports one and the thing is not restricted, so a Task's Linked row can open it in the browser.

### 1.3 Restricted things

A link can point at something the user's Connections cannot read. This is one of two cases, and they are kept apart:

- **A place no Connection can read** has no title, identifier or URL to show. Its `EntityPlace` carries the kind's `noun` and `restricted: true`, and the row says "A Sentry issue you cannot open". A title learned through someone else's read, such as an attachment's label, is never stored as the entity's title. `restricted` is on `EntityPlace`, and on `EntityCard` (section 8.3) for the same case. The same rule decides a prompt's context block ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).
- **A card that lost access** keeps its last known facts, with `access: inaccessible` or `deleted`. It is not restricted.

An unknown ref is neither. It is a ref with no record, and a reply leaves it as a ref: no record is invented for it.

## 2. Derived fields

These are worked out on read, from the observations and the Connections, by the same functions for the Inbox, the detail and the Work board.

- **`access`.** `ok` if any Connection reads it. Otherwise `deleted` if any Connection was told so by its source. Otherwise `inaccessible`. One account's 403 never hides another account's good read. A disabled Connection keeps its last known access: eligibility affects `stale`, not the stored facts.
- **`observedAt`.** The newest of `last_complete_at` for each Connection whose latest inventory still lists it (the row is `listed`, whether or not it has concerns) and `last_refreshed_at` for every Connection. So a scan of unrelated open pull requests does not make a closed one look fresh. With no success time at all it is `first_observed_at`.
- **`stale`.** True when no Connection with `access: ok` can poll now. A Connection can poll when its status is `connected` or `error`, its plugin is active at run time and the stored `enabled` flag is on. Backing off after a failed read is not stale; it makes `contextComplete` false.
- **Freshness is as fresh as the last announced change.** A poll that changes nothing announces nothing, so on an open screen `observedAt` can lag a poll that succeeded and found nothing new. A client shows the age only when `stale` is true.
- **`yours`.** True when any observation row of the ref has `owned_by_you`, whichever Connection presents the shared fields. Ownership is account-relative, so it does not follow `presented_by`: one account taking over the shared fields must not move a card between "mine" and "theirs".
- **`concerns`.** The sorted distinct concerns of all observations, plus `following` when a live Task has a link with `following` set. `following` never comes from a plugin and never starts a card by itself: the live Task does that.
- **`waitingSince`.** The source's `waitingSince`, else `concerned_since`. An unchanged concern union does not restart the wait.
- **`taskId`.** The active Task of the ref ([./09-tasks.md](./09-tasks.md#entity-links)).
- **`kindAvailable`.** The catalog still has the kind and its plugin is active. When false the card draws, its actions are off, and it shows why.
- **`contextComplete`.** False when part of what is above the thing could not be read ([section 7](#7-reading-the-graph)).

## 3. Shared fields and `presented_by`

The shared fields are everything on the entity row that is not one Connection's word: title, status, facts and the rest. With two Connections:

- A newer `sourceUpdatedAt` wins them.
- On an equal `sourceUpdatedAt`, only the Connection that wrote the row last (`presented_by`) may change them. A source can change a fact without moving its update time, as GitHub's checks do, so the last writer must be able to, and two accounts must not take turns rewriting one row on every poll.
- An older `sourceUpdatedAt` loses. An observation that loses still updates its own Connection's concerns, ownership and access.
- **`presented_by` hands over.** On an equal `sourceUpdatedAt`, a Connection also may write, and becomes `presented_by`, when the current one is no longer usable: it is null, it cannot poll now, its plugin is not active, or its own `access` for this ref is not `ok`. So the first usable Connection to report takes over, and a card that reads fresh is really being kept fresh.
- *(Added 2026-11-12, [#1121](https://github.com/theagenticage/hercule/issues/1121).)* **Field values are shared fields.** The field value rows ([section 1.1](#11-records)) are written only when the observation wins the shared write by the rules above, so an observation that loses changes none. A partial observation never touches them.
- A partial observation never takes over a full record. A full observation promotes a partial one, whatever the old source time was.

**`sourceRevision`.** A plugin may send the source's revision of a thing. An unchanged revision skips the shared facts only, and only when the reporter is the same Connection (`presented_by`) and `sourceUpdatedAt` is equal. It never skips concerns, access, ownership, rotation and freshness bookkeeping, or relations. A newer `sourceUpdatedAt` is stored even when the revision string happens to match, because a revision from one reporter is not a clock to compare with another's.

## 4. Lifecycle

### 4.1 What happens when

| Case | What happens |
|---|---|
| First seen | Inserted, with no event and no signal. A baseline is not news |
| A complete scan no longer lists it | That Connection's concerns become empty. The row stays |
| No concern, no open signal, no live Task | Off the Inbox. Pruned after 30 days, unless it is context something still reaches ([section 4.3](#43-pruning)) |
| It has a live Task, or an open signal | Stays observed by `listWanted`, whatever its concern |
| A Task link exists, Task finished | Kept, last known state, not refreshed |
| A source says for certain that it is gone | That Connection's `access` is `deleted`, and the card says so. No plugin can say this yet |
| 403, 404, or any missing answer | `access: inaccessible`, last known state kept. Never read as deleted or closed |
| Token lost, Connection disabled, plugin disabled | Nothing changes. The card shows its age and why. A stale scan is not an empty inventory, and a missing relationship read removes no claim |
| Back in a later scan | Concerns return, and the card comes back unless dismissed |
| Connection deleted | Its observation and scan rows go, and so do its claims. The entity stays and pruning applies. `presented_by` becomes null |

**`following`** lives on the Task's link. `addToWork` sets `task_entity_links.following` when the user added the thing to Work from nothing that concerned them. The entity's `following` concern is then worked out on read: a live Task has such a link. So there is nothing to clear. A Task ending or reopening, a deletion, a merge, an unlink or an Undo changes the links or their liveness, and the answer follows in the same transaction. `reconcile` cannot touch it, and a plugin that reports `following` is refused.

### 4.2 Dismissal

`dismissed_at` and `dismissed_by` (an actor). A dismissed thing stays out of sight and keeps its history. *(Amended 2026-11-12, [#1122](https://github.com/theagenticage/hercule/issues/1122).)* **An ask raised after the dismissal brings it back**, and `externalEntity.restore` does too. A new concern, an ask that was open when the thing was dismissed, and a signal of a kind that asks nothing do not ([section 8.1](#81-membership)). The dismissal is kept: the row says it came back (`dismissedAt`), and a second dismissal moves the cutoff to its own time: dismissing a thing that came back dismisses it again, from that moment, and announces the change. A thing that comes back is a new arrival ([section 8.4](#84-counts-the-outline-and-the-new-mark)). Dismissing tells the plugin nothing and ends no signal. A dismissal is never pruned.

### 4.3 Pruning

A daily sweep, in the shape of the runner-metrics prune, deletes:

- entities with no concern, no link from any Task, no open signal on the ref, no path up from anything concerned or linked, no dismissal, not a context record listed by any Connection's latest inventory *(added 2026-11-12, [#1121](https://github.com/theagenticage/hercule/issues/1121): a source that lists every project or repository keeps each of them, so a Facet can list them all. Work records are not kept this way: a call with `complete: false` also marks what it lists, so keeping them would stop them being pruned beyond a cut)*, and no change for 30 days; and
- the observation rows of refs with no entity and no reason to be wanted.

It also deletes the timeline rows of refs that have no entity. *(Added 2026-11-12, [#1121](https://github.com/theagenticage/hercule/issues/1121).)* It deletes the field value rows of refs that have no entity too. It keeps their claims: they are small, and they are history. A dismissal is never pruned, because a record that came back without it would undo "only Undo brings it back".

## 5. What a poll reports

A poll returns no data. A plugin that has the `entities` capability reports what it read through `IngestContext.entities` ([./05-plugins.md](./05-plugins.md) section 4.3). The core owns what happens next.

### 5.1 `reconcile`

A plugin reads its whole inventory of one kind, then calls `reconcile({ kind, complete, observations })` once. So a failed page, a rate limit or a restart between pages stores nothing and removes nothing, and the next poll starts again.

**Refused before anything is written** (a `PluginError`; nothing is stored, claims and scan included):

- more than `MAX_ENTITY_OBSERVATIONS` (2,000) observations;
- a kind the source did not declare, or a ref that does not start with the kind's `refPrefix`, or the same ref twice;
- an oversized field (at most 32 fields, 64 characters in a name, 512 in a text), or more than 64 parents or peers in `relations`;
- the concern `following`, or any concern on a context kind;
- a parent or peer in `relations` that starts with `unresolved:`, which the core keeps for its own pending targets ([section 5.4](#54-addresses-and-texts)). The message tells the plugin to report a web address in `relations.linkedUrls` instead;
- more than 64 `linkedUrls`, one that is not an `http` or `https` address, more than 3 `texts`, a text over 16 KiB or an `evidenceKey` over 128 characters. The bounds are checked before any recognizer is called;
- a full observation of a work kind with no `url` or `lifecycle`;
- *(Added 2026-11-12, [#1121](https://github.com/theagenticage/hercule/issues/1121).)* a field value of the wrong type for its declaration, or an `enum` value the kind does not declare, or a ref in a field with `facet.values` that does not start with that kind's `refPrefix` ([./05-plugins.md](./05-plugins.md#43-event-source)). The message names the ref, the field and the expected type. A `null` or missing value is not an error;
- a status key or reason key that is not in the kind's table, or a template that names a missing field (`renderEntitySlots` fails);
- a Connection that is deleted, disabled or no longer ingesting (`assertConnectionIngesting`, as `emit` does).

**Inside one transaction, in this order:**

1. Read the state to compare against.
2. Write this Connection's observation rows: a full observation sets `access: ok`, the supplied concerns and `owned_by_you`, and resets the failure backoff. A partial observation sets `access: ok` and leaves concerns and ownership as they are.
3. Apply the shared-field rule of [section 3](#3-shared-fields-and-presented_by) in ref order.
4. Apply each observation's `relations` ([section 6](#6-relation-claims)), whatever the shared-field outcome.
5. With `complete: true`, empty this Connection's concerns and clear its `listed` mark for every ref of the kind it reported before and left out now. Retain access, ownership and the entity. Other Connections' concerns stay. Then write the scan row, `last_complete_at`.
6. Raise `arrival_sequence` for the entities that qualify ([section 8.4](#84-counts-the-outline-and-the-new-mark)).

**Rules:**

- **Compare before writing.** Only a row whose facts or concerns changed is written, and only those announce. For the members of a complete inventory, a poll that changes nothing writes one scan row. That saving covers inventory members only. A wanted ref is outside the inventory and keeps its own `last_refreshed_at`.
- *(Added 2026-11-12, [#1121](https://github.com/theagenticage/hercule/issues/1121).)* **Field values are written with the shared fields, and compared first.** `replaceFieldRows` reads the stored field rows of every ref it is given in one statement, never one per ref, compares them in memory with the values the observation reports and writes only the difference. A full observation that wins the shared write replaces the ref's whole set: rows for declared keys that have a value are written, and every other row of the ref is deleted. That drops a field the plugin stopped declaring and a field whose value became null. A partial observation never touches the rows. A change to field rows alone counts as a change of the entity: it is written and announced as a changed fact is. An unchanged `sourceRevision` skips the shared facts ([section 3](#3-shared-fields-and-presented_by)) but never this comparison, because a changed declaration with an unchanged revision must still add or drop rows. The comparison is also what keeps a quiet poll write-free. The same rules apply to `refresh`.
- **A complete call is the whole kind.** It unlists what an earlier complete call listed and this one leaves out, so a plugin cannot split one kind over several complete calls: each call would unlist the others' refs, and the rows would change on every poll. A kind that can exceed `MAX_ENTITY_OBSERVATIONS` reports a stable subset in one complete call (GitHub sorts repositories by name and lists the first 2,000). The rest are not listed, so `listWanted` returns them for `refresh`.
- **`complete: false`** updates what it was given and takes nothing away, and it does not move `last_complete_at`. It sets the Connection's `warning` to a fixed sentence saying the Inbox may be missing items. The system tells the user.
- **No event and no signal.** `reconcile` emits none, so 300 existing pull requests never become 300 proposals or 300 runs.
- **Poll writes are stamped** with the plugin's actor (`plugin:<id>`), on the scan row. They hold no user decision.
- **The Connection's `warning` is shared with account setup.** Entity ingest writes it only when it is empty or one of entity ingest's own fixed sentences (a missing page, a refused loop), and clears it only when it is one of them. Those sentences are constants in one place. It never overwrites or clears an authentication warning.
- **A disabled plugin or a lost token** changes no entity. The records stay readable, and the card shows its age.

### 5.2 The core renders; the plugin reports fields

A plugin reports raw `fields` (`Record<string, string | number | boolean | null>`, boolean added 2026-11-12, [#1121](https://github.com/theagenticage/hercule/issues/1121)) and a status key. `renderEntitySlots(declaration, observation)` applies the kind table and the result is stored on the row.

| Slot | How it is rendered |
|---|---|
| `identifier` | The kind's template with `{field}` placeholders filled from `fields`, at most 64 characters |
| `person`, `owner` | The text of the field the kind names, or left out when the kind has none or the field is empty |
| `status` | The kind's status entry for the observation's key: `shape`, `tone`, the `word` as `label`, and `norm`. *(Amended 2026-11-10, [#1105](https://github.com/theagenticage/hercule/issues/1105).)* Also its `icon` and its `hue` or `color` when the kind declares them ([./05-plugins.md](./05-plugins.md#43-event-source)) |
| `facts` | At most three, in a fixed form. A field that is missing, null or empty leaves its fact out |
| `reason` | The kind's `reasons` entry for the observation's `reason` key, with `{person}` and `{value}` filled in. Finished text |
| `noun`, `card`, `pace`, `patience`, `home`, `section` | Copied from the declaration. `card` is `rich` when left out |

Fixed sets: status shapes `ring`, `dashed`, `quarter`, `half`, `most`, `fork`, `join`, `check`, `cross`, `hold`, `alert`; tones `quiet`, `active`, `attention`, `good`, `bad` (the colour kept for the person is out of a plugin's reach); fact forms `delta` (`+120 -30`), `count` (a whole number and a unit in the singular), `word`, `date`, `money`, `bars` (a level from 1 to 3); reason tones `plain`, `attention`, `good`, `bad`. A status may declare a Task `stage`, used by [section 9.3](#93-the-stage-a-new-task-starts-at).

*(Added 2026-11-10, [#1105](https://github.com/theagenticage/hercule/issues/1105).)* **The stored statuses follow the plugins.** A status is copied onto a thing when the thing is observed, and a thing that stopped changing at its source, such as a merged pull request, is not observed again. So at boot, once the plugins are loaded, the core copies every loaded plugin's status tables, active or not, onto the stored things whose `status_key` they declare (`refreshStoredStatuses`). A thing whose stored status already matches is left alone, and the time the thing was updated stays as it is. A failure is logged and the boot goes on.

#### Card Faces are drawn on read

*(Added 2026-11-12, [#1121](https://github.com/theagenticage/hercule/issues/1121).)* [ADR 0058](../adr/0058-the-inbox-is-a-list-queried-on-the-controller-over-fields-plugins-declare.md). This amends the rule above that a kind's words are copied onto the row when the thing is observed. **For the Card Face only, nothing is copied.** A face is drawn when the thing is read, from the stored field value rows ([section 1.1](#11-records)) and the declaration of the active kind held in memory.

- **What is drawn.** `field-values.ts` in `external-entities` holds the meaning of a field and reads no database: it encodes an observation's declared fields to rows, decodes a stored row to a value, and draws the face. `entity-fields.ts` only stores and reads the rows. Given the active kind (or none) and the stored field rows of one ref, `decodeEntityFields` returns `{ fields, face }`. `fields` holds one value for each declared key that has a stored value, in the kind's declaration order: its `key`, `label` and a value shaped by its type (text, an enum's value and label, a number, a money amount with its currency, the timestamp an age counts from, a boolean). A field that names a context kind in `facet.values` also carries the `ref`, and its text is the title of that record. `face` holds the `place`, `context` and `fact` slots, each the value of the field it names. A slot whose field has no value is left out.
- **Only declared keys.** A stored row for a key the kind no longer declares is ignored. It is deleted by the next full observation.
- **A stale row is left out, never thrown on.** The core omits a stored value whose column or enum value does not fit the key's current declaration (a number where the field is now text, an enum value the kind no longer declares). The next observation rewrites it. Storage cannot catch every change: a stored number reads as `true` if the key becomes `bool`, and an amount keeps its number if the currency changes. So a plugin that changes a field's type, currency or meaning must use a new key.
- **No active kind means the generic card.** When the plugin is inactive, or the kind is gone, the reply has `fields: []` and `face: null`, and the client draws the generic card from what this document stores on the row: title, identifier, status and noun. That is why those slots stay copied. A card therefore still draws after its plugin is gone, as ADR 0054 requires.
- **The reads.** `externalEntity.read` gains `fields` and `face`, at the cost of one statement (`readFieldValues`, which reads many refs in the same one statement), the field rows of that ref, with the kind of its entity and the title of each readable record a ref-valued field names, and no network call. A ref-valued field shows the record's title only when some Connection can read that record ([section 1.3](#13-restricted-things), restricted things); otherwise the field is left out ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)). `queryInbox` is unchanged in this slice. The Inbox's own reads over fields are [#1122](https://github.com/theagenticage/hercule/issues/1122)'s.

An entity row holds only normalized fields, checked against the contract before they are stored. Entity text comes from outside: it is stored and drawn as plain text, never as Markdown or HTML.

### 5.3 `refresh`, `listWanted` and `reportMissing`

- **`refresh(observations)`** updates what is known without touching any concern. It follows the same validation, shared-field rule, relation rules and partial rules as `reconcile`. It never changes existing concerns and starts new observation rows with none. It updates `owned_by_you` when a full observation supplies `ownedByYou`, and keeps it when absent or partial. It stamps `last_refreshed_at`, sets `access: ok` and resets the backoff, even when nothing changed: the read succeeded. It writes no scan and changes no dismissal. *(Amended 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* **A refresh of a ref with no entity creates one, with no concerns.** It never touches another Connection's concerns. The new entity is on the Inbox only while a live signal holds it ([section 8.5](#85-signals-inside-a-card)). Such an entity takes an arrival number when that signal alone puts it on the clock, because a refresh never changes the concerns otherwise.
- **`listWanted(kind, limit)`** returns the refs of one kind the core wants this Connection to read, at most `limit`. They are the refs with a live linked Task whose entity is not in this Connection's inventory (not `listed` by it), and the context reachable from what concerns the user: upward through `part of`, at most `MAX_CONTEXT_PARENTS` (32) parents read per thing, plus one read of each `linked` target for its title and access. Its own links and parents are not followed, and no peer is crawled. *(Amended 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* It also returns the refs of open signals, snoozed ones included, for a kind that has a card (a work kind, not a context kind): the signals that came through this Connection on a ref that starts with the kind's `refPrefix`, even when no entity exists yet. So a mention of a thing no inventory lists gets its card on a following poll, with no `mentions:@me` search, and old mentions never flood in. A read that fails reports `reportMissing`, and the signal stays on its own. It is a fair, durable rotation:
  - Order: refs this Connection has never tried first, then the oldest `last_attempted_at`, then the ref. A ref backing off waits until its `next_attempt_at`.
  - It stamps `last_attempted_at` on what it returns, before it returns. A request that fails for all 50 refs still moves on: the next call gets the next 50. So 51 wanted refs make progress, and no bad ref can hold up the rest.
  - It excludes refs already in this Connection's inventory, because its next complete scan refreshes them.
- **`reportMissing(ref, reason)`** says a ref could not be read, with `inaccessible` or `deleted`. It sets that Connection's `access` and leaves everything else: concerns, ownership, facts, claims and `last_refreshed_at`, so a failed read never looks fresh. It never creates an entity. It is the only source of per-ref retry backoff: `attempt_count` goes up by one and `next_attempt_at` is set to now plus 120 seconds doubling with each failure, at most 6 hours. A good `refresh` resets them. `deleted` is explicit evidence and is never inferred from a 403, a 404 or an empty answer.
- **A batch that fails as a whole** is a failed poll. The host backs the feed off, and the `last_attempted_at` stamp of `listWanted` has already moved the rotation on. Nothing is written for the refs of that batch.
- None of this announces. Only a change to what a card shows pushes.

### 5.4 Addresses and texts

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* A source can say more about a thing than its refs. Two optional fields of an observation carry it, and the core turns them into claims, because only the core knows every plugin's link forms.

**`relations.linkedUrls`** (at most 64 `http` or `https` addresses) holds the addresses the source itself says belong to this thing, such as a Linear attachment that points at a pull request. An address is the source's word whatever happens to its target, so it is always kept, as a `source` claim of the reporting Connection with the address as its `evidence_key`. The core runs a new address through the active plugins' `recognize`, and the first plugin that recognizes it (registry order) decides the target:

| The address is recognized as | The claim's target (`to_ref`) |
|---|---|
| a `ref` | that ref. "Linear reports this pull request", with no GitHub Connection involved |
| `scoped`, such as a Linear issue address | a pending target, resolved by the loop of [section 5.5](#55-resolving-pending-claims) |
| nothing, because no active plugin knows it | the pending target `unresolved:url:<url>`, tried again when the set of plugins that know addresses changes |

- **A claim is matched by its Connection, `from_ref`, relation and `evidence_key`.** The table applies to an address seen for the first time. An address seen again keeps its target, id and time, whatever the plugins recognize now. So an address that resolved once stays resolved after its plugin is disabled, and also when it recognizes as scoped on every poll.
- **`complete` applies to addresses by what the source said.** `relations.complete: true` removes a stored address claim only when the source left that address out. A disabled plugin, a failed resolve or a failed recognition never removes one. `complete: false` removes none, and an observation with no `relations` touches none. Reconcile fetches nothing.
- An address that recognizes as the thing itself makes no claim.

**`texts`** (at most 3, each `{ evidenceKey, text, revision? }`, a text at most 16 KiB, a key at most 128 characters) holds text the core searches for references, such as a description. **The core stores no text.** It runs each text through every active plugin's `recognize` (at most 20 things a text, each once) and keeps only the claims it finds: a `text` claim of the reporting Connection whose `evidence_key` names the text. "The description of #6263" is built from that key when it is drawn.

- A `ref` recognition becomes a claim at once. A `scoped` one is stored as a pending target, and the evidence stays on the claim.
- **An entry replaces that Connection's `text` claims for its `evidenceKey`:** a reference no longer in the text is removed. An entry with an empty text clears the key. A key the observation leaves out touches nothing. A text whose `revision` equals the one its stored claims were made from is skipped, and is not recognized again: the ingest reads the stored revisions of every ref of a call in one statement before it searches.
- A stored claim is matched by what the text said (`recognized_as`), so a claim the resolver already settled keeps its id and time while the text still says the same.
- **A reference is a hint.** It never joins, never groups and proves nothing. It is drawn only as a hint, which the user may turn into a link ([section 9.5](#95-link-and-unlink)). An unresolved reference draws nothing, so `UTF-8` in a description costs a few failed reads and never reaches a screen.

**The pending target** is the core's own format, in this file's `pending-target.ts` and nowhere else: `unresolved:url:<url>` for an address nothing recognized, or `unresolved:<plugin>:<kind>:<scope>/<identifier>` for something a plugin recognized and cannot place without a read. Every component of the second form is written with `encodeURIComponent` (empty means absent), so none holds `:` or `/` and the form decodes to exactly what was encoded. **A pending target is not an External Ref.** It lives only in claims and never in a link, a peer, a place or the walk of `listWanted`. The generated column `is_pending` marks the claims that hold one, and every read of links filters on it.

**Recognition runs in the ingest of this domain,** after the observations are decoded and bounds-checked and before the transaction opens. The host passes the ingest a `RecognizeText` function over the lookups of the plugins that are active at that moment. It is pure: no plugin gets credentials or makes a request. The claims module writes the difference between what was recognized and what is stored, and the transaction checks again that the Connection still ingests.

### 5.5 Resolving pending claims

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* A loop in the controller daemon gives pending `source` and `text` claims a ref. It runs there and not in the plugin host, because it needs `EntityLookups`, which requires the host, and the host builds the ingest loops: the other way would be a construction cycle.

- **A pass** runs every 30 seconds while the controller serves. With nothing pending, it is one statement over an empty index.
- **The budget is per target plugin, not per reporting Connection,** because the reads cost requests to the target plugin's source. A plugin may read at most 20 due claims in one window, the oldest due first. A window opens when the plugin has claims to read and is as long as the default interval of its `entities` feed. The loop keeps the windows in memory, so a restart opens them afresh. Recognizing a web address reads nothing and spends no budget.
- **A claim is read through `EntityLookups.resolve`,** with the rules of [section 10](#10-search-recognition-and-resolution): never the first match, and `ambiguous` and `incomplete` leave the claim pending. A target that several claims hold is read once in a pass. An answer that does not place it (not found, ambiguous, incomplete or unavailable) postpones every claim holding the target, in one statement. **An `incomplete` or `unavailable` answer also ends that plugin's pass:** a Connection failed or ran out of requests, so the next reads would fail the same way. The claims not yet read stay due for the next window. A pending address is recognized again first, because a plugin may have become active: a `ref` settles it, a `scoped` recognition rewrites it to the scoped target and resolves that, and no recognition postpones it. When the set of plugins that know addresses changes, every pending address becomes due at once.
- **Reads run outside any transaction.** Each result is then written in its own short transaction, which first checks that the claim still exists, is still pending and still holds the target the loop read, because the source may have rewritten it during the read.
- **Found** rewrites the target to the canonical ref and keeps the claim's type, Connection and id. It resets the backoff and announces both ends. When a `source` claim joins a pair that nothing joined before, it also writes a `linked` change on both timelines ([section 8.7](#87-what-changed-outside)), unless the claim is part of its thing's baseline (`in_baseline`, [section 6](#6-relation-claims)). A ref that is the claim's own origin, or that another claim of the same Connection and text already holds, counts as not placed.
- **Not placed** waits: 120 seconds, doubling with each failure, at most 6 hours (`resolve_attempts`, `next_resolve_at`, as the backoff of observations).
- **A failed lookup never marks the reporting Connection unhealthy** or changes its `warning`. The lookup is the target plugin's business, not that Connection's.

## 6. Relation claims

Two relations, and neither knows a system.

- **`part-of`** points from a child to a parent. It is a graph, not a chain: a thing can have many parents, a team is one more path, and no view may draw one parent as if it were the only one.
- **`linked`** is between peers. It draws both ways, keeps its direction in the claim, and can contain loops.

A claim has a `claim_type`:

| Claim | By | Meaning |
|---|---|---|
| `source` | a Connection (`connection_id`) | The source reports it. `evidence_key` holds the URL it came from, if any |
| `person` | an actor (`actor`) | A person made it. A person's claim is `linked` only, made by `externalEntity.link` ([section 9.5](#95-link-and-unlink)) |
| `text` | a Connection | A reference found in text. `evidence_key` names which text. A hint, not a link: it joins and groups nothing |

Each claim also has `observed_revision` (the source's revision of `from_ref`, when it has one), `state` (`current` or `conflicted`), `conflict_reason` and `observed_at`. *(Amended 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* A claim that waits for a read also has `recognized_as` (the target as the recognizer first named it), `resolve_attempts`, `next_resolve_at` and the generated `is_pending` ([section 5.4](#54-addresses-and-texts)). `in_baseline` is true for a claim written while its thing was not yet a full record: what a thing arrived with is not news, however late a pending claim of it resolves ([section 8.7](#87-what-changed-outside)). Two checks keep the stamp honest: a `person` claim has an `actor` and no `connection_id`, and any other claim has a `connection_id` and no `actor`.

**Partial unique keys.** SQLite treats NULLs as distinct, so one unique key over `connection_id` and `actor` would not stop a repeat. Each claim type has its own partial unique index:

| Claim | Unique on |
|---|---|
| `source` from a ref | `(from_ref, relation, to_ref, connection_id)` where `evidence_key` is empty |
| `source` from a URL | `(from_ref, relation, connection_id, evidence_key)`, whatever its target, so a URL claim keeps its identity when its target is resolved |
| `text` | `(from_ref, relation, to_ref, connection_id, evidence_key)` |
| `person` | `(from_ref, relation, to_ref, actor)` |

Partial indexes on `(from_ref, relation)` and `(to_ref, relation)` where `state = 'current'` serve the walks, and indexes on `from_ref` and `to_ref` where `state = 'conflicted'` serve the read of refused claims.

**Rules:**

- **Claims stay separate.** Two accounts reporting one edge make two rows. The effective relationship of a pair is worked out on read: one row, under its firmest claim (`source`, then `person`, then `text`).
- **The core stamps who claims it.** `claim_type`, `connection_id` and `actor` come from the caller, never from the data. `reconcile` and `refresh` write `source` claims for their own Connection. A manual correction can never pass as the source's word, and a plugin cannot write a `person` claim.
- **Writing claims is a difference.** The core compares the claims it would hold with the rows it has. An unchanged claim keeps its id and time and writes nothing, so the same partial read twice grows nothing and makes no news.
- **Replacing a membership needs a complete read.** An observation's `relations` is `{ complete, partOf, linked }`:
  - `complete: true` replaces this Connection's `source` claims from this ref (those with an empty `evidence_key`), in the same transaction: a parent left out stops being claimed. Other Connections' claims, people's claims, text claims and URL-evidence claims stay.
  - `complete: false` adds what it was given and removes nothing.
  - An observation with no `relations` touches no claim. So a failed page, a missing permission, a rate limit or a disabled plugin never reads as "removed".
- **`part-of` stays acyclic, and the check is inside the write.** Before a new `part-of` claim becomes current, one recursive statement walks up from `to_ref` over current claims, with no depth limit. If it reaches `from_ref`, or the claim makes a thing part of itself, the claim is stored with `state: conflicted` and a `conflict_reason`. The rest of the inventory applies. The claim is kept as evidence and the conflict is visible: the entity's read returns `conflicts`, and the Connection's `warning` names it. There is one writer, so two claims cannot close a loop together. A conflicted claim is not promoted later when the loop opens. A complete read that no longer reports it removes it, and reporting it again checks it again.
- **A link between peers shows once, under its firmest claim** (`source`, then `person`, then `text`), and names only the claim's plugin or actor, never a Connection. Only a `source` or a `person` claim makes two things joined. A hint stays visible as a hint.
- **A link grants nothing.** It gives no permission and creates no concern. A target nobody has read stays a ref ([section 1.3](#13-restricted-things)).
- **Reparenting announces.** A claim replaced by a complete read announces `externalEntity`, and `task` with `derived: true` for the Tasks below it, found by one walk down over current `part-of` claims with no limit, even when the child's own row did not change. The set is the union of the Tasks before and after the change, so Tasks that lost a parent are told too.

## 7. Reading the graph

A flat list of ancestors cannot say which initiative holds which project, so every reply that draws paths carries the edges too: a client rebuilds every path from `ancestors`, `edges` and `places` alone.

`readContext(starts, ...)` is the one read of what lies above a list of refs: the Inbox, one entity, the Work board and the Add sheet's suggestions all call it. It makes one recursive statement over the indexed claims for any number of refs, then one batched read of the records and observations. There is no per-card statement and no HTTP call on a read. It cuts the places by one rule: the places asked for first, then the ancestors of each start in order, nearest first, up to the reply's bound. An ancestor left out is dropped from the ancestors of every start and from the edges, so a reply never carries an edge to a ref it carries no place for.

- It walks the distinct current `part-of` edges (`UNION`, never `UNION ALL`), as `(start_ref, ancestor_ref, depth)`. Two Connections reporting one edge, or an equal-length diamond, give one state, so the limits bound the work.
- It stops at `MAX_CONTEXT_DEPTH` (8) and reads at most `MAX_CONTEXT_PARENTS` (32) parents of one thing. It also has a state budget, so a wide graph cannot cost unbounded work.
- It returns each ancestor once per start, at its minimum depth, nearest first (then by ref). It returns every current `part-of` edge it crossed, both paths of a diamond included, at most `MAX_GRAPH_EDGES` (2,000, with one more read as a sentinel).
- When the edges or the states are cut, every start is `contextComplete: false`, and the ancestors listed come from the edges kept, not from the walk before the cut. No second walk is made.
- **`contextComplete` is false** when a bound cut the walk, an ancestor has no full or partial record, or an ancestor is stale or backing off. A depth cut counts only when something lies above depth 8. Nothing presents a partial picture as whole.
- Work's `WorkBoard` carries `contextComplete` too, for the same reasons.

The walk down, for reparenting, is a separate statement with no limit: a notification cannot silently leave out a deeper descendant.

## 8. The Inbox

### 8.1 Membership

*(Amended 2026-11-12, [#1122](https://github.com/theagenticage/hercule/issues/1122).)* A thing is on the Inbox when it is a **full record of a work kind** with at least one of:

- a current concern;
- an open signal that is not snoozed now ([section 8.5](#85-signals-inside-a-card));
- a live linked Task;

and it is **not dismissed, or it has an ask raised after the dismissal** ([section 4.2](#42-dismissal)). Context and partial records are never on it. Membership is **one SQL definition in the external-entities domain** (`buildEligibleEntities`), used by every read of the Inbox: the page, the counts, the facets, the suggestions and the arrival recorder, so they cannot disagree. It does not filter on `lifecycle`, `access`, the Connection's state, the kind being active or `stale`: a thing survives a lost token and keeps its last known facts. A snooze ends with time and nothing is written when it ends, so every read takes the time of the read.

**An ask** is an open signal that is not snoozed, of a kind that asks the user for a move, that nobody has taken.

- A kind asks when its plugin declares `asks: true` ([./05-plugins.md](./05-plugins.md)) and the plugin is active. The core's own kinds (proposal, offer, unsure, fyi) do not ask: Triage shows them. One function decides which kinds ask (`listAskingKinds`), so a later per-user setting slots in there.
- **An ask is taken** when the user took the thing on, by Take on or Add to Work, after the ask was raised. The link of a Task to a ref records when the user took it on (`task_entity_links.taken_at`, null when they did not). Only Take on and Add to Work set it, and they set it in both cases: when they make the Task, and when they join a Task that something else made (a hand-off, a Task made from a signal or an event, a session). So a hand-off, a Task made from a signal and a Task made from an event do not take by themselves, and the user's Take on afterwards does. The take-on counts on the thing's active Task (the oldest live link). So Take on removes the thing from "Someone waits on me", and an ask raised after the take-on brings it back. After a hand-off, the asks its workflow answers are ended and the rest still ask. No existing link is marked taken when this is introduced: the evidence of an old Take on is ambiguous, and an ask is never hidden on a guess.

The saved queries, the Browse clauses and the search narrow this set with the clauses of one vocabulary (`InboxClause`), compiled by one pure function (`inbox-predicates.ts`) into SQL with bound values.

### 8.2 Sides

*(Amended 2026-11-12, [#1122](https://github.com/theagenticage/hercule/issues/1122).)* **Retired.** The Inbox has no sides (`requests`, `ongoing`, `with-someone-else`) and no riding. It is one list per saved query, one row per thing. A card that a live Task holds is on "With Hercule" (`held`). *(Amended 2026-11-13, [#1124](https://github.com/theagenticage/hercule/issues/1124).)* Things linked to each other are drawn as one group, which is not riding: see [section 8.6](#86-groups-of-linked-things).

### 8.3 Reading

*(Amended 2026-11-12, [#1122](https://github.com/theagenticage/hercule/issues/1122).)* `externalEntity.queryInbox` returns **one page of a list**, in a fixed number of statements however many things the Inbox holds.

- **The input** is one selection, `{ list, clauses?, text? }`, read in one of four modes, written `{ mode, ...selection }`: `first`; `next` with `after`; `refresh` with `held`; and `rows` with `held` (at most 400 refs each). A field that does not belong to the mode is refused. `list` is the scope: `{ savedQuery }` (the core's `waits`, `mine`, `updates`, `held` as `with-hercule`, and `everything`, then a plugin's, such as `github/review-requests`) or `{ browse: { source, connectionId?, key, value } }`, one value of one Facet. `clauses` (at most 12) and `text` (at most 200 characters, at most 12 words) are the search, and only narrow the scope. A clause is `{ key, op, value, source?, connectionId? }`: `op` is `is`, `over` or `under`; the key is a core key (`source`, `kind`, `account`, `from`, `waiting`, `asks`, `held`, `mine`, `signal`) or a field a source declares ([./05-plugins.md](./05-plugins.md)); a clause with a `source` or `connectionId` holds only for it. `is` takes one value or, in a saved query or an API call, a list of at most 8 that means "any of these" (a list with `over` or `under` is refused; the CLI and the search box type one value) *(Amended 2026-11-12, [#1122](https://github.com/theagenticage/hercule/issues/1122).)*. `is` on text, person and enum fields compares without regard to case (ASCII); on a facet of records it matches the stored ref or the record's title, but a title only while some Connection can read that record. `over` and `under` compare a number, an amount, or a duration in seconds (an `age` field, and `waiting`, the age of the oldest ask), measured against the one clock of the read. The value is read by one grammar for the type of the field (the CLI, the search box, the plugin load checks and the controller all use it): text, person and enum values stay text whatever they look like (`001`, `true` and `2d` are words on a text field); a boolean is `yes`, `no`, `true` or `false`; a number takes `is`, `over` and `under`; a duration takes `over` and `under` with a number of seconds or a number with `s`, `m`, `h`, `d` or `w`. A key nobody declares, or an operator the key does not take, fails `validation` with the sentence that says what to write. A value a source's type cannot hold does not match there.
- **The replies.** Each carries the `mode` it answers. `first` returns `{ things, nextCursor?, total, order, facets, offerSets }`; `next` returns `{ things, nextCursor?, offerSets }`; `rows` returns `{ things, offerSets }`; `refresh` returns `{ first, held: { things, offerSets } }`, where `first` is the reply of `first`. *(Amended 2026-11-13, [#1124](https://github.com/theagenticage/hercule/issues/1124).)* Every reply that holds `things` also holds `groups`, the groups those things belong to ([section 8.6](#86-groups-of-linked-things)); a thing that is in no group's `members` stands alone. A page holds at most 200 `InboxThing`s (things, not rows: a group counts as its members); `first` takes an optional `limit`, 1 to 200 (default 200), the most things its page holds, for a client that needs only a few results, such as the search of Link to... (a group that fits in `limit` is kept whole, and a first group larger than it is cut to it, as for 200; nothing else in the reply changes). A page is ordered `waiting` (things with an ask first, the oldest ask first, then the rest by the latest change) or `newest` (the latest change first), ties by ref. A Browse scope is ordered `waiting`. The page is a keyset: `nextCursor` carries a hash of the list, clauses, text and order beside the sort tuple, and a cursor of another query, or one that does not decode, fails `validation`. `total` counts the whole result, in things. `rows` reads the held refs that still belong to the list ([section 8.6](#86-groups-of-linked-things) says when a held ref in a group does), in the list's order, and a held ref that is not in `things` has left the list. `refresh` reads the first page and then the held refs that are not on it, in one read snapshot at one clock, so a client that keeps a list on screen needs one request and has no partly failed refresh. Each mode sends a fixed number of statements however many things the Inbox holds.
- **The first page** (mode `first`, and the first page inside `refresh`) also carries `facets`: the values of the facet fields over the whole result, per source and, for a source with several accounts, per account, with counts, at most 30 values each and a `more` count.
- **The statements.** One statement finds, filters, counts, orders and cuts the page; the first page carries the total, so an empty first page needs no second count. Then the details of the refs on the page alone, one statement each: the entity rows, the observations, the asks, the open signal kinds, the field values and card faces, the offers (including `lastHandedAt`: when the user last handed a thing of the kind to the workflow, from the hand-off records that were not taken back), and the workflows running on their Tasks. The first page adds the accounts and the facets. *(Amended 2026-11-13, [#1124](https://github.com/theagenticage/hercule/issues/1124).)* Groups add up to three statements: one that reads the links that join things, once per read snapshot, one that reads whether the things at the ends of those links are on the Inbox (left out when there are no links), and one that reads the members of the groups on the page (left out when the page holds none). No count depends on the number of things.
- **A thing** is lean: its ref, kind, noun, source, identifier, title, status, `access`, `stale`, `observedAt`, `sourceUpdatedAt`, `patience`, `face`, its `asks` (newest first, at most 3, each with its kind's noun, the asker and the finished sentence), `askCount` (all of them), `askKinds`, `openKinds` (every open signal's kind, snoozed ones too: what a hand-off ends), `waitingSince` (the oldest ask), ~~its Task (`taskId`) and `taskTitle` *(added 2026-11-13, [#1123](https://github.com/theagenticage/hercule/issues/1123))* (the Task's title, present exactly when `taskId` is, read in the page statement, so a pane names the Task with no read of it), `takenOn` (the user took the thing on, so the row may say that they have it),~~ *(amended 2026-11-14, [#1170](https://github.com/theagenticage/hercule/issues/1170))* its active Task as one optional `task` (`InboxActiveTask`: `id`; `title`, read in the page statement, so a pane names the Task with no read of it; and `workingThreadCount`, the Threads of the Task in a working status, one statement per page from the sessions table), `liveWorkflows` (a field of the thing, not of `task`, because a client draws a workflow it has just handed the thing to before it knows the Task the hand-off made), `dismissedAt` (only when it came back), `offerSetId` and `actingConnections`, and `accounts`. It leaves out what a row never draws, such as the lifecycle; the pane reads those and every ask from `externalEntity.read`. A page holds 200 things, so every field costs 200 times its size.

`externalEntity.suggestInboxValues` returns, for the search box, the values of one field among the things of a list (before the search), whose label starts with a prefix, most common first, at most 8. It works for text, person and enum fields and for the core keys `from`, `source`, `kind`, `signal` and `account`. A value that several sources hold is suggested once, with the summed count and the source that holds most of it. Signal kinds are matched and labelled by their noun ("review request"). A facet of records suggests only records some Connection can read. It names accounts, so it needs `connection.query` besides `task.read` and `signal.query`.

**Reading cards.** *(Added 2026-11-13, [#1127](https://github.com/theagenticage/hercule/issues/1127).)* `externalEntity.readCards` takes `{ ids }`, 1 to `MAX_CONTEXT_REFERENCES` (50) distinct entity ids, and returns `{ cards }`: an `EntityCard` for each id that names a thing, in the order asked. An id that names nothing (unknown or pruned) is left out and is no error, so a client draws what it already knows for it. A card is `{ id, ref, kind, noun, card?, identifier?, title?, status?, access?, face, restricted }`, where `card` is the kind's `rich` or `compact` card, so a client can hide a `norm` status on a compact card as the Inbox does: record data and the card face of the kind (`face` is null for a kind with none), with no signals, offers, links or Inbox membership. A place no Connection can read now is `restricted` ([section 1.3](#13-restricted-things)): only `id`, `ref`, `kind`, `noun` and a null `face`, with no `card`. A full record that lost access is not restricted: it keeps its last known facts, as `externalEntity.read` does, and its face, and its `access` (`inaccessible` or `deleted`) so a client shows the facts as last known; `access` is absent only on a restricted card. A partial record that some Connection can read gives what its rows hold, so `title` and `card` may be absent. It reads stored rows only, never a source, in a fixed number of statements however many ids there are: the records and their observations, then the field values the faces need. It needs `task.read` only, because a card shows what `search` shows (title and status) and none of what `signal.query`, `workflow.query` and `connection.query` guard. A card changes when the thing's record changes (the `externalEntity` push), when a Connection's access changes (`connection`), and when a plugin's face declaration changes (`plugin`).

### 8.4 Counts, the outline and the new mark

*(Amended 2026-11-12, [#1122](https://github.com/theagenticage/hercule/issues/1122).)* Two reads, because every screen needs the sidebar's number and only the Inbox needs the rail. Everything counts distinct things.

`externalEntity.countInbox` returns `{ waiting, newestArrival }` in one statement: how many things are in "Someone waits on me", and the highest `arrival_sequence` among them. It is shell data, read on every screen, with the grants `task.read` and `signal.query`.

`externalEntity.readInboxOutline` returns what the rail draws, in a fixed handful of statements, and only the Inbox screen reads it. It names accounts, so it needs `connection.query` too. The parts of `InboxOutline`:

| Part | Meaning |
|---|---|
| `savedQueries` | Every saved query with its count, in one statement, and its `signalKinds` *(added 2026-11-12, [#1123](https://github.com/theagenticage/hercule/issues/1123))*: the qualified kinds its `signal is` clauses name, at most 8, empty when it has none. The pane unfolds the ask of one of them first |
| `sources` | One entry per source that holds things: its count, whether the user folded it (`inbox.browseFolded`), its accounts when more than one holds things, and, unless folded, its facets with up to 100 values each and `more`. A record of a facet's context kind that holds none of the user's things is listed with count 0, so every Linear project is there, but only a record some Connection can read and, in the facet of one account, only a record that account observes. A counted value whose record nobody can read is labelled "A team you cannot open", never with the ref or the title |
| `pins` | Each of the user's `inbox.pins` with its current label (a readable record's title, an enum value's label, "A team you cannot open" for an unreadable record) and count; a value that names nothing keeps its text and count 0 |
| `fields` | The query fields: one per source and key, and the core's own with no source (one table, `CORE_INBOX_FIELDS`, which the query compiler and the plugin load checks read too) |
| `failing` | Sources with a Connection that needs signing in again or is in error, and `updatedAt`: when such a Connection was last changed (the latest sign of the failure the controller keeps, not when it began) |

A session reads the outline with no pins and every source open, because both settings are the user's own.

`arrival_sequence` comes from the counter table, never from `MAX() + 1`, and never from a time, so no clock is compared. A number is taken when a thing **comes onto the Inbox** (it was not on it and concerned the user through no Connection), **when it comes back after a dismissal**, or **when it begins to ask** (it had no ask before), in a `reconcile`, a `refresh` or a raised signal, through `recordArrivalsAfter`: the Inbox is looked at before the write. So these never take one:

- a refresh of a thing that was already there, a change of facts, a summary, or a second ask on a thing that already asks;
- an Undo (`restore`), or a Task finishing;
- a second Connection reporting a concern that is already present;
- a concern joining a thing that a live signal had already put on the Inbox;
- a partial record becoming full when it already had concerns.

**The new mark.** The 6px dot shows when `newestArrival` is above the value this client acknowledged. When an Inbox reply is really shown, the client stores that reply's `newestArrival` in local storage, under controller and user. It stores the reply's value and never the time, so an arrival racing the visit stays newer than what was acknowledged.

### 8.5 Signals inside a card

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033); [ADR 0054](../adr/0054-external-entities-are-durable-records-kept-true-by-polls.md).)* A signal shows inside the card it is about, and stays on Intake. The Signal record is [spec 10 section 9.1](./10-triage-intake-and-notifications.md#91-the-record).

- **The join** is exact string equality, on read: `signals.thread_ref = external_entities.ref`. Nothing is stored on either side, so a signal that came before its entity attaches the moment the entity appears, and an old signal needs no migration. Only an `event` signal has a thread ref: an `api` signal stores none and stays on its own. A ref is never parsed or changed to make it match, and a URL, a repository, a title or a core signal's evidence events never join. `github:pr:` and `github:issue:` are different refs. The index is `signals_thread_ref` on (`thread_ref`, `status`, `created_at`, `id`): a card's read seeks its open signals, and the detail reads the newest lines of one status straight off the index, in order, with no sort and no read of the other signals.
- **Only a work kind joins.** The entity must be a full record of a work kind, the shape that can have a card. A signal on a place (`linear:project:`), a document, a notification, a partial record or a ref nobody has read stays on its own, with Intake's actions. `listWanted`, `SignalEntity` and the Inbox all follow this rule.
- **Membership and retention differ on purpose:**

  | Question | Rule |
  |---|---|
  | Is the card on the Inbox? | An open signal that is not snoozed now puts it there ([section 8.1](#81-membership)). A snoozed signal does not, and shows in the card's lines marked so |
  | Is the record kept and read? | Any open signal, snoozed or not, stops the prune sweep and makes the ref wanted. A snoozed signal still needs its card to be current when it comes back |

- **Dismissal holds, except for a new ask.** A dismissed card stays out of sight whatever signals arrive, unless an ask is raised after the dismissal ([section 4.2](#42-dismissal)). The signal stays open and shows on Intake, so it is not lost.
- **A card's signals.** *(Amended 2026-11-12, [#1122](https://github.com/theagenticage/hercule/issues/1122).)* An Inbox row carries the open asks (`InboxThing.asks`, `askCount`, `askKinds`, `openKinds`), not the old `InboxCard.signals`. Before it: `InboxCard.signals` was `{ latest?, openCount }`; `openCount` counted the open signals that are not snoozed, and `latest` was the newest of them, by `createdAt` then `id`. A line (`EntitySignalLine`) holds the id, kind, title, asker, priority, status, time, the sentence (`say`), the `outcome` once the signal has ended and whether it is `snoozed` and, *(added 2026-11-12, [#1123](https://github.com/theagenticage/hercule/issues/1123))*, whether its kind `asks` (`listAskingKinds`, the one place that decides). It holds no blocks and no answers: opening a line reads `signal.read`. *(Amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* `InboxCard.signals` also carries `kinds`: the distinct kinds of the card's open signals, snoozed ones included, sorted and bounded by `MAX_ENTITY_SIGNALS`. A handoff ends the open signals of the kinds its workflow answers, and snoozed ones are among them, so the menu needs every open kind to say what a click ends and what it leaves open ("Ends *Review requested*. Leaves the mention open.").
- **Blocks of a thing.** *(Added 2026-11-12, [#1123](https://github.com/theagenticage/hercule/issues/1123).)* `externalEntity.readBlocks` serves the blocks a plugin offers for one thing, when the Inbox pane opens ([./05-plugins.md](./05-plugins.md#43-event-source)). They are read from the source on demand and never stored, so they cost a call to the source and can fail: the pane then draws one quiet line, and the rest of the detail is unaffected. The thing must be readable as `read` requires.
- **The detail's signals.** `ExternalEntityDetail` gains `signals` (at most `MAX_ENTITY_SIGNALS`, 50), `openCount` (every open signal, snoozed ones included) and `signalCount` (open and resolved). The newest open signals are selected first, up to 50. The newest resolved ones fill any room left. The selected lines are returned in time order, oldest first, by `createdAt` then `id`. It is three statements, all served by that index and bounded by the limit however many signals the ref has: the two counts, the open lines, and the resolved lines (not read when the open ones fill the room). Open work is never hidden behind the word "older": a client says how many open lines it left out before it says how many resolved ones.
- **The sentence.** The Inbox card's `reason` is the sentence of its latest live signal. A card with no live signal keeps the observation's own reason. One function builds the sentence for a card and for every line of its detail. It reads the entity's `reason_templates` under the signal kind's word (the part after `<plugin>/`, so `github/review-requested` reads `review-requested`) and fills `{person}` with the signal's `asker`. It falls back to the signal's title, with the tone `plain`, for a core kind, for a kind the entity stores no template for, and when the template needs a person the signal does not have. The result is cut at a word to the bound of `EntityReason.say`. The templates are stored, never read from the catalog at read time, so a sentence reads well after its plugin is gone.
- **Arrival** is in [section 8.4](#84-counts-the-outline-and-the-new-mark).
- **Acting on a card ends no signal it did not answer.** `takeOn` and `dismiss` end none. The user marks each signal done from its line with `signal.markDone`, or answers it with `signal.act`. A signal is never a fact of the Task. *(Amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* A handoff answers the signals of the kinds its workflow lists in `answers`, and only those ([section 9.6](#96-hand-off-and-its-undo)). Your work follows the links: it shows a signal on the active Task of its ref only ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#signal)).

### 8.6 Groups of linked things

*(Amended 2026-11-13, [#1124](https://github.com/theagenticage/hercule/issues/1124).)* The Inbox draws things that are linked to each other as one **group**. This replaces riding, which is gone with its counts. A group is not a record: nothing is stored, and the user's own act of grouping is `externalEntity.link` ([section 9.5](#95-link-and-unlink)). The UI says Link, never "bundle".

- **What a group is.** Take the things on the Inbox ([section 8.1](#81-membership), before the list's query, clauses and text) and the links that join two of them directly: a claim of relation `linked` that is current and resolved, whose firmest type is `source` or `person` (`EFFECTIVE_LINK_SQL`). A group is a connected component of that graph, so it is transitive: A linked to B and B linked to C is one group, even when B does not answer the list's query. A link through a thing that is not on the Inbox joins nothing, so a dismissed thing, a thing no concern holds, a context record or a partial record never bridges two groups. A text hint, a pending claim and a part-of edge join nothing. A thing linked to nothing on the Inbox is in no group, and a component of one thing is not a group.
- **The label.** A group is named after one member: the one whose active kind declares the highest `lasting`, then the oldest (`source_created_at`, else `first_observed_at`), then the lowest ref. A kind that is absent or inactive counts as `lasting` 0. `labelRef` and `label` (that member's title) travel with the group. `labelRef` names the group within one reply only. It changes when the members change, so a client never keeps it as an identity. Nobody renames a group.
- **Where a group stands.** A group is on a list when at least one member answers the list's query. It stands where its first matching member stands in the list's order (`ORDER_BY`, ties by ref), as one unit. Members that do not answer are still in it, and a client draws them quieter.
- **The members.** `InboxGroup.members` lists `{ id, ref, matches }` for every member, so a move that takes ids (Dismiss, Take on together) needs no other read, even for a member that is not on the page. The members that answer the query come first, then the others, each part in the list's order (ties by ref). So the first member is the one that places the group. `size` is how many members the group has.
- **Counts count things.** `total`, the facets, `countInbox` and `readInboxOutline` count the things that answer the query, as before. A group is never counted.
- **A page is made of units.** A unit is a group or a thing that is in no group. Units are ranked in the list's order before the keyset applies, and the keyset applies to each unit's placing row (its first matching member), so a group never comes twice and a cursor continues after the whole unit. `first` and `next` take whole units while they fit in 200 things, and stop at the first unit that does not fit, so a later small unit never jumps ahead of it. When the very first unit alone is larger than the page, the page holds its first members, in member order, and the cursor still moves past all of it. The group's `members` still list every member, so a client sees the group as cut when some of its members are not in `things`, and says so.
- **Held reads.** `rows` and the held half of `refresh` hydrate exactly the held refs that are still on the list, at most 400, and describe the group of each. A held ref is still on the list when it answers the query, or when its group has a member that answers (it is then drawn quieter). Whole groups are not expanded: the reply describes the group. The client does not hold a row for every member, so when a group is shown open its visit reads the rows of the members it does not hold, with the `rows` mode and its 400-ref window. Until those rows arrive, "Show N more" and the group head's count say how many members are not loaded yet. A held ref has left the list exactly when it is not in `things`. A `refresh` can describe one group in both of its halves, and both descriptions come from one snapshot, so they agree.
- **A group of more than 1,000 members** lists its first 1,000 (`MAX_INBOX_MOVED_THINGS`) and says its full `size`. The members that answer the query come first, so they all survive the cap unless more than 1,000 answer. The cap never drops a held member: `rows` and the held half of `refresh` keep every held ref of an answering group on the list, and list every one of them in its group's `members` (the capped members plus the held ones beyond them, so `members` may hold up to 400 more than 1,000). A client refuses Dismiss and Take on together for a group whose `size` is above its `members`, saying why, because they would not reach every member.
- **Cost.** The groups come from the effective links: one statement reads them, and a second checks which of their ends are on the Inbox and reads what electing the label needs, so the cost follows the links and not the number of things. The members of a group are ranked and cut per group in the statement that reads them, so a group of thousands sends only the 1,000 a reply holds. It is decided once per read snapshot, in the pure `decideGroups` (`inbox-groups.ts`), and `first`, `next`, `rows` and both halves of `refresh` all use that one decision.
- **Reading one group.** *(Added 2026-11-13, [#1124](https://github.com/theagenticage/hercule/issues/1124).)* `externalEntity.readInboxGroup` takes a `ref` and returns `InboxGroupDetail { labelRef, label, members, links, complete }`: the group of that thing among the things on the Inbox, decided by the same `readGroups` and `decideGroups` as `queryInbox`, in one read snapshot, with no list's query. `members` are `EntityPeer`s, built as `read` builds them, the label thing first and the others sorted by ref, at most 1,000. `links` are the links between two members, each pair once under its firmest claim with `hasPersonClaim`, in the order of that claim's id, at most `MAX_GRAPH_EDGES`, so the pane shows who linked each pair and offers Unlink. A thing on the Inbox that is linked to nothing there is a group of one with no links; a thing that is not on the Inbox fails `NotFound`. `complete` is false when members or links were cut. It shows no signal text, but whether a thing is on the Inbox depends on its signals, and the `NotFound` for a thing that is not would reveal that, so it needs `signal.query` as well as `task.read`, as `countInbox` does. It sends a fixed number of statements however large the group is.

**`peers`, `EntityLink` and `EntityHint`** stay for `externalEntity.read`:

- **`peers`.** `EntityPeer` holds `ref`, `kind`, `noun`, `identifier`, `title`, `status`, `yours`, `restricted` and `latestChange`, *(Amended 2026-11-10, [#1105](https://github.com/theagenticage/hercule/issues/1105).)* and `url`, where the source shows the thing, so its row can open it in the browser, and an `id` when the record is a full record of a work kind, so its row can open. A restricted peer holds only `ref`, `kind`, `noun`, `restricted: true` and `yours: false`. A link target that has no record, because no Connection ever read it, is a restricted peer too when an active kind owns its ref (by `refPrefix`), so it draws as a locked row while that kind is active. When no active kind owns it, it has no peer.
- **A link and a hint are two lists, and the controller decides which a pair is.** An `EntityLink` is a pair a source or a person claims, and names its claim's type (`source` or `person`) and its plugin or actor; an `EntityHint` is a pair only text holds together, with the `fromRef` whose text holds the reference and its `evidenceKey` (at most 128 characters), so a client can say "The description of #6263". A pair with a source's or a person's claim and a text claim is a link only, and a client never reads a claim's type to decide whether a pair joins. `hasPersonClaim` is true when a person also claims the pair, whatever the firmest claim is: a source's claim hides the person's one in `claim`, but the person can still take theirs back, and a client offers Unlink from this.

### 8.7 What changed outside

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* **The system shows that something happened at the source, and does not act on it.** Rogier, 2026-11-07: "the system should show that something happened in the external system (someone else assigned the ticket, someone else created a pr, etc.), but not really act on it."

- **Written** by `reconcile` and `refresh`, in their transaction, when a compare of the raw stored values (never of a rendered sentence) shows news, and only on the accepted shared write: an older Connection's rejected observation makes none.
  - `reassigned`: the update sets an `owner` that differs from the stored one. `person` is the new owner. Clearing the owner is news too: the change has no `person` and reads "Unassigned".
  - `moved`: the update sets a status whose **key** (`status_key`) differs from the stored one. `value` is the new word. A word the plugin only renamed is no news, and a thing with no status before is no news either.
  - `linked`: a `source` claim joined a pair that no source or person joined before. It is written once for the pair, on both ends, with `target_ref` the other end. It stores no words: they are worked out when it is read. A second Connection reporting the same edge, a person's link and a hint write none. The resolver loop writes one too when it settles a claim ([section 5.5](#55-resolving-pending-claims)).
  - **A first observation writes none,** and neither does a partial record that a full observation completes. A claim written while its thing was not yet a full record is stored with `in_baseline`, and writes no `linked` change then or when it resolves later: what a thing already carried is a baseline, not news.
- **At most 50 rows for a ref** (`MAX_ENTITY_TIMELINE`). The write that goes over deletes the oldest.
- **The words** come from the entity's `reason_templates` under the keys `reassigned`, `moved`, `linked` and `unassigned`, else from the core's own sentences: "Now with {person}", "Moved to {value}", "Linked {value}", "Unassigned". They are built when read, by the function that builds a signal's sentence.
  - **A `linked` change names the far end from what the user can open now.** `{value}` is the far end's identifier when some Connection reads it (else "a pull request", its noun with an article). A far end no Connection can read, or that has no record, reads "a pull request you cannot open": the noun of its record, else of the active kind whose `refPrefix` starts its ref, else "thing". It never shows an identifier. So a change written while the far end was readable stops naming it when it no longer is. Reading a whole list costs at most two more statements.
- **Read.** `ExternalEntityDetail.timeline` holds at most 50 changes, oldest first. Each is `{ reason, sentence, at, ref? }`, with `ref` for a `linked` change. Each entity record, `EntityPlace` and unrestricted `EntityPeer` has `latestChange`, read for a whole list in one statement, so a Task's linked thing shows its latest change wherever the shared relation row draws it.
- **Nothing acts on it.** No stage moves, no run stops, no signal ends, no card changes place, no Task changes, and no event or signal is raised. Two pull requests for one ticket are fine: each is linked, and each says so.

### 8.8 What a card can be handed to

*(Added 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* A workflow with an `entity` input ([./07-workflows.md](./07-workflows.md#3-inputs)) can take a card's thing. A card carries its **offers**: the workflows it could be handed to, each available or unavailable with a reason.

**A workflow is available on a thing** when all of these hold:

1. It is enabled and valid.
2. It has exactly one `entity` input, and that input lists the thing's qualified kind.
3. It has at most one required `connection` input with no default of the Connection type of the kind's plugin (the core fills it with the acting account), and at least one acting account exists for the thing.
4. Every other required input has a default.
5. Its repository fits. A workflow with no `workspace`, or with no checkout, runs anywhere. A workflow whose workspace names Resources fits a thing that has a `repository` only when one of those Resources' `canonicalRemote` equals the thing's `repository.target.remote`. A pull request from a fork compares its **target**: that is the repository the work lands in. **A kind with no `repository`, such as a Linear issue, has nothing to compare, so any workflow fits.** A ticket does not say which repository it needs, so the user chooses by choosing the workflow, as they do today.

**Unavailable, with a reason.** When a workflow is listed and one of the rules above fails, the offer says why, when the user can act on it. When several fail, the first of these is given:

| `reason` | The menu says |
|---|---|
| `needs-input` | "*Name* needs *input*, which a card cannot fill" |
| `repository` | "*Name* works on *acme/web* only" |
| `no-account` | "No connected account can act on this" |
| `needs-workflow-change` | "*Name* needs a workflow change: replace its signal input with an entity input" |

`needs-workflow-change` is for a workflow that has a `signal` input on a signal kind the thing's plugin raises, and no `entity` input. It is listed so the user learns what to change, and it stays offered on Intake meanwhile ([spec 10 §9.4](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)). A disabled or invalid workflow is not listed at all, and neither is one whose `entity` input does not list the kind.

**The acting accounts of a thing** are the Connections of the Connection type of the kind's plugin that have an observation of this very thing with `access: ok` and whose status passes the rule a run start applies to a `connection` input: a Connection that is `disabled` is refused, and `needs-reauth` and `error` are not, because the action that uses the Connection reports that problem. They are listed oldest first (`created_at`, then id), and the first is the default. With several, the menu names the default ("as northwind-bot") and the user can change it. The Connection a poll last used plays no part. A thing no Connection can act on has none, and every workflow is then unavailable with `no-account`.

**The reply.** Offers depend on the kind, the target repository and whether an account can act, not on the card. So `Inbox.offerSets` maps an opaque `offerSetId` to the offers of that group, and each card names its set with `offerSetId` and lists its own accounts in `actingConnections`. The id is built from those three parts, and a client only compares ids; it never parses one. Offers are listed available first, then unavailable, each by name. The lists are bounded by the server (`MAX_ENTITY_OFFERS`, `MAX_ACTING_CONNECTIONS`), so the handoff never reads them: it checks its one workflow and its one Connection directly, with the same rules. `ExternalEntityDetail` carries `offers` and `actingConnections` for one thing. One pure function decides each offer, from workflows, Resources and accounts that are already read, so the Inbox, the detail and the handoff cannot disagree about what is available.

## 9. Operations

The group is `externalEntity` in `packages/contract`; the CLI spells it `hercule entity`. It reuses the `task` grant family, as `modelProfile` reuses `infra`: no new family and no grants migration. The operations are in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#externalentity). Every mutation is stamped with an actor, and the permission check and the stamp live inside the service method. A transport handler is one line.

| Operation | Route | Grant | What it does |
|---|---|---|---|
| `externalEntity.queryInbox` | `POST /external-entities/inbox/query` | `task.read`, `signal.query`, `workflow.query`, `connection.query` and `run.query` | One read of an Inbox list in one of four modes ([section 8.3](#83-reading)), with the offers ([section 8.8](#88-what-a-card-can-be-handed-to)) |
| `externalEntity.countInbox` | `GET /external-entities/inbox/count` | `task.read` and `signal.query` | `InboxCounts` (`{ waiting, newestArrival }`), for the sidebar |
| `externalEntity.readInboxOutline` | `GET /external-entities/inbox/outline` | `task.read`, `signal.query` and `connection.query` | `InboxOutline`, for the rail ([section 8.4](#84-counts-the-outline-and-the-new-mark)) |
| `externalEntity.suggestInboxValues` | `POST /external-entities/inbox/values` | `task.read`, `signal.query` and `connection.query` | The search's value suggestions ([section 8.3](#83-reading)) |
| `externalEntity.matchProject` | `POST /external-entities/match-project` | `task.read`, `project.read` and `resource.read` | The Project a set of things points at ([section 9.4](#94-the-project-of-a-task-taken-on)). `NotFound` for an unknown id |
| `externalEntity.readInboxGroup` | `POST /external-entities/inbox/group` | `task.read` and `signal.query` | The group of one thing on the Inbox, with its members and links ([section 8.6](#86-groups-of-linked-things)). `NotFound` when the thing is not on the Inbox |
| `externalEntity.readCards` | `POST /external-entities/cards` | `task.read` | The small cards of 1 to 50 things, in the order asked ([section 8.3](#83-reading), reading cards). An id that names nothing is left out |
| `externalEntity.read` | `GET /external-entities/:id` | `task.read`, `signal.query`, `workflow.query` and `connection.query` | One full record of a work kind, with its offers. `NotFound` for a partial or context record |
| `externalEntity.takeOn` | `POST /external-entities/:id/take-on` | `task.update`, user only | [Section 9.1](#91-take-on-and-add-to-work) |
| `externalEntity.undoTakeOn` | `POST /external-entities/:id/take-on/undo` | `task.update`, user only | [Section 9.2](#92-undo-of-a-take-or-an-add) |
| `externalEntity.takeOnTogether` | `POST /external-entities/take-on` | `task.update`, user only | [Section 9.1](#91-take-on-and-add-to-work) |
| `externalEntity.undoTakeOnTogether` | `POST /external-entities/take-on/undo` | `task.update`, user only | [Section 9.2](#92-undo-of-a-take-or-an-add) |
| `externalEntity.handOff` | `POST /external-entities/:id/hand-off` | `run.start`, user only | [Section 9.6](#96-hand-off-and-its-undo) |
| `externalEntity.undoHandOff` | `POST /external-entities/handoffs/:runId/undo` | `run.write`, user only | [Section 9.6](#96-hand-off-and-its-undo) |
| `externalEntity.dismiss` | `POST /external-entities/dismiss` | `task.update`, user only | Sets `dismissed_at` and `dismissed_by` of up to 1,000 things, all or none |
| `externalEntity.restore` | `POST /external-entities/restore` | `task.update`, user only | Undo of a dismissal, for the same ids |
| `externalEntity.search` | `GET /external-entities/search` | `task.read` and `connection.query`, user only | [Section 10](#10-search-recognition-and-resolution) |
| `externalEntity.listSuggestions` | `GET /external-entities/suggestions` | `task.read` | What the Add sheet lists before you type |
| `externalEntity.addToWork` | `POST /external-entities/add-to-work` | `task.update`, user only | [Section 9.1](#91-take-on-and-add-to-work) |
| `externalEntity.link` | `POST /external-entities/links` | `task.update`, user only | [Section 9.5](#95-link-and-unlink) |
| `externalEntity.unlink` | `POST /external-entities/links/remove` | `task.update`, user only | [Section 9.5](#95-link-and-unlink) |

`read` returns the common fields of a card plus `kindAvailable`, `places`, `edges`, `links` (the pairs a source or a person joined, each once, under its firmest claim, which names only its plugin or actor and never a Connection), `hints` (the pairs only text holds together), `conflicts` (the claims the graph refused, with why), and, from slice 5, `signals`, `openCount`, `signalCount`, `timeline` and `peers` ([sections 8.5 to 8.7](#85-signals-inside-a-card)). It needs `signal.query` besides `task.read`, because it shows signal text. *(Amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* It also returns `offers` and `actingConnections`, and needs `workflow.query` and `connection.query` for them, because offers name workflows and accounts. The service checks all four before it reads. The static paths (`inbox`, `search`, `suggestions`, `add-to-work`) sit beside `/external-entities/:id`, and the router prefers them.

A session may read (`list`, `read`, `suggestions`) but may not take on, add, dismiss, restore, link, unlink, hand off or take a handoff back: those are user only. The three reads that show signal text need `signal.query` as well, and the two that show offers need `workflow.query` and `connection.query`.

### 9.1 Take on and Add to work

Both create a Task for a thing, and share one step, `prepareEntityForTask(ref)`, which runs outside any transaction, after looking for an active Task:

- A **context kind** cannot be taken on. It fails `InvalidState`, saying why.
- A full record with `access: ok` and an active kind needs no read.
- Anything else (no record, a partial record, lost access) is read with `resolve` ([section 10](#10-search-recognition-and-resolution)). If that fails, the operation fails and no Task exists. A partial `found` result cannot satisfy preparation.

Inside the final transaction the service revalidates the exact requested ref, full completeness, `access: ok` and an active kind. For a prepared observation, it first checks that its Connection is still eligible, and applies it. Otherwise it recomputes those properties from current rows, so the path with no read is checked too. If they no longer hold, it fails with `Conflict` and no Task, and asks to retry. It never resolves inside the transaction. It also checks that no active Task has appeared, then writes the Task and the link together. The window between the first look and the transaction is only an optimization.

**Tasks go through `TaskService`.** The tasks domain provides two user-only methods for this: one creates a Task linked to one ref inside the caller's transaction, and one deletes a Task only when it is untouched since creation. The entity domain never inserts a Task itself.

- **`takeOn`** with an active Task returns that Task: a second click, or a second account, is idempotent. When that Task was not taken on by the user yet (a hand-off, a session, a signal or an event made it), `takeOn` marks its link as taken at that moment and still answers `created: false` ([section 8.1](#81-membership)). With none it creates a Task: the entity's title, the stage of [section 9.3](#93-the-stage-a-new-task-starts-at), priority `normal`, the project of [section 9.4](#94-the-project-of-a-task-taken-on), and provenance `{ ref }`, which writes the link. It returns `{ taskId, created }`. It fails `NotFound` for an unknown id. It writes nothing on the source.
- **A Thread started on things** *(added 2026-11-13, [#1126](https://github.com/theagenticage/hercule/issues/1126))* takes several things on at once. `session.spawn` with `newTask { title, entityIds }` calls `ExternalEntityService.takeOnAsOneTask`, which makes one Task for all the things: the given title, the stage of a Thread's Task (`exploring`), priority `normal`, one provenance entry and one link per thing, each marked as taken on by the user at the same moment, and then the Thread joins it ([./09-tasks.md](./09-tasks.md#which-task-a-session-gets)). Before that transaction, `prepareThingsForTask` prepares every thing exactly as `takeOn` does (`prepareEntityForTask`, so a partial record or lost access is read at its source), reading at most 4 things at once so that a selection of fifty does not hit a tracker's rate limit. The transaction never reads a source: it stores what was read, checks every thing again against the rows (a thing that changed since is a `Conflict` and the caller repeats), and checks the active Tasks, with one read of the records and one of the Tasks however many things there are. `takeOn` itself keeps its own path, because it is idempotent and takes its stage from the thing's status. `takeOnTogether` ([section 9.1](#91-take-on-and-add-to-work)) shares the reading of the records, the preparation of each thing and the check that it can still become a Task, and keeps its own rules for Tasks: it joins the one Task the things share and refuses only when they are on two or more. Unlike `takeOn`, a thing that already has an active Task is a `Conflict` and not a returned Task, because a Thread cannot start on two Tasks. The Task, the links and the session are written together or not at all. Its `task.created` and `externalEntity` announcements make the Inbox take the things off "Someone waits on me".
- **`addToWork { ref, projectId? }`** with an active Task returns that Task with `created: false` before any read, even when Hercule holds no record of the ref (the reply then has no `id`). Otherwise, after `prepareEntityForTask`, it writes in one transaction: the observation that was read (which creates the entity when it is new), the Task as `takeOn` makes it (in `projectId` when given; an unknown Project is `NotFound`), and `following` on the link when the entity has no concern of its own. It returns `{ id?, taskId, created, stage, followed }`; `id` is absent only when an existing Task links a ref Hercule holds no record of. The line at the foot reads "Added to Exploring. Hercule now follows WEB-301." Adding is always one thing at a time.
- **`takeOnTogether { ids, title }`** *(Amended 2026-11-13, [#1124](https://github.com/theagenticage/hercule/issues/1124).)* takes two or more things (at most 1,000, each once) on as one piece of work, for the Inbox's T on a group or a selection. The ids are full records of work kinds. It prepares each thing that has no active Task as `takeOn` does, outside any transaction, and revalidates inside the one transaction. It looks at the active Task of each id, and there are three cases:
  - **None has one.** It makes one Task, titled `title`, linked to every id and marked taken on by the user. The stage and the project follow [section 9.3](#93-the-stage-a-new-task-starts-at) and [section 9.4](#94-the-project-of-a-task-taken-on) for the **first id**, so the client puts the group's label thing first. It returns `created: true`.
  - **Those that have one share the same Task.** It links the others to that Task and marks every id taken on, as a single `takeOn` does for a Task a hand-off made. It makes no Task, ignores `title` and returns `created: false`.
  - **Two or more different Tasks.** It fails `InvalidState`, naming the Tasks, and writes nothing. The user takes the things on one at a time, or merges the Tasks first.

  It returns `{ taskId, created, recordId, added, taken }`: `added` is how many things it linked to the Task (all of them when it made the Task); `taken` is how many links it marked taken, which is `added` plus any thing the Task already linked that was not taken yet. A link that was taken already keeps its first time and taker. In the same transaction the call stores a **record** (table `entity_take_ons`, kept by the Task domain like the hand-off record): the Task, whether the call made it, the links it inserted with the `linked_at` they hold, and the links it marked taken with the `taken_at` they hold. `recordId` names it. Nothing else about the call is kept by the client, and the record is never deleted. It fails `InvalidState` also for a place, a thing that could not be read, and the same id twice, `NotFound` for an unknown id, and `Conflict` when a thing changed while the Task was being made and the call should be repeated. It writes nothing on the sources. The Task is made and joined through `TaskService`, as for `takeOn`.

Outbound work uses no credential in this slice. Never pick credentials from whichever poll updated the card. *(Amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* A handoff starts a run that acts through a Connection, so it picks one by a rule and not by the last poll: the acting account of [section 8.8](#88-what-a-card-can-be-handed-to), chosen by the user or the oldest one.

### 9.2 Undo of a Take or an Add

A Take or an Add that `created` a Task undoes with `externalEntity.undoTakeOn { id, taskId }`. In one transaction it reads the Task by its own id, **without following a merge redirect**, and deletes it only when it is live, not merged, and untouched since it was created: no Thread, no run, no other link, no edit. A Task that was merged into another is refused with its own reason, because the survivor now holds its work and its links. The check also requires the Task to link this entity's ref, so a stale id never deletes another thing's Task. Otherwise it changes nothing and answers `{ undone: false, reason }`, the undo line says why, and the Task stays. A check in the client could race a Thread joining, so the check and the delete are one write. A Dismiss undoes with `restore`.

*(Amended 2026-11-13, [#1124](https://github.com/theagenticage/hercule/issues/1124).)* **`externalEntity.undoTakeOnTogether { recordId }`** loads the record of a `takeOnTogether` call and takes back exactly what it holds. A `recordId` the controller does not hold fails `NotFound`. It reads no ids from the caller.

- **The Task was made.** It is deleted by the rule above, applied to the refs the record holds: it must link no other ref than those. The links the call itself wrote do not count as a touch.
- **The Task was joined.** Before any write, it checks that every link the record added still holds the recorded `linked_at` and every link the record marked taken still holds the recorded `taken_at`, each in the same row and column. A link that was removed, written again, or marked again by something else refuses the whole undo, and nothing changes. When they hold, it removes the added links and clears the taken mark on the other recorded links, and does nothing else. Removed links go as `unlink` removes a Task's link, but the refs are not recorded as unlinked by hand: an undo is not a decision to keep the thing away, so a scan may link it again.
- **A call that wrote nothing** (it joined a Task whose links were all written and taken already) has nothing to undo, and says so.
- It answers `{ undone, reason? }` as `undoTakeOn` does, with the reason in a sentence, and changes nothing when it refuses. The answer of an undo that succeeded is stored on the record, so a repeat returns `{ undone: true }` and writes nothing. A refusal is not stored: a later undo reads the rows again.

### 9.3 The stage a new Task starts at

`chooseStageForEntity(entity)` is the `stage` that the entity's status declares in the kind table, else `planned`. So Todo is Planned and In progress is Building. This one rule serves Take and Add.

### 9.4 The project of a Task taken on

Task `projectId` must be a real Project, so a Linear project or a GitHub repository is never used as one. The service takes `repository.target.remote` from the entity, finds its Resource by canonical remote, and finds that Resource's Projects (`project_resources`), leaving out deleted Projects, which keep their rows. With exactly one, it uses it. Otherwise the Task has no project. External team and project facts group things and never create core Projects or Initiatives.

*(Added 2026-11-13, [#1126](https://github.com/theagenticage/hercule/issues/1126).)* `externalEntity.matchProject` finds the Project that a selection of things points at, for the start-thread dialog's default, with the same Resource and Project rule but over many things in one read snapshot and a fixed number of statements. Its input is `{ ids }`, 1 to `MAX_THREAD_THINGS` entity ids (it fails `NotFound` naming any unknown id), and it returns a `ProjectMatch`:

1. The evidence is first each selected thing's own `repository.target.remote`. Only when none of them reaches a live Project, it is the repositories of the things directly linked to the selected ones (a link a source or a person made, in either direction, one hop; a hint and a pending claim count for nothing).
2. The distinct Projects of the step that produced evidence are counted: one is `matched`, with the Project, the Resource whose canonical remote matched, the first selected thing in input order that has the evidence (`thing`) and, for a linked thing's repository, that linked thing (`via`); more than one is `ambiguous`; none in either step is `none`.
3. `thing` and `via` are an `EvidenceEntity`: the id, the identifier the Inbox row shows, and the title only when some Connection can read that record ([section 1.3](#13-restricted-things)).

### 9.5 Link and unlink

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033). Amended 2026-11-13, [#1124](https://github.com/theagenticage/hercule/issues/1124): a call takes a set.)* The user links one thing to others with one move, and takes the links back. Both are methods on the service, user only, with the grant `task.update`. Refs hold `:`, `/` and `#`, so they travel in a body. The CLI spells them `hercule entity link <ref> --to <ref>...` and `hercule entity unlink <ref> --to <ref>...`, the flag repeated for each target. A group is one call, not one call per pair.

- **`externalEntity.link { fromRef, toRefs }`** (1 to 1,000 targets) writes, in one transaction, a `person` claim of relation `linked` from `fromRef` to each target, stamped with the actor. A target may be a ref nobody has read: it is read like any other linked target ([section 5.3](#53-refresh-listwanted-and-reportmissing)). The source is never told. It checks the whole set before it writes anything, so one bad target changes nothing: it fails `InvalidState` for a target equal to `fromRef`, a target named twice, and a ref that starts with `unresolved:`, and `NotFound` when Hercule holds no record of `fromRef`. It writes only the claims that are missing and announces the changed things once. It returns `{ created }`: the targets whose claim this call wrote, in order. A target the user had already linked in either direction is left out, and nothing changes for it. A client that undoes the call unlinks only the targets in `created`.
- **`externalEntity.unlink { fromRef, toRefs }`** removes, in one transaction, the user's own claims between `fromRef` and each target, in either direction, and returns `{ results }`: one `{ toRef, removed, remaining? }` per target, in order. `removed` is false when the user had made none. `remaining` is the firmest claim type that still joins the pair (`source`, `person` or `text`). A source's claim stays: only a person's word is the person's to take back. A target named twice fails `InvalidState`.
- A source's claim is firmer than a person's, so linking a pair that a source reports changes nothing the user sees. Linking a pair that only a hint reports makes it a link, and the hint is no longer drawn.

### 9.6 Hand off and its Undo

*(Added 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034); [ADR 0046](../adr/0046-handing-a-signal-off-tracks-the-work-on-a-task.md).)* **`externalEntity.handOff { id, workflowId, connectionId? }`** hands a card's thing to a workflow, as the user. It lives in its own service, `ExternalEntityHandoffs`, in the shape of `SignalHandoffs`, because it calls the run and signal services. It returns `RunStarted` and the `taskId` the run works on.

**The rule: acting never ends a signal it did not answer.** A handoff ends only the open signals of the kinds its workflow's `entity` input lists in `answers`. A mention on the same pull request stays open on the card. The order is what makes this safe:

1. Check the caller is the user and the entity exists.
2. **The boundary.** Read the workflow's `answers`, then the ids of the open signals on this exact ref whose kind is in it, snoozed ones included. This is the whole set the handoff may end. A signal that arrives after this read stays open: it is new work.
3. **Claims.** Take `SignalClaims.withSignalsClaimed` on those ids, around the transaction ([spec 10 §9.6](./10-triage-intake-and-notifications.md#96-when-a-signal-leaves)). If a plugin answer or a withdrawal holds one, the whole handoff fails `invalid_state` before anything is written: "A reply to this is still running. Try again in a moment."
4. In one transaction:
   - Check the offer again: the workflow is available on the thing ([section 8.8](#88-what-a-card-can-be-handed-to)) and the chosen account, or the oldest one, can act. An offer read a moment ago proves nothing.
   - Read the workflow's definition and compare its `answers` with the boundary's, as sets. If they differ, fail `invalid_state`, "This workflow changed. Try again.", with nothing written. The run below is started from this same read, so the run and the signals it ends come from one definition.
   - Find the active Task of the ref ([./09-tasks.md](./09-tasks.md#entity-links)), or choose an id for a new one.
   - **Refuse a double click.** When `RunService.findLiveRunOnTask` finds a run of this workflow on the Task that has not ended, fail `invalid_state`, "*Workflow* is already working on this." A second handoff to another workflow is allowed: that is the chain the Task holds.
   - Start the run on the Task with the ref in the `entity` input and the acting account in the `connection` input, if the workflow has one. The first session is placed after the commit, so no transaction waits on a runner ([ADR 0004](../adr/0004-controller-state-lives-in-one-sqlite-database.md)). A run that cannot start rolls everything back.
   - Write the Task and its provenance entry `{ ref, runId }` ([./09-tasks.md](./09-tasks.md#a-handoff-from-a-card)). The core never moves a stage on its own: a handoff decides `building` only from `exploring` or `planned`.
   - End each claimed signal that is still open, with `SignalService.resolveAnswered`: `decided`, the Hand to an agent action id of the workflow, the outcome "Handed to *workflow*", the run, the user's actor, a `signal.decided` audit entry. One that its source ended in the meantime is skipped and is no failure. It runs no source action, tells the source nothing, and feeds no Ignore Rule suggestion: this is not Done.
   - Write the `entity_handoffs` row the Undo reads.
5. After the commit it announces `externalEntity`, `task` and `signal`, and the run's start pushes `run` ([section 12](#12-live-updates)).

Intake's Hand to an agent works as before and shares two rules with this: both continue the oldest live link's Task, and both refuse a second live run of the same workflow on it ([spec 10 §9.4](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)).

**`externalEntity.undoHandOff { runId }`** takes a handoff back as far as is safe. Cancelling a run is not a rollback, so the handoff keeps its `entity_handoffs` row and the Undo reads that, not the client. In one transaction: it returns the first answer when the Undo was done before; answers `too-late` and changes nothing when the run has ended; decides what may be taken back, before cancelling, because cancelling changes how the run looks; cancels the run and its unfinished sub-runs, as `run.cancel` does (the runner hears after the commit, so this is a stop requested and not a stop done); and reverses the Task if the rules allow. The rules for the Task, the three outcomes (`undone`, `stopped`, `too-late`) and the failure that comes back are in [./09-tasks.md](./09-tasks.md#a-handoff-from-a-card). In practice a full Undo works in the moment before the run's first step starts. After that, Undo means Stop, and the line says so. Signals the handoff ended stay ended; the card stays, because its concern stays, and its place and wait return. A second handoff's run is never touched.

## 10. Search, recognition and resolution

Three separate steps, because they have different rights.

**Recognition is pure.** A plugin recognizes only its own URL and identifier forms. It fetches nothing, follows no redirect and gets no credentials. `recognize(text)` returns at most 20 recognitions, each one of:

- `{ recognized: "ref", form, ref, kind }`: the text names exactly one thing;
- `{ recognized: "scoped", form, kind?, identifier, scopeHint? }`: the text names something only inside a scope, such as `SHOP-123`, which means nothing without its workspace. `kind` is absent when the text does not say which kind it is. GitHub's `owner/repo#87` names an issue or a pull request, so it is `scoped` with no `kind`, and `resolve` finds out which.

**Resolution is credentialed.** Reading the target always uses the target plugin's eligible Connection: `connected` or `error`, with the plugin active. Never the Connection of the thing that mentioned it, and never the first match.

**Search reaches the source.** Results come live through the plugin, never from what Hercule holds. A lookup runs outside any transaction, and the host gives each call a timeout of 8 seconds and fails it as `source-unavailable`.

**How the host decides a resolution.** It gives one answer for all the target plugin's eligible Connections, at most 8:

- A `ref` recognition asks them in turn, oldest first, until one finds it. If none does, a failed Connection makes the answer `incomplete`. Otherwise the answer is the firmest `missing`: `inaccessible`, then `unknown`, then `not-found`.
- A `scoped` recognition asks every one. `outOfScope` rules a Connection out. What was found is grouped by canonical ref, so two accounts in one workspace give one answer, not two:
  - one ref, and every other Connection answered or was ruled out: found;
  - two or more refs: `ambiguous`, and it stays unresolved with its evidence;
  - a Connection failed or was skipped: `incomplete`, even with one ref found, because that Connection may hold another answer.

**`externalEntity.search { source, text, scopeRef? }`**, where `source` is a plugin id:

1. **A link can change the source.** When the text is one URL, the host runs `recognize` over every active plugin's lookup and takes a recognition with `form: "url"`. The reply's `source` is then that plugin's. A URL no plugin recognizes answers `unknown-link`, with the sources that can read links in `linkSources`.
2. **Anything else stays on the chosen source and scope.** An identifier is recognized by that plugin alone, and words go to its `search`, over its eligible Connections, at most 4, oldest first, merged by ref. A fifth eligible Connection sets `incomplete`. A scope the source cannot search by fails the call; it never widens the search.
3. **Mark each result** from what Hercule holds, in one batched read: `new` (no record), `known` (a record, no live Task) or `on-work` (a live Task, named in `taskId`).

Outcomes: `results`, `no-match`, `inaccessible`, `not-found`, `unknown`, `ambiguous`, `incomplete`, `unknown-link`, `source-unavailable`. A reply holds at most 20 results. A source that cannot tell a missing thing from a forbidden one, as GitHub cannot, answers `unknown`. Nothing is stored by a search. A link to something no Connection can read returns no title, because none was read.

**`externalEntity.listSuggestions { contextRef? }`** lists entities with a current concern and no active Task, under the given context when there is one, reached through upward `part of`, each once, at most 100. Context records are never listed. A thing in two contexts is listed once, and the reply names the others in `alsoIn` ("Also in Pricing rules"). Choosing a context never creates Tasks for its children.

**Scopes.** The Add sheet's scope select lists the stored context records of that plugin's `groupable` kinds, from `places` on the board and the Inbox. It needs no read of its own.

## 11. Work's context

Work's Group by and Filter read through a read model, with no new table. `TaskBoardFacts` reads every board Task's explicit entity links, then one `readContext` over all those refs at once. No per-card statement runs.

- `WorkCard` gains `entityMarks` (at most 3: plugin id and kind) and `contextRefs`: its linked refs and everything above them, at most `MAX_CARD_CONTEXTS` (64).
- `WorkBoard` gains `places` (each record once, at most `MAX_BOARD_PLACES`), `edges` (at most `MAX_GRAPH_EDGES`), `groupings` (the `groupable` kinds that have at least one place on this board, each with its caption) and `contextComplete`.
- **A Task is matched through its own links and upward `part of` only.** A peer's ancestors are never its own: a `linked` claim adds nothing to `contextRefs`.
- `task.queryBoard` needs no new grant: `places` comes with the Task's links.
- **Hercule's Initiatives and Projects stay separate.** An outside project is only ever a lane or a filter. Filtering or grouping by one never sets a Task's `projectId` or `initiativeId`.

**The details pane.** `TaskDetail` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#task)) carries the Task's own `entities` (each linked thing as an `EntityPlace`, in link order), `places` and `edges`, read through the same `readContext` for one Task. The pane draws two sections from them, as the shared relation rows: **Part of** lists every place above any linked thing by every path, each once, nearest first, with a place no Connection can read as a locked row; **Linked** lists the linked things themselves, each as its identifier and title and its kind and status. A section with no rows is not drawn. An `EntityPlace` carries `identifier` when the record has one and the place is not restricted, for these rows. *(Amended 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* Each `EntityPlace` carries `latestChange` ([section 8.7](#87-what-changed-outside)), which the shared relation row draws. The direct links between things, the hints found in text and the far-end records are on the thing's own `externalEntity.read` reply.

**Stacks.** *(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* A stack means what a confirmed link says. `WorkBoard` gains `stackCandidates`, at most `MAX_BOARD_STACK_CANDIDATES` (2,000) pairs `{ leadTaskId, memberTaskId, noun }`, and `stackCandidatesTruncated`. A pair is a Task that links a rich thing and a Task that links a compact thing with a direct `source` or `person` link to it. `noun` is the member thing's kind noun (the lowest, when a member links several). A hint never makes a pair. A Task is never paired with itself, so a Task that links both things makes none, and a pair found through two links is one candidate. Both are decided before the limit, in one statement. What the limit leaves out simply draws as cards.

A Task can link several things, so candidates can compete or point both ways. The client's `arrangeCell` chooses, per cell, by one rule, so stacks never nest:

1. Walk the cell's Tasks in `boardRank` order, then id.
2. A Task not yet placed, with at least one unplaced candidate member in this cell, becomes a lead and takes all of those members.
3. Each Task ends up once: a lead, a member of one lead, or a card alone. A lead is never another stack's member.

Nothing stores a stack. A member dragged to another cell is a card. A stack counts as one row, floats as one unit, and is loud, and opens by itself, when its lead or any member is.

Filtering and grouping run in client-core over that reply, so they cost no read. A Task under two places has a card in each; stage headers count distinct Tasks. A drop in an outside lane changes the stage only and never the membership.

## 12. Live updates

The `externalEntity` topic is a mutable topic ([./14-web-app.md](./14-web-app.md#wire-format)): its push names the changed entity ids. A card depends on more than its own row, so each cause is named:

| Cause | Reads it changes | Who publishes |
|---|---|---|
| A poll changes what a card shows (access included) | the Inbox, the count, Work's marks, an open pane | `external-entities` announces `externalEntity`. When the ref has a live Task, it also announces `task` with `derived: true`: it imports `tasks` |
| A claim changes, or a place's title, status or progress | the Inbox, the board's lanes and filters | the same, for the Tasks below it, found by one walk down |
| Take, Add, Dismiss, Restore | the Inbox, the count, the board | the service, on both topics |
| A handoff, or its Undo *(added 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034))* | the Inbox, the board, the count, To do | the service announces `externalEntity` and `task`; the signals it ended push `signal`; the run's start pushes `run` |
| An offer's inputs change: a workflow is edited, enabled or disabled, or a Connection changes *(added 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034))* | the Inbox's and a detail's offers | `workflow` and `connection` already push. `workflow` is not shell data, so the Inbox route subscribes to it; `connection` is mapped to the Inbox keys |
| A Task finishes, is deleted, merged, or gains or loses a link | the Inbox's membership, the count | `task` already pushes. The client maps `task` to the Inbox keys, so no reverse import is needed |
| A signal opens, ends or is snoozed | the Inbox, the count, an open card | `signal` already pushes. The client maps it to the Inbox keys |
| A thing becomes a full record of a work kind (created, or a partial record made full) | Intake: its open signals now show the record as `Signal.entity` | the poll announces `signal` for each open signal on that ref, snoozed ones included, beside `externalEntity`. An `externalEntity` push alone leaves the signal lists alone |
| A snooze runs out | the Inbox, the count | nothing is written, so nothing pushes. The desktop's snooze timer reads them again when the soonest `until` passes |
| A Fact moves a stage *(added 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035))* | the board, an open pane | an ordinary `task` write on the 50 ms window, not `derived` |
| A Fact moves only the fence | nothing | no announce |
| A Task links or unlinks a thing by hand, or the branch step links one | the board, the pane, the Inbox | `TaskService` announces `task` and `externalEntity` |
| A person links or unlinks two things | the Inbox, an open card, the board | the service announces `externalEntity` for both refs, and `task` with `derived: true` for the Tasks that link them |
| The resolver settles a claim | the same | the same announcement |
| A Connection changes status | `stale` | `connection` already pushes. The client maps it to the Inbox keys |
| A plugin is enabled or disabled | `stale`, `kindAvailable` | `plugin` already pushes. The client maps it to the Inbox keys |

A Task's summary reads the kind, identifier, title, status label and lifecycle of each thing the Task links ([./09-tasks.md](./09-tasks.md#task-summaries)). The write that changes one of those marks every live Task that links the ref dirty (`TaskService`'s marker, `makeSummaryDirtyMarker`), in the write's own transaction. A change to concerns, progress, dates or access alone marks nothing, so a busy poll does not cost a model call. The summary's input reads the facts through `externalEntityRepository.listLinkedEntityFacts`, one batched statement, never through the service.

Renaming a context record announces only that record. A thing whose field points at it is not announced, so a list that shows their titles re-reads them ([#1122](https://github.com/theagenticage/hercule/issues/1122)).

A poll that changes nothing announces nothing, so a quiet Inbox costs no read. Nothing is announced after a rolled-back transaction: the service publishes after commit.

## 13. The domain graph

Source lives in `apps/controller/src/external-entities/`. It owns entity lifecycle, relation claims, rendering slots, and the Inbox reads. Reading the source stays in the plugin, and polling stays in the host.

```
external-entities -> actor db events tasks resources connections plugins signals
                     runs workflows *(added 2026-11-08, #1034)*

plugins    declares port EntityObservations  -> answered in daemon/ingest/
           declares EntityRecognizer         -> filled by the plugin host at start
signals    declares port SignalEntities      -> answered in daemon/ingest/
workflows  declares port WorkflowEntities    -> answered in daemon/workflows/ *(added 2026-11-08, #1034)*
tasks      TaskBoardFacts                    -> daemon/tasks/ also reads entities and their ancestors
daemon/ingest  ClaimResolution (external-entities) + EntityLookups (plugins) -> the resolver loop
```

- No domain imports `external-entities` except through a port, so the arrows only ever point out of it and the graph stays acyclic.
- *(Added 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035).)* The tasks domain declares a port, `LinkedEntities.readMany(refs)`, which returns each ref's stored work or context classification, lifecycle and access, or nothing for a ref with no record. `daemon/tasks/linked-entities.ts` answers it from the entity repository and, for a ref with no record, from the declared kinds in the stored plugin catalog. It reads the database only. It must never require `PluginHost`, `ExternalEntityService` or anything that does: `ExternalEntityIngestLayer` sits below `PluginHost`, and ingest calls `TaskService`. `external-entities` wraps every write that can change a linked entity's state in `TaskService.recordEntityFactsAround` ([section 14](#14-facts-links-by-hand-and-the-branch-join)).
- `ExternalEntityService` requires `TaskService`, so nothing `TaskService` needs may require `ExternalEntityService`. A port the tasks domain declares is answered from the repository, which needs only the SQL client.
- `plugins` cannot import `external-entities`, because it imports `plugins` for the catalog. The port is `EntityObservations`, in `plugins/entity-observations.ts`, answered in `daemon/ingest/entity-observations.ts`, as Open Signals is. The host side of search is `EntityLookups` in `plugins/entity-lookups.ts`.
- *(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* `external-entities` imports `signals`, for the rows. `signals` imports nothing of it: it declares the port `SignalEntities` (`readByRefs`, `recordArrivalAfter`) and the controller daemon answers it from the entity repository.
- Recognition (pure) is the ingest's, over a `RecognizeText` that the ingest context builds from the active sources it is given at each call. `PluginHost` requires the ingest loops, so the ingest context cannot depend on the host: the reconciler hands the active sources to `IngestLoops.open`. Resolution (credentialed, slow) is the controller daemon's resolver loop, which may require `EntityLookups`; the database side is `ClaimResolution` in this domain ([section 5.5](#55-resolving-pending-claims)).
- The repository requires the SQL client only. Its write methods join the caller's transaction and never open their own or call a service.

## 14. Facts, links by hand and the branch join

*(Added 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035), slice 7; [ADR 0055](../adr/0055-facts-move-cards-through-editable-workflows.md).)* A Task keeps its link to a thing true, and the thing's state moves the Task's card through two shipped workflows. The Task side (Facts, the fence, what counts as open, the shipped workflows) is in [./09-tasks.md](./09-tasks.md#facts-and-the-fence). This section holds what belongs to entities: how ingest feeds Facts, how a link is found, and how the user's unlink holds.

### 14.1 Ingest feeds Facts

A Fact is a lifecycle change of a linked thing, so it is written where the entity is written. Every write that can change what a Task counts goes through one `TaskService` method, `recordEntityFactsAround(refs, write)`, and nothing else in this domain knows the rules. It joins the caller's transaction or opens one, and does three things in it:

1. It reads, before the write, the linked-work state of those refs that a live Task links.
2. It runs the write: `writeObservations` (for `reconcile`, `refresh` and a read of one ref), `reportMissing`, and any other place that changes `access` (the inaccessible rows of `listWanted`, pruning, and the deletion of a Connection).
3. It compares each ref's state now with what it read, and writes one Fact and one `task.entityChanged` for each live linked Task when:
   - the lifecycle changed;
   - the ref had no record before (a first observation, `previous_lifecycle` null);
   - the Task's `openLinks` or `completedLinks` differ between before and now (a change of `access`, or a first full record), with `previous_lifecycle` equal to the lifecycle.

   Never anything else. A poll that changes nothing writes nothing: no Fact, no event, no push.

**Deleting a Connection also records Facts.** Its observation rows go, so `access` can change for the things it was the only reader of. The connections domain declares a port, `ConnectionEntityFacts` (`recordFactsOfDeletion`), and `daemon/connections/entity-facts.ts` answers it. The port wraps the deletion, for the linked refs the Connection holds an observation for, in the same `recordEntityFactsAround`. The connections domain cannot read External Entities itself, because External Entities depends on it.

A first observation with no link writes no Fact. `reconcile` and `refresh` still emit no event and raise no signal of their own ([section 5.1](#51-reconcile)).

### 14.2 What counts as open

The count that decides whether a card lands is in [./09-tasks.md](./09-tasks.md#what-counts-as-open). The entity side of it:

- Work or context for a **full record** comes from the stored record. So a record stays counted after its kind leaves the catalog, and its stored `access` decides whether it is readable. A kind leaving the catalog does not by itself make a record unreadable.
- Work or context for a **partial record**, and for a ref with no record, comes from the kind the catalog declares. The catalog definition of an event source stores its entity kinds as `{ kind, refPrefix, classification }` for this, and the daemon reads them with SQL alone, for every plugin the catalog holds, enabled or not, because a thing of a disabled plugin cannot be read and so still counts as open ([./05-plugins.md](./05-plugins.md#43-event-source)). `isWorkRecord` needs a full record and cannot classify a partial one.
- Readable means `access: ok` (derived across Connections, [section 4](#4-lifecycle)). Anything else counts as open.

### 14.3 Links, suppressions and unlinking

- A link is a row of `task_entity_links` ([./09-tasks.md](./09-tasks.md#entity-links)), added by a provenance `ref`, a handoff, `task.linkEntity` or the branch link step. A link added by any path writes a Fact (`previous_lifecycle` null) when the entity has a stored lifecycle.
- **`task_entity_link_suppressions (task_id, ref, suppressed_at, suppressed_by)`** holds one row for each Task and ref the user unlinked. `task.unlinkEntity` writes it, in the transaction that removes the link and voids the pair's Facts. `task.linkEntity` and an explicit provenance `ref` on `task.update` clear it.
- **The branch link step checks suppressions first.** It never adds back a pair the user unlinked, and a refresh of the entity updates the record and never restores the link.
- **A merge** moves suppressions with the Task, without duplicates. When one Task links a ref and the other suppresses it, the link wins and the suppression is dropped.

### 14.4 Finding a Thread's pull request: the branch join

Hercule already knows a session's live branch. The runner reports the workspace after each `turn.completed` and on exit, and the controller writes `checkouts.branch`. So a rename by the agent is followed. An entity holds `repository.head` as `(remote, branch)` since slice 4. A link is a join of the two.

A step of the controller daemon (`daemon/tasks/branch-links.ts`) runs after each complete scan, after each refresh of a kind that has a `repository`, and when a checkout's branch changes. It joins the entities whose `repository.head` is `(remote, branch)` with the checkouts of ephemeral workspaces whose sessions have a live Task. The checkout's remote is its Resource's `canonicalRemote`.

- **Match on the head, not the target.** A fork's head remote differs from the Resource's, so a fork's pull request does not match; the user links it by hand. Two repositories that share a branch name never match each other.
- **Skip** a checkout on its `default_branch`, and workspaces of kind `primary`: a main workspace's branch says nothing about one Task.
- **Count the Tasks first.** The step counts distinct live Tasks for each `(remote, branch)` over the whole association, before it filters by suppression or "already linked". Several sessions of one Task in one workspace are one match. Two different live Tasks on one branch link neither, and the step logs why. A wrong link is worse than a missing one, and the user can link by hand. Counting before the filter matters: otherwise a Task that unlinked the pull request would drop out of the count, and the other Task would look alone on the branch and get the link.
- **Skip** a pair the user unlinked ([section 14.3](#143-links-suppressions-and-unlinking)).
- **A pull request that is not open matches only if the source created it at or after the Task's workspace.** Branch names get reused (`fix-typo`), and the lookup of [section 14.5](#145-short-lived-pull-requests-listtrackedbranches) reads merged and closed pull requests too, so an old merged pull request on a reused name would otherwise link to a new Task and land its card. The rule compares `source_created_at` with the creation time of the Task's oldest workspace on the branch, both parsed to a point in time. It uses the creation time and not `source_updated_at`, because a retitle or a comment on the old pull request moves the update time past the workspace. An open pull request always matches. A pull request with no known creation time does not match until its next observation brings one.
- **Known limit of that guard.** A pull request that the source created before the Task's workspace, and that is merged or closed before the first link pass that sees it open, does not link by itself. The guard cannot tell it from an old pull request on a reused branch name, because both were created before the workspace and both are not open when the step first sees them. The user links it by hand. This is accepted because a wrong link is worse than a missing one: a wrong link lands a card on work that is not its own, and a missing one costs the user one click.
- **Read and write in one transaction.** A first read, with no transaction, finds out whether anything matches, and a scan that finds nothing takes no write lock. When something matches, the match is read again inside the transaction that writes the links, so a checkout that moved or a second Task that joined the branch in between cannot leave a stale pair. The log line for a shared branch is written once, when the branch becomes shared.
- **This is not the branch-name match ADR 0046 rejected.** It reads the branch the checkout really has, it matches on the head's remote, and it holds for a Thread and a run alike.
- A pull request never links its ticket: that needs reading text. A Take or a handoff links it, the user links it by hand, or a workflow records a ref.

### 14.5 Short-lived pull requests: `listTrackedBranches`

The inventory is `is:open`, so a pull request opened and merged between two scans may never appear in it. So the core also tells the plugin which branches it cares about. `IngestContext.entities` gains:

```ts
/** Returns tracked branches on remotes starting with `remotePrefix`, at most `limit`, in a fair rotation. */
readonly listTrackedBranches: (remotePrefix: string, limit: number) =>
  Effect.Effect<ReadonlyArray<{ readonly remote: string; readonly branch: string }>>;
```

- It lists the branches of ephemeral checkouts of live Tasks that are not the default branch and are on the remote (`remote_branches`, a JSON column on `checkouts`).
- **A fair rotation.** Branches have no observation rows, so the rotation has its own durable cursor, `tracked_branch_attempts (connection_id, remote, branch, last_attempted_at)`, primary key on all three. Like `listWanted`, it stamps `last_attempted_at` on what it returns, before it returns, never-tried first and then oldest first. So more branches than the limit all get their turn. Rows for branches that are no longer listed are deleted in the same call.
- **It leaves a branch out only when the Task already links an entity whose `repository.head` is this exact `(remote, branch)`.** It is an anti-join on the head, not on "has a link":

| What the Task already has | Is the branch listed? | Can the link step link what it finds? |
|---|---|---|
| A link to something else, such as its Linear ticket | Yes | Yes. A ticket says nothing about this branch |
| A link to a pull request with this head | No | Nothing to do |
| A pull request with this head that the user unlinked | Yes, it may be read again | No. The suppression holds, so a refresh updates the entity and never restores the link |

- **The plugin** reads each branch's pull requests by head and reports them with `refresh`, which creates the entity with no concerns ([section 5.3](#53-refresh-listwanted-and-reportmissing)). The GitHub feed is in [./08](./08-events-and-connections.md#51-github-plugin). The link step does the rest. So a pull request that is already merged when first seen links, and its Fact has `lifecycle: completed` and `previous_lifecycle` null: the card lands.
- The capability grows additively, so `hostApi` stays 8.

## Later slices

Not in this document yet, and the tables allow for them:

- ~~Linking a Thread's pull request to its Task, and moving cards on facts. `repository.head` is stored here and used there (slice 7).~~ *(Amended 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035): built, in [section 14](#14-facts-links-by-hand-and-the-branch-join).)*
- A triage cluster as Hercule's own kind, `core/triage-cluster`, written by the core with no Connection. `external_entities.kind` is a string and an entity needs no observation row, so it fits. It is not built.

## Sources

- [Work overview: the design and its tickets (#1026)](https://github.com/theagenticage/hercule/issues/1026)
- [The Inbox of External Entities (#1032)](https://github.com/theagenticage/hercule/issues/1032)
- [Work overview, slice 5: signals live inside their entity, and Linear joins (#1033)](https://github.com/theagenticage/hercule/issues/1033)
- [ADR 0054 - External Entities are durable records kept true by polls](../adr/0054-external-entities-are-durable-records-kept-true-by-polls.md)
- [ADR 0006 - Plugins request capabilities and register contributions in code](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md)
- [ADR 0019 - The task model is thin; workflows own task semantics](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)
- [ADR 0046 - Handing a signal off tracks the work on a Task](../adr/0046-handing-a-signal-off-tracks-the-work-on-a-task.md)
- [ADR 0052 - Tasks have a stage, and Threads join them](../adr/0052-tasks-have-a-stage-and-threads-join-them.md)
- [ADR 0055 - Facts move cards through editable workflows](../adr/0055-facts-move-cards-through-editable-workflows.md)
