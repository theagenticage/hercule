import { describe, expect, it } from "vitest";
import { ATTACHMENTS_CAPABILITY, type ModelDescriptor } from "@hercule/protocol";
import { describeAttachmentRefusal, type AttachmentRecipient } from "./attachment-refusal";

const buildModel = (slug: string, acceptsImages: boolean): ModelDescriptor => ({
  slug,
  name: slug,
  acceptsImages,
  options: [],
});

const recipient: AttachmentRecipient = {
  runnerName: "laptop",
  capabilities: [ATTACHMENTS_CAPABILITY],
  models: [buildModel("opus", true), buildModel("glm-5.3", false)],
  model: "opus",
};

describe("describeAttachmentRefusal", () => {
  it("never refuses a turn without images", () => {
    expect(
      describeAttachmentRefusal({ ...recipient, capabilities: [], models: [] }, 0),
    ).toBeUndefined();
  });

  it("lets images through to a model that accepts them on a runner that takes them", () => {
    expect(describeAttachmentRefusal(recipient, 3)).toBeUndefined();
  });

  it("refuses images for a runner that did not agree to the capability, before asking about the model", () => {
    expect(describeAttachmentRefusal({ ...recipient, capabilities: [], model: "glm-5.3" }, 1)).toBe(
      "Runner `laptop` runs an older Hercule that can't take images. " +
        "Update the runner or send the prompt without images.",
    );
  });

  it("refuses images for a model that does not accept them, counting the images", () => {
    expect(describeAttachmentRefusal({ ...recipient, model: "glm-5.3" }, 2)).toBe(
      "`glm-5.3` does not accept images. Remove the 2 images or pick a model that accepts them.",
    );
    expect(describeAttachmentRefusal({ ...recipient, model: "glm-5.3" }, 1)).toBe(
      "`glm-5.3` does not accept images. Remove the image or pick a model that accepts them.",
    );
  });

  it("refuses images for a model the runner did not report, because unknown is not yes", () => {
    expect(describeAttachmentRefusal({ ...recipient, model: "mystery" }, 1)).toBe(
      "`mystery` is not in the models runner `laptop` reported, so Hercule can't tell " +
        "whether it accepts images. Send the prompt without images or pick another model.",
    );
  });
});
