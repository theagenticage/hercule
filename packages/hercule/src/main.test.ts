/**
 * Runs `main.ts` as a real process against a fake runner socket. The unit tests
 * of the github-token client cannot see whether `main.ts` hands it the words
 * after the verb, which is what keeps `--help` from printing a token.
 */
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const folder = mkdtempSync(join(tmpdir(), "hercule-main-"));
const socketPath = join(folder, "daemon.sock");
let asked = 0;
const server: Server = createServer((socket) => {
  socket.on("data", () => {
    asked += 1;
    socket.write('{"token":"ghp_fake_for_test"}\n');
  });
  socket.on("error", () => undefined);
});
const listening = new Promise<void>((resolve) => server.listen(socketPath, resolve));

afterAll(() => {
  server.close();
  rmSync(folder, { recursive: true, force: true });
});

/** Runs `hercule github-token <args>` from source and returns what it printed. */
const runGithubTokenVerb = async (
  args: readonly string[],
): Promise<{ out: string; err: string; code: number }> => {
  await listening;
  const child = Bun.spawn(["bun", join(import.meta.dirname, "main.ts"), "github-token", ...args], {
    env: { ...process.env, HERCULE_RUNNER_SOCKET: socketPath, HERCULE_TOKEN: "session-token" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
};

describe("hercule github-token, started through main.ts", () => {
  it("prints the token for a bare call", async () => {
    const result = await runGithubTokenVerb([]);

    expect(result).toEqual({ out: "ghp_fake_for_test\n", err: "", code: 0 });
  });

  it.each([["--help"], ["-h"], ["--bogus"]])(
    "does not ask the runner for a token when given %s",
    async (argument) => {
      const before = asked;

      const result = await runGithubTokenVerb([argument]);

      expect(asked).toBe(before);
      expect(result.out).not.toContain("ghp_fake_for_test");
    },
  );
});
