/**
 * Test helpers for the Skill Library: building a skill's archive and importing
 * it over HTTP, the way a user does.
 */
import { expect } from "vitest";
import { Effect } from "effect";
import type { Skill } from "@hercule/contract";
import { buildSkillArchive } from "@hercule/protocol";

/**
 * Builds the archive of a skill named `name` with one `SKILL.md`. Its body is
 * `body`, so two calls with different bodies build two different revisions.
 */
export const buildTestSkillArchive = (name: string, body = "Body"): Promise<Uint8Array> =>
  Effect.runPromise(
    buildSkillArchive([
      {
        path: "SKILL.md",
        mode: "644",
        content: new TextEncoder().encode(
          `---\nname: ${name}\ndescription: Teaches.\n---\n${body}\n`,
        ),
      },
    ]),
  );

/**
 * Imports the skill `name` as the user, with `body` as its `SKILL.md` body,
 * and returns the Skill the import answers. `replace` makes new content
 * current over a Skill that has other content. Fails the test when the import
 * does not answer `200`.
 */
export const importTestSkill = async (
  base: string,
  token: string,
  name: string,
  options: { readonly body?: string; readonly replace?: true } = {},
): Promise<Skill> => {
  const query = options.replace === true ? `name=${name}&replace=true` : `name=${name}`;
  const response = await fetch(`${base}/api/v1/skills/import?${query}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
    body: await buildTestSkillArchive(name, options.body),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { readonly skill: Skill }).skill;
};
