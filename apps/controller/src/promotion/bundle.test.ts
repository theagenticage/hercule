import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { readTransferLayout, streamTransfer, TRANSFER_FORMAT_VERSION } from "./bundle";

const header = {
  formatVersion: TRANSFER_FORMAT_VERSION,
  controllerId: "0198e4b0-0000-7000-8000-000000000001",
  schemaVersion: 58,
  salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  databaseByteLength: 4,
  attachments: [{ id: "0198e4b0-0000-7000-8000-000000000002", byteLength: 3 }],
} as const;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hercule-bundle-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Streams a transfer of a 4-byte database and one 3-byte attachment into a file, and returns its path. */
const writeTransfer = async (): Promise<string> => {
  const database = join(dir, "database");
  const attachment = join(dir, "attachment");
  writeFileSync(database, new Uint8Array([1, 2, 3, 4]));
  writeFileSync(attachment, new Uint8Array([9, 8, 7]));
  const chunks = await Effect.runPromise(
    Stream.runCollect(streamTransfer(header, database, [attachment])),
  );
  const path = join(dir, "transfer");
  writeFileSync(path, Buffer.concat([...chunks]));
  return path;
};

describe("the promotion transfer format", () => {
  it("reads back the header and where the database and each attachment sit", async () => {
    const path = await writeTransfer();
    const layout = await Effect.runPromise(readTransferLayout(path));
    expect(layout.header).toEqual(header);
    const bytes = readFileSync(path);
    expect([...bytes.subarray(layout.database.start, layout.database.end)]).toEqual([1, 2, 3, 4]);
    expect(layout.attachments).toHaveLength(1);
    const [attachment] = layout.attachments;
    expect(attachment?.id).toBe(header.attachments[0].id);
    expect([...bytes.subarray(attachment!.start, attachment!.end)]).toEqual([9, 8, 7]);
  });

  it("refuses a file that is not a promotion transfer", async () => {
    const path = join(dir, "error.json");
    writeFileSync(path, '{"error":{}}');
    const exit = await Effect.runPromiseExit(readTransferLayout(path));
    expect(JSON.stringify(exit)).toContain("is not a promotion transfer");
  });

  it("refuses a transfer that broke off", async () => {
    const path = await writeTransfer();
    truncateSync(path, readFileSync(path).byteLength - 2);
    const exit = await Effect.runPromiseExit(readTransferLayout(path));
    expect(JSON.stringify(exit)).toContain("broke off");
  });

  it("refuses a transfer with bytes its header does not account for", async () => {
    const path = await writeTransfer();
    writeFileSync(path, new Uint8Array([0]), { flag: "a" });
    const exit = await Effect.runPromiseExit(readTransferLayout(path));
    expect(JSON.stringify(exit)).toContain("more bytes than its header accounts for");
  });

  it("refuses an attachment id that is not an id, so no file name escapes the attachments directory", async () => {
    const forged = JSON.stringify({
      ...header,
      databaseByteLength: 0,
      attachments: [{ id: "../../x", byteLength: 0 }],
    });
    const length = Buffer.alloc(4);
    length.writeUInt32BE(Buffer.byteLength(forged));
    const path = join(dir, "transfer");
    writeFileSync(path, Buffer.concat([Buffer.from("HCL1"), length, Buffer.from(forged)]));
    const exit = await Effect.runPromiseExit(readTransferLayout(path));
    expect(JSON.stringify(exit)).toContain("header is not one this build can read");
  });
});
