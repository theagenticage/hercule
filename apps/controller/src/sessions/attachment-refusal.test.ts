import { describe, expect, it } from "vitest";
import { ATTACHMENTS_CAPABILITY, type ModelDescriptor } from "@hercule/protocol";
import { describeAttachmentRefusal, type AttachmentRecipient } from "./attachment-refusal";

const MEBIBYTE = 1024 * 1024;

const buildModel = (slug: string, imageInput: ModelDescriptor["imageInput"]): ModelDescriptor => ({
  slug,
  name: slug,
  imageInput,
  options: [],
});

/** Returns `count` attachments of one MB each, named `1.png`, `2.png`, and so on. */
const buildAttachments = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: `${String(index + 1)}.png`,
    sizeBytes: MEBIBYTE,
  }));

const recipient: AttachmentRecipient = {
  runnerName: "laptop",
  capabilities: [ATTACHMENTS_CAPABILITY],
  models: [
    buildModel("opus", { maxBytes: null }),
    buildModel("glm-5.3", null),
    buildModel("pi", { maxBytes: 3.375 * MEBIBYTE }),
  ],
  model: "opus",
};

describe("describeAttachmentRefusal", () => {
  it("never refuses a turn without images", () => {
    expect(
      describeAttachmentRefusal(
        { ...recipient, capabilities: [], models: [] },
        buildAttachments(0),
      ),
    ).toBeUndefined();
  });

  it("lets images through to a model that accepts them on a runner that takes them", () => {
    expect(describeAttachmentRefusal(recipient, buildAttachments(3))).toBeUndefined();
  });

  it("refuses images for a runner that did not agree to the capability, before asking about the model", () => {
    expect(
      describeAttachmentRefusal(
        { ...recipient, capabilities: [], model: "glm-5.3" },
        buildAttachments(1),
      ),
    ).toBe(
      "Runner `laptop` runs an older Hercule that can't take images. " +
        "Update the runner or send the prompt without images.",
    );
  });

  it("refuses images for a model that does not accept them, counting the images", () => {
    expect(describeAttachmentRefusal({ ...recipient, model: "glm-5.3" }, buildAttachments(2))).toBe(
      "`glm-5.3` does not accept images. Remove the 2 images or pick a model that accepts them.",
    );
    expect(describeAttachmentRefusal({ ...recipient, model: "glm-5.3" }, buildAttachments(1))).toBe(
      "`glm-5.3` does not accept images. Remove the image or pick a model that accepts them.",
    );
  });

  it("refuses an image larger than the model's own limit, naming it, and lets one at the limit through", () => {
    const pi = { ...recipient, model: "pi" };
    expect(
      describeAttachmentRefusal(pi, [
        { name: "small.png", sizeBytes: MEBIBYTE },
        { name: "photo.png", sizeBytes: 4 * MEBIBYTE },
      ]),
    ).toBe(
      '"photo.png" is 4 MB; this model accepts images up to 3.375 MB. ' +
        "Send a smaller image or pick another model.",
    );
    expect(
      describeAttachmentRefusal(pi, [{ name: "exact.png", sizeBytes: 3.375 * MEBIBYTE }]),
    ).toBeUndefined();
  });

  it("rounds an image just over the limit up, so the message never shows it as equal", () => {
    expect(
      describeAttachmentRefusal({ ...recipient, model: "pi" }, [
        { name: "edge.png", sizeBytes: 3.375 * MEBIBYTE + 1 },
      ]),
    ).toBe(
      '"edge.png" is 3.376 MB; this model accepts images up to 3.375 MB. ' +
        "Send a smaller image or pick another model.",
    );
  });

  it("refuses images for a model the runner did not report, because unknown is not yes", () => {
    expect(describeAttachmentRefusal({ ...recipient, model: "mystery" }, buildAttachments(1))).toBe(
      "`mystery` is not in the models runner `laptop` reported, so Hercule can't tell " +
        "whether it accepts images. Send the prompt without images or pick another model.",
    );
  });
});
