/**
 * The workflows a card can be handed to: the rules that decide, for one kind
 * of thing, one target repository and whether an account can act, which
 * workflows are available and why the others are not.
 *
 * Nothing here reads the database. The caller reads the workflows, the
 * Resources and the acting accounts, and these functions decide. The Inbox,
 * the detail of one thing and the handoff all go through `evaluateWorkflowOffer`, so
 * what a menu offers and what a handoff accepts can never disagree.
 */
import { createHash } from "node:crypto";
import {
  MAX_ENTITY_OFFERS,
  MAX_OFFER_MESSAGE_LENGTH,
  type WorkflowDefinition,
  type WorkflowOffer,
} from "@hercule/contract";
import { cutTextAtWord } from "../text";
import type { WorkflowOfferCandidate } from "../workflows";

/**
 * What the offers need to know of an entity kind's plugin: the type of the
 * Connections that act on its things, and the signal kinds its cards show.
 * Kinds and types are qualified, such as `github/pull-request` and
 * `github/github`.
 *
 * A card shows the signals of its own ref, and a signal kind does not name
 * the entity kind it is raised on. So the cards of a kind count as showing
 * every signal kind of the plugin's event source.
 */
export interface EntityKindSource {
  readonly kind: string;
  readonly connectionType: string;
  readonly signalKinds: ReadonlyArray<string>;
}

/** What the offers depend on. Two things with the same subject have the same offers. */
export interface WorkflowOfferSubject {
  readonly kind: EntityKindSource;
  /** The canonical remote of the repository the work lands in, or none for a kind with no repository. */
  readonly targetRemote: string | undefined;
  /** True when at least one Connection can act on the thing. */
  readonly hasAccount: boolean;
}

type InputDeclaration = WorkflowOfferCandidate["inputs"][number];

/** The Resources of a workflow's workspace: the repo of a primary workspace, or the repos it checks out. */
export const listWorkspaceResourceIds = (
  workspace: WorkflowDefinition["workspace"],
): ReadonlyArray<string> => {
  if (workspace === undefined) return [];
  return workspace.kind === "primary"
    ? [workspace.resourceId]
    : workspace.checkouts.map((checkout) => checkout.resourceId);
};

/**
 * Builds the id of the offer set of a subject. The same subject always gets
 * the same id, and the id fits the contract's bound however long the remote
 * is. Clients only compare these ids.
 */
export const buildWorkflowOfferSetId = (subject: WorkflowOfferSubject): string =>
  createHash("sha256")
    .update(JSON.stringify([subject.kind.kind, subject.targetRemote ?? null, subject.hasAccount]))
    .digest("hex")
    .slice(0, 24);

/**
 * Builds the `unavailable` part of an offer. The message is cut at a word to
 * the length the contract allows, so a long workflow name or input name can
 * never make a read fail.
 */
const buildUnavailable = (
  reason: NonNullable<WorkflowOffer["unavailable"]>["reason"],
  message: string,
): NonNullable<WorkflowOffer["unavailable"]> => ({
  reason,
  message: cutTextAtWord(message, MAX_OFFER_MESSAGE_LENGTH),
});

/**
 * Names the repositories a workflow works on for a message: the first one,
 * then how many more there are ("acme/web and 2 more").
 */
const describeRepositories = ([first, ...rest]: ReadonlyArray<string>): string =>
  rest.length === 0 ? first! : `${first!} and ${String(rest.length)} more`;

/** Returns the repository as `owner/name`, the way the user knows it, from a canonical remote such as `github.com/acme/web`. */
const describeRemote = (canonicalRemote: string): string =>
  canonicalRemote.slice(canonicalRemote.indexOf("/") + 1);

/**
 * Returns the repositories a workflow works on, as `acme/web`, when none of
 * them is the one the work lands in. Returns nothing when the workflow runs
 * anywhere: it has no workspace, or its workspace checks out no repository
 * (`resourceRemotes` holds only Resources that have a canonical remote, so a
 * folder or a mailbox is not one), or the thing names no repository to
 * compare. A repository is compared by its canonical remote, so a fork
 * compares its target. The list is never empty when it is returned.
 */
const findOtherRepositories = (
  workspace: WorkflowDefinition["workspace"],
  targetRemote: string | undefined,
  resourceRemotes: ReadonlyMap<string, string>,
): ReadonlyArray<string> | undefined => {
  const remotes = listWorkspaceResourceIds(workspace).flatMap(
    (id) => resourceRemotes.get(id) ?? [],
  );
  if (targetRemote === undefined || remotes.length === 0 || remotes.includes(targetRemote)) {
    return undefined;
  }
  return [...new Set(remotes.map(describeRemote))];
};

/**
 * Evaluates one workflow for a subject. Returns the offer, with `unavailable`
 * set when it cannot be used and the user can act on why. Returns `undefined`
 * when the workflow is not listed at all. It is listed when:
 *
 * - it has an `entity` input that lists the kind (available or not); or
 * - it has no `entity` input and a `signal` input on a signal kind the cards
 *   of this kind show: it needs a workflow change.
 *
 * `workflow` must be enabled and valid; the caller reads only those.
 * `resourceRemotes` maps a Resource id to its canonical remote, for the
 * Resources of the workflow's workspace.
 *
 * When several reasons hold, the first of these is given: a required input
 * the card cannot fill, a repository that differs, no account.
 */
export const evaluateWorkflowOffer = (
  workflow: WorkflowOfferCandidate,
  subject: WorkflowOfferSubject,
  resourceRemotes: ReadonlyMap<string, string>,
): WorkflowOffer | undefined => {
  const { id: workflowId, name, inputs } = workflow;
  const entityInput = inputs.find((input) => input.entity !== undefined);

  if (entityInput === undefined) {
    const showsSignal = inputs.some((input) =>
      input.signal?.kinds.some((kind) => subject.kind.signalKinds.includes(kind)),
    );
    return showsSignal
      ? {
          workflowId,
          name,
          answers: [],
          unavailable: buildUnavailable(
            "needs-workflow-change",
            `${name} needs a workflow change: replace its signal input with an entity input`,
          ),
        }
      : undefined;
  }
  if (!entityInput.entity!.kinds.includes(subject.kind.kind)) return undefined;

  const needsValue = (input: InputDeclaration) => input.required && input.default === undefined;
  const connectionInput = inputs.find(
    (input) => input.connection?.type === subject.kind.connectionType && needsValue(input),
  );
  const unfillable = inputs.find(
    (input) => input !== entityInput && input !== connectionInput && needsValue(input),
  );
  const otherRepositories = findOtherRepositories(
    workflow.workspace,
    subject.targetRemote,
    resourceRemotes,
  );

  const offer = {
    workflowId,
    name,
    answers: entityInput.entity!.answers ?? [],
    ...(connectionInput === undefined ? {} : { connectionInputName: connectionInput.name }),
  };
  if (unfillable !== undefined) {
    return {
      ...offer,
      unavailable: buildUnavailable(
        "needs-input",
        `${name} needs ${unfillable.name}, which a card cannot fill`,
      ),
    };
  }
  if (otherRepositories !== undefined) {
    return {
      ...offer,
      unavailable: buildUnavailable(
        "repository",
        `${name} works on ${describeRepositories(otherRepositories)} only`,
      ),
    };
  }
  if (!subject.hasAccount) {
    return {
      ...offer,
      unavailable: buildUnavailable("no-account", "No connected account can act on this"),
    };
  }
  return offer;
};

/**
 * Evaluates every workflow for a subject and returns the offers: the
 * available ones first, then the unavailable ones, each group by name, cut
 * to `MAX_ENTITY_OFFERS`. The cut keeps the available ones before any
 * unavailable one. The list is for a menu; whether a workflow can be handed
 * a thing is decided by `evaluateWorkflowOffer`, never by this list.
 */
export const evaluateWorkflowOffers = (
  workflows: ReadonlyArray<WorkflowOfferCandidate>,
  subject: WorkflowOfferSubject,
  resourceRemotes: ReadonlyMap<string, string>,
): ReadonlyArray<WorkflowOffer> =>
  workflows
    .flatMap((workflow) => evaluateWorkflowOffer(workflow, subject, resourceRemotes) ?? [])
    .sort(
      (a, b) =>
        Number(a.unavailable !== undefined) - Number(b.unavailable !== undefined) ||
        a.name.localeCompare(b.name) ||
        a.workflowId.localeCompare(b.workflowId),
    )
    .slice(0, MAX_ENTITY_OFFERS);

/**
 * Lists what the offers need of each entity kind that an active event source
 * declares. A source's signal kinds and Connection type are those of its
 * plugin.
 */
export const listEntityKindSources = (
  sources: ReadonlyArray<{
    readonly connectionType: string;
    readonly entityKinds: ReadonlyArray<{ readonly word: string }>;
    readonly signalKinds: ReadonlyArray<{ readonly kind: string }>;
  }>,
): ReadonlyArray<EntityKindSource> =>
  sources.flatMap((source) =>
    source.entityKinds.map((declaration) => ({
      kind: declaration.word,
      connectionType: source.connectionType,
      signalKinds: source.signalKinds.map((signal) => signal.kind),
    })),
  );
