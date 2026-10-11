// Shows what is inside a live game value: every property it answers to, with
// values, a few levels deep. For exploring, not for regular use.
//
//   pnpm inspect "level:find('COMP_VILLAGER_MANAGER')"
//   pnpm inspect "manager('PlaCCompEconomyManager').ResourceStatList" --depth 3 --items 4
//
// In the expression: `level` is the level, `first(list)` the first element of a
// game list, `manager(kind)` a component under the level's Manager object, and
// `componentOf(object, kind)` a component by engine type name.
//
// Property names come from the game binary, as in probe-api. The game stalls
// briefly for each object looked at.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GAME_DIR, HOST, HTTP_PORT } from "./config.ts";

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
}
const expression = process.argv[2];
if (!expression || expression.startsWith("--")) {
  console.error('usage: pnpm inspect "<lua expression>" [--depth 2] [--items 3]');
  process.exit(2);
}
const depth = option("--depth", 2);
const items = option("--items", 3);

async function evalLua(code: string): Promise<unknown[]> {
  const response = await fetch(`http://${HOST}:${HTTP_PORT}/eval`, { method: "POST", body: code });
  const result = (await response.json()) as { ok: boolean; values?: unknown[]; error?: string };
  if (!result.ok) throw new Error(result.error);
  return result.values ?? [];
}

// Capitalised identifiers from the binary: the candidate property names.
const [loaded] = await evalLua("return __bridge.inspectNames and #__bridge.inspectNames or 0");
if (!loaded) {
  const binary = (await readFile(join(GAME_DIR, "foundation.exe"))).toString("latin1");
  const names = new Set<string>();
  for (const match of binary.matchAll(/(?<=\0)[A-Z][A-Za-z0-9]{2,63}(?=\0)/g)) {
    if (!/^[A-Z0-9]+$/.test(match[0])) names.add(match[0]);
  }
  const list = [...names].sort();
  await evalLua("__bridge.inspectNames = {}");
  for (let i = 0; i < list.length; i += 4000) {
    await evalLua(`local t = __bridge.inspectNames; for name in ([[${list.slice(i, i + 4000).join(" ")}]]):gmatch("%S+") do t[#t + 1] = name end`);
  }
}

const [value] = await evalLua(`
  local B = __bridge
  local level = B.level
  local function first(list)
    local found
    if list and list.forEach then list:forEach(function(item) if found == nil then found = item end end) end
    return found
  end
  local function componentOf(object, kind)
    local found
    object:forEachComponent(function(c) if found == nil and c:getComponentType() == kind then found = c end end)
    return found
  end
  local function manager(kind)
    local root = level:find("COMP_BUILDING_MANAGER"):getOwner()
    while root:getParent() do root = root:getParent() end
    local found = componentOf(root, kind)
    if not found then
      root:forEachChildRecursive(function(child)
        if found then return false end
        found = componentOf(child, kind)
      end)
    end
    return found
  end

  local MAX_DEPTH, MAX_ITEMS = ${depth}, ${items}
  local function get(object, key)
    local ok, value = pcall(function() return object[key] end)
    if ok then return value end
  end
  local describe
  -- A short label for something we are not going to open.
  local function brief(value)
    if get(value, "getGlobalPosition") then return "<object " .. tostring(get(value, "Name")) .. ">" end
    if get(value, "getComponentType") then
      local owner = value:getOwner()
      return "<component " .. tostring(value:getComponentType()) .. " on " .. tostring(owner and owner.Name) .. ">"
    end
    local name = get(value, "Name") or get(value, "ResourceName") or get(value, "JobName") or get(value, "NeedTypeName") or get(value, "VillageName")
    return "<" .. (type(name) == "string" and name ~= "" and name or "object") .. ">"
  end
  describe = function(value, depth)
    local kind = type(value)
    if kind == "table" then
      local out, n = {}, 0
      for key, item in pairs(value) do
        if type(key) == "userdata" then key = describe(key, depth + 1) end
        if type(key) ~= "string" and type(key) ~= "number" then key = "?" end
        out[key] = describe(item, depth + 1)
        n = n + 1
      end
      return n == #value and B.array(out) or out
    end
    if kind ~= "userdata" then return value end
    local named, toString = pcall(function() return value.toString end)
    if not named then
      local list = B.array()
      for i = 1, 16 do
        local ok, item = pcall(function() return value[i] end)
        if not ok or item == nil then break end
        list[i] = describe(item, depth + 1)
      end
      return list
    end
    if toString and value.toNumber then return value:toString() end
    if value.forEach then
      local shown, total = B.array(), 0
      value:forEach(function(item)
        total = total + 1
        if total <= MAX_ITEMS then shown[#shown + 1] = describe(item, depth + 1) end
      end)
      if total > MAX_ITEMS then shown[#shown + 1] = "... " .. total .. " in total" end
      return shown
    end
    -- Components and game objects are only opened when asked for directly.
    if depth >= MAX_DEPTH or (depth > 0 and (get(value, "getGlobalPosition") or get(value, "getComponentType"))) then
      return brief(value)
    end
    local out = {}
    for _, name in ipairs(B.inspectNames) do
      local item = value[name]
      if item ~= nil then out[name] = describe(item, depth + 1) end
    end
    return out
  end
  local target = (function() return ${expression} end)()
  if target == nil then return "nil" end
  return describe(target, 0)
`);
console.log(JSON.stringify(value, null, 1));
