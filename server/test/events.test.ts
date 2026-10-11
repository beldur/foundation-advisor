import { test } from "node:test";
import assert from "node:assert/strict";
import { diffStates } from "../src/events.ts";
import type { Building, GameState, Villager } from "../src/state.ts";

const at = { x: 0, y: 0, z: 0 };
const building = (id: string, name: string, partsBuilt: number, parts = 1): Building => ({ id, name, parts, partsBuilt, ...at });
const villager = (id: string, name: string, job?: string, jobLevel?: number): Villager => ({ id, name, job, jobLevel, state: "WORKING", ...at });
const time = (week: number, day: number) => ({ week, day, month: 0, dayLengthSeconds: 60, timeScale: 1 });
const texts = (before: GameState | null, after: GameState) => diffStates(before, after).map((event) => event.text);

test("the first snapshot reports nothing", () => {
  assert.deepEqual(diffStates(null, { buildings: [building("a", "SAWMILL", 1)] }), []);
});

test("identical snapshots report nothing", () => {
  const state: GameState = { time: time(0, 3), buildings: [building("a", "SAWMILL", 1)], villagers: [villager("v", "Tetsy", "MINER", 1)] };
  assert.deepEqual(diffStates(state, structuredClone(state)), []);
});

test("buildings: started, finished, removed", () => {
  const before: GameState = { buildings: [building("a", "SAWMILL", 0), building("b", "WELL", 1), building("keep", "VILLAGE_CENTER", 1)] };
  const after: GameState = { buildings: [building("a", "SAWMILL", 1), building("c", "LUMBER_CAMP", 0), building("keep", "VILLAGE_CENTER", 1)] };
  assert.deepEqual(texts(before, after), ["Finished building: sawmill", "Construction started: lumber camp", "Removed: well"]);
});

test("villagers: arrival, departure, job change, level up", () => {
  const before: GameState = { villagers: [villager("a", "Tetsy"), villager("b", "Gawyn", "BUILDER", 1), villager("c", "Alfrigg", "MINER", 1), villager("d", "Hilda", "BAKER")] };
  const after: GameState = { villagers: [villager("a", "Tetsy", "MINER"), villager("b", "Gawyn", "BUILDER", 2), villager("c", "Alfrigg"), villager("e", "Odo")] };
  assert.deepEqual(texts(before, after), [
    "Tetsy started working as miner",
    "Gawyn reached level 2 as builder",
    "Alfrigg stopped working as miner",
    "Odo joined the village",
    "Hilda is gone (left or died)",
  ]);
});

test("a new day carries the game date", () => {
  const [event] = diffStates({ time: time(1, 166) }, { time: time(1, 167) });
  assert.deepEqual(event, { kind: "new-day", text: "Day 167 began", day: 167 });
});

test("an opened trade route and a new quest", () => {
  const route = (open: boolean) => ({ name: "NORTHBURY", open, buys: [], sells: [] });
  assert.deepEqual(texts({ tradeRoutes: [route(false)], quests: [] }, { tradeRoutes: [route(true)], quests: [{ name: "QUEST_FIRST_HARVEST" }] }), [
    "Trade route opened: northbury",
    "New quest: quest first harvest",
  ]);
});

test("loading another village is one event, not a flood", () => {
  const before: GameState = { buildings: [building("a", "SAWMILL", 1)], villagers: [villager("v", "Tetsy")] };
  const after: GameState = { buildings: [building("x", "WELL", 1), building("y", "HOUSE", 1)], villagers: [villager("w", "Odo")] };
  assert.deepEqual(texts(before, after), ["A different village was loaded"]);
});
