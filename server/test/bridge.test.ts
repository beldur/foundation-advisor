// Runs the real bridge/bridge.lua in a Lua VM (fengari) against the real BridgeServer.
// Only the socket library is faked: its calls are forwarded to a Node TCP socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fengari from "fengari";
import { BridgeServer } from "../src/bridge-server.ts";
import { PROJECT_DIR } from "../src/config.ts";

const { lua, lauxlib, lualib, to_luastring } = fengari;

const FAKE_SOCKET = `
io.open = function() return nil end
dofile = function() js_run_bridge() end
package.preload["socket.core"] = function()
	return {
		gettime = js_time,
		tcp = function()
			return {
				settimeout = function() end,
				setoption = function() end,
				close = function() end,
				connect = function() return 1 end,
				send = function(_, data) js_send(data) return #data end,
				-- Like a non-blocking socket: whatever has arrived, reported as a partial read.
				receive = function() return nil, "timeout", js_receive() end,
			}
		end,
	}
end
`;

function startGame(socket: Socket, source: string) {
  const received: Buffer[] = [];
  socket.on("data", (chunk) => received.push(chunk));

  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const define = (name: string, fn: (L: unknown) => number) => {
    lua.lua_pushcfunction(L, fn);
    lua.lua_setglobal(L, to_luastring(name));
  };
  define("js_time", (L) => {
    lua.lua_pushnumber(L, performance.now() / 1000);
    return 1;
  });
  define("js_send", (L) => {
    socket.write(Buffer.from(lua.lua_tolstring(L, 1)));
    return 0;
  });
  define("js_receive", (L) => {
    lua.lua_pushstring(L, new Uint8Array(Buffer.concat(received.splice(0))));
    return 1;
  });

  const run = (code: string, name: string) => {
    const status = lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring(name)) || lua.lua_pcall(L, 0, 0, 0);
    if (status !== lua.LUA_OK) throw new Error(lua.lua_tojsstring(L, -1));
  };
  const runBridge = () => run(source, "@C:\\Users\\Test\\Documents\\Polymorph Games\\Foundation\\moddev\\bridge.lua");
  define("js_run_bridge", () => {
    runBridge();
    return 0;
  });
  run(FAKE_SOCKET, "=fake-socket");
  runBridge();

  // Stands in for the game running Lua every frame.
  const frames = setInterval(() => run("__bridge.tick('frame')", "=frame"), 5);
  return { stop: () => clearInterval(frames), run };
}

test("bridge.lua talks to the server", async (t) => {
  const server = new BridgeServer();
  await server.listen(0, "127.0.0.1");
  const socket = connect(server.port, "127.0.0.1");
  await once(socket, "connect");
  let game: ReturnType<typeof startGame> | undefined;
  t.after(async () => {
    game?.stop();
    socket.destroy();
    await server.close();
  });
  const hello = once(server, "hello");
  game = startGame(socket, await readFile(join(PROJECT_DIR, "bridge", "bridge.lua"), "utf8"));

  await t.test("sends a hello describing the Lua environment", async () => {
    const [payload] = await hello;
    assert.match(payload.lua, /^Lua 5\./);
    assert.equal(payload.globals.__bridge.type, "table");
    assert.ok(payload.globals.string.keys.includes("format"));
    assert.equal(payload.userDir, "C:\\Users\\Test\\Documents\\Polymorph Games\\Foundation\\");
    assert.equal(typeof payload.registry.otherEntries, "number");
  });

  await t.test("evaluates code and returns every value", async () => {
    const result = await server.eval(`return 1 + 1, "two\\n\\"quoted\\"", { a = { 1, 2 }, b = true }, 0.5`);
    assert.deepEqual(result, { ok: true, values: [2, 'two\n"quoted"', { a: [1, 2], b: true }, 0.5] });
  });

  await t.test("reports syntax and runtime errors", async () => {
    const syntax = await server.eval("return +");
    assert.equal(syntax.ok, false);
    const runtime = await server.eval("local t = nil; return t.x");
    assert.equal(runtime.ok, false);
    assert.match(runtime.error ?? "", /attempt to index/);
  });

  await t.test("survives values JSON cannot hold", async () => {
    const result = await server.eval("local t = {}; t.self = t; return print, t, 0/0, { [1] = 'a', [3] = 'c' }");
    assert.equal(result.ok, true);
    const [fn, cyclic, nan, sparse] = result.values as [string, { self: string }, null, Record<string, string>];
    assert.match(fn, /^<function/);
    assert.equal(cyclic.self, "<cycle>");
    assert.equal(nan, null);
    assert.deepEqual(sparse, { "1": "a", "3": "c" });
  });

  await t.test("handles payloads larger than one read", async () => {
    const big = "x".repeat(300_000);
    const result = await server.eval(`local s = "${big}"; return #s, s`);
    assert.deepEqual(result.values, [300_000, big]);
  });

  await t.test("describes objects and state", async () => {
    const result = await server.eval("return __bridge.describe(setmetatable({}, { __index = { hello = 1 } })), __bridge.status()");
    const [described, status] = result.values as [{ metatables: { index: string[] }[] }, { state: string; hookCalls: number }];
    assert.deepEqual(described.metatables[0]?.index, ["hello"]);
    assert.equal(status.state, "connected");
    assert.ok(status.hookCalls > 0, "the count hook should have fired");
  });

  await t.test("registers a ticker through the companion mod and puts it in the level", async () => {
    const result = await server.eval(`
      local classes, assets, overrides = {}, {}, {}
      local mod = {
        registerClass = function(_, class) classes[class.TypeName] = class end,
        registerAsset = function(_, asset) assets[#assets + 1] = asset.Id end,
        overrideAsset = function(_, asset) overrides[#overrides + 1] = asset.Id end,
      }
      __bridge.attachMod(mod)

      local added = {}
      local level = {
        find = function() return nil end,
        createObject = function(_, setup)
          setup({ addComponent = function(_, type) added[#added + 1] = type end })
        end,
      }
      local instance = { getTaxationManager = function() return { getLevel = function() return level end } end }
      classes.TAXATION_FUNCTION_COMPANION_BRIDGE.init({}, instance)
      local levelSeen = __bridge.level == level
      __bridge.level = nil
      classes.GAME_ACTION_COMPANION_BRIDGE.execute({}, level)
      levelSeen = levelSeen and __bridge.level == level

      local before = __bridge.tickSources.component or 0
      local deadline = js_time() + 0.2
      while js_time() < deadline do classes.COMP_COMPANION_BRIDGE_TICKER.update({ getLevel = function() return level end }) end
      __bridge.level = nil
      return assets, overrides, added, levelSeen, (__bridge.tickSources.component or 0) - before
    `);
    assert.equal(result.ok, true, result.error);
    const [assets, overrides, added, levelSeen, ticks] = result.values as [string[], string[], string[], boolean, number];
    assert.deepEqual(assets, ["COMPANION_BRIDGE_EVENT", "COMPANION_BRIDGE_TAXATION_FUNCTION"]);
    assert.deepEqual(overrides, ["DEFAULT_BALANCING", "DEFAULT_TAXATION_SETTINGS"]);
    assert.deepEqual(added, ["COMP_COMPANION_BRIDGE_TICKER", "COMP_COMPANION_BRIDGE_TICKER"]);
    assert.equal(levelSeen, true);
    assert.equal(ticks, 0, "ticks are refused while an eval is running, so re-entry is impossible");
  });

  await t.test("encodes marked lists as arrays even when empty", async () => {
    const result = await server.eval("return __bridge.array(), __bridge.array({ 1 }), {}, __bridge.snapshot() == nil");
    assert.deepEqual(result.values, [[], [1], {}, true]);
  });

  await t.test("tracks globals defined after it loaded", async () => {
    await server.eval("lateGlobal = 1");
    const result = await server.eval("return __bridge.newGlobals");
    assert.ok((result.values?.[0] as string[]).includes("lateGlobal"));
  });

  await t.test("reloads in place and keeps what it knew", async () => {
    await server.eval("__bridge.level = 'the level'; __bridge.marker = 'old copy'");
    const hello = once(server, "hello");
    game?.run("reloaded = __bridge.reload()", "=mod-reload");
    await hello;
    const result = await server.eval("return __bridge.marker, __bridge.level, reloaded == __bridge, __bridge.status().state");
    assert.deepEqual(result.values, [null, "the level", true, "connected"]);
  });
});
