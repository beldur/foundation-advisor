// Condenses a state snapshot into a short briefing for the advisor.
//
// The model reasons well about a village described in a page of facts and
// badly about hundreds of villagers' raw need lists, so the counting and
// arithmetic are done here.
import type { GameEvent } from "./events.ts";

type Amounts = Record<string, number>;

/** The parts of the snapshot the briefing reads. See B.snapshot in bridge/bridge.lua. */
export interface Snapshot {
  time?: { day: number; timeScale: number };
  village?: { name?: string; level?: number; happiness?: number; needsFilledPercent?: number; leaveBelowHappiness?: number; villagersLeaving?: number; unlockedSystems?: string[] };
  villagers?: {
    id: string;
    name: string;
    job?: string;
    idle?: boolean;
    leaving?: boolean;
    needs?: { need?: string; lacking: boolean; penaltyInSeconds?: number; wants?: string }[];
    happiness?: { factor?: string; value: number }[];
  }[];
  buildings?: { id: string; name: string; customName?: string; type?: string; parts: number; partsBuilt: number; status?: string[] }[];
  workplaces?: { building?: string; name: string; paused?: boolean; workers: string[]; workerCapacity?: number; lacking?: string[]; waiting?: Amounts; producedThisWeek?: Amounts }[];
  depots?: { input?: Amounts; output?: Amounts }[];
  houses?: { residents: string[]; density: number; status: number; readyForUpgrade?: boolean; readyForStatusUpgrade?: boolean }[];
  resources?: Record<string, { trade?: string; tradeAmount?: number; produced?: number; consumed?: number; traded?: number }>;
  economy?: { dailyWealthAverage?: number; weeks?: { income: Record<string, Amounts>; expenses: Record<string, Amounts> }[] };
  notifications?: { title?: string; category?: string; targets: number }[];
  tradeRoutes?: { name: string; open: boolean; level?: number; buys: string[]; sells: string[] }[];
  territory?: { owned: string[]; nextTax?: number };
  taxes?: { name?: string; active?: boolean; bracket?: number }[];
  unlockables?: { name?: string; bought: number; daysUntilAvailable?: number }[];
  estates?: { name?: string; influence: number; splendor: number }[];
  immigration?: { daysUntilNext: number; enabled: boolean };
  scores?: { splendor?: number };
}

/** One building from docs/rules-summary.json. */
export interface BuildingRule {
  id: string;
  name?: string;
  type?: string;
  job?: string;
  workers?: number;
  cycleSeconds?: number;
  recipes?: { consumes: Amounts; produces: Amounts }[];
  cost?: { permit?: Amounts; materials?: Amounts; upkeep?: Amounts };
}

export interface Rules {
  buildings: BuildingRule[];
}

const label = (name: string | undefined) => (name ?? "?").replace(/_/g, " ").toLowerCase();
// The well reports the largest 32-bit number: it never runs out.
const UNLIMITED = 1_000_000_000;
const round = (value: number) => Math.round(value * 10) / 10;
const amounts = (record: Amounts | undefined) =>
  Object.entries(record ?? {}).map(([name, quantity]) => `${round(quantity)} ${label(name)}`).join(", ") || "nothing";
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function tally<T>(items: T[], key: (item: T) => string | undefined): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = key(item);
    if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function sumCategories(side: Record<string, Amounts> | undefined): { byCategory: string[]; gold: number } {
  let gold = 0;
  const byCategory: string[] = [];
  for (const [category, moved] of Object.entries(side ?? {})) {
    gold += moved.GOLD_COINS ?? 0;
    byCategory.push(`${label(category)} ${amounts(moved)}`);
  }
  return { byCategory, gold };
}

/** Rules worth sending: buildings the village has, and ones that make something it is short of. */
function relevantRules(snapshot: Snapshot, rules: Rules, shortOf: Set<string>): BuildingRule[] {
  const present = new Set((snapshot.buildings ?? []).map((building) => building.name));
  const chosen = rules.buildings.filter((rule) => {
    if (rule.name && present.has(rule.name)) return true;
    return (rule.recipes ?? []).some((recipe) => Object.keys(recipe.produces).some((resource) => shortOf.has(resource)));
  });
  // One entry per building name; DLC variants repeat names.
  const seen = new Set<string>();
  return chosen.filter((rule) => !seen.has(rule.name ?? rule.id) && seen.add(rule.name ?? rule.id)).slice(0, 30);
}

function ruleLine(rule: BuildingRule): string {
  const parts = [`${label(rule.name)}`];
  if (rule.workers) parts.push(`${plural(rule.workers, label(rule.job ?? "worker"))}`);
  for (const recipe of rule.recipes ?? []) {
    const every = rule.cycleSeconds ? ` every ${rule.cycleSeconds}s` : "";
    const inputs = Object.keys(recipe.consumes);
    // Gatherers are written as consuming the thing they collect from the map.
    const gathers = inputs.length === 0 || (inputs.length === 1 && inputs[0]! in recipe.produces);
    parts.push(gathers ? `collects ${amounts(recipe.produces)} from the map${every}` : `turns ${amounts(recipe.consumes)} into ${amounts(recipe.produces)}${every}`);
  }
  if (rule.cost) {
    const cost = [rule.cost.permit && `permit ${amounts(rule.cost.permit)}`, rule.cost.materials && `materials ${amounts(rule.cost.materials)}`, rule.cost.upkeep && `upkeep ${amounts(rule.cost.upkeep)}`].filter(Boolean);
    if (cost.length) parts.push(`costs ${cost.join("; ")}`);
  }
  return `- ${parts.join("; ")}`;
}

/** The briefing as plain text, one fact per line under short headings. */
export function buildBriefing(snapshot: Snapshot, rules: Rules, events: GameEvent[] = []): string {
  const villagers = snapshot.villagers ?? [];
  const buildings = snapshot.buildings ?? [];
  const workplaces = snapshot.workplaces ?? [];
  const lines: string[] = [];
  const section = (title: string, body: string[]) => {
    if (body.length) lines.push(`## ${title}`, ...body, "");
  };

  // --- Overview
  const village = snapshot.village;
  const housed = new Set((snapshot.houses ?? []).flatMap((house) => house.residents));
  const homeless = snapshot.houses ? villagers.filter((villager) => !housed.has(villager.id)).length : undefined;
  const overview = [
    `Village: ${village?.name ?? "unknown"}, level ${village?.level ?? "?"}, day ${snapshot.time?.day ?? "?"}.`,
    `Population: ${villagers.length}, of whom ${villagers.filter((villager) => !villager.job).length} have no job${homeless === undefined ? "" : ` and ${homeless} have no house`}.`,
  ];
  if (village?.happiness !== undefined) {
    overview.push(`Happiness: ${round(village.happiness)}. Villagers leave below ${village.leaveBelowHappiness}. ${village.villagersLeaving ?? 0} are leaving now.`);
  }
  if (village?.needsFilledPercent !== undefined) overview.push(`Needs met: ${Math.round(village.needsFilledPercent)}%.`);
  if (snapshot.immigration) overview.push(snapshot.immigration.enabled ? `Next newcomers in ${plural(snapshot.immigration.daysUntilNext, "day")}.` : "Immigration is paused.");
  if (village?.unlockedSystems) overview.push(`Game systems unlocked: ${village.unlockedSystems.map(label).join(", ")}.`);
  section("Overview", overview);

  // --- What the game itself is flagging
  section("Warnings shown by the game", (snapshot.notifications ?? []).map((notification) =>
    `- ${label(notification.title)}${notification.targets > 1 ? ` (${notification.targets} affected)` : ""}`));

  // --- Buildings in trouble
  const quiet = new Set(["WORKPLACE_WORKING", "NONE", "PART_NORMAL"]);
  const problems = new Map<string, string[]>();
  const report = (problem: string, where: string) => problems.set(problem, [...(problems.get(problem) ?? []), where]);
  const nameOf = new Map(buildings.map((building) => [building.id, label(building.customName || building.name)]));
  for (const building of buildings) {
    for (const status of building.status ?? []) if (!quiet.has(status)) report(label(status.replace(/^WORKPLACE_/, "")), label(building.customName || building.name));
  }
  for (const workplace of workplaces) {
    const where = nameOf.get(workplace.building ?? "") ?? label(workplace.name);
    for (const resource of workplace.lacking ?? []) report(`lacks ${label(resource)}`, where);
    if (workplace.paused) report("paused", where);
    if (workplace.workerCapacity && workplace.workers.length < workplace.workerCapacity) {
      report("has free worker slots", `${where} (${workplace.workers.length}/${workplace.workerCapacity})`);
    }
  }
  section("Building problems", [...problems].map(([problem, where]) => `- ${problem}: ${where.join(", ")}`));

  // --- Needs
  const unmet = new Map<string, { count: number; soonest: number; wants: Set<string> }>();
  for (const villager of villagers) {
    for (const need of villager.needs ?? []) {
      if (!need.lacking) continue;
      const entry = unmet.get(need.need ?? "?") ?? { count: 0, soonest: Infinity, wants: new Set<string>() };
      entry.count += 1;
      entry.soonest = Math.min(entry.soonest, need.penaltyInSeconds ?? Infinity);
      if (need.wants) entry.wants.add(need.wants);
      unmet.set(need.need ?? "?", entry);
    }
  }
  const shortOf = new Set<string>();
  section("Unmet needs", [...unmet].sort((a, b) => b[1].count - a[1].count).map(([need, entry]) => {
    for (const resource of entry.wants) shortOf.add(resource);
    const urgency = entry.soonest <= 0 ? "already costing happiness for some" : Number.isFinite(entry.soonest) ? `first penalty in ${Math.round(entry.soonest / 60)} min` : "";
    const wants = entry.wants.size ? `; they are looking for ${[...entry.wants].map(label).join(", ")}` : "";
    return `- ${label(need)}: ${entry.count} of ${villagers.length} villagers${urgency ? `, ${urgency}` : ""}${wants}`;
  }));

  // --- Happiness factors, averaged over the villagers they apply to
  const factors = new Map<string, { total: number; count: number }>();
  for (const villager of villagers) {
    for (const factor of villager.happiness ?? []) {
      if (!factor.value) continue;
      const entry = factors.get(factor.factor ?? "?") ?? { total: 0, count: 0 };
      entry.total += factor.value;
      entry.count += 1;
      factors.set(factor.factor ?? "?", entry);
    }
  }
  section("What moves happiness", [...factors].sort((a, b) => a[1].total - b[1].total).map(([factor, entry]) =>
    `- ${label(factor.replace(/^(HAPPINESS_)?FACTOR_/, ""))}: ${round(entry.total / entry.count)} each for ${plural(entry.count, "villager")}`));

  // --- Money
  const stock: Amounts = {};
  for (const depot of snapshot.depots ?? []) {
    for (const side of [depot.input, depot.output]) for (const [name, quantity] of Object.entries(side ?? {})) stock[name] = (stock[name] ?? 0) + quantity;
  }
  const money: string[] = [`Gold coins in hand: ${round(stock.GOLD_COINS ?? 0)}.`];
  const weeks = snapshot.economy?.weeks ?? [];
  for (const [index, name] of [[weeks.length - 1, "This week so far"], [weeks.length - 2, "Last week"]] as const) {
    const week = weeks[index];
    if (!week) continue;
    const income = sumCategories(week.income), expenses = sumCategories(week.expenses);
    money.push(`${name}: income ${income.byCategory.join("; ") || "none"}. Expenses ${expenses.byCategory.join("; ") || "none"}. Net ${round(income.gold - expenses.gold)} gold.`);
  }
  if (snapshot.economy?.dailyWealthAverage !== undefined) money.push(`Average daily change in wealth: ${round(snapshot.economy.dailyWealthAverage)}.`);
  const taxes = (snapshot.taxes ?? []).filter((tax) => tax.active && !/COMPANION_BRIDGE/.test(tax.name ?? ""));
  if (taxes.length) money.push(`Taxes in force: ${taxes.map((tax) => `${label(tax.name)}${tax.bracket === undefined ? "" : ` at bracket ${tax.bracket + 1}`}`).join(", ")}.`);
  section("Money", money);

  // --- Resources: stock and this week's flow
  const resourceNames = new Set([...Object.keys(stock), ...Object.entries(snapshot.resources ?? {}).filter(([, r]) => r.produced || r.consumed || r.traded).map(([name]) => name)]);
  resourceNames.delete("GOLD_COINS");
  section("Resources (in storage; this week produced, used, traded)", [...resourceNames].sort().map((name) => {
    const flow = snapshot.resources?.[name];
    const produced = flow?.produced ?? 0, consumed = flow?.consumed ?? 0;
    if (consumed > produced) shortOf.add(name);
    const trade = flow?.trade && flow.trade !== "NO_TRADE" ? `, set to ${label(flow.trade)}` : "";
    const stored = (stock[name] ?? 0) >= UNLIMITED ? "unlimited" : `${round(stock[name] ?? 0)} stored`;
    return `- ${label(name)}: ${stored}; +${round(produced)} −${round(consumed)}${flow?.traded ? `, ${round(flow.traded)} traded` : ""}${trade}`;
  }));

  // --- People and buildings
  section("Jobs", tally(villagers, (villager) => villager.job ?? "NO_JOB").map(([job, count]) => `- ${label(job)}: ${count}`));
  section("Buildings", tally(buildings, (building) => building.name).map(([name, count]) => {
    const unfinished = buildings.filter((building) => building.name === name && building.partsBuilt < building.parts).length;
    return `- ${label(name)}: ${count}${unfinished ? ` (${unfinished} under construction)` : ""}`;
  }));
  if (snapshot.houses) {
    const ready = snapshot.houses.filter((house) => house.readyForUpgrade || house.readyForStatusUpgrade).length;
    section("Housing", [`${plural(snapshot.houses.length, "house")} with ${housed.size} residents; ${homeless} villagers have no house.${ready ? ` ${plural(ready, "house")} ready to upgrade.` : ""}`]);
  }

  // --- Options
  const options: string[] = [];
  if (snapshot.territory) options.push(`Regions owned: ${snapshot.territory.owned.length}.`);
  const routes = snapshot.tradeRoutes ?? [];
  for (const route of routes.filter((candidate) => candidate.open)) {
    options.push(`Trade route open with ${label(route.name)}: it buys ${route.buys.map(label).join(", ")}; it sells ${route.sells.map(label).join(", ")}.`);
  }
  const closed = routes.filter((route) => !route.open).map((route) => label(route.name));
  if (closed.length) options.push(`Trade routes not opened yet: ${closed.join(", ")}.`);
  const bought = (snapshot.unlockables ?? []).filter((unlockable) => unlockable.bought > 0).map((unlockable) => label(unlockable.name));
  if (bought.length) options.push(`Unlocked on the progress screen: ${bought.join(", ")}.`);
  for (const estate of snapshot.estates ?? []) options.push(`Estate ${label((estate.name ?? "").replace(/^Estate/, ""))}: influence ${round(estate.influence)}, splendor ${round(estate.splendor)}.`);
  section("Options and progress", options);

  section("Recent events", events.filter((event) => event.kind !== "new-day").slice(-10).map((event) => `- ${event.text}`));

  section("Rules for relevant buildings", relevantRules(snapshot, rules, shortOf).map(ruleLine));

  return lines.join("\n").trim();
}
