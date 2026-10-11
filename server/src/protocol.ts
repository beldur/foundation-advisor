// Wire format shared with bridge/bridge.lua: "TYPE id length\n" then length bytes.

export interface Frame {
  type: string;
  id: string;
  payload: Buffer;
}

export function encodeFrame(type: string, id: string | number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  return Buffer.concat([Buffer.from(`${type} ${id} ${body.length}\n`, "ascii"), body]);
}

const MAX_HEADER = 128;

export class FrameParser {
  #buffer: Buffer = Buffer.alloc(0);

  /** Adds received bytes and returns every frame they complete. */
  push(chunk: Buffer): Frame[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const lineEnd = this.#buffer.indexOf(0x0a);
      if (lineEnd === -1) {
        if (this.#buffer.length > MAX_HEADER) throw new Error("frame header too long");
        break;
      }
      const header = this.#buffer.subarray(0, lineEnd).toString("ascii");
      const match = /^([A-Z]+) (\S+) (\d+)$/.exec(header);
      if (!match) throw new Error(`bad frame header: ${JSON.stringify(header)}`);
      const [, type, id, lengthText] = match as unknown as [string, string, string, string];
      const end = lineEnd + 1 + Number(lengthText);
      if (this.#buffer.length < end) break;
      frames.push({ type, id, payload: this.#buffer.subarray(lineEnd + 1, end) });
      this.#buffer = this.#buffer.subarray(end);
    }
    return frames;
  }
}
