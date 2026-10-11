// Works out what happened in the village by comparing two state snapshots.
// The game is not asked to notify us: fewer callbacks inside the game means
// fewer ways to disturb it, and two seconds of delay does not matter here.
import type { Building, GameState, Villager } from "./state.ts";

export interface GameEvent {
  kind:
    | "village-loaded"
    | "new-day"
    | "construction-started"
    | "building-completed"
    | "building-removed"
    | "villager-arrived"
    | "villager-left"
    | "job-changed"
    | "job-level-up"
    | "trade-route-opened"
    | "quest-added";
  /** Plain sentence for the dashboard. */
  text: string;
  /** The game's day count when it was noticed. */
  day?: number;
}

const label = (name: string | undefined) => (name ?? "").replace(/_/g, " ").toLowerCase();
const byId = <T extends { id: string }>(items: T[] | undefined) => new Map((items ?? []).map((item) => [item.id, item]));
const finished = (building: Building) => building.partsBuilt >= building.parts;

/** Events that turn `before` into `after`. With no `before` there is nothing to report. */
export function diffStates(before: GameState | null, after: GameState): GameEvent[] {
  if (!before) return [];
  const events: Omit<GameEvent, "day">[] = [];

  const oldBuildings = byId(before.buildings), newBuildings = byId(after.buildings);
  const oldVillagers = byId(before.villagers), newVillagers = byId(after.villagers);

  // A different village has none of the old one's objects; listing every
  // building as "new" would be noise.
  const kept = [...oldBuildings.keys()].filter((id) => newBuildings.has(id)).length + [...oldVillagers.keys()].filter((id) => newVillagers.has(id)).length;
  const hadAny = oldBuildings.size + oldVillagers.size > 0;
  if (hadAny && kept === 0 && newBuildings.size + newVillagers.size > 0) {
    events.push({ kind: "village-loaded", text: "A different village was loaded" });
  } else {
    for (const [id, building] of newBuildings) {
      const old = oldBuildings.get(id);
      if (!old) {
        events.push(finished(building)
          ? { kind: "building-completed", text: `${label(building.name)} appeared, already built` }
          : { kind: "construction-started", text: `Construction started: ${label(building.name)}` });
      } else if (!finished(old) && finished(building)) {
        events.push({ kind: "building-completed", text: `Finished building: ${label(building.name)}` });
      }
    }
    for (const [id, building] of oldBuildings) {
      if (!newBuildings.has(id)) events.push({ kind: "building-removed", text: `Removed: ${label(building.name)}` });
    }

    for (const [id, villager] of newVillagers) {
      const old = oldVillagers.get(id);
      if (!old) {
        events.push({ kind: "villager-arrived", text: `${villager.name} joined the village` });
        continue;
      }
      if (old.job !== villager.job) events.push({ kind: "job-changed", text: jobChange(old, villager) });
      else if ((villager.jobLevel ?? 0) > (old.jobLevel ?? 0)) {
        events.push({ kind: "job-level-up", text: `${villager.name} reached level ${villager.jobLevel} as ${label(villager.job)}` });
      }
    }
    for (const [id, villager] of oldVillagers) {
      if (!newVillagers.has(id)) events.push({ kind: "villager-left", text: `${villager.name} is gone (left or died)` });
    }

    const wasOpen = new Set((before.tradeRoutes ?? []).filter((route) => route.open).map((route) => route.name));
    for (const route of after.tradeRoutes ?? []) {
      if (route.open && !wasOpen.has(route.name)) events.push({ kind: "trade-route-opened", text: `Trade route opened: ${label(route.name)}` });
    }

    const oldQuests = new Set((before.quests ?? []).map((quest) => quest.name));
    for (const quest of after.quests ?? []) {
      if (!oldQuests.has(quest.name)) events.push({ kind: "quest-added", text: `New quest: ${label(quest.name) || "unnamed"}` });
    }

    if (before.time && after.time && before.time.day !== after.time.day) {
      events.push({ kind: "new-day", text: `Day ${after.time.day} began` });
    }
  }

  return events.map((event) => ({ ...event, day: after.time?.day }));
}

function jobChange(old: Villager, now: Villager): string {
  if (!now.job) return `${now.name} stopped working as ${label(old.job)}`;
  if (!old.job) return `${now.name} started working as ${label(now.job)}`;
  return `${now.name} changed from ${label(old.job)} to ${label(now.job)}`;
}
