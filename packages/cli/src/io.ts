/**
 * Everything the CLI touches outside itself, in one record.
 *
 * The CLI is a pure function of `argv` plus this: tests hand it a stub `fetch`,
 * a captured stdout and a canned stdin, and never touch the real process. It is
 * a test seam and nothing more - there is exactly one production `Io`.
 */
import { createInterface } from "node:readline";
import { hostname } from "node:os";
import type { FetchLike } from "@hercule/client-core";
import type { Env } from "./credentials";

export interface Io {
  readonly env: Env;
  /** Writes one line to stdout. */
  readonly out: (line: string) => void;
  /** Writes one line to stderr. */
  readonly err: (line: string) => void;
  /** All of stdin, as text. Read at most once per invocation. */
  readonly stdin: () => Promise<string>;
  /** True when stdin is a terminal, so a password may be prompted for. */
  readonly isTty: () => boolean;
  /** Reads a password with echo off. The one prompt the CLI is allowed. */
  readonly prompt: (label: string) => Promise<string>;
  /** The machine name, the default `hercule login --name`. */
  readonly hostname: () => string;
  /** The transport `client-core` sends through; the one seam a test replaces. */
  readonly fetch: FetchLike;
}

const readAllStdin = async (): Promise<string> => {
  const chunks: Array<Uint8Array> = [];
  for await (const chunk of process.stdin) chunks.push(new Uint8Array(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * An echo-off password prompt: the one exception to "the CLI never prompts".
 *
 * `readline` writes the prompt itself and then every echoed character; muting
 * the output stream after the prompt has been written is what turns the echo
 * off without hiding the label.
 */
const promptPassword = (label: string): Promise<string> =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const output = rl as unknown as { output: NodeJS.WritableStream & { write: unknown } };
    rl.question(label, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
    const stream = output.output;
    const write = stream.write.bind(stream);
    stream.write = (chunk: string) => (chunk === label ? write(chunk) : true);
  });

export const processIo: Io = {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  stdin: readAllStdin,
  isTty: () => process.stdin.isTTY === true,
  prompt: promptPassword,
  hostname,
  fetch: (url, init) => globalThis.fetch(url, init),
};
