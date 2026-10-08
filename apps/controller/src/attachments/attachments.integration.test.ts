/**
 * Tests images in prompts over the real listener: the upload and the read,
 * the route a runner fetches an image from, the check that a turn's images
 * can go to its runner and model, the edit of a queued input's images, and
 * the sweep of images nobody claimed.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { Attachment, Input, RunnerDetail, Session } from "@hercule/contract";
import type { ImageInputCapability, SessionInput, SessionStart } from "@hercule/protocol";
import { get, post, send } from "../http/testing";
import {
  at,
  listFrames,
  listInputs,
  readSession,
  reportEvent,
  reportTurnCompleted,
  spawnSession,
  spawnSessionOrFail,
  spawnThreadWithGrants,
  waitForFrames,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  WAIT_DEADLINE_MS,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";
import { EXPIRED_ATTACHMENT_MESSAGE } from "./claims";

/** A fleet, plus the time to wait for what the controller does. */
const TEST_TIMEOUT_MS = WAIT_DEADLINE_MS + 10_000;

/** The eight bytes every PNG file starts with, then a few more. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const upload = (
  arranged: Arranged,
  name: string,
  bytes: Uint8Array = PNG,
  token: string = arranged.token,
): Promise<Response> =>
  fetch(`${arranged.harness.base}/api/v1/attachments?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
    body: bytes,
  });

const uploadOrFail = async (arranged: Arranged, name: string): Promise<Attachment> => {
  const response = await upload(arranged, name);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Attachment;
};

/** Fetches an image the way a runner does, with `credential` as its bearer, if any. */
const fetchAsRunner = (arranged: Arranged, id: string, credential?: string): Promise<Response> =>
  fetch(`${arranged.harness.base}/api/v1/runners/attachments/${id}`, {
    headers: credential === undefined ? {} : { authorization: `Bearer ${credential}` },
  });

/** Spawns a session with the image as its prompt, answers its start, and waits until it is busy. */
const startSessionWithAttachment = async (
  arranged: Arranged,
  image: Attachment,
): Promise<Session> => {
  const session = await spawnSessionOrFail(arranged, { prompt: "", attachments: [image.id] });
  await waitForStartFrames(arranged, session.id, 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
  });
  return waitForSession(arranged, session.id, (one) => one.status === "busy");
};

/**
 * Sets what every model the runner reported takes as image input, as if the
 * runner had probed again: `null` for no images.
 */
const setImageInputOnEveryModel = (
  arranged: Arranged,
  imageInput: ImageInputCapability | null,
): Promise<unknown> =>
  Effect.runPromise(
    arranged.harness.sql`
      UPDATE capability_snapshots
      SET models = (
        SELECT json_group_array(json_set(model.value, '$.imageInput', json(${JSON.stringify(imageInput)})))
        FROM json_each(capability_snapshots.models) AS model
      )
    `,
  );

/** Waits until the controller has recorded the capabilities the runner listed at its last hello. */
const waitForCapabilities = (
  arranged: Arranged,
  capabilities: ReadonlyArray<string>,
): Promise<true> =>
  waitUntil("recorded the runner's capabilities", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/runners/${arranged.runnerId}`,
      arranged.token,
    );
    const runner = (await response.json()) as RunnerDetail;
    return JSON.stringify(runner.negotiatedCapabilities) === JSON.stringify(capabilities)
      ? true
      : undefined;
  });

/** Checks the headers that keep a browser from treating an image's bytes as anything else. */
const expectAttachmentHeaders = (response: Response): void => {
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
};

/** The quota of unsent images per uploader, as the controller holds it. */
const MAX_UNCLAIMED_BYTES = 200 * 1024 * 1024;

/** Inserts a row for an upload by the user that no input references, with no file behind it. */
const insertUploadRow = (
  arranged: Arranged,
  sizeBytes: number,
  createdAt: string,
): Promise<unknown> =>
  Effect.runPromise(
    arranged.harness.sql`
      INSERT INTO attachments (id, name, mime_type, size_bytes, sha256, created_at, actor)
      VALUES (randomblob(16), 'big.png', 'image/png', ${sizeBytes}, ${"0".repeat(64)},
              ${createdAt}, 'user')
    `,
  );

/** Returns the names in the directory, sorted, or none when it does not exist. */
const listFiles = (directory: string): ReadonlyArray<string> =>
  existsSync(directory) ? readdirSync(directory).sort() : [];

/** Returns a PNG of `sizeBytes` bytes: the PNG signature, then zeros. */
const buildPng = (sizeBytes: number): Uint8Array => {
  const bytes = new Uint8Array(sizeBytes);
  bytes.set(PNG);
  return bytes;
};

const deleteAttachment = (
  arranged: Arranged,
  id: string,
  token = arranged.token,
): Promise<Response> =>
  send("DELETE", arranged.harness.base, `/api/v1/attachments/${id}`, { token });

const MEBIBYTE = 1024 * 1024;

/** An id in the right format that no upload has. */
const NO_SUCH_ATTACHMENT = "0199e0e7-0000-7000-8000-0000000000aa";

const MODEL_REFUSAL =
  "`fast` does not accept images. Remove the image or pick a model that accepts them.";

describe("uploading and reading an image", () => {
  it(
    "stores the image with the type read from its bytes, and returns the bytes with that type",
    async () => {
      await withAgentFleet(async (arranged) => {
        const image = await uploadOrFail(arranged, "screen.png");
        expect(image).toEqual({
          id: image.id,
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: PNG.byteLength,
        });

        const read = await get(
          arranged.harness.base,
          `/api/v1/attachments/${image.id}/content`,
          arranged.token,
        );
        expect(read.status).toBe(200);
        expectAttachmentHeaders(read);
        expect(read.headers.get("content-length")).toBe(String(PNG.byteLength));
        expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "hides an image from anyone but its uploader until an input claims it",
    async () => {
      await withAgentFleet(async (arranged) => {
        const agent = await spawnThreadWithGrants(arranged, "uploader", [
          "session.steer",
          "session.read",
        ]);
        const mine = await uploadOrFail(arranged, "mine.png");
        const theirs = await upload(arranged, "theirs.png", PNG, agent.token);
        expect(theirs.status, await theirs.clone().text()).toBe(201);
        const { id: theirsId } = (await theirs.json()) as Attachment;

        const read = await get(
          arranged.harness.base,
          `/api/v1/attachments/${mine.id}/content`,
          agent.token,
        );
        expect(read.status).toBe(404);
        const spawned = await spawnSession(arranged, { prompt: "look", attachments: [theirsId] });
        expect(spawned.status).toBe(400);
        expect(await spawned.json()).toMatchObject({
          error: {
            details: {
              issues: [{ path: ["attachments", "0"], message: EXPIRED_ATTACHMENT_MESSAGE }],
            },
          },
        });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a file name with a control character in it",
    async () => {
      await withAgentFleet(async (arranged) => {
        const response = await upload(arranged, "screen\n.png");
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses an upload past the uploader's 200 MiB of unsent images, says when room frees up, and keeps no file",
    async () => {
      await withAgentFleet(async (arranged) => {
        const hours = (count: number): string =>
          new Date(Date.now() - count * 60 * 60 * 1000).toISOString();
        // A full quota uploaded 21 hours ago frees up in 3 hours. An upload
        // past the lifetime no longer counts, even before the sweep runs.
        await insertUploadRow(arranged, MAX_UNCLAIMED_BYTES, hours(21));
        await insertUploadRow(arranged, MAX_UNCLAIMED_BYTES, hours(25));
        const directory = join(arranged.harness.home, "data", "attachments");
        const filesBefore = listFiles(directory);

        const refused = await upload(arranged, "one-more.png");
        expect(refused.status).toBe(400);
        expect(await refused.json()).toMatchObject({
          error: {
            code: "validation",
            details: {
              issues: [
                {
                  message:
                    '"one-more.png" would take your images that are not sent yet past 200 MB. ' +
                    "Remove some images, or try again in about 3 hours.",
                },
              ],
            },
          },
        });
        expect(listFiles(directory)).toEqual(filesBefore);
        const agent = await spawnThreadWithGrants(arranged, "uploader", ["session.steer"]);
        expect((await upload(arranged, "theirs.png", PNG, agent.token)).status).toBe(201);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lets exactly one of several uploads at once take the last room under the quota",
    async () => {
      await withAgentFleet(async (arranged) => {
        await insertUploadRow(
          arranged,
          MAX_UNCLAIMED_BYTES - PNG.byteLength,
          new Date().toISOString(),
        );

        const responses = await Promise.all(
          Array.from({ length: 8 }, (_, index) => upload(arranged, `${String(index)}.png`)),
        );
        expect(responses.map((response) => response.status).sort()).toEqual([
          201, 400, 400, 400, 400, 400, 400, 400,
        ]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses bytes that are not an image",
    async () => {
      await withAgentFleet(async (arranged) => {
        const response = await upload(arranged, "notes.txt", new TextEncoder().encode("hello"));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: {
            code: "validation",
            details: { issues: [{ message: '"notes.txt" is not a PNG, JPEG, GIF or WebP image' }] },
          },
        });
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("an input with images", () => {
  it(
    "sends the image's reference on the start frame, titles the session after it, and lists it on the input",
    async () => {
      await withAgentFleet(async (arranged) => {
        const image = await uploadOrFail(arranged, "screen.png");
        const session = await spawnSessionOrFail(arranged, {
          prompt: "",
          attachments: [image.id],
        });

        expect(session.title).toBe("screen.png");
        const [start] = await waitForStartFrames(arranged, session.id, 1);
        expect(start!.input.attachments).toEqual([
          { ...image, sha256: createHash("sha256").update(PNG).digest("hex") },
        ]);
        const [input] = await listInputs(arranged, session.id);
        expect(input?.attachments).toEqual([image]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the images in the order they were attached",
    async () => {
      await withAgentFleet(async (arranged) => {
        const first = await uploadOrFail(arranged, "a.png");
        const second = await uploadOrFail(arranged, "b.png");
        const session = await spawnSessionOrFail(arranged, {
          prompt: "compare",
          attachments: [second.id, first.id],
        });

        const [start] = await waitForStartFrames(arranged, session.id, 1);
        expect(start!.input.attachments?.map((image) => image.id)).toEqual([second.id, first.id]);
        const [input] = await listInputs(arranged, session.id);
        expect(input?.attachments).toEqual([second, first]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sends no `attachments` on a frame for an input without images",
    async () => {
      await withAgentFleet(async (arranged) => {
        const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
        const [start] = await waitForStartFrames(arranged, session.id, 1);
        expect(start!.input).not.toHaveProperty("attachments");
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses an image id that does not exist, at its place in the list",
    async () => {
      await withAgentFleet(async (arranged) => {
        const image = await uploadOrFail(arranged, "screen.png");
        const response = await spawnSession(arranged, {
          prompt: "look",
          attachments: [image.id, NO_SUCH_ATTACHMENT],
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: {
            details: {
              issues: [{ path: ["attachments", "1"], message: EXPIRED_ATTACHMENT_MESSAGE }],
            },
          },
        });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses an upload older than a day, even before the sweep deletes it",
    async () => {
      await withAgentFleet(async (arranged) => {
        const image = await uploadOrFail(arranged, "old.png");
        const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        await Effect.runPromise(
          arranged.harness.sql`UPDATE attachments SET created_at = ${dayAgo}`,
        );
        const response = await spawnSession(arranged, { prompt: "", attachments: [image.id] });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: {
            details: {
              issues: [{ path: ["attachments", "0"], message: EXPIRED_ATTACHMENT_MESSAGE }],
            },
          },
        });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts a session without images on a runner on an older build, exactly as before",
    async () => {
      await withAgentFleet(async (arranged) => {
        const older = await arranged.reconnect({ capabilities: [] });
        older.send({ _tag: "sessionsReport", sessions: [] });
        await waitForCapabilities(arranged, []);
        const session = await spawnSessionOrFail(arranged, { prompt: "hello" });

        const start = await waitUntil("sent the start frame", () =>
          older.frames.find(
            (frame): frame is SessionStart =>
              frame._tag === "sessionStart" && frame.sessionId === session.id,
          ),
        );
        expect(start.input).not.toHaveProperty("attachments");
        expect(start.input.text).toBe("hello");
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses images for a runner on an older build, and stores nothing",
    async () => {
      await withAgentFleet(async (arranged) => {
        await arranged.reconnect({ capabilities: [] });
        await waitForCapabilities(arranged, []);
        const image = await uploadOrFail(arranged, "screen.png");
        const response = await spawnSession(arranged, { prompt: "look", attachments: [image.id] });

        expect(response.status).toBe(400);
        const body = (await response.json()) as {
          error: { details: { issues: ReadonlyArray<{ path: unknown; message: string }> } };
        };
        expect(body.error.details.issues).toHaveLength(1);
        expect(body.error.details.issues[0]?.path).toEqual(["attachments"]);
        expect(body.error.details.issues[0]?.message).toContain("runs an older Hercule");
        const sessions = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
        expect(((await sessions.json()) as { items: ReadonlyArray<Session> }).items).toEqual([]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a queued input's images when an edit leaves `attachments` out, and refuses an edit that empties it",
    async () => {
      await withAgentFleet(async (arranged) => {
        const session = await startSessionWithAttachment(
          arranged,
          await uploadOrFail(arranged, "a.png"),
        );
        const image = await uploadOrFail(arranged, "b.png");
        const queued = await post(
          arranged.harness.base,
          `/api/v1/sessions/${session.id}/input`,
          { text: "and this", attachments: [image.id] },
          arranged.token,
        );
        expect(queued.status, await queued.clone().text()).toBe(200);
        const { inputId } = (await queued.json()) as { inputId: string };
        const path = `/api/v1/sessions/${session.id}/inputs/${inputId}`;

        const kept = await send("PATCH", arranged.harness.base, path, {
          body: { text: "" },
          token: arranged.token,
        });
        expect(kept.status, await kept.clone().text()).toBe(200);
        expect(await kept.json()).toMatchObject({ text: "", attachments: [image] });

        const emptied = await send("PATCH", arranged.harness.base, path, {
          body: { text: "", attachments: [] },
          token: arranged.token,
        });
        expect(emptied.status).toBe(400);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lets a user's edit keep the images a session uploaded to its input, or replace them",
    async () => {
      await withAgentFleet(async (arranged) => {
        const agent = await spawnThreadWithGrants(arranged, "uploader", [
          "session.steer",
          "session.read",
        ]);
        const theirs = await upload(arranged, "theirs.png", PNG, agent.token);
        expect(theirs.status, await theirs.clone().text()).toBe(201);
        const theirImage = (await theirs.json()) as Attachment;
        const queued = await post(
          arranged.harness.base,
          `/api/v1/sessions/${agent.session.id}/input`,
          { text: "look", attachments: [theirImage.id] },
          agent.token,
        );
        expect(queued.status, await queued.clone().text()).toBe(200);
        const { inputId } = (await queued.json()) as { inputId: string };
        const path = `/api/v1/sessions/${agent.session.id}/inputs/${inputId}`;

        const mine = await uploadOrFail(arranged, "mine.png");
        const kept = await send("PATCH", arranged.harness.base, path, {
          body: { text: "look at both", attachments: [theirImage.id, mine.id] },
          token: arranged.token,
        });
        expect(kept.status, await kept.clone().text()).toBe(200);
        expect(await kept.json()).toMatchObject({ attachments: [theirImage, mine] });

        const other = await uploadOrFail(arranged, "other.png");
        const replaced = await send("PATCH", arranged.harness.base, path, {
          body: { text: "look at this one", attachments: [other.id] },
          token: arranged.token,
        });
        expect(replaced.status, await replaced.clone().text()).toBe(200);
        expect(await replaced.json()).toMatchObject({ attachments: [other] });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "waits past the usual deadline for a runner still downloading an input's images, and sends the input once",
    async () => {
      const deadline = Duration.millis(100);
      await withAgentFleet(
        async (arranged) => {
          const session = await startSessionWithAttachment(
            arranged,
            await uploadOrFail(arranged, "a.png"),
          );
          reportTurnCompleted(arranged, session.id, 2);
          await waitForSession(arranged, session.id, (one) => one.status === "idle");
          const image = await uploadOrFail(arranged, "b.png");
          arranged.wire.answering(() => undefined);

          const answered = post(
            arranged.harness.base,
            `/api/v1/sessions/${session.id}/input`,
            { text: "and this", attachments: [image.id] },
            arranged.token,
          );
          await waitForFrames(arranged.wire, "sessionInput", 1);
          // Several deadlines go by, as they would during a slow download.
          await new Promise((resolve) => setTimeout(resolve, Duration.toMillis(deadline) * 5));
          arranged.wire.release("opened");

          const response = await answered;
          expect(response.status, await response.clone().text()).toBe(200);
          expect(await response.json()).toMatchObject({ result: "opened" });
          expect(listFrames(arranged.wire, "sessionInput")).toHaveLength(1);
        },
        { inputDeadline: deadline, eventRoutingInterval: Duration.millis(20) },
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a queued input waiting, with the reason, when its model stops taking images before it is sent",
    async () => {
      await withAgentFleet(
        async (arranged) => {
          const session = await startSessionWithAttachment(
            arranged,
            await uploadOrFail(arranged, "a.png"),
          );
          const image = await uploadOrFail(arranged, "b.png");
          const queued = await post(
            arranged.harness.base,
            `/api/v1/sessions/${session.id}/input`,
            { text: "and this", attachments: [image.id] },
            arranged.token,
          );
          expect(await queued.json()).toMatchObject({ result: "queued" });

          await setImageInputOnEveryModel(arranged, null);
          reportTurnCompleted(arranged, session.id, 2);

          const waiting = await waitUntil("returned the input with a reason", async () => {
            const input = (await listInputs(arranged, session.id))[1];
            return input?.reason === MODEL_REFUSAL ? input : undefined;
          });
          expect(waiting).toMatchObject({
            status: "queued",
            sentAt: null,
          } satisfies Partial<Input>);
          // Delivery passes keep finding the input waiting. None of them may
          // claim it again while the model refuses images: a claim would
          // clear the reason and notify every client, once per pass. A claim
          // is too brief to see from outside, so a trigger counts them.
          await Effect.runPromise(
            Effect.andThen(
              arranged.harness.sql`CREATE TABLE claims_seen (input_id BLOB)`,
              arranged.harness.sql`
                CREATE TRIGGER count_claims AFTER UPDATE OF sent_at ON session_inputs
                WHEN NEW.sent_at IS NOT NULL
                BEGIN INSERT INTO claims_seen VALUES (NEW.id); END
              `,
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          const claims = await Effect.runPromise(
            arranged.harness.sql<{
              readonly count: number;
            }>`SELECT count(*) AS count FROM claims_seen`,
          );
          expect(claims[0]?.count).toBe(0);
          expect((await listInputs(arranged, session.id))[1]?.reason).toBe(MODEL_REFUSAL);
          expect(listFrames<SessionInput>(arranged.wire, "sessionInput")).toEqual([]);

          await setImageInputOnEveryModel(arranged, { maxBytes: null });
          const [sent] = await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
          expect(sent!.input.attachments?.map((one) => one.id)).toEqual([image.id]);
        },
        { eventRoutingInterval: Duration.millis(20) },
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves a queued session queued, with the reason on its prompt, when its model stops taking images",
    async () => {
      await withAgentFleet(async (arranged) => {
        const capped = await send(
          "PATCH",
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          { body: { maxConcurrentSessions: 1 }, token: arranged.token },
        );
        expect(capped.status, await capped.clone().text()).toBe(200);
        const first = await spawnSessionOrFail(arranged, { prompt: "take the slot" });
        await waitForStartFrames(arranged, first.id, 1);
        const image = await uploadOrFail(arranged, "a.png");
        const queued = await spawnSessionOrFail(arranged, {
          prompt: "look",
          attachments: [image.id],
        });
        expect(queued.status).toBe("queued");

        await setImageInputOnEveryModel(arranged, null);
        reportEvent(arranged.wire, 1, {
          eventId: crypto.randomUUID(),
          sessionId: first.id,
          at,
          _tag: "session.exited",
          reason: "stopped",
        });

        await waitUntil("returned the prompt with a reason", async () => {
          const [prompt] = await listInputs(arranged, queued.id);
          return prompt?.reason === MODEL_REFUSAL ? prompt : undefined;
        });
        expect((await readSession(arranged, queued.id)).status).toBe("queued");
        expect(
          (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1)).map(
            (frame) => frame.sessionId,
          ),
        ).toEqual([first.id]);
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("an image's own size limit on a model", () => {
  const LIMIT_REFUSAL =
    '"big.png" is 2 MB; this model accepts images up to 1.5 MB. ' +
    "Send a smaller image or pick another model.";

  it(
    "refuses an image over the model's limit when the input is created, and holds a queued one when the limit shrinks",
    async () => {
      await withAgentFleet(
        async (arranged) => {
          const session = await startSessionWithAttachment(
            arranged,
            await uploadOrFail(arranged, "a.png"),
          );
          const big = await upload(arranged, "big.png", buildPng(2 * MEBIBYTE));
          expect(big.status, await big.clone().text()).toBe(201);
          const image = (await big.json()) as Attachment;
          const queued = await post(
            arranged.harness.base,
            `/api/v1/sessions/${session.id}/input`,
            { text: "and this", attachments: [image.id] },
            arranged.token,
          );
          expect(await queued.json()).toMatchObject({ result: "queued" });

          await setImageInputOnEveryModel(arranged, { maxBytes: 1.5 * MEBIBYTE });
          // Refused at once when the input is created, on a new session or an
          // existing one.
          const spawned = await spawnSession(arranged, { prompt: "", attachments: [image.id] });
          expect(spawned.status).toBe(400);
          expect(await spawned.json()).toMatchObject({
            error: { details: { issues: [{ path: ["attachments"], message: LIMIT_REFUSAL }] } },
          });
          const another = await post(
            arranged.harness.base,
            `/api/v1/sessions/${session.id}/input`,
            { text: "again", attachments: [image.id] },
            arranged.token,
          );
          expect(another.status).toBe(400);

          // Held, not sent, when the input was queued before the limit shrank.
          reportTurnCompleted(arranged, session.id, 2);
          await waitUntil("returned the input with a reason", async () => {
            const input = (await listInputs(arranged, session.id))[1];
            return input?.reason === LIMIT_REFUSAL ? input : undefined;
          });
          await new Promise((resolve) => setTimeout(resolve, 200));
          expect((await listInputs(arranged, session.id))[1]).toMatchObject({
            status: "queued",
            sentAt: null,
            reason: LIMIT_REFUSAL,
          });
          expect(listFrames<SessionInput>(arranged.wire, "sessionInput")).toEqual([]);
        },
        { eventRoutingInterval: Duration.millis(20) },
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe("deleting an upload", () => {
  it(
    "deletes the caller's own unsent upload with its file, and nothing else",
    async () => {
      await withAgentFleet(async (arranged) => {
        const directory = join(arranged.harness.home, "data", "attachments");
        const own = await uploadOrFail(arranged, "own.png");
        expect(existsSync(join(directory, own.id))).toBe(true);
        const deleted = await deleteAttachment(arranged, own.id);
        expect(deleted.status, await deleted.clone().text()).toBe(200);
        expect(existsSync(join(directory, own.id))).toBe(false);
        const read = await get(
          arranged.harness.base,
          `/api/v1/attachments/${own.id}/content`,
          arranged.token,
        );
        expect(read.status).toBe(404);

        // Someone else's upload.
        const agent = await spawnThreadWithGrants(arranged, "uploader", [
          "session.steer",
          "session.read",
        ]);
        const theirs = (await (
          await upload(arranged, "theirs.png", PNG, agent.token)
        ).json()) as Attachment;
        expect((await deleteAttachment(arranged, theirs.id)).status).toBe(404);
        expect(
          (
            await get(
              arranged.harness.base,
              `/api/v1/attachments/${theirs.id}/content`,
              agent.token,
            )
          ).status,
        ).toBe(200);

        // An upload an input references.
        const sent = await uploadOrFail(arranged, "sent.png");
        await spawnSessionOrFail(arranged, { prompt: "", attachments: [sent.id] });
        expect((await deleteAttachment(arranged, sent.id)).status).toBe(404);
        expect(existsSync(join(directory, sent.id))).toBe(true);

        // An id no upload has.
        const missing = await deleteAttachment(arranged, NO_SUCH_ATTACHMENT);
        expect(missing.status).toBe(404);
        expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a runner fetching an image", () => {
  it(
    "streams an image an input on the runner's session carries, and nothing else",
    async () => {
      await withAgentFleet(async (arranged) => {
        const image = await uploadOrFail(arranged, "screen.png");
        const unclaimed = await uploadOrFail(arranged, "other.png");
        await spawnSessionOrFail(arranged, { prompt: "", attachments: [image.id] });

        const fetched = await fetchAsRunner(arranged, image.id, arranged.credential);
        expect(fetched.status).toBe(200);
        expectAttachmentHeaders(fetched);
        expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(PNG);

        expect((await fetchAsRunner(arranged, unclaimed.id, arranged.credential)).status).toBe(404);
        expect((await fetchAsRunner(arranged, "not-an-id", arranged.credential)).status).toBe(404);
        expect((await fetchAsRunner(arranged, image.id)).status).toBe(401);
        expect((await fetchAsRunner(arranged, image.id, "a-made-up-credential")).status).toBe(401);
        // A user's token is not a runner's credential.
        expect((await fetchAsRunner(arranged, image.id, arranged.token)).status).toBe(401);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses an image that only another runner's session carries",
    async () => {
      await withAgentFleet(async (arranged) => {
        const image = await uploadOrFail(arranged, "screen.png");
        await spawnSessionOrFail(arranged, { prompt: "", attachments: [image.id] });
        const joined = await send("POST", arranged.harness.base, "/api/v1/runners/join", {
          body: {},
          token: await arranged.harness.joinToken(),
        });
        const { credential } = (await joined.json()) as { credential: string };

        const response = await fetchAsRunner(arranged, image.id, credential);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the sweep", () => {
  it(
    "deletes an image no input claimed within a day, with its file, and stray files, and keeps a claimed one",
    async () => {
      await withAgentFleet(
        async (arranged) => {
          const unclaimed = await uploadOrFail(arranged, "old.png");
          const claimed = await uploadOrFail(arranged, "kept.png");
          await spawnSessionOrFail(arranged, { prompt: "", attachments: [claimed.id] });
          const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
          await Effect.runPromise(
            arranged.harness.sql`UPDATE attachments SET created_at = ${dayAgo}`,
          );
          const directory = join(arranged.harness.home, "data", "attachments");
          // An upload interrupted a day ago leaves a temp file with no row.
          const stray = join(directory, `${NO_SUCH_ATTACHMENT}.upload`);
          writeFileSync(stray, PNG);
          utimesSync(stray, new Date(dayAgo), new Date(dayAgo));

          await waitUntil("swept the unclaimed image and the stray file", () =>
            existsSync(join(directory, unclaimed.id)) || existsSync(stray) ? undefined : true,
          );
          const read = (id: string): Promise<Response> =>
            get(arranged.harness.base, `/api/v1/attachments/${id}/content`, arranged.token);
          expect((await read(unclaimed.id)).status).toBe(404);
          expect((await read(claimed.id)).status).toBe(200);
          expect(existsSync(join(directory, claimed.id))).toBe(true);
        },
        { attachmentSweepInterval: Duration.millis(50) },
      );
    },
    TEST_TIMEOUT_MS,
  );
});
