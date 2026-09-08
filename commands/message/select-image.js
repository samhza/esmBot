import { Message } from "oceanic.js";
import Command from "#cmd-classes/command.js";
import { selectedImages } from "#utils/collections.js";
import { findMedia } from "#utils/media.js";
import imageDetect from "#utils/mediadetect.js";

class SelectImageCommand extends Command {
  async run() {
    const message = this.interaction?.data.target;
    if (!(message instanceof Message)) throw Error("Target is not a message");
    const mediaArr = await imageDetect(this.client, this.permissions, message, this.interaction, true).catch((e) => {
      if (e.name === "AbortError") return this.getString("image.timeout");
      throw e;
    });
    this.success = false;
    if (typeof mediaArr === "string") return mediaArr;
    if (mediaArr.length === 0) return this.getString("image.couldNotFind");

    const final = await findMedia(mediaArr);
    if (!final) return this.getString("image.couldNotFind");

    selectedImages.set(this.author.id, final);
    return this.getString("image.selected");
  }

  static ephemeral = true;
}

export default SelectImageCommand;
