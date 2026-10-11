// Dumps the game's static rules (buildings, costs, recipes, resources, jobs,
// needs) from the running game into docs/rules/<TYPE>.json.
//
// The game ships a list of every asset id and every property name in
// mods/vs-code-snippets.json. For each asset we ask the live object for every
// known property name and walk into what comes back. An object that is itself
// an asset is written as {"$ref": "<id>"} instead of being repeated.
//
//   pnpm dump-rules                     the rule-related asset types
//   pnpm dump-rules --types JOB,ZONE    only these types
//   pnpm dump-rules --limit 3           first few assets per type, for a trial run
//
// The game stutters while this runs: each asset is read inside one frame.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GAME_DIR, HOST, HTTP_PORT, PROJECT_DIR } from "./config.ts";

const OUT_DIR = join(PROJECT_DIR, "docs", "rules");

/** Asset types that describe how the game plays, as opposed to how it looks. */
const RULE_TYPES = [
  /^BUILDING$/, /^BUILDING_PART$/, /^BUILDING_FUNCTION/, /^WORKPLACE_RECIPE$/, /^RESOURCE$/, /^JOB$/,
  /^AGENT_NEED/, /^VILLAGER_STATUS$/, /^HAPPINESS_FACTOR$/, /^PROGRESS_TIER/, /^UNLOCKABLE/, /^ZONE$/,
  /^BALANCING$/, /^TRADING_VILLAGE$/, /^TAXATION/, /^HOUSE/, /^PRIVILEGE$/, /^EDICT/, /^DESIRABILITY/,
];

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function evalLua(code: string): Promise<unknown[]> {
  const response = await fetch(`http://${HOST}:${HTTP_PORT}/eval`, { method: "POST", body: code });
  const result = (await response.json()) as { ok: boolean; values?: unknown[]; error?: string };
  if (!result.ok) throw new Error(result.error);
  return result.values ?? [];
}

interface Snippet {
  prefix: string;
  body: string[];
}

/** Asset ids per type and every property name, from the game's snippet file. */
async function readSnippets(): Promise<{ assets: Map<string, string[]>; properties: string[] }> {
  const text = await readFile(join(GAME_DIR, "mods", "vs-code-snippets.json"), "utf8");
  // The file has trailing commas, which JSON.parse rejects.
  const snippets = Object.values(JSON.parse(text.replace(/^﻿/, "").replace(/,(\s*[}\]])/g, "$1"))) as Snippet[];
  const assets = new Map<string, string[]>();
  const properties = new Set<string>();
  for (const { prefix, body } of snippets) {
    if (prefix.startsWith("ASSET_")) {
      const choices = /\$\{1\|(.*)\|\}/.exec(body.join(""))?.[1] ?? "";
      assets.set(prefix.slice("ASSET_".length), [...choices.matchAll(/"([^"]+)"/g)].map((match) => match[1]!));
    } else if (prefix.startsWith("CLASS_")) {
      for (const line of body) {
        const name = /^\s*([A-Za-z0-9_]+) = /.exec(line)?.[1];
        if (name && name !== "DataType") properties.add(name);
      }
    }
  }
  return { assets, properties: [...properties].sort() };
}

const { assets, properties } = await readSnippets();
const requested = argument("--types")?.split(",");
const limit = Number(argument("--limit") ?? Infinity);
const types = [...assets.keys()].filter((type) => (requested ? requested.includes(type) : RULE_TYPES.some((pattern) => pattern.test(type)))).sort();
console.log(`${properties.length} property names; ${types.length} asset types to dump`);

// Give the game the property names and every asset id, then define the dumper.
const upload = async (target: string, names: string[]) => {
  await evalLua(`__bridge.${target} = {}`);
  for (let i = 0; i < names.length; i += 3000) {
    await evalLua(`local t = __bridge.${target}; for name in ([[${names.slice(i, i + 3000).join(" ")}]]):gmatch("%S+") do t[#t + 1] = name end`);
  }
};
await upload("ruleProperties", properties);
await upload("ruleAssetIds", [...new Set([...assets.values()].flat())]);

const [indexed] = await evalLua(`
  local B = __bridge
  -- Index every asset by the first naming property it has, so that an object
  -- met while walking can be recognised as an asset with a few comparisons.
  local NAMING = { "Name", "ResourceName", "JobName", "BuildingName", "VillageName", "Title" }
  local function fingerprint(object)
    for _, key in ipairs(NAMING) do
      local value = object[key]
      if type(value) == "string" and value ~= "" then return key .. "=" .. value end
    end
  end
  local buckets, count = {}, 0
  for _, id in ipairs(B.ruleAssetIds) do
    local ok, asset = pcall(foundation.findAsset, id)
    if ok and asset ~= nil then
      local key = fingerprint(asset)
      if key then
        buckets[key] = buckets[key] or {}
        table.insert(buckets[key], { id = id, asset = asset })
        count = count + 1
      end
    end
  end
  local function assetId(object)
    local key = fingerprint(object)
    for _, entry in ipairs(key and buckets[key] or {}) do
      if entry.asset == object then return entry.id end
    end
  end

  local dump
  local function dumpObject(object, depth)
    local out = {}
    for _, name in ipairs(B.ruleProperties) do
      local value = object[name]
      if value ~= nil then out[name] = dump(value, depth + 1) end
    end
    return out
  end
  dump = function(value, depth)
    local kind = type(value)
    if kind == "table" then
      local out, n = {}, 0
      for key, item in pairs(value) do
        -- Flag sets come back as tables keyed by enum values.
        if type(key) == "userdata" then key = dump(key, depth + 1) end
        if type(key) ~= "string" and type(key) ~= "number" then key = "?" end
        out[key] = dump(item, depth + 1)
        n = n + 1
      end
      return n == #value and B.array(out) or out
    end
    if kind ~= "userdata" then return value end
    -- Fixed-size arrays (float[2] and the like) only accept numeric indexes.
    local named, toString = pcall(function() return value.toString end)
    if not named then
      local list = B.array()
      for i = 1, 64 do
        local ok, item = pcall(function() return value[i] end)
        if not ok or item == nil then break end
        list[i] = dump(item, depth + 1)
      end
      return list
    end
    if toString and value.toNumber then return value:toString() end
    if value.forEach then
      local list = B.array()
      value:forEach(function(item) list[#list + 1] = dump(item, depth + 1) end)
      return list
    end
    local id = assetId(value)
    if id then return { ["$ref"] = id } end
    if depth >= 7 then return "<too deep>" end
    return dumpObject(value, depth)
  end
  B.dumpAsset = function(id)
    local asset = foundation.findAsset(id)
    if asset == nil then return nil end
    return dumpObject(asset, 0)
  end
  return count
`);
console.log(`${indexed} assets indexed for cross-references`);

await mkdir(OUT_DIR, { recursive: true });
for (const type of types) {
  const ids = assets.get(type)!.slice(0, limit);
  const dumped: Record<string, unknown> = {};
  let missing = 0;
  for (const id of ids) {
    try {
      const [value] = await evalLua(`return __bridge.dumpAsset(${JSON.stringify(id)})`);
      if (value == null) missing++;
      else dumped[id] = value;
    } catch (error) {
      console.log(`  ${id}: ${String(error).split("\n")[0]}`);
    }
  }
  await writeFile(join(OUT_DIR, `${type}.json`), JSON.stringify(dumped, null, 1) + "\n");
  console.log(`${type}: ${Object.keys(dumped).length} assets${missing ? `, ${missing} not found` : ""}`);
}
await evalLua("__bridge.ruleProperties, __bridge.ruleAssetIds, __bridge.dumpAsset = nil, nil, nil");
