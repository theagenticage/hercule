# 58. The Inbox is a list queried on the controller, over fields plugins declare

Date: 2026-11-12

## Status

Accepted by [Inbox for many sources (#1119)](https://github.com/theagenticage/hercule/issues/1119), decisions 22 to 25, first built by [#1121](https://github.com/theagenticage/hercule/issues/1121). Amends [ADR 0054](./0054-external-entities-are-durable-records-kept-true-by-polls.md) in one place: a kind's words are no longer all copied onto the row when the thing is observed. The Card Face is drawn on read. Keeps the rest of ADR 0054 true: one record per ref, polls keep it true, a plugin reports and the core renders, and a card still draws after its plugin is gone. The rules are in [spec 05](../spec/05-plugins.md) section 4.3 and [spec 20](../spec/20-external-entities.md).

## Context

The Inbox of [#1026](https://github.com/theagenticage/hercule/issues/1026) shows the outside things that concern the user as cards. It does not scale to many sources. With several accounts and hundreds of things, the user cannot get an overview and cannot find a thing: the client holds a full reply of up to 1,000 cards, and it knows nothing about a source's own structure, such as the Linear project or the Sentry team a thing sits in.

The replacement is a list with a rail, Browse and a search that knows each source's fields (`team:Checkout`). Three questions follow:

- **Who knows the fields?** The plugin does. Only the Linear plugin knows that a Linear issue has a team, a project and a priority. The core must not branch on a kind, and the client must not either.
- **Where is the face of a row?** A row shows a status glyph, an identifier, the place a thing belongs to and a quiet line of context. ADR 0054 copies a kind's words onto the row when the thing is observed. A face made of fields would then be a second copy of the same words, and it would go stale when a plugin is updated.
- **Who counts and who finds?** The rail shows counts per saved query and per Facet value. A search must answer over things the client has never loaded.

## Decision

**The Inbox is a list queried on the controller. A plugin declares the fields, as plain data. The core stores their values, draws the face on read and answers queries and counts.**

- **A plugin declares typed fields per kind.** Each has a key, a label and a type: `text`, `person`, `enum`, `number`, `age`, `bool` or `money`. The key is the name of the observation field the value is read from, and it is also the search token. A declaration is serializable and bounded: no callback, no markup.
- **Some fields are Facets.** A Facet is a field the plugin marks as browsable. Browse lists its values and Narrow offers them, with counts. A Facet may name a context kind of the same source whose stored records are every value the source knows of, so Browse can list every Linear project, with its health, even a project with nothing of the user's in it. A field of that kind holds the record's ref, not its name.
- **A kind may declare a Card Face.** It names which declared fields draw the place, the context and the fact of a row. The status glyph and the identifier come from what the kind already declares.
- **Saved queries are declared the same way,** as a name and a query over declared fields. They arrive with [#1122](https://github.com/theagenticage/hercule/issues/1122), because they need its query shape. Entity blocks for the detail pane arrive with [#1123](https://github.com/theagenticage/hercule/issues/1123).
- **Field values live in one table,** `external_entity_fields (ref, key, text_value, number_value)`, one row per ref and key, indexed by key and value for search and counts. It is written with each observation, under the same rules as the other shared fields. A field the plugin stopped declaring, or reported empty, is dropped on the next full observation.
- **Card Faces are drawn on read,** from the stored values and the declaration held in memory. Nothing is stored per entity for the face. A thing whose plugin is inactive, or whose kind is gone, has no face and draws the generic card from what spec 20 already stores: title, identifier, status and noun. This is the amendment of ADR 0054: the words of a kind are no longer all copied at observation. The stored slots stay, and they are what the generic card draws.
- **Queries and counts run on the controller.** One counts read covers the rail. The client refreshes it when a live update arrives and never on a timer.
- **The client never branches on a kind.** It draws what the reply holds: the face, the fields and the counts.

## Considered options

- **Query in the client over one full reply.** Rejected. It is the current design, and it is what stopped scaling. The reply would have to hold every thing to count it, and a search could never reach a thing the page left out. Counts would be wrong whenever the reply was cut.
- **Store a rendered face per entity.** Rejected. It copies the same words a second time. A plugin update that renames a field or moves a slot would leave every stored face stale until each thing is observed again, and a thing that stopped changing at its source is never observed again. Drawing on read costs one extra statement and never goes stale.
- **A JSON column on the entity for all fields.** Rejected. SQLite cannot index into it for a count by value without an expression index per key, and the keys differ per kind. A table with a key column and one index each for text and number values serves every kind. It also lets one statement count the values of a Facet.
- **A column per field.** Rejected. Fields belong to plugins and change with a plugin update. A migration per update would put a plugin's release schedule into the core's schema.
- **Facet values by name, with the context record found by title.** Rejected. A rename would break the join, and two projects with one title would merge. The field holds the ref and the core shows the record's title.
- **A plugin that renders its own face.** Rejected for the reason ADR 0054 gives: the desktop must not import a plugin, and a face must draw after the plugin is gone.
- **Run counts on a timer.** Rejected. The Inbox already gets live updates. A timer would work while nothing changes, and the desktop spends nothing while idle.

## Consequences

- A new table `external_entity_fields`. Migration `0120-entity-fields` adds only a table and two indexes, so it needs no upgrade fixture.
- `EntityKindDeclaration` gains the optional `plural`, `lasting`, `fields` and `face`, and `EntityObservation.fields` values may be booleans. They are additive, so `hostApi` does not change.
- Every ingest of a full observation compares the stored field rows of the touched refs, in one statement per call, and writes only changes. A quiet poll writes nothing. A change to field values alone counts as a change of the entity.
- The reply of `externalEntity.read` gains `fields` and `face`. It costs one statement (the field rows of that ref, with the title of each readable record a ref-valued field names) and no network call. A ref-valued field shows the record's title only when some Connection can read that record ([spec 20 section 1.3](../spec/20-external-entities.md), restricted things); otherwise the field is left out.
- An observation that was stored before its plugin declared fields has no field rows until the next observation. Until then it has fields of no value and draws no face slots. The core omits a stored value whose column or enum value does not fit the current declaration, and the next observation rewrites it. Storage cannot catch every change (a stored number reads as `true` if a key becomes `bool`, an amount is relabelled if a money field changes currency), so a plugin that changes a field's type, currency or meaning must use a new key.
- The Linear plugin reports every project as one complete inventory, so a Facet can list all projects. A kind that can exceed 2,000 reports a stable subset, as GitHub's repositories do.
- Core-owned query fields (source, kind, waiting, account) and the query itself belong to #1122. This ADR fixes only where fields come from and where they are kept.
