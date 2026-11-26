import { describe, expect, it } from "vitest";
import { decideAfterHookFailure, decidePreToolHook } from "./pre-tool-hook-policy";
import type { EditTarget, GuardedPlace, PreToolFacts } from "./pre-tool-hook-policy";

const target = (path: string, overrides: Partial<EditTarget> = {}): EditTarget => ({
  lexicalPath: path,
  resolvedPath: path,
  existingIdentities: [],
  ...overrides,
});

const file = (path: string, overrides: Partial<GuardedPlace> = {}): GuardedPlace => ({
  isFolder: false,
  lexicalPath: path,
  resolvedPath: path,
  identity: undefined,
  ...overrides,
});

const folder = (path: string, overrides: Partial<GuardedPlace> = {}): GuardedPlace =>
  file(path, { isFolder: true, ...overrides });

const editFacts = (
  path: unknown,
  editTarget: EditTarget | undefined,
  guardedPlaces: ReadonlyArray<GuardedPlace>,
): PreToolFacts => ({
  guardIsOn: true,
  deniesWebSearch: false,
  call: { name: "edit_file", args: { Path: path } },
  editTarget,
  guardedPlaces,
});

describe("decideAfterHookFailure", () => {
  it("lets the call run when nothing is enforced, and otherwise denies with a reason", () => {
    expect(decideAfterHookFailure({ guardIsOn: false, deniesWebSearch: false })).toBeUndefined();
    for (const flags of [
      { guardIsOn: true, deniesWebSearch: false },
      { guardIsOn: false, deniesWebSearch: true },
    ]) {
      const denial = decideAfterHookFailure(flags);
      expect(denial?.reason).toContain("check of this tool call failed");
      expect(denial?.reason).toContain("Full access");
    }
  });
});

describe("decidePreToolHook", () => {
  it("always gives a denial a reason that is not empty", () => {
    const places = [file("/r/hooks.json")];
    const denials = [
      decidePreToolHook({ ...editFacts("x", target("/r/hooks.json"), places) }),
      decidePreToolHook(editFacts(5, undefined, places)),
      decidePreToolHook({
        guardIsOn: false,
        deniesWebSearch: true,
        call: { name: "search_web", args: {} },
        editTarget: undefined,
        guardedPlaces: [],
      }),
      decidePreToolHook({
        guardIsOn: true,
        deniesWebSearch: false,
        call: undefined,
        editTarget: undefined,
        guardedPlaces: [],
      }),
    ];

    expect(denials.map((denial) => denial?.reason.length ?? 0).every((length) => length > 0)).toBe(
      true,
    );
  });

  it("denies web search only when the web search denial is on", () => {
    const search = { name: "search_web", args: {} };
    const base = { guardIsOn: true, editTarget: undefined, guardedPlaces: [] };

    expect(decidePreToolHook({ ...base, deniesWebSearch: true, call: search })).toEqual({
      decision: "deny",
      reason:
        "Web search is off in Approval required, because a search runs without a card. Ask the user, or switch the thread to another access mode.",
    });
    expect(decidePreToolHook({ ...base, deniesWebSearch: false, call: search })).toBeUndefined();
  });

  it("lets a shell command through", () => {
    expect(
      decidePreToolHook({
        guardIsOn: true,
        deniesWebSearch: true,
        call: { name: "run_command", args: { CommandLine: "ls" } },
        editTarget: undefined,
        guardedPlaces: [],
      }),
    ).toBeUndefined();
  });

  it.each([
    ["the guard", { guardIsOn: true, deniesWebSearch: false }],
    ["the web search denial", { guardIsOn: false, deniesWebSearch: true }],
  ])("denies a call it cannot decode when %s is on, and says why", (_name, flags) => {
    const denial = decidePreToolHook({
      ...flags,
      call: undefined,
      editTarget: undefined,
      guardedPlaces: [],
    });

    expect(denial?.reason).toContain("could not read this tool call");
    expect(denial?.reason).toContain("Full access");
  });

  it("lets a call it cannot decode through when neither is on", () => {
    expect(
      decidePreToolHook({
        guardIsOn: false,
        deniesWebSearch: false,
        call: undefined,
        editTarget: undefined,
        guardedPlaces: [],
      }),
    ).toBeUndefined();
  });

  it("denies an edit with no text Path, and an edit whose target could not be built", () => {
    const places = [file("/r/.agents/hooks.json")];

    expect(decidePreToolHook(editFacts(undefined, undefined, places))?.reason).toContain(
      "could not read",
    );
    expect(decidePreToolHook(editFacts(5, undefined, places))?.reason).toContain("could not read");
    expect(decidePreToolHook(editFacts("/r/a.ts", undefined, places))?.reason).toContain(
      "could not read",
    );
  });

  it("allows every edit when the guard is off", () => {
    expect(
      decidePreToolHook({
        ...editFacts("/r/.agents/hooks.json", target("/r/.agents/hooks.json"), [
          file("/r/.agents/hooks.json"),
        ]),
        guardIsOn: false,
      }),
    ).toBeUndefined();
  });

  describe("the guard", () => {
    it("denies a guarded file by either reading of the target, and names the path as written", () => {
      const places = [file("/r/.agents/hooks.json")];

      const byText = decidePreToolHook(
        editFacts(
          "a/../.agents/hooks.json",
          target("/r/.agents/hooks.json", { resolvedPath: "/elsewhere" }),
          places,
        ),
      );
      const byLink = decidePreToolHook(
        editFacts("link", target("/r/link", { resolvedPath: "/r/.agents/hooks.json" }), places),
      );

      expect(byText?.reason).toBe(
        "Hercule does not let the agent change a/../.agents/hooks.json: it decides what the agent may do without asking. Ask the user to change it.",
      );
      expect(byLink?.decision).toBe("deny");
    });

    it("denies by either reading of the guarded place", () => {
      const places = [file("/spelled", { resolvedPath: "/real/hooks.json" })];

      expect(decidePreToolHook(editFacts("x", target("/real/hooks.json"), places))).toBeDefined();
      expect(decidePreToolHook(editFacts("x", target("/spelled"), places))).toBeDefined();
    });

    it("denies a path in a guarded folder and the folder itself, not a sibling named alike", () => {
      const places = [folder("/r/.agents/plugins")];

      expect(
        decidePreToolHook(editFacts("x", target("/r/.agents/plugins/a/b.json"), places)),
      ).toBeDefined();
      expect(decidePreToolHook(editFacts("x", target("/r/.agents/plugins"), places))).toBeDefined();
      expect(
        decidePreToolHook(editFacts("x", target("/r/.agents/plugins.json"), places)),
      ).toBeUndefined();
      expect(
        decidePreToolHook(editFacts("x", target("/r/.agents/plugins-extra/a"), places)),
      ).toBeUndefined();
    });

    it("denies a new file below an existing guarded folder reached by another spelling, by file identity", () => {
      const places = [folder("/r/.agents/plugins", { identity: "1:42" })];

      const denial = decidePreToolHook(
        editFacts(
          "x",
          target("/r/.Agents/Plugins/new.json", { existingIdentities: ["1:7", "1:42"] }),
          places,
        ),
      );

      expect(denial?.decision).toBe("deny");
    });

    it("allows a path that shares no spelling and no identity with a guarded place", () => {
      const places = [
        file("/r/.agents/hooks.json", { identity: "1:5" }),
        folder("/r/.agents/plugins", { identity: "1:6" }),
      ];

      expect(
        decidePreToolHook(
          editFacts("x", target("/r/src/a.ts", { existingIdentities: ["1:9", "1:2"] }), places),
        ),
      ).toBeUndefined();
    });
  });
});
