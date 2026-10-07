import { expect, it } from "vitest";
import type { StartingRevision } from "@hercule/contract";
import { buildBranchField } from "./branch-menu";
import { buildSubmission } from "./submission";
import { buildThreadWorkspaceLabel } from "./thread-workspace";
import { buildWorkspaceMenu } from "./workspace-menu";
import {
  buildWorkspaceLead,
  decideDefaultWorkspacePick,
  joinPhraseText,
  setWorkspaceStartingRevision,
} from "./workspaces";
import {
  MOSS,
  PRIMARY,
  WEBSHOP,
  buildCheckout,
  buildSession,
  buildWorkspace,
} from "./workspaces.testing";

const around = { workspaces: [PRIMARY], runnerId: MOSS.id };
const draft = {
  kind: "draft" as const,
  config: {
    instanceId: null,
    model: null,
    options: {},
    accessMode: "approval-required" as const,
    runnerId: MOSS.id,
    profileId: null,
  },
};

it("defaults a coding project to separate files while honoring each explicit stored choice", () => {
  expect(decideDefaultWorkspacePick([WEBSHOP], null)).toEqual({
    kind: "ephemeral",
    checkouts: [{ resourceId: WEBSHOP.id }],
  });
  expect(decideDefaultWorkspacePick([WEBSHOP], "primary")).toEqual({
    kind: "primary",
    resourceId: WEBSHOP.id,
  });
  expect(decideDefaultWorkspacePick([WEBSHOP], "ephemeral")).toEqual({
    kind: "ephemeral",
    checkouts: [{ resourceId: WEBSHOP.id }],
  });
  expect(decideDefaultWorkspacePick([], "primary")).toEqual({ kind: "none" });
});

it("names the two file choices explicitly and explains that main shares existing files", () => {
  const menu = buildWorkspaceMenu({
    repos: [WEBSHOP],
    workspaces: [PRIMARY],
    sessions: [],
    runners: [MOSS],
    runnerId: MOSS.id,
    pick: { kind: "primary", resourceId: WEBSHOP.id },
  });
  expect(menu.rows.map((row) => row.name)).toContain("Use main workspace");
  expect(menu.rows.map((row) => row.name)).toContain("New workspace");
  expect(menu.rows.find((row) => row.pick.kind === "primary")?.sub).toMatch(/share.*files/i);
  expect(
    joinPhraseText(
      buildWorkspaceLead(
        { kind: "existing", workspaceId: PRIMARY.id },
        { resources: [WEBSHOP], workspaces: [PRIMARY], machine: MOSS.name, runnerId: MOSS.id },
      ),
    ),
  ).toMatch(/joins|share|same.*files/i);
});

it("keeps the actual main branch when a Thread shares its files", () => {
  const pick = { kind: "primary" as const, resourceId: WEBSHOP.id };
  expect(setWorkspaceStartingRevision(pick, "release/2.4")).toEqual(pick);
  const field = buildBranchField(pick, around);
  if (field !== null) {
    expect(field.label).toBe(PRIMARY.checkouts[0]?.branch);
    expect(field.rows).toEqual([]);
    expect(field.locked).not.toBeNull();
  }
  expect(
    buildSubmission(draft, { workspace: pick }, { text: "Share these files" }).input.workspace,
  ).toEqual(pick);
});

it.each<StartingRevision>([
  { kind: "current" },
  { kind: "local", branch: "unpublished-main" },
  { kind: "remote", branch: "release" },
])("preserves explicit %j in the public spawn request", (startingRevision) => {
  const workspace = {
    kind: "ephemeral" as const,
    checkouts: [{ resourceId: WEBSHOP.id, startingRevision }],
  };
  expect(
    buildSubmission(draft, { workspace }, { text: "Use the chosen revision" }).input.workspace,
  ).toEqual(workspace);
});

it.each<StartingRevision>([
  { kind: "current" },
  { kind: "local", branch: "unpublished-main" },
  { kind: "remote", branch: "release" },
])("describes explicit %j without presenting a different remote default", (startingRevision) => {
  const workspace = {
    kind: "ephemeral" as const,
    checkouts: [{ resourceId: WEBSHOP.id, startingRevision }],
  };
  const field = buildBranchField(workspace, around);
  const shown = [
    field?.label,
    field?.note,
    joinPhraseText(field?.foot ?? []),
    joinPhraseText(
      buildWorkspaceLead(workspace, {
        resources: [WEBSHOP],
        workspaces: [PRIMARY],
        machine: MOSS.name,
        runnerId: MOSS.id,
      }),
    ),
  ].join(" ");
  if (startingRevision.kind === "current") expect(shown).toMatch(/current|HEAD/i);
  if (startingRevision.kind === "local") {
    expect(shown).toContain("unpublished-main");
    expect(shown).not.toContain("origin/unpublished-main");
  }
  if (startingRevision.kind === "remote") expect(shown).toMatch(/origin\/release|remote.*release/i);
});

it.each<StartingRevision>([
  { kind: "current" },
  { kind: "local", branch: "unpublished-main" },
  { kind: "remote", branch: "release" },
])("labels started files from their recorded %j instead of a later default", (startingRevision) => {
  const workspace = buildWorkspace({
    id: "recorded-work",
    kind: "ephemeral",
    checkouts: [
      {
        ...buildCheckout(WEBSHOP.id, "fresh-local-branch"),
        startingRevision,
        baseCommit: "ab".repeat(20),
        defaultBranch: "later-default",
      },
    ],
  });
  const [label] = buildThreadWorkspaceLabel(
    buildSession({ id: "thread", workspaceId: workspace.id }),
    [workspace],
  );
  expect(label?.text).toBe("fresh-local-branch");
  expect(label?.kind === "branch" ? label.startedFrom : null).not.toContain("later-default");
  const description = label?.kind === "branch" ? label.startedFrom : null;
  if (startingRevision.kind === "current") expect(description).toMatch(/current|commit/i);
  if (startingRevision.kind === "local") expect(description).toContain("unpublished-main");
  if (startingRevision.kind === "remote")
    expect(description).toMatch(/origin\/release|remote.*release/i);
});
