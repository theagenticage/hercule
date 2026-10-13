/**
 * Tests that a checkout is recognized as the resource's repository when its
 * remote is an SSH alias, using the real `ssh` program with an SSH
 * configuration written for the test. The machine's own `~/.ssh/config` is
 * never read: a wrapper called `ssh`, first on the PATH given to the runner's
 * git environment, always adds `-F <test configuration>`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterAll, describe, expect, it } from "vitest";
import { inspectCheckoutIdentity } from "./identity";
import { describeRemoteMismatch } from "./remote-match";
import {
  cleanTemporaries,
  cloneUserCheckout,
  createTemporaryDir,
  makeRemote,
  runGitOrThrow,
} from "./testing";

afterAll(cleanTemporaries);

const REAL_SSH = Bun.which("ssh");

/**
 * Returns a git environment whose `ssh` reads only `sshConfig`. The wrapper
 * calls the real `ssh` by its full path, so production code needs no test hook.
 */
const makeSshEnvironment = (sshConfig: string): Record<string, string> => {
  const directory = createTemporaryDir("hercule-ssh-config-");
  const configPath = join(directory, "config");
  writeFileSync(configPath, sshConfig);
  const wrapper = join(directory, "ssh");
  // Each start of ssh leaves a line in `calls`, so a test can tell whether ssh ran.
  writeFileSync(
    wrapper,
    `#!/bin/sh\necho started >> "${join(directory, "calls")}"\nexec "${REAL_SSH}" -F "${configPath}" "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return { PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}` };
};

/** Returns how many times ssh was started with an environment from `makeSshEnvironment`. */
const countSshStarts = (env: Record<string, string>): number => {
  const calls = join(env["PATH"]!.split(":")[0]!, "calls");
  return existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
};

/** Creates a checkout whose `origin` is `checkoutRemote` and returns its path. */
const makeCheckoutWithOrigin = (checkoutRemote: string): string => {
  const path = cloneUserCheckout(makeRemote());
  runGitOrThrow(path, "remote", "set-url", "origin", checkoutRemote);
  return path;
};

/** Inspects the checkout at `path` against `resourceRemote`, returning the outcome. */
const inspectCheckout = (path: string, resourceRemote: string, env: Record<string, string>) =>
  Effect.runPromise(Effect.result(inspectCheckoutIdentity(path, "origin", resourceRemote, env)));

/** Inspects a fresh checkout whose `origin` is `checkoutRemote` against `resourceRemote`. */
const inspectWithOrigin = (
  checkoutRemote: string,
  resourceRemote: string,
  env: Record<string, string>,
) => inspectCheckout(makeCheckoutWithOrigin(checkoutRemote), resourceRemote, env);

const RESOURCE = "https://github.com/acme/web";

describe.skipIf(REAL_SSH === null)("a checkout remote that is an SSH alias", () => {
  it("is accepted when the alias connects to the resource's host", async () => {
    const env = makeSshEnvironment("Host work-github\n  HostName github.com\n");

    const result = await inspectWithOrigin("git@work-github:Acme/web.git", RESOURCE, env);

    expect(result._tag).toBe("Success");
  });

  it.each([
    "work-github:Acme/web.git",
    "ssh://git@work-github:2222/Acme/web.git",
    "ssh://work-github/Acme/web.git",
    "git+ssh://git@work-github/Acme/web.git",
  ])("is accepted when it is spelled %s", async (checkoutRemote) => {
    const env = makeSshEnvironment("Host work-github\n  HostName github.com\n");

    const result = await inspectWithOrigin(checkoutRemote, RESOURCE, env);

    expect(result._tag).toBe("Success");
  });

  it("is accepted when the alias connects to an IPv6 address the resource names in brackets", async () => {
    const env = makeSshEnvironment("Host review-ipv6\n  HostName 2001:db8::1\n");

    const result = await inspectWithOrigin(
      "git@review-ipv6:acme/web.git",
      "https://[2001:db8::1]/acme/web",
      env,
    );

    expect(result._tag).toBe("Success");
  });

  it("is accepted when the SSH configuration depends on the user in the remote", async () => {
    const env = makeSshEnvironment(
      "Match originalhost user-alias user git\n  HostName github.com\n",
    );

    const result = await inspectWithOrigin("git@user-alias:Acme/web.git", RESOURCE, env);

    expect(result._tag).toBe("Success");
  });

  it("is rejected when the alias connects to another host, and the error names both repositories", async () => {
    const env = makeSshEnvironment("Host work-github\n  HostName gitlab.com\n");

    const result = await inspectWithOrigin("git@work-github:Acme/web.git", RESOURCE, env);

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure.message).toContain("work-github/acme/web");
    expect(result.failure.message).toContain("github.com/acme/web");
  });

  it("is rejected when the alias leads to the right host but another repository", async () => {
    const env = makeSshEnvironment("Host work-github\n  HostName github.com\n");

    const result = await inspectWithOrigin("git@work-github:Acme/api.git", RESOURCE, env);

    expect(result._tag).toBe("Failure");
  });
});

describe.skipIf(REAL_SSH === null)("an SSH configuration that depends on the directory", () => {
  // Git starts ssh in the checkout, so a `Match exec` rule can pick another
  // host there than in the runner's own directory.
  const CONFIG = [
    'Match originalhost review-cwd exec "test ! -f review-private-marker"',
    "  HostName github.com",
    'Match originalhost review-cwd exec "test -f review-private-marker"',
    "  HostName gitlab.com",
    "",
  ].join("\n");

  it("is evaluated in the checkout, so a marker there changes the host", async () => {
    const env = makeSshEnvironment(CONFIG);
    const path = makeCheckoutWithOrigin("git@review-cwd:acme/web.git");
    writeFileSync(join(path, "review-private-marker"), "");

    const result = await inspectCheckout(path, RESOURCE, env);

    expect(result._tag).toBe("Failure");
  });

  it("is evaluated at the checkout root, even when a subdirectory was selected", async () => {
    // Git starts ssh at the root of the checkout whichever directory is selected.
    const env = makeSshEnvironment(
      [
        'Match originalhost review-sub exec "test -f review-root-marker"',
        "  HostName github.com",
        'Match originalhost review-sub exec "test ! -f review-root-marker"',
        "  HostName gitlab.com",
        "",
      ].join("\n"),
    );
    const path = makeCheckoutWithOrigin("git@review-sub:acme/web.git");
    writeFileSync(join(path, "review-root-marker"), "");
    mkdirSync(join(path, "src"));

    const result = await inspectCheckout(join(path, "src"), RESOURCE, env);

    expect(result._tag).toBe("Success");
  });

  it("accepts the same checkout when the marker is absent", async () => {
    const env = makeSshEnvironment(CONFIG);

    const result = await inspectWithOrigin("git@review-cwd:acme/web.git", RESOURCE, env);

    expect(result._tag).toBe("Success");
  });
});

describe.skipIf(REAL_SSH === null)("remotes written with the same host", () => {
  it("are the same repository as written, without starting ssh", async () => {
    // The user's own SSH configuration redirects github.com. That is their
    // choice; asking ssh on every check would also start it for every ordinary
    // `git@github.com:` checkout.
    const env = makeSshEnvironment("Host github.com\n  HostName gitlab.com\n");

    const result = await inspectWithOrigin("git@github.com:Acme/web.git", RESOURCE, env);

    expect(result._tag).toBe("Success");
    expect(countSshStarts(env)).toBe(0);
  });
});

describe.skipIf(REAL_SSH === null)("an ssh:// remote with an IPv6 host", () => {
  // Git passes the address to ssh without brackets, so `git@::1` is what the
  // SSH configuration is asked about, not the Host line of the Resource's alias.
  const CONFIG = [
    "Host review-alias",
    "  HostName ::1",
    "Host ::1",
    "  HostName different.invalid",
    "",
  ].join("\n");

  it("is resolved as the address, and rejected when SSH sends it elsewhere", async () => {
    const env = makeSshEnvironment(CONFIG);

    const result = await inspectWithOrigin(
      "ssh://git@[::1]/acme/web.git",
      "git@review-alias:acme/web.git",
      env,
    );

    expect(result._tag).toBe("Failure");
  });

  it("is accepted when SSH sends the address to the resource's host", async () => {
    const env = makeSshEnvironment("Host ::1\n  HostName github.com\n");

    const result = await inspectWithOrigin("ssh://git@[::1]/acme/web.git", RESOURCE, env);

    expect(result._tag).toBe("Success");
  });
});

describe.skipIf(REAL_SSH === null)("a host that cannot be resolved", () => {
  it("never matches another remote's resolved host, even when written the same", async () => {
    // Both remotes are SSH, and really lead to different hosts (gitlab.com and
    // review-slow.invalid). The checkout's alias is slow to resolve and times
    // out. Comparing its written host instead would equal the resource's
    // resolved host and wrongly match.
    const env = makeSshEnvironment(
      [
        "Host review-slow.invalid",
        "  HostName gitlab.com",
        "Host review-fast",
        "  HostName review-slow.invalid",
        'Match originalhost review-slow.invalid exec "sleep 60"',
        "  User git",
        "",
      ].join("\n"),
    );

    const result = await inspectWithOrigin(
      "git@review-slow.invalid:acme/web.git",
      "git@review-fast:acme/web.git",
      env,
    );

    expect(result._tag).toBe("Failure");
  }, 20_000);
});

describe.skipIf(REAL_SSH === null)("a checkout remote that is not reached over SSH", () => {
  it("is not resolved through the SSH configuration", async () => {
    // Git does not read the SSH configuration for an HTTPS remote, so this
    // HostName line says nothing about where the HTTPS remote leads.
    const env = makeSshEnvironment("Host review-internal.example\n  HostName github.com\n");

    const result = await inspectWithOrigin(
      "https://review-internal.example/acme/web",
      RESOURCE,
      env,
    );

    expect(result._tag).toBe("Failure");
  });
});

describe.skipIf(REAL_SSH === null)("an SSH configuration that never finishes", () => {
  it("stops waiting after the deadline and leaves the runner responsive", async () => {
    const env = makeSshEnvironment(
      'Host work-github\n  HostName github.com\nMatch host github.com exec "sleep 60"\n  User x\n',
    );
    // The checkout is built first: creating it runs git synchronously, which
    // would otherwise be counted as the runner being unresponsive.
    const path = makeCheckoutWithOrigin("git@work-github:Acme/web.git");
    let longestGapMs = 0;
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      longestGapMs = Math.max(longestGapMs, now - lastTick);
      lastTick = now;
    }, 10);

    try {
      const result = await inspectCheckout(path, RESOURCE, env);

      expect(result._tag).toBe("Failure");
      expect(longestGapMs).toBeLessThan(1000);
    } finally {
      clearInterval(timer);
    }
  }, 20_000);
});

describe("describeRemoteMismatch", () => {
  it("names the remote and both repositories", () => {
    const message = describeRemoteMismatch(
      "origin",
      "git@gh-mws:MatchWornShirt/monorepo.git",
      "https://github.com/Acme/web",
    );
    expect(message).toContain('"origin"');
    expect(message).toContain("gh-mws/matchwornshirt/monorepo");
    expect(message).toContain("github.com/acme/web");
  });

  it.each([
    ["a password", "https://user:s3cret-token@github.com/acme/api.git"],
    ["a query string", "https://github.com/acme/api?access_token=s3cret-token"],
    ["a fragment", "https://github.com/acme/api#s3cret-token"],
  ])("never repeats %s from the checkout's remote", (_name, remote) => {
    const message = describeRemoteMismatch("origin", remote, "https://github.com/acme/web");
    expect(message).not.toContain("s3cret-token");
    expect(message).toContain("github.com/acme/api");
  });
});

describe("inspectCheckoutIdentity", () => {
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

  it("does not put a secret from the checkout's remote in its error", async () => {
    const result = await inspectWithOrigin(
      "https://github.com/acme/api?access_token=s3cret-token",
      RESOURCE,
      env,
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure.message).not.toContain("s3cret-token");
  });

  it("fails naming the remote when the checkout has no remote of that name", async () => {
    const path = cloneUserCheckout(makeRemote());

    const error = await Effect.runPromise(
      Effect.flip(inspectCheckoutIdentity(path, "upstream", RESOURCE, env)),
    );

    expect(error.message).toContain('"upstream"');
  });
});
