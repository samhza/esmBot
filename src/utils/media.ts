import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import process from "node:process";
import { fileTypeStream } from "file-type";
import ipaddr from "ipaddr.js";
import logger from "./logger.ts";
import MediaConnection from "./mediaConnection.ts";
import run from "./mediaRunner.ts";
import { random } from "./misc.ts";
import type { MediaMeta, MediaParams } from "./types.ts";

let mediaLib: import("./mediaLib.ts").MediaLib | undefined;

interface ServerConfig {
  name: string;
  server: string;
  auth?: string;
  tls?: boolean;
}

const allowedFormats = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/heif"];
export const connections = new Map<string, MediaConnection>();
export let servers: ServerConfig[] = [];

export async function initMediaLib() {
  const { media } = await import("./mediaLib.ts");
  media.init();
  mediaLib = media;
}

const MAX_SIZE = 41943040; // 40 MB

export interface MediaData {
  type: string;
  data: ArrayBuffer;
}

interface OpenedMedia {
  type: string;
  stream: ReadableStream<Uint8Array>;
}

function limitSize(max: number) {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) throw "large";
      controller.enqueue(chunk);
    },
  });
}

async function isUnicast(host: string): Promise<boolean> {
  try {
    return ipaddr.parse((await lookup(host)).address).range() === "unicast";
  } catch (e) {
    const err = e as Error;
    if ("code" in err && err.code === "ENOTFOUND") return false;
    throw e;
  }
}

async function open(media: URL): Promise<OpenedMedia | undefined> {
  // verify that IP address is valid
  if (!(await isUnicast(media.host))) return;

  const controller = new AbortController();
  const res = await fetch(media, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
    headers: {
      "User-Agent": `Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com) esmBot/${process.env.ESMBOT_VER}`,
    },
  });

  let opened: OpenedMedia | undefined;
  try {
    if (res.status === 429) throw "ratelimit";

    if (res.redirected && !(await isUnicast(new URL(res.url).host))) return;

    const range = res.headers.get("content-range")?.split("/")[1];
    if (Number.parseInt(range ?? res.headers.get("content-length") ?? "0") > MAX_SIZE) throw "large";

    if (!res.body) return;

    const stream = await fileTypeStream(res.body, { sampleSize: 1024 });
    const type = stream.fileType?.mime;
    if (!type || !allowedFormats.includes(type)) return;

    opened = { stream, type };
    return opened;
  } finally {
    if (!opened) controller.abort();
  }
}

export async function findMedia(inputs: MediaMeta[]): Promise<MediaMeta | undefined> {
  for (const input of inputs) {
    try {
      const res = await open(new URL(input.path));
      if (!res) continue;
      await res.stream.cancel();
      return input;
    } catch {
      // try the next
    }
  }
}

export async function request(media: URL): Promise<MediaData | undefined> {
  const res = await open(media);
  if (!res) return;
  const data = await new Response(res.stream.pipeThrough(limitSize(MAX_SIZE))).arrayBuffer();
  return { data, type: res.type };
}

function connect(server: string, auth: string | undefined, name: string | undefined, tls?: boolean) {
  const connection = new MediaConnection(server, auth, name, tls);
  connections.set(server, connection);
}

export function disconnect() {
  for (const connection of connections.values()) {
    connection.close();
  }
  connections.clear();
}

async function repopulate() {
  const data = await fs.promises.readFile(new URL("../../config/servers.json", import.meta.url), { encoding: "utf8" });
  const parsed = JSON.parse(data);
  servers = parsed.media;
}

export async function reloadMediaConnections() {
  disconnect();
  await repopulate();
  let amount = 0;
  for (const server of servers) {
    try {
      connect(server.server, server.auth, server.name, server.tls);
      amount += 1;
    } catch (e) {
      logger.error(e);
    }
  }
  return amount;
}

async function getIdeal(object: MediaParams): Promise<MediaConnection | undefined> {
  const idealServers: Array<
    | {
        connection: MediaConnection;
        count: number;
      }
    | undefined
  > = [];
  for (const connection of connections.values()) {
    if (connection.conn.readyState !== 1) {
      continue;
    }
    if (!connection.commands.has(object.cmd)) {
      idealServers.push(undefined);
      continue;
    }
    try {
      const count = await connection.getCount();
      idealServers.push({ connection, count });
    } catch {
      continue;
    }
  }
  if (idealServers.length === 0) throw "No available servers";
  const sorted = idealServers.filter((v) => !!v).sort((a, b) => a.count - b.count);
  if (sorted.length === 0) return;
  return (sorted.every((v) => v.count === 0) ? random(sorted) : sorted[0]).connection;
}

let running = 0;

export async function runMediaJob(params: MediaParams): Promise<{ buffer: Buffer; type: string; spoiler: boolean }> {
  if (process.env.API_TYPE === "ws") {
    const currentServer = await getIdeal(params);
    if (!currentServer)
      return {
        buffer: Buffer.alloc(0),
        type: "nocmd",
        spoiler: false,
      };
    try {
      await currentServer.queue(BigInt(params.id), params);
      const result = await currentServer.wait(BigInt(params.id));
      if (result.sent)
        return {
          buffer: result.data,
          type: "sent",
          spoiler: false,
        };
      const output = await currentServer.getOutput(params.id);
      return output;
    } catch (e) {
      if (e !== "Request ended prematurely due to a closed connection") {
        if (e === "No available servers") throw "Request ended prematurely due to a closed connection";
        throw e;
      }
    }
    return {
      buffer: Buffer.alloc(0),
      type: "noresult",
      spoiler: false,
    };
  }
  // Called from command (not using media API)
  running++;
  const data = await run(params).finally(() => {
    running--;
    if (running < 0) running = 0;
    if (mediaLib && running === 0) {
      mediaLib.trim();
    }
  });
  return data;
}
