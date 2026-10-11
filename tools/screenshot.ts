// Takes a screenshot of the running dashboard for the README.
//   pnpm screenshot [output.png]
//
// Drives Microsoft Edge in headless mode over the DevTools protocol, so it
// needs no extra packages. The server must be running, with a village loaded.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = "http://127.0.0.1:47801/";
const PORT = 9333;
const SIZE = { width: 1600, height: 1000 };
const output = process.argv[2] ?? join(import.meta.dirname, "..", "docs", "screenshot.png");

const edge = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((candidate) => existsSync(candidate));
if (!edge) throw new Error("Microsoft Edge was not found");

const profile = await mkdtemp(join(tmpdir(), "dashboard-shot-"));
const browser = spawn(edge, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${SIZE.width},${SIZE.height}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  // Wait for the browser to offer its page over the DevTools protocol.
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let attempt = 0; attempt < 50 && !target; attempt++) {
    await sleep(200);
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      target = pages.find((page) => page.type === "page");
    } catch {
      // not listening yet
    }
  }
  if (!target) throw new Error("Edge did not start");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  let nextId = 1;
  const pending = new Map<number, (result: any) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message.result);
  });
  const send = (method: string, params: object = {}) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Emulation.setDeviceMetricsOverride", { ...SIZE, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: URL });
  // The page fills in as the state and the terrain survey arrive over its event stream.
  await sleep(7000);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(output, Buffer.from(data, "base64"));
  console.log(`wrote ${output}`);
  socket.close();
} finally {
  browser.kill();
  await sleep(500);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
