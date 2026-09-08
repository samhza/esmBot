import { Buffer } from "node:buffer";
import path from "node:path";
import { requestata, requestData } from "./media.ts";
import type { MediaLib } from "./mediaLib.ts";
import { mimeToExt } from "./mime.ts";
import type { JobOutput, MediaParams } from "./types.ts";

let media: MediaLib | undefined;

export default async function run(object: MediaParams): Promise<JobOutput> {
  // dynamically load media library
  if (!media) {
    const imported = await import("./mediaLib.js");
    media = imported.media;
  }

  let input: MediaData | undefined;
  let spoiler = !!object.spoiler;
  try {
    const func = media.funcs.find((v) => v.name === object.cmd);
    if (!func) throw "nocmd";

    for (const source of object.inputs) {
      input = await requestData(new URL(source.path));
      if (input) {
        spoiler ||= source.spoiler;
        break;
      }
    }
    if (!input && func.input) throw "nomedia";

    // Reject non-animated formats for commands that only work on animations
    if (func.anim && input?.type !== "image/gif" && input?.type !== "image/webp") throw "noanim";
  } catch (e) {
    if (typeof e !== "string") throw e;
    return { buffer: Buffer.alloc(0), type: e, spoiler: false };
  }

  object.params.basePath = path.join(import.meta.dirname, "../../");
  const { data, type } = await media.process(
    object.cmd,
    object.params,
    input ? { data: input.data, type: mimeToExt(input.type) } : {},
  );
  return {
    buffer: data,
    type,
    spoiler,
  };
}
