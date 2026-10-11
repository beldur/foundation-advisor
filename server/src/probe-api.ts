// Finds out what each kind of game object answers to.
//
// Game objects serve their members through a C function, so they can't be
// listed. But asking for a name an object lacks just returns nil, and the game
// binary contains every bound name as a plain string. So: take every
// identifier-shaped string in the binary as a candidate and ask each object.
//
//   pnpm probe-api                 probe the targets below
//   pnpm probe-api --properties    also ask for capitalised names (runs getters)
//   pnpm probe-api --only A,B      probe only the named targets
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GAME_DIR, HOST, HTTP_PORT, PROJECT_DIR } from "./config.ts";

const OUT_DIR = join(PROJECT_DIR, "docs", "api");
const withProperties = process.argv.includes("--properties");
/** `--only A,B` probes just those targets. */
const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1]?.split(",")) : null;

/** Lua expressions that produce one object of each kind, given `level`. */
const TARGETS: Record<string, string> = {
  LEVEL: "level",
  GAME: "level:getGame()",
  COMPONENT_MANAGER: "level:getComponentManager('COMP_VILLAGER')",
  GAME_OBJECT: "level:getComponentManager('COMP_VILLAGER'):getFirst():getOwner()",
  COMP_VILLAGER: "level:getComponentManager('COMP_VILLAGER'):getFirst()",
  COMP_AGENT: "level:getComponentManager('COMP_VILLAGER'):getFirst():getOwner():getComponent('COMP_AGENT')",
  COMP_BUILDING: "level:getComponentManager('COMP_BUILDING'):getFirst()",
  COMP_BUILDING_PART: "level:getComponentManager('COMP_BUILDING_PART'):getFirst()",
  COMP_MAIN_GAME_LOOP: "level:find('COMP_MAIN_GAME_LOOP')",
  COMP_WORKPLACE: "level:getComponentManager('COMP_WORKPLACE'):getFirst()",
  COMP_RESOURCE_DEPOT: "level:getComponentManager('COMP_RESOURCE_DEPOT'):getFirst()",
  COMP_RESOURCE_STOCKPILE: "level:getComponentManager('COMP_RESOURCE_STOCKPILE'):getFirst()",
  COMP_RESOURCE_CONTAINER: "level:getComponentManager('COMP_RESOURCE_CONTAINER'):getFirst()",
  COMPONENT_LIST: "level:getComponentManager('COMP_VILLAGER'):getAllComponent()",
  ASSET_BUILDING: "level:getComponentManager('COMP_BUILDING'):getFirst().AssetBuilding",
  BUILDING_DATA: "level:getComponentManager('COMP_BUILDING'):getFirst().BuildingData",
  INVENTORY: "level:getComponentManager('COMP_RESOURCE_DEPOT'):getFirst().OutputInventory",
  WORKER_LIST: "level:getComponentManager('COMP_WORKPLACE'):getFirst().AssignedWorkerList",
  RESOURCE_CONTAINER_DATA: "level:getComponentManager('COMP_RESOURCE_CONTAINER'):getFirst().ResourceContainerData",
  AGENT_PROFILE: "level:getComponentManager('COMP_AGENT'):getFirst():getProfile()",
  INVENTORY_DATA: "level:getComponentManager('COMP_RESOURCE_DEPOT'):getFirst().OutputInventory.Inventory",
  BUILDING_ZONE_DATA: "level:getComponentManager('COMP_BUILDING_ZONE'):getFirst().BuildingZone",
  QUEST_LIST: "__bridge.samples['PlaCCompQuestManager'].QuestList",
  TRADING_VILLAGE: "__bridge.samples['PlaCCompTradingVillage'].TradingVillage",
  PRODUCTION_PROGRESS_ITEM: "firstIn('COMP_WORKPLACE', 'ActiveVillagerProductionProgressList')",
  PRODUCTION_AMOUNT_ITEM: "firstIn('COMP_WORKPLACE', 'CurrentProductionAmountList')",
  PRODUCED_QUEUE_ITEM: "firstIn('COMP_WORKPLACE', 'CurrentlyProducedResourcesQueue')",
  QUEST_ITEM: "first(__bridge.samples['PlaCCompQuestManager'].QuestList)",
  STATE_ITEM: "first(__bridge.samples['PlaCCompStateMachine'].States)",
  JOB_INSTANCE: "level:getComponentManager('COMP_VILLAGER'):getFirst():getJobInstance()",
  NEED_INSTANCE: "firstIn('COMP_AGENT_NEED_PROCESSOR', 'NeedInstanceList')",
  HAPPINESS_FACTOR_INSTANCE: "first(__bridge.samples['PlaCCompHappinessFactorProcessor'].HappinessFactorList)",
  BUDGET_INFO: "first(__bridge.samples['PlaCCompEconomyManager'].DailyBudgetInfoList)",
  RESOURCE_STAT: "first(__bridge.samples['PlaCCompEconomyManager'].ResourceStatList)",
  SCORE_TRACKER_DATA: "first(__bridge.samples['PlaCCompGlobalScore'].ScoreTrackerDataList)",
  BUDGET_TRANSACTION: "first(first(__bridge.samples['PlaCCompEconomyManager'].WeeklyBudgetInfoList).IncomeTransactionList) or first(first(__bridge.samples['PlaCCompEconomyManager'].WeeklyBudgetInfoList).ExpenseTransactionList)",
  TERRITORY_REGION: "first(__bridge.samples['PlaCCompTerritoryManager'].RegionList)",
  HOUSE_VILLAGER: "first(__bridge.samples['PlaCCompHouse'].VillagerList)",
  AGENT_GENDER: "level:getComponentManager('COMP_AGENT'):getFirst().Gender",
};

// Component types named in the binary; each is looked up with level:find.
const COMPONENT_TYPES = [
  "COMP_ACCOMMODATION",
  "COMP_AGENT_NEED_PROCESSOR",
  "COMP_BAILIFF_OFFICE",
  "COMP_BUILDER_WORKSHOP",
  "COMP_BUILDING_ATTACH_NODE",
  "COMP_BUILDING_MANAGER",
  "COMP_BUILDING_ZONE",
  "COMP_CROP_FIELD_ELEMENT",
  "COMP_ENCAMPMENT",
  "COMP_ENVIRONMENT_SYSTEM",
  "COMP_FARM",
  "COMP_FARM_LIVESTOCK",
  "COMP_GUEST",
  "COMP_HAPPINESS_GIVER",
  "COMP_HEALING_HOUSE",
  "COMP_IMMIGRATION_MANAGER",
  "COMP_INTERACTIVE_LOCATION",
  "COMP_INVENTORY",
  "COMP_LIVESTOCK",
  "COMP_LODGING",
  "COMP_MANDATE_MANAGER",
  "COMP_MANDATE_OFFICE",
  "COMP_MARKET_TENT",
  "COMP_PLANTABLE",
  "COMP_RESOURCE_GENERATOR",
  "COMP_RESOURCE_TO_PICKUP",
  "COMP_SOLDIER",
  "COMP_TAXATION_MANAGER",
  "COMP_TAX_COLLECTABLE",
  "COMP_TRADER",
  "COMP_TREE",
  "COMP_VEHICLE",
  "COMP_VILLAGER_MANAGER",
  "COMP_VISITOR",
  "COMP_WORKPLACE_FORESTER",
  "COMP_WORKPLACE_KITCHEN",
  "COMP_WORKPLACE_TAX_OFFICE",
];
for (const type of COMPONENT_TYPES) TARGETS[type] ??= `level:find('${type}')`;

async function evalLua(code: string): Promise<unknown[]> {
  const response = await fetch(`http://${HOST}:${HTTP_PORT}/eval`, { method: "POST", body: code });
  const result = (await response.json()) as { ok: boolean; values?: unknown[]; error?: string };
  if (!result.ok) throw new Error(result.error);
  return result.values ?? [];
}

async function candidateNames(): Promise<string[]> {
  const binary = (await readFile(join(GAME_DIR, "foundation.exe"))).toString("latin1");
  const names = new Set<string>();
  // Bound names are stored as zero-terminated ASCII identifiers.
  for (const match of binary.matchAll(/(?<=\0)[A-Za-z][A-Za-z0-9_]{2,63}(?=\0)/g)) {
    const name = match[0];
    const isConstant = /^[A-Z0-9_]+$/.test(name) && !name.startsWith("ON_");
    if (isConstant) continue;
    if (!withProperties && /^[A-Z]/.test(name) && !name.startsWith("ON_")) continue;
    names.add(name);
  }
  return [...names].sort();
}

const names = await candidateNames();
console.log(`${names.length} candidate names from the binary`);

await evalLua("__bridge.candidates = {}");
for (let i = 0; i < names.length; i += 4000) {
  const chunk = names.slice(i, i + 4000).join(" ");
  await evalLua(`local c = __bridge.candidates; for name in ([[${chunk}]]):gmatch("%S+") do c[#c + 1] = name end`);
}

// Many components are not in the documented list; they show up under the
// engine's class names (PlaCComp..., GamCComp...). Walk the object trees and
// keep one instance of every component type found.
const [crawl] = (await evalLua(`
  local level = __bridge.level
  local samples, roots, visited = {}, {}, 0
  local function note(component)
    local ok, name = pcall(function() return component:getComponentType() end)
    if ok and type(name) == "string" and samples[name] == nil then samples[name] = component end
  end
  local function visit(object)
    visited = visited + 1
    object:forEachComponent(note)
  end
  for _, componentType in ipairs({ ${[...new Set(["COMP_VILLAGER", "COMP_BUILDING", "COMP_TREE", "COMP_RESOURCE_CONTAINER", "COMP_VISITOR", "COMP_MAIN_GAME_LOOP", "COMP_BUILDING_MANAGER", "COMP_ENVIRONMENT_SYSTEM", "COMP_PLANTABLE"])].map((t) => `"${t}"`).join(", ")} }) do
    local ok, first = pcall(function() return level:find(componentType) end)
    if ok and first then
      local root = first:getOwner()
      while root:getParent() do root = root:getParent() end
      roots[root:getId()] = root
    end
  end
  local rootNames = {}
  for _, root in pairs(roots) do
    rootNames[#rootNames + 1] = root.Name
    local startedAt = visited
    visit(root)
    root:forEachChildRecursive(function(child)
      if visited - startedAt >= (root.Name == 'Trees' and 2000 or 80000) then return false end
      visit(child)
    end)
  end
  __bridge.samples = samples
  local names = {}
  for name in pairs(samples) do names[#names + 1] = name end
  table.sort(names)
  return { roots = rootNames, visited = visited, types = __bridge.array(names) }
`)) as [{ roots: string[]; visited: number; types: string[] }];
console.log(`walked ${crawl.visited} objects under ${JSON.stringify(crawl.roots)}; ${crawl.types.length} component types`);
for (const type of crawl.types) TARGETS[type] ??= `__bridge.samples[${JSON.stringify(type)}]`;

await mkdir(OUT_DIR, { recursive: true });
for (const [kind, expression] of Object.entries(TARGETS)) {
  if (only && !only.has(kind)) continue;
  let found: Record<string, string> | null;
  try {
    [found] = (await evalLua(`
      local level = __bridge.level
      -- First element of a game list, and of that list property across all components of a type.
      local function first(list)
        local found
        if list and list.forEach then list:forEach(function(item) if found == nil then found = item end end) end
        return found
      end
      local function firstIn(componentType, property)
        local found
        level:getComponentManager(componentType):getAllComponent():forEach(function(component)
          if found == nil then found = first(component[property]) end
        end)
        return found
      end
      local ok, target = pcall(function() return ${expression} end)
      if not ok or target == nil then return nil end
      local found = {}
      for _, name in ipairs(__bridge.candidates) do
        local ok, value = pcall(function() return target[name] end)
        if ok and value ~= nil then found[name] = type(value) end
      end
      return found
    `)) as [Record<string, string> | null];
  } catch (error) {
    console.log(`${kind}: failed (${error})`);
    continue;
  }
  if (!found) {
    console.log(`${kind}: no such object in this level`);
    continue;
  }
  const members = Object.keys(found).sort();
  const sorted = Object.fromEntries(members.map((name) => [name, found[name]]));
  await writeFile(join(OUT_DIR, `${kind}.json`), JSON.stringify(sorted, null, 2) + "\n");
  console.log(`${kind}: ${members.length} members`);
}
await evalLua("__bridge.candidates = nil; __bridge.samples = nil");
