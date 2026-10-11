import { createServer, type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { encodeFrame, FrameParser, type Frame } from "./protocol.ts";

export interface EvalResult {
  ok: boolean;
  /** Return values of the evaluated chunk, when ok. */
  values?: unknown[];
  error?: string;
}

interface Pending {
  resolve: (result: EvalResult) => void;
  timer: NodeJS.Timeout;
}

/**
 * Accepts the connection from the game and runs Lua in it.
 * Emits "hello", "status", "state", "terrain" and "camera" with the decoded payload, "connect" and "disconnect".
 */
export class BridgeServer extends EventEmitter {
  #server: Server;
  #game: Socket | null = null;
  #pending = new Map<string, Pending>();
  #nextId = 1;
  lastStatus: unknown = null;
  /** Latest state snapshot from the game, as sent (see B.snapshot in bridge.lua). */
  lastState: unknown = null;
  /** Latest terrain survey from the game (see surveyTerrain in bridge.lua). */
  lastTerrain: unknown = null;

  constructor() {
    super();
    this.#server = createServer((socket) => this.#accept(socket));
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => resolve());
    });
  }

  close(): Promise<void> {
    this.#game?.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  /** The port actually bound, for callers that asked for port 0. */
  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("server is not listening");
    return address.port;
  }

  get connected(): boolean {
    return this.#game !== null;
  }

  eval(code: string, timeoutMs = 10_000): Promise<EvalResult> {
    const game = this.#game;
    if (!game) return Promise.resolve({ ok: false, error: "game is not connected" });
    const id = String(this.#nextId++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ok: false, error: `no reply within ${timeoutMs} ms` });
      }, timeoutMs);
      this.#pending.set(id, { resolve, timer });
      game.write(encodeFrame("EVAL", id, code));
    });
  }

  #accept(socket: Socket): void {
    // One game at a time; a new connection replaces a stale one.
    this.#game?.destroy();
    this.#game = socket;
    socket.setNoDelay(true);
    const parser = new FrameParser();
    this.emit("connect");

    socket.on("data", (chunk) => {
      try {
        for (const frame of parser.push(chunk)) this.#handle(frame);
      } catch (error) {
        this.emit("protocol-error", error);
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.#game !== socket) return;
      this.#game = null;
      for (const [id, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, error: "game disconnected" });
        this.#pending.delete(id);
      }
      this.emit("disconnect");
    });
  }

  #handle(frame: Frame): void {
    const text = frame.payload.toString("utf8");
    switch (frame.type) {
      case "HELLO":
        this.emit("hello", JSON.parse(text));
        break;
      case "STATUS":
        this.lastStatus = JSON.parse(text);
        this.emit("status", this.lastStatus);
        break;
      case "STATE":
        this.lastState = JSON.parse(text);
        this.emit("state", this.lastState);
        break;
      case "TERRAIN":
        this.lastTerrain = JSON.parse(text);
        this.emit("terrain", this.lastTerrain);
        break;
      case "CAMERA":
        this.emit("camera", JSON.parse(text));
        break;
      case "RES":
      case "ERR": {
        const pending = this.#pending.get(frame.id);
        if (!pending) break;
        this.#pending.delete(frame.id);
        clearTimeout(pending.timer);
        const body = JSON.parse(text);
        pending.resolve(frame.type === "RES" ? { ok: true, values: body } : { ok: false, error: body.error });
        break;
      }
    }
  }
}
