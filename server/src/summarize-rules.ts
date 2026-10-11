// Boils the raw dump in docs/rules down to what an advisor needs:
// docs/rules-summary.json with, per building, what it costs, who works there
// and what it turns into what. Run `pnpm dump-rules` first.
//
// Resources are named as the running game names them in inventories
// (ResourceName, e.g. PLANKS), not by asset id (PLANK).
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_DIR } from "./config.ts";

const RULES_DIR = join(PROJECT_DIR, "docs", "rules");

type Json = Record<string, any>;

const byType = new Map<string, Record<string, Json>>();
const byId = new Map<string, Json>();
for (const file of await readdir(RULES_DIR)) {
  const assets = JSON.parse(await readFile(join(RULES_DIR, file), "utf8")) as Record<string, Json>;
  byType.set(file.replace(/\.json$/, ""), assets);
  for (const [id, asset] of Object.entries(assets)) byId.set(id, asset);
}

/** Follows a {"$ref": id} to the asset it names; returns inline objects as they are. */
function resolve(value: Json | undefined): Json | undefined {
  return value?.$ref ? byId.get(value.$ref) : value;
}

function resourceName(reference: Json | undefined): string {
  return resolve(reference)?.ResourceName ?? reference?.$ref ?? "?";
}

/** {Collection: [{Resource, Quantity}]} -> {NAME: quantity}, adding to `into`. */
function amounts(collection: Json | undefined, into: Record<string, number> = {}): Record<string, number> {
  for (const pair of collection?.Collection ?? []) {
    const name = resourceName(pair.Resource);
    into[name] = (into[name] ?? 0) + pair.Quantity;
  }
  return into;
}

const present = (record: Record<string, number>) => (Object.keys(record).length ? record : undefined);

function workplace(fn: Json | undefined) {
  if (!fn) return undefined;
  const recipes = (fn.AssetWorkplaceRecipeList ?? [])
    .map(resolve)
    .filter(Boolean)
    .map((recipe: Json) => ({ consumes: amounts(recipe.ResourceListNeeded), produces: amounts(recipe.ResourceListProduced) }))
    .filter((recipe: { consumes: object; produces: object }) => Object.keys(recipe.consumes).length + Object.keys(recipe.produces).length);
  const job = resolve(fn.RelatedJob?.Job)?.JobName;
  if (!recipes.length && !job && !fn.WorkerCapacity) return undefined;
  return {
    job,
    workers: fn.WorkerCapacity || undefined,
    cycleSeconds: fn.ProductionCycleDurationInSec || undefined,
    recipes: recipes.length ? recipes : undefined,
  };
}

function cost(part: Json | undefined) {
  const data = part?.Cost;
  if (!data) return undefined;
  const materials: Record<string, number> = {};
  for (const step of data.ResourceNeededList ?? []) amounts(step, materials);
  const result = { permit: present(amounts(data.BuildRightTaxes)), materials: present(materials), upkeep: present(amounts(data.UpkeepCost)) };
  return result.permit || result.materials || result.upkeep ? result : undefined;
}

const buildings = Object.entries(byType.get("BUILDING") ?? {}).map(([id, building]) => {
  const core = resolve(building.AssetCoreBuildingPart);
  const fn = resolve(building.BuildingFunction) ?? resolve(core?.AssetBuildingFunction);
  return {
    id,
    name: building.Name,
    type: building.BuildingType,
    function: building.BuildingFunction?.$ref ?? core?.AssetBuildingFunction?.$ref,
    ...workplace(fn),
    cost: cost(core),
  };
});

const resources = Object.entries(byType.get("RESOURCE") ?? {}).map(([id, resource]) => ({
  id,
  name: resource.ResourceName,
  types: resource.ResourceTypeList?.length ? resource.ResourceTypeList : undefined,
  buyFor: present(amounts(resource.TradeBuyingPrice)),
  sellFor: present(amounts(resource.TradeSellingPrice)),
}));

const summary = { buildings, resources };
const file = join(PROJECT_DIR, "docs", "rules-summary.json");
await writeFile(file, JSON.stringify(summary, null, 1) + "\n");
const withRecipes = buildings.filter((building) => building.recipes).length;
const withCost = buildings.filter((building) => building.cost).length;
console.log(`${buildings.length} buildings (${withRecipes} with recipes, ${withCost} with costs), ${resources.length} resources -> ${file}`);
