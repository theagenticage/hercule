/**
 * A fleet with workspaces on it, for the tests that drive them over the real
 * API and the real runner socket. Shared between this domain's own suites - the
 * provisioning one, the expiry sweep and the git credentials - and the
 * resources one, because all four stand up the same machine and read the same
 * records back: a second copy of what a workspace looks like on the wire is a
 * second place for the tests and the controller to drift apart.
 *
 * What varies between callers is passed in: the plugins beside the provider
 * fixture, and the sweep interval a test that watches the reaper hands over.
 */
import { expect } from "vitest";
import type * as Duration from "effect/Duration";
import type { ModelDescriptor, RunnerFacts } from "@hercule/protocol";
import type { Plugin } from "@hercule/plugin-host";
import { get, post } from "../http/testing";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import { withFleet as withRunnerFleet, type Arranged, type Wire } from "../sessions/testing";

/** What the one machine in these fleets reports about itself. */
export const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [{ name: "git", version: "2.50.1", path: "/usr/bin/git" }],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["test-provider"],
  identityPort: 4939,
};

/** What its probe answers with, so a session has something to be placed against. */
export const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", isDefault: true, options: [] },
];

export interface WorkspaceFleetOptions {
  /** Plugins beside the provider fixture every one of these fleets needs. */
  readonly plugins?: ReadonlyArray<Plugin>;
  /** The shipped ten minutes is longer than a test that watches the sweep can wait. */
  readonly workspaceSweepInterval?: Duration.Duration;
}

/** A controller with one enlisted, connected, logged-in machine and a provider on it. */
export const withFleet = (
  body: (arranged: Arranged) => Promise<void>,
  options: WorkspaceFleetOptions = {},
): Promise<void> =>
  withRunnerFleet(body, {
    plugins: [
      createPluginFixture({
        id: "providers",
        definitions: [buildProviderDefinition("test-provider")],
      }).plugin,
      ...(options.plugins ?? []),
    ],
    facts: FACTS,
    models: MODELS,
    ...(options.workspaceSweepInterval === undefined
      ? {}
      : { workspaceSweepInterval: options.workspaceSweepInterval }),
  });

/** A frame on the wire, read as the object it is rather than as a member of a union. */
export type Frame = { readonly _tag: string } & Record<string, unknown>;

export const listFramesTagged = (wire: Wire, tag: string): ReadonlyArray<Frame> =>
  (wire.frames as ReadonlyArray<Frame>).filter((frame) => frame._tag === tag);

/** One checkout of a workspace, as the API hands it back. */
export interface CheckoutRecord {
  readonly checkoutId?: string;
  readonly id?: string;
  readonly resourceId: string;
  readonly form: string;
  readonly subdirectory: string | null;
  readonly branch: string | null;
  readonly branches?: ReadonlyArray<string>;
  readonly defaultBranch?: string | null;
}

/** A workspace as the API hands it back; only the fields these tests read are named. */
export interface WorkspaceRecord {
  readonly id: string;
  readonly runnerId: string;
  readonly kind: string;
  readonly status: string;
  readonly checkouts: ReadonlyArray<CheckoutRecord>;
  readonly designatedConnectionId: string | null;
  readonly provisionedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly disposedAt: string | null;
  readonly sessionIds: ReadonlyArray<string>;
  readonly message?: string | null;
}

/** The error code a refusal answered with. */
export const readErrorCode = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

/** A repo resource, optionally naming the Connection its token comes from. */
export const createRepo = async (
  arranged: Arranged,
  remote: string,
  connectionId?: string,
): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/resources",
    { kind: "repo", remote, ...(connectionId === undefined ? {} : { connectionId }) },
    arranged.token,
  );
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return ((await response.json()) as { id: string }).id;
};

/** A workspace the controller took the request for; the machine has yet to make it. */
export const provisionWorkspaceOrFail = async (
  arranged: Arranged,
  body: unknown,
): Promise<WorkspaceRecord> => {
  const response = await post(arranged.harness.base, "/api/v1/workspaces", body, arranged.token);
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return (await response.json()) as WorkspaceRecord;
};

export const readWorkspace = async (arranged: Arranged, id: string): Promise<WorkspaceRecord> => {
  const response = await get(arranged.harness.base, `/api/v1/workspaces/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as WorkspaceRecord;
};
