/**
 * Tests which workflows a card offers: one table for the availability rules
 * and the four reasons a listed workflow is unavailable, then the order of
 * the offers and the offer set ids.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowDefinition, WorkflowOffer } from "@hercule/contract";
import {
  buildOfferSetId,
  evaluateOffer,
  evaluateOffers,
  type OfferSubject,
  type OfferableWorkflow,
} from "./offers";

const WEB = "github.com/acme/web";
const API = "github.com/acme/api";
const RESOURCES = new Map([
  ["web-resource", WEB],
  ["api-resource", API],
]);

const PULL_REQUEST: OfferSubject = {
  kind: {
    kind: "forge/pull-request",
    connectionType: "forge/forge",
    signalKinds: ["forge/review-requested"],
  },
  targetRemote: WEB,
  hasAccount: true,
};

type Input = NonNullable<WorkflowDefinition["inputs"]>[number];

const ENTITY: Input = {
  name: "pull_request",
  entity: { kinds: ["forge/pull-request"], answers: ["forge/review-requested"] },
  required: true,
};
const ACCOUNT: Input = { name: "account", connection: { type: "forge/forge" }, required: true };

/** Builds a workflow named Review PR that takes a pull request and an account, unless told otherwise. */
const workflow = (
  inputs: ReadonlyArray<Input> = [ENTITY, ACCOUNT],
  workspace?: WorkflowDefinition["workspace"],
): OfferableWorkflow => ({
  id: "workflow-1",
  definition: {
    name: "Review PR",
    inputs,
    steps: [],
    ...(workspace === undefined ? {} : { workspace }),
  },
});

const AVAILABLE: WorkflowOffer = {
  workflowId: "workflow-1",
  name: "Review PR",
  answers: ["forge/review-requested"],
  connectionInputName: "account",
};
const unavailable = (
  reason: NonNullable<WorkflowOffer["unavailable"]>["reason"],
  message: string,
  offer: WorkflowOffer = AVAILABLE,
): WorkflowOffer => ({ ...offer, unavailable: { reason, message } });

const primary = (resourceId: string): WorkflowDefinition["workspace"] => ({
  kind: "primary",
  resourceId,
});
const checkouts = (...resourceIds: ReadonlyArray<string>): WorkflowDefinition["workspace"] => ({
  kind: "ephemeral",
  checkouts: resourceIds.map((resourceId) => ({ resourceId })),
});

describe("evaluateOffer", () => {
  it.each<[string, OfferableWorkflow, Partial<OfferSubject>, WorkflowOffer | undefined]>([
    ["is available with an entity input and an account input", workflow(), {}, AVAILABLE],
    [
      "needs no connection input to be available",
      workflow([ENTITY]),
      {},
      { workflowId: "workflow-1", name: "Review PR", answers: ["forge/review-requested"] },
    ],
    [
      "answers nothing when the entity input names no signal kinds",
      workflow([{ ...ENTITY, entity: { kinds: ["forge/pull-request"] } }, ACCOUNT]),
      {},
      { ...AVAILABLE, answers: [] },
    ],
    [
      "fills no input for an optional input or one with a default",
      workflow([
        ENTITY,
        ACCOUNT,
        { name: "focus", schema: { type: "string" }, required: false },
        { name: "depth", schema: { type: "string" }, required: true, default: "full" },
      ]),
      {},
      AVAILABLE,
    ],
    [
      "needs an input a card cannot fill",
      workflow([
        ENTITY,
        ACCOUNT,
        { name: "base_branch", schema: { type: "string" }, required: true },
      ]),
      {},
      unavailable("needs-input", "Review PR needs base_branch, which a card cannot fill"),
    ],
    [
      "fills only one required account input of its plugin's type",
      workflow([ENTITY, ACCOUNT, { ...ACCOUNT, name: "second_account" }]),
      {},
      unavailable("needs-input", "Review PR needs second_account, which a card cannot fill"),
    ],
    [
      "cannot fill an account input of another plugin's type",
      workflow([ENTITY, { name: "chat", connection: { type: "chat/chat" }, required: true }]),
      {},
      unavailable("needs-input", "Review PR needs chat, which a card cannot fill", {
        workflowId: "workflow-1",
        name: "Review PR",
        answers: ["forge/review-requested"],
      }),
    ],
    [
      "needs an account that can act, even with no account input",
      workflow([ENTITY]),
      { hasAccount: false },
      unavailable("no-account", "No connected account can act on this", {
        workflowId: "workflow-1",
        name: "Review PR",
        answers: ["forge/review-requested"],
      }),
    ],
    [
      "works on one repository only",
      workflow(undefined, primary("api-resource")),
      {},
      unavailable("repository", "Review PR works on acme/api only"),
    ],
    [
      "names every repository it works on",
      workflow(undefined, checkouts("api-resource", "web-resource")),
      { targetRemote: "github.com/acme/docs" },
      unavailable("repository", "Review PR works on acme/api or acme/web only"),
    ],
    [
      "fits when one of its checkouts is the repository the work lands in",
      workflow(undefined, checkouts("api-resource", "web-resource")),
      {},
      AVAILABLE,
    ],
    [
      "runs anywhere with no workspace",
      workflow(),
      { targetRemote: "github.com/acme/docs" },
      AVAILABLE,
    ],
    [
      "runs anywhere with a workspace that checks nothing out",
      workflow(undefined, checkouts()),
      { targetRemote: "github.com/acme/docs" },
      AVAILABLE,
    ],
    [
      "fits a kind with no repository, whatever its checkout",
      workflow(undefined, primary("api-resource")),
      { targetRemote: undefined },
      AVAILABLE,
    ],
    [
      "names the input before the repository, and the repository before the account",
      workflow(
        [ENTITY, ACCOUNT, { name: "base_branch", schema: { type: "string" }, required: true }],
        primary("api-resource"),
      ),
      { hasAccount: false },
      unavailable("needs-input", "Review PR needs base_branch, which a card cannot fill"),
    ],
    [
      "names the repository before the account",
      workflow(undefined, primary("api-resource")),
      { hasAccount: false },
      unavailable("repository", "Review PR works on acme/api only"),
    ],
    [
      "needs a workflow change when it takes a signal this card shows and no entity",
      workflow([{ name: "signal", signal: { kinds: ["forge/review-requested"] }, required: true }]),
      {},
      {
        workflowId: "workflow-1",
        name: "Review PR",
        answers: [],
        unavailable: {
          reason: "needs-workflow-change",
          message:
            "Review PR needs a workflow change: replace its signal input with an entity input",
        },
      },
    ],
    [
      "is not listed when it takes a signal this card does not show",
      workflow([{ name: "signal", signal: { kinds: ["forge/build-failed"] }, required: true }]),
      {},
      undefined,
    ],
    [
      "is not listed when its entity input lists another kind",
      workflow([{ ...ENTITY, entity: { kinds: ["forge/issue"] } }]),
      {},
      undefined,
    ],
    [
      "is not listed for a signal input when it also has an entity input of another kind",
      workflow([
        { ...ENTITY, entity: { kinds: ["forge/issue"] } },
        { name: "signal", signal: { kinds: ["forge/review-requested"] }, required: false },
      ]),
      {},
      undefined,
    ],
    ["is not listed with no inputs", workflow([]), {}, undefined],
  ])("%s", (_name, offered, subject, expected) => {
    expect(evaluateOffer(offered, { ...PULL_REQUEST, ...subject }, RESOURCES)).toEqual(expected);
  });
});

describe("evaluateOffers", () => {
  it("lists the available offers first, then the unavailable ones, each by name", () => {
    const named = (id: string, name: string, inputs?: ReadonlyArray<Input>): OfferableWorkflow => ({
      id,
      definition: { ...workflow(inputs).definition, name },
    });
    const needsBranch: ReadonlyArray<Input> = [
      ENTITY,
      { name: "base_branch", schema: { type: "string" }, required: true },
    ];
    const offers = evaluateOffers(
      [
        named("1", "Zeta"),
        named("2", "Alpha", needsBranch),
        named("3", "Mid"),
        named("4", "Beta", needsBranch),
        named("5", "Unrelated", [{ name: "text", schema: { type: "string" }, required: false }]),
      ],
      PULL_REQUEST,
      RESOURCES,
    );
    expect(offers.map((offer) => [offer.name, offer.unavailable?.reason])).toEqual([
      ["Mid", undefined],
      ["Zeta", undefined],
      ["Alpha", "needs-input"],
      ["Beta", "needs-input"],
    ]);
  });
});

describe("buildOfferSetId", () => {
  it("is the same for the same kind, target and account state, and differs when any differs", () => {
    const id = buildOfferSetId(PULL_REQUEST);
    expect(buildOfferSetId({ ...PULL_REQUEST })).toBe(id);
    for (const other of [
      { targetRemote: API },
      { targetRemote: undefined },
      { hasAccount: false },
      { kind: { ...PULL_REQUEST.kind, kind: "forge/issue" } },
    ]) {
      expect(buildOfferSetId({ ...PULL_REQUEST, ...other })).not.toBe(id);
    }
  });

  it("fits the contract's bound for a very long remote", () => {
    const remote = `github.com/${"a".repeat(200)}/${"b".repeat(200)}`;
    expect(buildOfferSetId({ ...PULL_REQUEST, targetRemote: remote }).length).toBeLessThanOrEqual(
      64,
    );
  });
});
