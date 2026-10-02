/**
 * The service unit: what the OS supervisor runs to keep Hercule up, and the
 * text of the two unit files that describe it (spec 15 section 4).
 *
 * The renderers and the parser are pure. `buildServicePath` checks which
 * folders on the caller's PATH exist.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  BOOTSTRAP_KEYS,
  buildEnvName,
  locateProcessLogFile,
  locateStderrLogFile,
  type DaemonRole,
} from "@hercule/home";

/** The role a unit runs: `hercule serve` on the controller machine, `hercule runner` elsewhere. */
export type ServiceRole = "serve" | "runner";

/**
 * One service unit, before it is written in either supervisor's format.
 *
 * - `program` is the absolute path of the compiled `hercule` binary.
 * - `home` is the absolute Hercule Home, passed as `HERCULE_HOME`.
 * - `path` is the `PATH` the process runs with.
 * - `stderrLog` catches what the process writes to stderr before its own
 *   logger starts, and the trace of a crash.
 */
export interface ServiceUnit {
  readonly role: ServiceRole;
  readonly program: string;
  readonly home: string;
  readonly path: string;
  readonly stderrLog: string;
}

/**
 * The launchd label. An older edge `install.sh` wrote its LaunchAgent under
 * the same label, so installing the service replaces that LaunchAgent instead
 * of adding a second one.
 */
export const LAUNCHD_LABEL = "sh.hercule.service";

/** The name of the systemd user unit. */
export const SYSTEMD_UNIT_NAME = "hercule.service";

/**
 * Returns the two log files of a role's process in a Hercule Home: the
 * process's own rotated log, and the file the supervisor sends stderr to.
 */
export const locateServiceLogs = (
  home: string,
  role: ServiceRole,
): { readonly log: string; readonly stderrLog: string } => {
  const daemon: DaemonRole = role === "serve" ? "controller" : "runner";
  return {
    log: locateProcessLogFile(home, daemon),
    stderrLog: locateStderrLogFile(home, daemon),
  };
};

/** Checks whether a path names an existing directory. */
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Returns the PATH the service runs with: the folders on the caller's PATH,
 * in order and without duplicates.
 *
 * A supervisor starts a process with only the system folders on its PATH, so
 * the caller's PATH is passed on, and the controller and the runner find the
 * same harnesses (claude, codex, pi), git and gh as the user does. Relative
 * entries are dropped, and so are folders that do not exist: the runner starts
 * programs inside workspace checkouts, where `.` on the PATH would let a
 * repository supply its own `git`.
 *
 * The binary's own folder is not added. Hercule finds itself through
 * `process.execPath`, never by name, and the binary may sit in a checkout,
 * where the files beside it would shadow the user's `git` or `gh`.
 */
export const buildServicePath = (callerPath: string | undefined): string => {
  const folders: Array<string> = [];
  for (const folder of (callerPath ?? "").split(":")) {
    if (isAbsolute(folder) && !folders.includes(folder) && isDirectory(folder)) {
      folders.push(folder);
    }
  }
  return folders.join(":");
};

/**
 * Builds the unit that runs `program` in `role` for the Hercule Home `home`,
 * with `path` as its PATH, usually from `buildServicePath`.
 */
export const buildServiceUnit = (options: {
  readonly role: ServiceRole;
  readonly program: string;
  readonly home: string;
  readonly path: string;
}): ServiceUnit => ({
  ...options,
  stderrLog: locateServiceLogs(options.home, options.role).stderrLog,
});

/** Escapes the characters XML gives a meaning to, so any text can go in a plist string. */
const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Renders a unit as a launchd property list. launchd starts the process at
 * load and again whenever it exits, discards its stdout, and appends its
 * stderr to `stderrLog`.
 *
 * stdout is discarded because the controller prints its one-time setup URL
 * there, and the token in that URL must not land in a file.
 */
export const renderLaunchdPlist = (unit: ServiceUnit): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${LAUNCHD_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    `\t\t<string>${escapeXml(unit.program)}</string>`,
    `\t\t<string>${unit.role}</string>`,
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    "\t\t<key>PATH</key>",
    `\t\t<string>${escapeXml(unit.path)}</string>`,
    "\t\t<key>HERCULE_HOME</key>",
    `\t\t<string>${escapeXml(unit.home)}</string>`,
    "\t</dict>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<true/>",
    "\t<key>StandardOutPath</key>",
    "\t<string>/dev/null</string>",
    "\t<key>StandardErrorPath</key>",
    `\t<string>${escapeXml(unit.stderrLog)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

/**
 * Escapes text for a systemd setting that expands specifiers: `%` starts a
 * specifier such as `%h`, so a literal `%` is written `%%`.
 */
const escapeSpecifiers = (text: string): string => text.replaceAll("%", "%%");

/**
 * Quotes a value in double quotes, the way systemd unquotes it: a backslash
 * and a double quote inside the quotes are escaped with a backslash.
 */
const quoteSystemdValue = (text: string): string =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Escapes one word of `ExecStart=`. Besides specifiers, systemd expands
 * `$NAME` and `${NAME}` in a command line, so a literal `$` is written `$$`.
 * `Environment=` expands no variables, so this escape applies only here.
 */
const quoteCommandWord = (word: string): string =>
  quoteSystemdValue(escapeSpecifiers(word).replaceAll("$", () => "$$"));

/** Quotes one `Environment=` assignment, `NAME=value`, as a whole. */
const quoteAssignment = (name: string, value: string): string =>
  quoteSystemdValue(escapeSpecifiers(`${name}=${value}`));

/**
 * Renders a unit as a systemd user unit. systemd restarts the process ten
 * seconds after it exits, discards its stdout, and appends its stderr to
 * `stderrLog`. `WantedBy=default.target` starts it when the user's service
 * manager starts, which with lingering on is at boot.
 *
 * `UnsetEnvironment=` removes every `HERCULE_*` bootstrap variable the user's
 * service manager may hold, for example from `systemctl --user
 * set-environment`, so the process reads its settings from `config.toml`
 * alone, like the unit promises.
 */
export const renderSystemdUnit = (unit: ServiceUnit): string =>
  [
    "[Unit]",
    `Description=Hercule (hercule ${unit.role})`,
    "",
    "[Service]",
    `ExecStart=${quoteCommandWord(unit.program)} ${unit.role}`,
    `Environment=${quoteAssignment("PATH", unit.path)}`,
    `Environment=${quoteAssignment("HERCULE_HOME", unit.home)}`,
    `UnsetEnvironment=${BOOTSTRAP_KEYS.map(buildEnvName).join(" ")}`,
    "Restart=always",
    "RestartSec=10",
    "StandardOutput=null",
    `StandardError=append:${escapeSpecifiers(unit.stderrLog)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

/**
 * Splits a systemd value into its words, removing the double quotes and the
 * backslash escapes `quoteSystemdValue` adds. Returns `undefined` when a quote
 * is not closed.
 */
const splitSystemdWords = (text: string): ReadonlyArray<string> | undefined => {
  const words: Array<string> = [];
  let at = 0;
  while (at < text.length) {
    if (text[at] === " ") {
      at += 1;
      continue;
    }
    let word = "";
    if (text[at] === '"') {
      at += 1;
      while (at < text.length && text[at] !== '"') {
        if (text[at] === "\\" && at + 1 < text.length) at += 1;
        word += text[at];
        at += 1;
      }
      if (at >= text.length) return undefined;
      at += 1;
    } else {
      while (at < text.length && text[at] !== " ") {
        word += text[at];
        at += 1;
      }
    }
    words.push(word);
  }
  return words;
};

/**
 * Reads the role and the Hercule Home from the text of a systemd unit this
 * package wrote. Either is `null` when the unit does not name it, for example
 * because someone edited the file by hand.
 */
export const parseSystemdUnit = (
  text: string,
): { readonly role: ServiceRole | null; readonly home: string | null } => {
  let role: ServiceRole | null = null;
  let home: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("ExecStart=")) {
      const word = splitSystemdWords(line.slice("ExecStart=".length))?.[1];
      role = word === "serve" || word === "runner" ? word : null;
    } else if (line.startsWith("Environment=")) {
      for (const assignment of splitSystemdWords(line.slice("Environment=".length)) ?? []) {
        const plain = assignment.replaceAll("%%", "%");
        if (plain.startsWith("HERCULE_HOME=")) home = plain.slice("HERCULE_HOME=".length);
      }
    }
  }
  return { role, home };
};
