/**
 * Everything outside the CLI that the CLI uses, in one record.
 *
 * The CLI depends only on `argv` and this record. Tests pass a stub `fetch`, a
 * captured stdout and a fixed stdin, and never touch the real process. It
 * exists only for tests: there is exactly one production `Io`.
 */
import { createInterface } from "node:readline";
import { hostname } from "node:os";
import type { FetchLike } from "@hercule/client-core";
import type { Env } from "@hercule/home";
import { UsageError } from "./exit";

export interface Io {
  readonly env: Env;
  /** Writes one line to stdout. */
  readonly out: (line: string) => void;
  /** Writes one line to stderr. */
  readonly err: (line: string) => void;
  /** Reads all of stdin as text. Called at most once per invocation. */
  readonly stdin: () => Promise<string>;
  /** Returns true when stdin is a terminal, so the CLI may prompt for a password. */
  readonly isTty: () => boolean;
  /** Reads a password with echo off. This is the only prompt the CLI may show. */
  readonly prompt: (label: string) => Promise<string>;
  /** Returns the machine's hostname, the default for `hercule login --name`. */
  readonly hostname: () => string;
  /** The `fetch` that `client-core` sends requests with; tests replace it with a stub. */
  readonly fetch: FetchLike;
}

/**
 * Decodes the bytes read from stdin as UTF-8. Throws a UsageError if they are
 * not valid UTF-8. Invalid bytes are not replaced with U+FFFD, because that
 * would silently change what the caller sent. A leading byte order mark is
 * kept, because it is part of what was sent.
 */
export const decodeStdin = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new UsageError(
      "stdin is not valid UTF-8 text. Convert it to UTF-8, for example with iconv, and pipe it in again.",
    );
  }
};

const readAllStdin = async (): Promise<string> => {
  const chunks: Array<Uint8Array> = [];
  for await (const chunk of process.stdin) chunks.push(new Uint8Array(chunk as Uint8Array));
  return decodeStdin(Buffer.concat(chunks));
};

/**
 * Prompts for a password with echo off. This is the only exception to "the
 * CLI never prompts".
 *
 * `readline` writes the prompt label and then echoes every typed character.
 * Muting the output stream after the label is written turns off the echo
 * without hiding the label.
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
