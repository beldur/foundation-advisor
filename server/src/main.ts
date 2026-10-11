import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BridgeServer } from "./bridge-server.ts";
import { BRIDGE_PORT, DUMP_DIR, HOST, HTTP_PORT, PROJECT_DIR } from "./config.ts";
import { advise, type AdviceResult } from "./advisor.ts";
import { buildBriefing, type Rules, type Snapshot } from "./briefing.ts";
import { diffStates, type GameEvent } from "./events.ts";
import type { GameState } from "./state.ts";

const bridge = new BridgeServer();

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

bridge.on("connect", () => console.log(`${stamp()} game connected`));
bridge.on("disconnect", () => console.log(`${stamp()} game disconnected`));
bridge.on("protocol-error", (error) => console.log(`${stamp()} protocol error: ${error}`));
bridge.on("hello", async (hello) => {
  await mkdir(DUMP_DIR, { recursive: true });
  const file = join(DUMP_DIR, "hello.json");
  await writeFile(file, JSON.stringify(hello, null, 2));
  console.log(`${stamp()} hello: ${hello.lua}, ${hello.jit} -> ${file}`);
});

// Browsers listening on /events; each gets every state snapshot as it arrives.
const listeners = new Set<ServerResponse>();

function publish(event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const listener of listeners) listener.write(message);
}

// What changed between consecutive snapshots, newest last. Kept across bridge
// reloads, since the village is still the same one.
const MAX_EVENTS = 200;
const eventLog: (GameEvent & { at: string })[] = [];
let previousState: GameState | null = null;

bridge.on("state", (state: GameState) => {
  for (const event of diffStates(previousState, state)) {
    const entry = { ...event, at: new Date().toISOString() };
    eventLog.push(entry);
    if (eventLog.length > MAX_EVENTS) eventLog.shift();
    publish("event", entry);
  }
  previousState = state;
  publish("state", state);
});
bridge.on("camera", (camera) => publish("camera", camera));
bridge.on("terrain", (terrain) => publish("terrain", terrain));
bridge.on("connect", () => publish("connection", { connected: true }));
bridge.on("disconnect", () => publish("connection", { connected: false }));

// The advisor: one question at a time, and the last answer is kept for pages that open later.
// It runs only when asked through POST /advise, which the page's button calls. Nothing here
// starts it by itself, and nothing should: each call costs money.
let rules: Rules = { buildings: [] };
try {
  rules = JSON.parse(await readFile(join(PROJECT_DIR, "docs", "rules-summary.json"), "utf8"));
} catch {
  console.log(`${stamp()} docs/rules-summary.json not found; the advisor will work without building rules (run pnpm dump-rules, then pnpm summarize-rules)`);
}

const currentBriefing = () => (bridge.lastState ? buildBriefing(bridge.lastState as Snapshot, rules, eventLog) : null);

type AdviceEntry = AdviceResult & { at: string; question?: string };
let lastAdvice: AdviceEntry | null = null;
let advising: Promise<AdviceEntry> | null = null;

function askAdvisor(question?: string): Promise<AdviceEntry> {
  if (advising) return advising;
  const briefing = currentBriefing();
  if (!briefing) return Promise.resolve({ ok: false, error: "No village state yet. Load a village with the Companion Bridge mod.", at: new Date().toISOString() });
  publish("advising", { question });
  advising = advise(briefing, question)
    .then((result) => {
      lastAdvice = { ...result, at: new Date().toISOString(), question };
      publish("advice", lastAdvice);
      console.log(`${stamp()} advisor: ${result.ok ? `${result.advice.tips.length} tips from ${result.model}` : result.error}`);
      return lastAdvice;
    })
    .finally(() => { advising = null; });
  return advising;
}

async function readBody(request: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const http = createServer(async (request, response) => {
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const route = `${request.method} ${request.url}`;

  if (route === "GET /") {
    // Read on every request so edits to the page show up on refresh.
    const page = await readFile(join(PROJECT_DIR, "web", "index.html"));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(page);
  }
  if (route === "GET /events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    listeners.add(response);
    request.on("close", () => listeners.delete(response));
    response.write(`event: connection\ndata: ${JSON.stringify({ connected: bridge.connected })}\n\n`);
    response.write(`event: events\ndata: ${JSON.stringify(eventLog)}\n\n`);
    if (lastAdvice) response.write(`event: advice\ndata: ${JSON.stringify(lastAdvice)}\n\n`);
    if (bridge.connected && bridge.lastTerrain) response.write(`event: terrain\ndata: ${JSON.stringify(bridge.lastTerrain)}\n\n`);
    if (bridge.connected && bridge.lastState) response.write(`event: state\ndata: ${JSON.stringify(bridge.lastState)}\n\n`);
    return;
  }
  if (route === "GET /state") return reply(200, bridge.lastState);
  if (route === "GET /terrain") return reply(200, bridge.lastTerrain);
  if (route === "GET /event-log") return reply(200, eventLog);
  if (route === "GET /briefing") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return response.end(currentBriefing() ?? "No village state yet.");
  }
  if (route === "POST /advise") {
    const body = await readBody(request);
    let question: string | undefined;
    try { question = body ? JSON.parse(body).question : undefined; } catch { question = body; }
    return reply(200, await askAdvisor(question));
  }
  if (route === "GET /status") return reply(200, { connected: bridge.connected, status: bridge.lastStatus });
  if (route === "POST /eval") return reply(200, await bridge.eval(await readBody(request)));
  reply(404, { error: "not found" });
});

await bridge.listen(BRIDGE_PORT, HOST);
http.listen(HTTP_PORT, HOST);
console.log(`${stamp()} waiting for the game on ${HOST}:${BRIDGE_PORT}`);
console.log(`${stamp()} dashboard: http://${HOST}:${HTTP_PORT}/`);
