import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildServicePath,
  buildServiceUnit,
  locateServiceLogs,
  parseSystemdUnit,
  renderLaunchdPlist,
  renderSystemdUnit,
  type ServiceUnit,
} from "./unit";

const UNIT: ServiceUnit = {
  role: "serve",
  program: "/Users/ada/.local/bin/hercule",
  home: "/Users/ada/.hercule",
  path: "/Users/ada/.local/bin:/usr/bin:/bin",
  stderrLog: "/Users/ada/.hercule/logs/controller.stderr.log",
};

/** A unit whose every value holds a character that some format gives a meaning to. */
const AWKWARD: ServiceUnit = {
  role: "runner",
  program: '/opt/a & b/<x> "q" 100%/$HOME\\bin/hercule',
  home: "/home/ada/my %h $USER home",
  path: "/opt/a & b:/usr/bin",
  stderrLog: "/home/ada/my %h $USER home/logs/runner.stderr.log",
};

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "hercule-service-unit-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("locateServiceLogs", () => {
  it("names the controller's logs for serve and the runner's for runner", () => {
    expect(locateServiceLogs("/h", "serve")).toEqual({
      log: "/h/logs/controller.log",
      stderrLog: "/h/logs/controller.stderr.log",
    });
    expect(locateServiceLogs("/h", "runner")).toEqual({
      log: "/h/logs/runner.log",
      stderrLog: "/h/logs/runner.stderr.log",
    });
  });
});

describe("buildServicePath", () => {
  it("keeps the existing absolute folders in order, without duplicates", () => {
    const bin = join(scratch, "bin");
    const tools = join(scratch, "tools");
    mkdirSync(bin);
    mkdirSync(tools);
    const caller = [tools, "relative/bin", ".", join(scratch, "missing"), bin, tools, ""].join(":");
    expect(buildServicePath(caller)).toBe(`${tools}:${bin}`);
  });

  it("leaves out a PATH entry that is a file, not a folder", () => {
    const file = join(scratch, "file");
    writeFileSync(file, "");
    expect(buildServicePath(`${file}:${scratch}`)).toBe(scratch);
  });

  it("is empty when the caller has no PATH", () => {
    expect(buildServicePath(undefined)).toBe("");
  });
});

describe("buildServiceUnit", () => {
  it("sends stderr to the role's stderr log in the Home", () => {
    const unit = buildServiceUnit({
      role: "runner",
      program: "/opt/hercule/hercule",
      home: "/home/ada/.hercule",
      path: "/usr/bin",
    });
    expect(unit).toEqual({
      role: "runner",
      program: "/opt/hercule/hercule",
      home: "/home/ada/.hercule",
      path: "/usr/bin",
      stderrLog: "/home/ada/.hercule/logs/runner.stderr.log",
    });
  });
});

describe("renderLaunchdPlist", () => {
  it("renders the LaunchAgent install.sh wrote, with stdout discarded and stderr to its own log", () => {
    expect(renderLaunchdPlist(UNIT)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>sh.hercule.service</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/Users/ada/.local/bin/hercule</string>
\t\t<string>serve</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/Users/ada/.local/bin:/usr/bin:/bin</string>
\t\t<key>HERCULE_HOME</key>
\t\t<string>/Users/ada/.hercule</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>/dev/null</string>
\t<key>StandardErrorPath</key>
\t<string>/Users/ada/.hercule/logs/controller.stderr.log</string>
</dict>
</plist>
`);
  });

  it("escapes the characters XML gives a meaning to", () => {
    const text = renderLaunchdPlist(AWKWARD);
    expect(text).toContain('<string>/opt/a &amp; b/&lt;x&gt; "q" 100%/$HOME\\bin/hercule</string>');
    expect(text).toContain("<string>runner</string>");
    expect(text).toContain("<string>/opt/a &amp; b:/usr/bin</string>");
  });
});

describe("renderSystemdUnit", () => {
  it("renders a user unit that restarts the process and appends stderr to its own log", () => {
    expect(renderSystemdUnit(UNIT)).toBe(`[Unit]
Description=Hercule (hercule serve)

[Service]
ExecStart="/Users/ada/.local/bin/hercule" serve
Environment="PATH=/Users/ada/.local/bin:/usr/bin:/bin"
Environment="HERCULE_HOME=/Users/ada/.hercule"
UnsetEnvironment=HERCULE_DATA_DIR HERCULE_BIND_HOST HERCULE_BIND_PORT HERCULE_LOG_LEVEL
Restart=always
RestartSec=10
StandardOutput=null
StandardError=append:/Users/ada/.hercule/logs/controller.stderr.log

[Install]
WantedBy=default.target
`);
  });

  it("escapes specifiers everywhere, $ only in the command, and quotes and backslashes inside quotes", () => {
    const text = renderSystemdUnit(AWKWARD);
    expect(text).toContain('ExecStart="/opt/a & b/<x> \\"q\\" 100%%/$$HOME\\\\bin/hercule" runner');
    // systemd expands no variables in Environment=, so `$` stays as it is.
    expect(text).toContain('Environment="HERCULE_HOME=/home/ada/my %%h $USER home"');
    expect(text).toContain(
      "StandardError=append:/home/ada/my %%h $USER home/logs/runner.stderr.log",
    );
  });
});

describe("parseSystemdUnit", () => {
  it("reads back the role and the Home a rendered unit runs, whatever they hold", () => {
    expect(parseSystemdUnit(renderSystemdUnit(UNIT))).toEqual({
      role: "serve",
      home: "/Users/ada/.hercule",
    });
    expect(parseSystemdUnit(renderSystemdUnit(AWKWARD))).toEqual({
      role: "runner",
      home: "/home/ada/my %h $USER home",
    });
  });

  it("returns null for what a unit edited by hand does not name", () => {
    expect(parseSystemdUnit("[Service]\nExecStart=/usr/bin/true\n")).toEqual({
      role: null,
      home: null,
    });
  });
});
