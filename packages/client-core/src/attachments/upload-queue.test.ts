import { describe, expect, it } from "vitest";
import type { Attachment } from "@hercule/contract";
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

/** Lets every settled promise run its callbacks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createUploadQueue", () => {
  it("runs at most `concurrency` uploads at once, in the order they were added", async () => {
    const { calls, upload } = holdUploads();
    const queue = createUploadQueue({ upload, concurrency: 3 });
    const outcomes = ["a", "b", "c", "d"].map((name) => queue.add(name, buildFile(name)));

    expect(calls.map((call) => call.name)).toEqual(["a", "b", "c"]);
    calls[1]!.resolve(buildAttachment("b"));
    await flush();
    expect(calls.map((call) => call.name)).toEqual(["a", "b", "c", "d"]);
    expect(await outcomes[1]).toEqual({ status: "uploaded", attachment: buildAttachment("b") });
  });

  it("reports a failure with its reason and never tries again on its own", async () => {
    const { calls, upload } = holdUploads();
    const queue = createUploadQueue({ upload, concurrency: 3 });
    const outcome = queue.add("a", buildFile("a"));

    calls[0]!.reject(new Error("The controller is unreachable."));
    expect(await outcome).toEqual({ status: "failed", reason: "The controller is unreachable." });
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("cancels a waiting upload before it starts, and drops a running one's result", async () => {
    const { calls, upload } = holdUploads();
    const queue = createUploadQueue({ upload, concurrency: 1 });
    const running = queue.add("a", buildFile("a"));
    const waiting = queue.add("b", buildFile("b"));

    queue.cancel("b");
    queue.cancel("a");
    expect(await waiting).toEqual({ status: "cancelled" });
    expect(await running).toEqual({ status: "cancelled" });

    // The cancelled request keeps its slot until it ends, then the next one starts.
    const next = queue.add("c", buildFile("c"));
    expect(calls.map((call) => call.name)).toEqual(["a"]);
    calls[0]!.resolve(buildAttachment("a"));
    await flush();
    expect(calls.map((call) => call.name)).toEqual(["a", "c"]);
    calls[1]!.resolve(buildAttachment("c"));
    expect(await next).toMatchObject({ status: "uploaded" });
  });
});
