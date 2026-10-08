import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "@hercule/contract";
import type { ShelfItem } from "./shelf";
import { createUploadQueue } from "./upload-queue";

const buildFile = (name: string) => Object.assign(new Blob(["x"]), { name });

/** An upload whose calls a test settles by hand, in any order. */
const holdUploads = () => {
  const calls: Array<{
    readonly name: string;
    readonly resolve: (attachment: Attachment) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  const upload = (file: Blob & { readonly name: string }) =>
    new Promise<Attachment>((resolve, reject) => {
      calls.push({ name: file.name, resolve, reject });
    });
  return { calls, upload };
};

const buildAttachment = (name: string): Attachment => ({
  id: `id-${name}`,
  name,
  mimeType: "image/png",
  sizeBytes: 1,
});

/** A delete that records the ids it was asked for, and fails when `fails` is set. */
const recordDeletes = (fails = false) => {
  const deleted: string[] = [];
  const deleteAttachment = (id: string) => {
    deleted.push(id);
    return fails ? Promise.reject(new Error("offline")) : Promise.resolve();
  };
  return { deleted, deleteAttachment };
};

const buildItem = (key: string, status: ShelfItem["status"]): ShelfItem => ({
  key,
  name: key,
  sizeBytes: 1,
  file: buildFile(key),
  ...(status === "uploaded"
    ? { status, attachment: buildAttachment(key) }
    : status === "failed"
      ? { status, reason: "offline" }
      : { status }),
});

/** Lets every settled promise run its callbacks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createUploadQueue", () => {
  it("runs at most `concurrency` uploads at once, in the order they were added", async () => {
    const { calls, upload } = holdUploads();
    const queue = createUploadQueue({
      upload,
      deleteAttachment: recordDeletes().deleteAttachment,
      concurrency: 3,
    });
    const outcomes = ["a", "b", "c", "d"].map((name) => queue.add(name, buildFile(name)));

    expect(calls.map((call) => call.name)).toEqual(["a", "b", "c"]);
    calls[1]!.resolve(buildAttachment("b"));
    await flush();
    expect(calls.map((call) => call.name)).toEqual(["a", "b", "c", "d"]);
    expect(await outcomes[1]).toEqual({ status: "uploaded", attachment: buildAttachment("b") });
  });

  it("reports a failure with its reason and never tries again on its own", async () => {
    const { calls, upload } = holdUploads();
    const queue = createUploadQueue({
      upload,
      deleteAttachment: recordDeletes().deleteAttachment,
      concurrency: 3,
    });
    const outcome = queue.add("a", buildFile("a"));

    calls[0]!.reject(new Error("The controller is unreachable."));
    expect(await outcome).toEqual({ status: "failed", reason: "The controller is unreachable." });
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("cancels a discarded upload, and deletes what a running one uploads after all", async () => {
    const { calls, upload } = holdUploads();
    const { deleted, deleteAttachment } = recordDeletes();
    const queue = createUploadQueue({ upload, deleteAttachment, concurrency: 1 });
    const running = queue.add("a", buildFile("a"));
    const waiting = queue.add("b", buildFile("b"));

    queue.discard(buildItem("b", "uploading"));
    queue.discard(buildItem("a", "uploading"));
    expect(await waiting).toEqual({ status: "cancelled" });
    expect(await running).toEqual({ status: "cancelled" });

    // The cancelled request keeps its slot until it ends, then the next one starts.
    const next = queue.add("c", buildFile("c"));
    expect(calls.map((call) => call.name)).toEqual(["a"]);
    calls[0]!.resolve(buildAttachment("a"));
    await flush();
    expect(deleted).toEqual(["id-a"]);
    expect(calls.map((call) => call.name)).toEqual(["a", "c"]);
    calls[1]!.resolve(buildAttachment("c"));
    expect(await next).toMatchObject({ status: "uploaded" });
    expect(deleted).toEqual(["id-a"]);
  });

  it("deletes a discarded uploaded image, and has nothing to delete for a failed one", () => {
    const { upload } = holdUploads();
    const { deleted, deleteAttachment } = recordDeletes();
    const queue = createUploadQueue({ upload, deleteAttachment, concurrency: 3 });

    queue.discard(buildItem("a", "uploaded"));
    queue.discard(buildItem("b", "failed"));
    queue.discard(buildItem("c", "expired"));
    expect(deleted).toEqual(["id-a"]);
  });

  it("only logs a delete that fails", async () => {
    const { upload } = holdUploads();
    const { deleteAttachment } = recordDeletes(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = createUploadQueue({ upload, deleteAttachment, concurrency: 3 });

    queue.discard(buildItem("a", "uploaded"));
    await flush();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
