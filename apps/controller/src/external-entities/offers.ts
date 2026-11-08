/**
 * The workflows a card can be handed to: the rules that decide, for one kind
 * of thing, one target repository and whether an account can act, which
 * workflows are available and why the others are not.
 *
 * Nothing here reads the database. The caller reads the workflows, the
 * Resources and the acting accounts, and these functions decide. The Inbox,
 * the detail of one thing and the handoff all go through `evaluateOffer`, so
 * what a menu offers and what a handoff accepts can never disagree.
 */
import { createHash } from "node:crypto";
import type { WorkflowDefinition, WorkflowOffer } from "@hercule/contract";

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
export interface OfferedKind {
  readonly kind: string;
  readonly connectionType: string;
  readonly signalKinds: ReadonlyArray<string>;
}

/** A stored workflow that a run can start: enabled and valid. */
export interface OfferableWorkflow {
  readonly id: string;
  readonly definition: WorkflowDefinition;
}

/** What the offers depend on. Two things with the same subject have the same offers. */
export interface OfferSubject {
  readonly kind: OfferedKind;
  /** The canonical remote of the repository the work lands in, or none for a kind with no repository. */
  readonly targetRemote: string | undefined;
  /** True when at least one Connection can act on the thing. */
  readonly hasAccount: boolean;
}

type InputDeclaration = NonNullable<WorkflowDefinition["inputs"]>[number];

/** The Resources of a workflow's workspace: the repo of a primary workspace, or the repos it checks out. */
export const listWorkspaceResourceIds = (definition: WorkflowDefinition): ReadonlyArray<string> => {
  const workspace = definition.workspace;
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
export const buildOfferSetId = (subject: OfferSubject): string =>
  createHash("sha256")
    .update(JSON.stringify([subject.kind.kind, subject.targetRemote ?? null, subject.hasAccount]))
    .digest("hex")
    .slice(0, 24);

/** Returns the repository as `owner/name`, the way the user knows it, from a canonical remote such as `github.com/acme/web`. */
const describeRemote = (canonicalRemote: string): string =>
  canonicalRemote.slice(canonicalRemote.indexOf("/") + 1);

/**
 * Returns the repositories a workflow works on, as `acme/web`, when none of
 * them is the one the work lands in. Returns nothing when the workflow runs
 * anywhere: it has no workspace, or no checkout, or the thing names no
 * repository to compare. A repository is compared by its canonical remote,
 * so a fork compares its target.
 */
const findOtherRepositories = (
  definition: WorkflowDefinition,
  targetRemote: string | undefined,
  resourceRemotes: ReadonlyMap<string, string>,
): ReadonlyArray<string> | undefined => {
  const resourceIds = listWorkspaceResourceIds(definition);
  if (targetRemote === undefined || resourceIds.length === 0) return undefined;
  const remotes = resourceIds.flatMap((id) => resourceRemotes.get(id) ?? []);
  if (remotes.includes(targetRemote)) return undefined;
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
export const evaluateOffer = (
  workflow: OfferableWorkflow,
  subject: OfferSubject,
  resourceRemotes: ReadonlyMap<string, string>,
): WorkflowOffer | undefined => {
  const { id: workflowId, definition } = workflow;
  const { name } = definition;
  const inputs = definition.inputs ?? [];
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
          unavailable: {
            reason: "needs-workflow-change",
            message: `${name} needs a workflow change: replace its signal input with an entity input`,
          },
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
    definition,
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
      unavailable: {
        reason: "needs-input",
        message: `${name} needs ${unfillable.name}, which a card cannot fill`,
      },
    };
  }
  if (otherRepositories !== undefined) {
    const where =
      otherRepositories.length === 0 ? "another repository" : otherRepositories.join(" or ");
    return {
      ...offer,
      unavailable: { reason: "repository", message: `${name} works on ${where} only` },
    };
  }
  if (!subject.hasAccount) {
    return {
      ...offer,
      unavailable: {
        reason: "no-account",
        message: "No connected account can act on this",
      },
    };
  }
  return offer;
};

/**
 * Evaluates every workflow for a subject and returns the offers: the
 * available ones first, then the unavailable ones, each group by name.
 */
export const evaluateOffers = (
  workflows: ReadonlyArray<OfferableWorkflow>,
  subject: OfferSubject,
  resourceRemotes: ReadonlyMap<string, string>,
): ReadonlyArray<WorkflowOffer> =>
  workflows
    .flatMap((workflow) => evaluateOffer(workflow, subject, resourceRemotes) ?? [])
    .sort(
      (a, b) =>
        Number(a.unavailable !== undefined) - Number(b.unavailable !== undefined) ||
        a.name.localeCompare(b.name) ||
        a.workflowId.localeCompare(b.workflowId),
    );

/**
 * Lists what the offers need of each entity kind that an active event source
 * declares. A source's signal kinds and Connection type are those of its
 * plugin.
 */
export const listOfferedKinds = (
  sources: ReadonlyArray<{
    readonly connectionType: string;
    readonly entityKinds: ReadonlyArray<{ readonly word: string }>;
    readonly signalKinds: ReadonlyArray<{ readonly kind: string }>;
  }>,
): ReadonlyArray<OfferedKind> =>
  sources.flatMap((source) =>
    source.entityKinds.map((declaration) => ({
      kind: declaration.word,
      connectionType: source.connectionType,
      signalKinds: source.signalKinds.map((signal) => signal.kind),
    })),
  );
