import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProcessLogLayer } from "./index";

let home: string;
let wasTTY: boolean | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hercule-process-log-"));
  wasTTY = process.stderr.isTTY;
});

afterEach(() => {
  setStderrIsTTY(wasTTY);
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

/** Makes the layer see stderr as a terminal or not; the layer reads this when it is built. */
const setStderrIsTTY = (value: boolean | undefined): void => {
  Object.defineProperty(process.stderr, "isTTY", { value, configurable: true, writable: true });
};

const logFile = (): string => join(home, "logs", "controller.log");

/** Runs `program` with the controller's process log at `level`. */
const runLogged = (program: Effect.Effect<void>, level: "warn" | "info" = "info"): Promise<void> =>
  Effect.runPromise(
    program.pipe(Effect.provide(makeProcessLogLayer({ home, role: "controller", level }))),
  );

describe("makeProcessLogLayer", () => {
  it("writes one logfmt line per entry into <home>/logs/<role>.log", async () => {
    await runLogged(
      Effect.andThen(Effect.logInfo("first entry"), Effect.logWarning("second\nentry")),
    );

    const lines = readFileSync(logFile(), "utf8").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^timestamp=\S+ level=INFO fiber=#\d+ message="first entry"$/);
    expect(lines[1]).toContain("level=WARN fiber=#");
    expect(lines[1]).toContain('message="second\\nentry"');
    expect(lines[2]).toBe("");
  });

  it("creates the logs folder with mode 0700 and the file with mode 0600", async () => {
    await runLogged(Effect.logInfo("entry"));

    expect(statSync(join(home, "logs")).mode & 0o777).toBe(0o700);
    expect(statSync(logFile()).mode & 0o777).toBe(0o600);
  });

  it("restricts a logs folder that already exists to mode 0700", async () => {
    mkdirSync(join(home, "logs"), { mode: 0o755 });
    chmodSync(join(home, "logs"), 0o755);
    await runLogged(Effect.logInfo("entry"));

    expect(statSync(join(home, "logs")).mode & 0o777).toBe(0o700);
  });

  it("drops entries below the configured level", async () => {
    await runLogged(
      Effect.andThen(Effect.logInfo("too detailed"), Effect.logWarning("kept")),
      "warn",
    );

    const content = readFileSync(logFile(), "utf8");
    expect(content).not.toContain("too detailed");
    expect(content).toContain("kept");
  });

  it("writes nothing to the console when stderr is not a terminal", async () => {
    setStderrIsTTY(false);
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");

    await runLogged(Effect.logInfo("only in the file"));

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(readFileSync(logFile(), "utf8")).toContain("only in the file");
  });

  it("echoes every entry to stderr, never stdout, when stderr is a terminal", async () => {
    setStderrIsTTY(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runLogged(Effect.logInfo("echoed").pipe(Effect.annotateLogs({ runner: "r1" })));

    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).toContain("echoed");
    expect(error.mock.calls.flat().join(" ")).toContain("r1");
    expect(readFileSync(logFile(), "utf8")).toContain("echoed");
  });

  it("reports a failing rotation on stderr once, and keeps logging", async () => {
    setStderrIsTTY(false);
    const written: Array<string> = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    // A log file already at the 10 MiB limit makes the first entry rotate it,
    // and a folder that is not empty at `.5` makes every rotation fail.
    mkdirSync(join(home, "logs"));
    writeFileSync(logFile(), Buffer.alloc(10 * 1024 * 1024, "x"));
    writeFileSync(`${logFile()}.4`, "old\n");
    mkdirSync(join(`${logFile()}.5`, "blocker"), { recursive: true });

    await runLogged(Effect.andThen(Effect.logInfo("first"), Effect.logInfo("second")));

    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(
      new RegExp(`^hercule: cannot rotate ${logFile()}, so it grows past its size limit`),
    );
    const tail = readFileSync(logFile(), "utf8").slice(10 * 1024 * 1024);
    expect(tail).toContain("message=first");
    expect(tail).toContain("message=second");
  });
});
