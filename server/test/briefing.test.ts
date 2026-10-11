import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBriefing, type Rules, type Snapshot } from "../src/briefing.ts";

const rules: Rules = {
  buildings: [
    { id: "BUILDING_SAWMILL", name: "SAWMILL", job: "CARPENTER", workers: 3, cycleSeconds: 30, recipes: [{ consumes: { WOOD: 1 }, produces: { PLANKS: 1 } }], cost: { permit: { GOLD_COINS: 10 }, materials: { WOOD: 20, STONES: 10 }, upkeep: { GOLD_COINS: 1 } } },
    { id: "BUILDING_WELL", name: "WELL", recipes: [{ consumes: {}, produces: { WATER: 1 } }], cost: { materials: { STONES: 5 } } },
    { id: "BUILDING_BAKERY", name: "BAKERY", recipes: [{ consumes: { FLOUR: 3 }, produces: { BREAD: 5 } }] },
  ],
};

const snapshot: Snapshot = {
  time: { day: 167, timeScale: 1 },
  village: { name: "Kreuzfeld", level: 1, happiness: 77, leaveBelowHappiness: -50, villagersLeaving: 0, needsFilledPercent: 91 },
  villagers: [
    { id: "a", name: "Tetsy", job: "MINER", needs: [{ need: "WATER", lacking: true, penaltyInSeconds: 0, wants: "WATER" }, { need: "FOOD", lacking: false }], happiness: [{ factor: "TAXES", value: -15 }, { factor: "FACTOR_BASE_HAPPINESS", value: 0 }] },
    { id: "b", name: "Gawyn", needs: [{ need: "WATER", lacking: true, penaltyInSeconds: 600, wants: "WATER" }], happiness: [{ factor: "TAXES", value: -15 }] },
  ],
  buildings: [
    { id: "s", name: "SAWMILL", parts: 1, partsBuilt: 1, status: ["WORKPLACE_STORAGE_FULL"] },
    { id: "l", name: "LUMBER_CAMP", parts: 2, partsBuilt: 1, status: ["WORKPLACE_WORKING"] },
  ],
  workplaces: [{ building: "s", name: "SawmillCorePart", workers: ["a"], workerCapacity: 3, lacking: ["WOOD"] }],
  depots: [{ output: { GOLD_COINS: 410, PLANKS: 28, WATER: 2147483647 } }, { input: { WOOD: 3 }, output: { PLANKS: 2 } }],
  houses: [{ residents: ["a"], density: 0, status: 0 }],
  resources: { PLANKS: { produced: 40, consumed: 10 }, WOOD: { produced: 5, consumed: 40, trade: "SELL" } },
  economy: { dailyWealthAverage: -2, weeks: [{ income: { TAXES: { GOLD_COINS: 20 } }, expenses: {} }, { income: { TAXES: { GOLD_COINS: 31 } }, expenses: { UPKEEP: { GOLD_COINS: 10 } } }] },
  notifications: [{ title: "HOUSING_INSUFFICIENT", category: "VILLAGERS", targets: 8 }],
  tradeRoutes: [{ name: "NORTHBURY", open: true, buys: ["PLANKS"], sells: ["TOOLS"] }, { name: "MYDDLE", open: false, buys: [], sells: [] }],
  territory: { owned: ["region 1", "region 2"] },
  taxes: [{ name: "RESIDENTIAL_TAXES", active: true }, { name: "COMPANION_BRIDGE_TAXATION_NAME", active: true, bracket: 0 }],
};

const briefing = buildBriefing(snapshot, rules, [{ kind: "building-completed", text: "Finished building: sawmill" }, { kind: "new-day", text: "Day 167 began" }]);

test("the overview counts people, jobs and homes", () => {
  assert.match(briefing, /Village: Kreuzfeld, level 1, day 167\./);
  assert.match(briefing, /Population: 2, of whom 1 have no job and 1 have no house\./);
  assert.match(briefing, /Happiness: 77\. Villagers leave below -50\./);
});

test("needs are counted per need with urgency and what is wanted", () => {
  assert.match(briefing, /- water: 2 of 2 villagers, already costing happiness for some; they are looking for water/);
  assert.doesNotMatch(briefing, /- food:/);
});

test("building problems group buildings under each problem", () => {
  assert.match(briefing, /- storage full: sawmill/);
  assert.match(briefing, /- lacks wood: sawmill/);
  assert.match(briefing, /- has free worker slots: sawmill \(1\/3\)/);
  assert.doesNotMatch(briefing, /working: /);
});

test("money shows both weeks with a net figure and hides the bridge's placeholder tax", () => {
  assert.match(briefing, /Gold coins in hand: 410\./);
  assert.match(briefing, /This week so far: income taxes 31 gold coins\. Expenses upkeep 10 gold coins\. Net 21 gold\./);
  assert.match(briefing, /Last week: income taxes 20 gold coins\. Expenses none\. Net 20 gold\./);
  assert.match(briefing, /Taxes in force: residential taxes\./);
  assert.doesNotMatch(briefing, /companion/i);
});

test("resources combine stock across depots with the week's flow", () => {
  assert.match(briefing, /- planks: 30 stored; \+40 −10/);
  assert.match(briefing, /- wood: 3 stored; \+5 −40, set to sell/);
  assert.match(briefing, /- water: unlimited; \+0 −0/);
});

test("rules are included for buildings present and for what the village is short of", () => {
  assert.match(briefing, /- sawmill; 3 carpenters; turns 1 wood into 1 planks every 30s; costs permit 10 gold coins; materials 20 wood, 10 stones; upkeep 1 gold coins/);
  assert.match(briefing, /- well; collects 1 water from the map/);
  assert.doesNotMatch(briefing, /bakery/);
});

test("events leave out the day ticks", () => {
  assert.match(briefing, /- Finished building: sawmill/);
  assert.doesNotMatch(briefing, /Day 167 began/);
});

test("an almost empty snapshot still produces a briefing", () => {
  assert.match(buildBriefing({}, { buildings: [] }), /Village: unknown/);
});
