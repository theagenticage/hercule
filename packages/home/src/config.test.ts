import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { buildEnvName, loadBootstrapConfig } from "./config";
import { locateConfigFile } from "./paths";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hercule-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("buildEnvName", () => {
  it("uppercases, turns dots into underscores and prefixes HERCULE_", () => {
    expect(buildEnvName("bind.port")).toBe("HERCULE_BIND_PORT");
    expect(buildEnvName("data.dir")).toBe("HERCULE_DATA_DIR");
    expect(buildEnvName("log.level")).toBe("HERCULE_LOG_LEVEL");
  });
});

describe("loadBootstrapConfig", () => {
  it("uses the defaults when the home has no config.toml, and writes none", async () => {
    const config = await Effect.runPromise(loadBootstrapConfig({ home, overrides: [], env: {} }));

    expect(config.logLevel).toBe("info");
    expect(config.dataDir).toBe("data");
    expect(existsSync(locateConfigFile(home))).toBe(false);
  });

  it("reads config.toml, with the environment and then -c on top", async () => {
    writeFileSync(locateConfigFile(home), 'log.level = "debug"\ndata.dir = "elsewhere"\n');

    const config = await Effect.runPromise(
      loadBootstrapConfig({
        home,
        overrides: [["log.level", "warn"]],
        env: { HERCULE_DATA_DIR: "from-env" },
      }),
    );

    expect(config.logLevel).toBe("warn");
    expect(config.dataDir).toBe("from-env");
  });

  it("reads the OTLP endpoint from Hercule's sources first, then from OTEL_EXPORTER_OTLP_ENDPOINT", async () => {
    const readEndpoint = (
      env: Record<string, string>,
      overrides: ReadonlyArray<readonly [string, string]> = [],
    ) =>
      Effect.runPromise(
        Effect.map(loadBootstrapConfig({ home, overrides, env }), (config) => config.otlpEndpoint),
      );
    const standard = "http://standard:4318";

    expect(await readEndpoint({})).toBeUndefined();
    expect(await readEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "" })).toBeUndefined();
    expect(await readEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: standard })).toBe(standard);

    writeFileSync(locateConfigFile(home), 'telemetry.otlp_endpoint = "http://file:4318"\n');
    expect(await readEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: standard })).toBe("http://file:4318");
    expect(
      await readEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: standard,
        HERCULE_TELEMETRY_OTLP_ENDPOINT: "https://env:4318/otlp",
      }),
    ).toBe("https://env:4318/otlp");
    expect(
      await readEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: standard }, [
        ["telemetry.otlp_endpoint", "http://flag:4318"],
      ]),
    ).toBe("http://flag:4318");

    const refused = await Effect.runPromise(
      Effect.flip(
        loadBootstrapConfig({
          home,
          overrides: [],
          env: { HERCULE_TELEMETRY_OTLP_ENDPOINT: "collector:4318?x=1" },
        }),
      ),
    );
    expect(refused.message).toContain("HERCULE_TELEMETRY_OTLP_ENDPOINT");
    expect(refused.message).toContain("http or https URL");
  });
});
