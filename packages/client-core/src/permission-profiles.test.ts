import { describe, expect, it } from "vitest";
import { ALL_GRANTS, GRANT_FAMILIES, type Grant } from "@hercule/contract";
import {
  chooseNewProfileName,
  describeProfileDeleteBlock,
  describeProfileUsers,
  formatGrantVerb,
  GRANT_FAMILY_TEXT,
  describeGrantChange,
  groupProfileUsers,
  isUnrestrictedProfile,
  setGrantHeld,
  sortProfiles,
  type ProfileUser,
} from "./permission-profiles";

const user = (name: string, kind: ProfileUser["kind"] = "agent", id = name): ProfileUser => ({
  id,
  name,
  kind,
});

describe("GRANT_FAMILY_TEXT", () => {
  it("has text for exactly the grant families, in the contract's order", () => {
    expect(Object.keys(GRANT_FAMILY_TEXT)).toEqual(Object.keys(GRANT_FAMILIES));
  });

  it("gives every family a label and a hint that ends in a period", () => {
    for (const [family, { label, hint }] of Object.entries(GRANT_FAMILY_TEXT)) {
      expect(label, family).not.toBe("");
      expect(hint.endsWith("."), family).toBe(true);
    }
  });
});

describe("formatGrantVerb", () => {
  it("capitalises the verb", () => {
    expect(formatGrantVerb("read")).toBe("Read");
    expect(formatGrantVerb("audit")).toBe("Audit");
  });
});

describe("chooseNewProfileName", () => {
  it("returns New profile when it is free", () => {
    expect(chooseNewProfileName([])).toBe("New profile");
    expect(chooseNewProfileName([{ name: "Reviewer" }])).toBe("New profile");
  });

  it("returns the first numbered name that is free", () => {
    expect(chooseNewProfileName([{ name: "New profile" }])).toBe("New profile 2");
    expect(chooseNewProfileName([{ name: "New profile" }, { name: "New profile 3" }])).toBe(
      "New profile 2",
    );
    expect(
      chooseNewProfileName([
        { name: "New profile" },
        { name: "New profile 2" },
        { name: "New profile 3" },
      ]),
    ).toBe("New profile 4");
  });

  it("compares names exactly, as the controller does", () => {
    expect(chooseNewProfileName([{ name: "new profile" }])).toBe("New profile");
  });
});

describe("groupProfileUsers", () => {
  it("groups agents and assistants by profile, assistants first, each by name", () => {
    const grouped = groupProfileUsers(
      [
        { id: "a2", name: "pr-review", permissionProfileId: "p1" },
        { id: "a1", name: "fix-step", permissionProfileId: "p1" },
        { id: "a3", name: "triage-step", permissionProfileId: "p2" },
      ],
      [
        { id: "s2", name: "Milo", permissionProfileId: "p1" },
        { id: "s1", name: "Ada", permissionProfileId: "p1" },
      ],
    );
    expect(grouped.get("p1")).toEqual([
      { id: "s1", name: "Ada", kind: "assistant" },
      { id: "s2", name: "Milo", kind: "assistant" },
      { id: "a1", name: "fix-step", kind: "agent" },
      { id: "a2", name: "pr-review", kind: "agent" },
    ]);
    expect(grouped.get("p2")).toEqual([{ id: "a3", name: "triage-step", kind: "agent" }]);
  });

  it("has no entry for a profile nobody uses", () => {
    const grouped = groupProfileUsers([], [{ id: "s1", name: "Ada", permissionProfileId: "p1" }]);
    expect([...grouped.keys()]).toEqual(["p1"]);
    expect(groupProfileUsers([], []).size).toBe(0);
  });

  it("orders two users with the same name by id", () => {
    const grouped = groupProfileUsers(
      [
        { id: "b", name: "same", permissionProfileId: "p1" },
        { id: "a", name: "same", permissionProfileId: "p1" },
      ],
      [],
    );
    expect(grouped.get("p1")?.map((each) => each.id)).toEqual(["a", "b"]);
  });
});

describe("describeProfileUsers", () => {
  it("says Nothing for no users", () => {
    expect(describeProfileUsers([])).toBe("Nothing");
  });

  it("joins one or two names with a comma", () => {
    expect(describeProfileUsers([user("Milo")])).toBe("Milo");
    expect(describeProfileUsers([user("Milo"), user("pr-review")])).toBe("Milo, pr-review");
  });

  it("names the first two and counts the rest", () => {
    expect(describeProfileUsers([user("Milo"), user("pr-review"), user("a")])).toBe(
      "Milo, pr-review and 1 more",
    );
    expect(
      describeProfileUsers([user("Milo"), user("pr-review"), user("a"), user("b"), user("c")]),
    ).toBe("Milo, pr-review and 3 more");
  });
});

describe("describeProfileDeleteBlock", () => {
  it("returns null when nobody uses the profile", () => {
    expect(describeProfileDeleteBlock([])).toBeNull();
  });

  it("reads naturally for one user", () => {
    expect(describeProfileDeleteBlock([user("Milo")])).toBe(
      "Milo uses it. Move it to another profile first.",
    );
  });

  it("reads naturally for two users", () => {
    expect(describeProfileDeleteBlock([user("Milo"), user("pr-review")])).toBe(
      "Milo and pr-review use it. Move them to another profile first.",
    );
  });

  it("names two users and counts the rest", () => {
    expect(
      describeProfileDeleteBlock([
        user("Milo"),
        user("pr-review"),
        user("a"),
        user("b"),
        user("c"),
      ]),
    ).toBe("Milo, pr-review and 3 more use it. Move them to another profile first.");
    expect(describeProfileDeleteBlock([user("Milo"), user("pr-review"), user("a")])).toBe(
      "Milo, pr-review and 1 more use it. Move them to another profile first.",
    );
  });
});

describe("setGrantHeld", () => {
  it("adds a grant in the contract's order", () => {
    expect(setGrantHeld(["task.read", "run.read"], "task.update", true)).toEqual([
      "task.read",
      "task.update",
      "run.read",
    ]);
  });

  it("removes a grant and keeps the others in order", () => {
    expect(setGrantHeld(["task.read", "task.update", "run.read"], "task.update", false)).toEqual([
      "task.read",
      "run.read",
    ]);
  });

  it("holds no repeats when the grant is already held or already absent", () => {
    expect(setGrantHeld(["task.read"], "task.read", true)).toEqual(["task.read"]);
    expect(setGrantHeld(["task.read"], "run.read", false)).toEqual(["task.read"]);
  });

  it("puts a list in any order, with repeats, into the contract's order", () => {
    const shuffled: Grant[] = ["secret.read", "task.read", "secret.read"];
    expect(setGrantHeld(shuffled, "workflow.read", true)).toEqual([
      "task.read",
      "workflow.read",
      "secret.read",
    ]);
  });

  it("can grow to every grant and back to none", () => {
    const all = ALL_GRANTS.reduce<ReadonlyArray<Grant>>(
      (held, grant) => setGrantHeld(held, grant, true),
      [],
    );
    expect(all).toEqual(ALL_GRANTS);
    expect(ALL_GRANTS.reduce((held, grant) => setGrantHeld(held, grant, false), all)).toEqual([]);
  });
});

describe("sortProfiles", () => {
  const profile = (id: string, name: string, shipped: boolean) => ({ id, name, shipped });

  it("puts the shipped profiles first, then each group by name", () => {
    const sorted = sortProfiles([
      profile("1", "Reviewer", false),
      profile("2", "worker", true),
      profile("3", "Releaser", false),
      profile("4", "assistant", true),
    ]);
    expect(sorted.map(({ name }) => name)).toEqual(["assistant", "worker", "Releaser", "Reviewer"]);
  });

  it("breaks a tie of names by id, and leaves its argument alone", () => {
    const profiles = [profile("b", "Same", false), profile("a", "Same", false)];
    expect(sortProfiles(profiles).map(({ id }) => id)).toEqual(["a", "b"]);
    expect(profiles.map(({ id }) => id)).toEqual(["b", "a"]);
  });
});

describe("isUnrestrictedProfile", () => {
  it("is true for the shipped profile named unrestricted only", () => {
    expect(isUnrestrictedProfile({ name: "unrestricted", shipped: true })).toBe(true);
    expect(isUnrestrictedProfile({ name: "worker", shipped: true })).toBe(false);
    expect(isUnrestrictedProfile({ name: "unrestricted", shipped: false })).toBe(false);
  });
});

describe("describeGrantChange", () => {
  it("says a removed grant is taken away from the profile", () => {
    expect(describeGrantChange("unrestricted", "task.delete", false)).toBe(
      "This takes Delete on Tasks away from unrestricted.",
    );
  });

  it("says a grant put back is given back to the profile", () => {
    expect(describeGrantChange("unrestricted", "infra.write", true)).toBe(
      "This gives Write on Machines back to unrestricted.",
    );
  });
});
