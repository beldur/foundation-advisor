# Foundation: what we know

Verified findings about the game, with how each was established. Checked against Foundation 1.12.0.14 (Steam, Windows). Add to this as we learn; move anything that turns out wrong to the end with a note.

Status words: **confirmed** means we observed it ourselves, **documented** means the wiki says so and we have not tested it.

## Runtime

| Fact | Status | Source |
|---|---|---|
| The game embeds LuaJIT 2.0.5 (Lua 5.1). | confirmed | version strings in `foundation.exe` |
| Engine: custom C++. Class prefixes seen: `GamC*` (game framework), `PlaC*` (gameplay), `ComI*`, `GenC*`. | confirmed | `foundation.log`, binary strings |
| The Lua manager is `GamCLuaManager`; `initEngineScripts` loads the `moddev` scripts and reports `Error when running '%s.lua'`. | confirmed | binary strings (the folder name is stored as UTF-16) |
| Mods are loaded by `GamCMod::runModScript`, which requires `mod.lua` and `generated_ids.lua`. | confirmed | binary strings |
| Analytics are posted every 3 minutes. | confirmed | `foundation.log` |
| The Lua VM is created once at game start, on a worker thread that is not the window thread and has no message loop. | confirmed | thread IDs reported by the bridge, compared with the window's thread |
| The unmodded game runs no Lua after startup, in the menu or in a loaded village. | confirmed | a `debug.sethook` count hook never fired |
| LuaJIT's FFI is available to unsandboxed scripts, so Lua can call Windows functions and read process memory. | confirmed | `require("ffi")` and `GetCurrentThreadId` worked |
| A Windows timer (`SetTimer` with a callback) registered from Lua never fires, because of the thread above. | confirmed | tried and removed |
| At `moddev` load time the globals already exist: `foundation`, `event`, `version`, 89 enum tables, and `vec2f`, `vec3f`, `matrix`, `quaternion`, `polygon`, `color`, `LINE`. | confirmed | `docs/dumps/hello.json` |
| The Lua registry holds no named metatables for game classes at startup, so the class list has to come from live objects. | confirmed | `docs/dumps/hello.json` |

## Getting code into the game

| Route | Restrictions | Status |
|---|---|---|
| `Documents\Polymorph Games\Foundation\moddev\*.lua` | None; loaded when the Lua VM is created. Meant for debuggers. | confirmed: `io`, `debug`, `require`, sockets and FFI all work |
| Regular mod in `Documents\Polymorph Games\Foundation\mods\<name>\` or from mod.io | Needs `mod.json`, `mod.lua` and `generated_ids.lua`. Sandboxed; file access only inside the mod's folder via `mod:readFileAsString` and friends. | documented |

- LuaSocket ships at `<game>\mods\libs\socket\core.dll` (64-bit). Load it with `package.cpath = package.cpath .. ";mods/libs/?.dll"` then `require("socket.core")`.
- Ctrl+Shift+R reloads mods in game. (documented)
- `myMod:msgBox` needs `ModMsgBoxEnabled` in `usersetting.config`. (documented)

## Lua API

The wiki lists signatures without descriptions. Index: https://www.polymorph.games/foundation/modding/api, one page per class at `/api/<lowercase_class_name>`.

### Globals (documented)

- `foundation`: `createMod`, `isModEnabled`, `isModLoaded`, `getModVersion`, `getGameVersion`, `isDlcEnabled`, `createData`, `createAsset`, `findAsset(name)`, `findGameObject(name)`
- `event`: `register(target, objectEvent, callback)`, `unregister(target, objectEvent)`, `clear(target)`

### LEVEL

`getGame`, `createObject(prefab [, position [, orientation [, setup]]])`, `getDeltaTime`, `getUnscaledDeltaTime`, `getEnvironmentDeltaTime`, `getTimeScale`, `getComponentManager(type)`, `find(type [, enabledOnly])`, `find(guid [, type])`, `find(name)`, `createPickingLine`, `pick`, `pickObject`, `pickPosition`, `worldToScreenCoordinates`, `isVisibleOnScreen`, `rayCast(from, to, outResult [, flag])`

### GAME_OBJECT

Properties: `Position`, `Scale`, `Orientation`, `Name`, `Active`.

Useful methods: `getGlobalPosition`, `getGlobalOrientation`, `buildMinMaxBounding(outMin, outMax)`, `getId`, `getLevel`, `getParent`, `forEachChild`, `forEachChildRecursive`, `forEachComponent`, `getComponent(type)`, `getEnabledComponent(type)`, `findFirstParentWithComponent`, `findFirstObjectWithComponentUp`, `findFirstObjectWithComponentDown`.

### COMPONENT_MANAGER

`getFirst`, `getFirstEnabled`, `getAllComponent`, `getAllEnabledComponent`, `getAllDisabledComponent`. Lists have `forEach(fn)`.

Events: `ON_COMPONENT_INITIALIZED`, `ON_COMPONENT_ENABLED`, `ON_COMPONENT_DISABLED`, `ON_COMPONENT_FINALIZED`, `ON_COMPONENT_DESTROYED`.

### Components

| Class | Members |
|---|---|
| `COMPONENT` (base) | `getOwner`, `getLevel`, `isEnabled`, `isInitialized`, `getComponentType` |
| `COMP_BUILDING` | `AssetBuilding`, `getBuildingPartList`, `getSubBuildingList`, `getEditMode`; about 25 events including `ON_BUILDING_COMPLETED`, `ON_BUILDING_DESTROYED`, `ON_CONSTRUCTION_STARTED` |
| `COMP_BUILDING_MANAGER` | `findAvailableWorkplaceForJob(job, villager)`, `unlockBuilding`, `lockBuilding`, `canAssignBuildingFunction`, `getAssignedBuildingFunctionCount` |
| `COMP_VILLAGER` | `getJobInstance` (has `.Workplace`), `findDisplayJobInstance`, `changeJob(job [, workplace])`, `getAssetJob`, `hasJob`, `getVillagerBehaviorState`, `getDeceasedData`; events `ON_JOB_CHANGED`, `ON_JOB_ASSIGNED`, `ON_BEHAVIOR_STATE_CHANGED` |
| `COMP_MAIN_GAME_LOOP` | events `ON_NEW_DAY`, `ON_NEW_WEEK`, `ON_NEW_MONTH`; get it with `level:find("COMP_MAIN_GAME_LOOP")` |
| `COMP_IMMIGRATION_MANAGER` | `getDaysUntilImmigration`, `getIsImmigrationEnabled`, `setIsImmigrationEnabled`, `triggerImmigration` |

### Names found in the binary but not on the wiki pages we read

The exe stores bound method names in contiguous runs, one run per class. Not yet tied to their classes:

- Agent or villager: `getHappiness`, `ON_HAPPINESS_CHANGED`, `setBehaviorMessage`, `getProfile`, `getVehicle`, `isOnBoat`, `ON_DYING`, `spawnImmigrant`
- Progress: `getGameStep`, `getScoreValue`, `getScoreTrackerData`, `addScoreValue`, `setScoreValue`, `isUnlocked`
- Mandates: `startMandate`, `cancelMandate`, `completeMandate`, `findMandateAssignedToVillager`
- Depots: `PlaCCompResourceDepot::setupAsSocket`

The runtime API dump from the bridge will replace this list.

## Files

| File | Notes |
|---|---|
| `Save Game\<village>\*.foundation` | Starts `03 00 00 00 01 00 00 00`, then two lengths, then a zlib stream (`78 01`) at offset 0x10 and a PNG thumbnail (720x420) at 0x1F. About 49 MB. Autosave every 5 minutes. Inner format unknown. |
| `<game>\game.package` (3.4 GB), `engine.package`, `loading.package` | Custom archive. Starts `02 00 00 00`, a 32-character hex hash, then a table with length-prefixed names. Unparsed. |
| `foundation.log` | Tab-separated: time, level, category, C++ function, message. Rewritten each run. |
| `<game>\mods\vs-code-snippets.json` | Data class properties and asset IDs. Has a trailing comma, so strict JSON parsers reject it. |
| `<game>\mods\Example *.zip` | Three official example mods. |

## The bridge (this project)

- `bridge/bridge.lua` runs from `moddev`, connects to `127.0.0.1:47800`, and evaluates Lua sent by the server.
- On its own it runs once, at startup. To be called every frame it needs the companion mod in `bridge/mod`, which hands it a mod object. Through that the bridge registers a component with `update()`, and a taxation function whose `init()` gives it the level so it can create an object carrying the component. Untested in the game as of 2026-10-11.
- A `debug.sethook` count hook stays installed as a second way in. LuaJIT does not fire hooks inside JIT-compiled code.
- The bridge is published as the global `__bridge`, and also as `foundation.__bridge` and `("").__bridge` in case the mod sandbox hides globals.
- It writes `bridge.log` and `bridge-startup.json` next to `foundation.log`.
- Frames in both directions: `TYPE id length\n` followed by `length` bytes. Types: `HELLO`, `STATUS`, `RES`, `ERR` from the game; `EVAL` to the game.

## Open questions at that point

These were open when the sections above were written. Most are answered further down.

- Does a `moddev` script get called every frame, or only once at startup?
- How does a script get hold of the level outside a component callback?
- Which methods exist beyond the documented ones?
- Where do village-wide resource totals live?
- Can buildings be placed and zones painted from Lua?
- Does running with `moddev` scripts or a local mod disable achievements for that save?

## Findings from the first live session (2026-10-11)

All confirmed by running the bridge in the game.

### Mods and saves

- A save carries its own mod list, chosen when the game is started. An existing save loads "0 mods" even when a mod is installed and listed.
- A village is identified by an ID inside the save file, not by its folder name. A copied folder does not appear as a second village. Steam Cloud names saves `<village-id>-<name>.foundation` with a `.foundation-meta` beside each.
- Mods run when a game starts, on a worker thread, and a different one each time. Component updates then all arrive on one thread.
- A hand-written `generated_ids.lua` in the example format is accepted. Only assets need entries; registered classes do not.
- Functions defined outside the mod sandbox can be registered through a mod object, so the unsandboxed bridge can do all the registering.
- The sandbox can see the global `__bridge` defined by the `moddev` script.

### Getting called every frame

- A custom `COMPONENT` class gets `update()` every frame once an object carrying it is in the level. `level:createObject(setup)` plus `object:addComponent(type)` creates one from Lua.
- To reach the level in the first place: a custom `GAME_ACTION` class receives it in `execute(level)`. Put the action in an `EVENT` asset, and add the event to `DEFAULT_BALANCING.EventListGlobal`; registering the event alone does nothing. With `DaysToFirst = 0`, `IsRecurrent = true` and `DaysBetweenOccurences = 1` it ran within 20 seconds of the game starting and about every 20 seconds after at speed 3.
- A custom taxation function's `init()` is not called in a new village, presumably until taxation is unlocked.
- Re-running `bridge.lua` in the same VM works, so the bridge can be updated by reloading mods instead of restarting.

### Things that break the game

- **`tostring()` on some game userdata crashes the game.** The game replaces `tostring` with its own formatter (function at `foundation.exe+0x279C60`, also used by `mod:log` and the console). It crashed twice at `+0x27A487`, in the branch that formats a `Property Owner ["..."]`: a lookup returns null and the next instruction reads through it. `tostring(level:getComponentManager("COMP_VILLAGER"))` triggers it; `tostring(level)` does not. `pcall` cannot catch it. Rule: never call `tostring` on userdata, and never pass userdata to `mod:log`.
- My first explanation, that only non-game userdata such as sockets was dangerous, was a guess and was wrong. The cause above comes from locating the crash address in the binary.
- **Indexing a mod object with an unknown name fails the mod.** The game logs `s_modMetaIndex: Function '<name>' not recognized` and then reports "Mod loading failed".
- Game object methods are served by a C `__index` function, so they cannot be listed from the metatable. The class list has to come from the wiki and the names in the binary.

### Built-in console

The binary has a `GamCConsole` class with `executeLoadedCode`, which reports `Console error: %s`. So the game has a Lua console of its own. How to open it is not known.

### Player commands

The log names each player action as a command class: `PlaCPlayerCommandChangeVillagerJob`, `PlaCPlayerCommandCreateBuildingPart`, `PlaCPlayerCommandBuildMonument`, `PlaCPlayerCommandGameSpeed`, `PlaCPlayerCommandToggleTerritoryRegion`. Whether Lua can issue them is not known.

### Still unknown

- Whether the ticker object the bridge creates is written into the save.
- Whether a mod can be added to an existing save.

## Reading state (confirmed live, 2026-10-11)

The members each class really has are in `docs/api/<CLASS>.json`, produced by `pnpm probe-api --properties`. That tool takes every identifier-shaped string in the binary as a candidate name and asks a live object for each one.

| Want | How |
|---|---|
| All components of a type | `level:getComponentManager("COMP_X"):getAllComponent():forEach(fn)`. Lists are userdata with only `forEach`; `#` does not work. |
| A singleton | `level:find("COMP_MAIN_GAME_LOOP")`. Returns nil if the level has none. |
| Position | `object:getGlobalPosition()` returns a plain table `{x, y, z}`; y is height. |
| Identity | `object:getId()` is a GUID string; `object.Name` is a string. |
| Enum name | `ENUM:fromNumber(n):toString()`. Note the colon. Enum-typed properties already have `:toString()`. |
| Game time | Main game loop: `getDay()`, `getWeek()`, `getMonth()`, `getDayDurationInSeconds()` (60). `getDayCount` needs arguments we don't know. `level:getTimeScale()` is the speed. |
| Villager job | `villager:getAssetJob().JobName`, for example `MINER`. The job asset has no `Name`. |
| Villager activity | `villager:getVillagerBehaviorState()` is a number; convert with `VILLAGER_BEHAVIOR_STATE`. |
| Building type | `building.AssetBuilding.Name` and `.BuildingType:toString()`, for example `VILLAGE_CENTER`, `LOGISTICS`. |
| Construction progress | `building:getBuildingPartList()`, then `part:getIsBuilt()`. |
| Stored resources | `depot.InputInventory` and `depot.OutputInventory` are `COMP_INVENTORY` components; `.Inventory.Collection` is a list of pairs with `.Resource.ResourceName` and `.Quantity`. Sum over all `COMP_RESOURCE_DEPOT`. |
| Workers of a workplace | `workplace.AssignedWorkerList:forEach(fn)`; `workplace.IsPaused`. |
| Building of any object | `object:findFirstObjectWithComponentUp("COMP_BUILDING")` returns the component. |

The component type names that exist are the 65 `COMP_*` strings in the binary. There is no village-wide resource or economy manager among them.

Not reachable through the Lua API as far as we have seen: villager happiness and needs, territory, terrain, house occupancy, trade state. `getHappiness` is in the binary but no probed class answers to it.

### Map orientation

With the camera as the game starts it, world +x points right on screen and world +z points up (measured with `level:worldToScreenCoordinates` on three points). So a top-down map must draw z upwards; drawing it downwards mirrors the village. The player can rotate the camera, so "up" in the game is not fixed.

## What else is readable (surveyed live, 2026-10-11)

`pnpm probe-api --properties` now also walks the object trees and probes every component type it meets: 132 types in a new village. The level's top-level objects are `Buildings`, `Environment`, `Trees`, `Agents` (with `Villagers`, `Visitors`, `Traders`, `Animals`, `Vehicles`), `Manager` and `Props`.

Components outside the documented `COMP_*` list report the engine's class name from `getComponentType()`, for example `PlaCCompBuildingStatus`. They can be reached with `object:forEachComponent(fn)`.

Readable and not yet in the snapshot:

| Data | Where | Seen |
|---|---|---|
| Every tree, with position | `COMP_TREE` owners | 32,182 trees; heights 0.2 to 66.2, so tree positions double as a terrain height sample |
| Natural deposits | `COMP_RESOURCE_CONTAINER`, `.ResourceContainerData.ResourceData.ResourceName`, `.InitialQuantity`, `.IsUnlimited` | BERRIES 830, BOAR 1581, STONES 20 (400 each), IRON_ORE 40 (200 each), FISH 15 (40 each), cabbages 4. Trees are WOOD containers. |
| Building footprint | `PlaCCompRectangleBuildingBlocker` on the building object: `.Size`, `.ZoneSize` | Village centre 9 x 9, well 6 x 6. Not every building has one. |
| Days until immigration | `COMP_IMMIGRATION_MANAGER:getDaysUntilImmigration()`, `getIsImmigrationEnabled()` | 3, true |
| Visitors | `COMP_VISITOR`: `.Name`, `.HasArrived`, `.IsLeaving`, `.VisitorPurpose`, `.TimeAtDestination` | none present |
| Quests | `PlaCCompQuestManager.QuestList` | not read yet |
| Trade routes | `PlaCCompTradingVillage`: `.IsTradeRouteEnabled`, `.TradingVillage` | not read yet |
| Edict and privilege slots | `PlaCCompEdictsManager`: `.MaxEdictSlotCount`, `.MaxPrivilegeSlotCount` | not read yet |
| Desirability inputs | `PlaCCompDesirable`: `.Config`, `.Data`, `.DesirabilityModifierList` | not read yet |
| Player's current tool | `PlaCCompStateMachine.States`, with states such as `PlaCStateBuildMonument`, `PlaCStateZoning`, `PlaCStateExpandTerritory`, `PlaCStateManage` | not read yet |
| Static rules | `foundation.findAsset("WOOD")` returns the resource asset with `.TradeBuyingPrice`, `.TradeSellingPrice`, `.ResourceTypeList`; `foundation.findAsset("LUMBER_CAMP")` returns the building asset | lists not walked yet |
| Workplace production | `COMP_WORKPLACE`: `.CurrentProductionCycleCount`, `.CurrentProductionAmountList`, `.ActiveVillagerProductionProgressList` | not read yet |
| Villager movement | `PlaCCompGroundMovable`: `.LinearSpeed`, `.IsMovementEnabled` | |
| Farms | `COMP_FARM` (45 members) | no farm in the test village |

Present as objects but exposing nothing beyond the base component members: `PlaCCompEconomyManager`, `PlaCCompNeedManager`, `PlaCCompHappinessFactorProcessor`, `PlaCCompVillageManager`, `PlaCCompJobManager`, `PlaCCompEstateManager`, `PlaCCompEventManager`, `PlaCCompResourceTrackerManager`, `PlaCCompZoneManager`, `PlaCCompGlobalScore`, `PlaCCompBuildingStatus`. So happiness, needs, the money ledger, territory, zoning and scores are not available through Lua properties. They exist in memory behind these objects, which is where an FFI memory reader would start.

## Terrain, footprints and rules (confirmed live, 2026-10-11)

### Out-arguments

Functions documented with out-arguments take plain tables that the game fills in:

- `level:rayCast(from, to, result, flags)`: `result` is `{}`; afterwards it has `Position`, `Normal` and `RigidBody`. Returns false on a miss.
- `object:buildMinMaxBounding(low, high)`: both must be three-element tables such as `{0, 0, 0}`. Empty tables are rejected with "This function's arguments are not recognized".
- `level:pickPosition` rejects every argument form tried so far.

### Terrain

- Flags are bit positions: pass `2 ^ OBJECT_FLAG.TERRAIN:toNumber()`. `TERRAIN` is 2, `WATER` 3, `BRIDGE` 4, `PICKABLE` 5, `PLATFORM` 7, `BUILDING_PART` 8.
- A vertical ray from y = 2000 to y = -1000 gives ground height with the terrain flag and the water surface with the water flag. Water counts where its surface is above the ground.
- A ray cast takes about 2 microseconds, so a 256 x 256 grid with both flags is about a quarter of a second in total.
- The playable map is 1024 x 1024 units, from (0, 0). Terrain continues outside it, from -1024 to 2048 on both axes.

### Footprints

- Houses have `COMP_BUILDING_ZONE` components on child objects. `.BuildingZone.ZoneEntryList` holds entries with `.Polygon`, a table of `{x, z}` points in the object's local space; rotate by `getGlobalOrientation()` (a table `{x, y, z, w}`) and add `getGlobalPosition()`. `.Type` is a table keyed by enum values.
- Other buildings have no zone components in the level. Their part assets do carry `BuildingZone` polygons (see `docs/rules/BUILDING_PART.json`), and the bounding box is available through `buildMinMaxBounding`.
- A building object's own orientation is the identity; rotation lives on its parts.

### Static rules

- `foundation.findAsset(id)` takes the ids listed under `ASSET_*` in `mods/vs-code-snippets.json`, for example `BUILDING_PART_LUMBER_CAMP`. An asset's `Name` is a display key, not its id.
- Assets do not know their own id. `pnpm dump-rules` recognises references by comparing objects with `==` against all 2,338 assets that have a naming property.
- Fixed-size arrays (`float[2]` and similar) are userdata that raise "Unsupported static array index type" for any string index; read them with numeric indexes.
- A resource has two names: the asset id (`PLANK`) and `ResourceName` (`PLANKS`). Inventories in the running game use `ResourceName`.
- Recipes sit on workplace functions: `AssetWorkplaceRecipeList`, each with `ResourceListNeeded` and `ResourceListProduced`, plus `WorkerCapacity`, `ProductionCycleDurationInSec` and `RelatedJob.Job`. Costs sit on the building's core part: `Cost.BuildRightTaxes`, `Cost.ResourceNeededList` (one collection per construction step) and `Cost.UpkeepCost`.
- Example: the sawmill has 3 carpenters and turns 1 wood into 1 plank every 30 seconds; it costs 10 gold coins for the permit, 20 wood and 10 stones, and 1 gold coin upkeep.
- Which of `TradeBuyingPrice` and `TradeSellingPrice` is the player's buying price has not been checked against the game's trade window.

## More state, the console, and existing saves (2026-10-11)

### More readable state (confirmed live)

- Job instance (`villager:getJobInstance()`): `.CurrentLevel`, `.Experience`, `.IsActive`, `.Workplace`.
- Workplace: `.CurrentlyProducedResourcesQueue` is a list of batches, each with `.Collection` of resource pairs (goods waiting for pickup). `.CurrentProductionAmountList` holds plain numbers. `.CurrentProductionCycleCount` read 0 everywhere; its meaning is unclear. The items of `.ActiveVillagerProductionProgressList` expose nothing.
- Trade: `PlaCCompTradingVillage` components under `Manager/Trade Manager/<NAME>` have `.IsTradeRouteEnabled` and `.TradingVillage` with `.VillageName`, `.BuyingResourceList`, `.SellingResourceList` (lists of resource assets).
- `PlaCCompEdictsManager`: `.MaxEdictSlotCount`, `.MaxPrivilegeSlotCount`.
- `PlaCCompStateMachine.States` lists the player's tools by `.Name` but not which one is active.
- All of these internal components sit under the top-level `Manager` object, within three levels.
- `foundation.findGameObject("Manager")` returns that object, and `:getLevel()` on it gives the level. So the level can be reached by name from any Lua that runs while a village is loaded.

### Events

The server derives events (construction started and finished, arrivals and departures, job changes, level-ups, trade routes opening, new days) by comparing consecutive snapshots in `server/src/events.ts`. Nothing is registered inside the game for this.

### Threads

Component updates, and so the bridge's ticks, run on the game-logic thread, which is not the thread that owns the window. A Windows message hook or timer therefore cannot reach it.

### The built-in console

- The game has a console class with a GUI, an input action `TOGGLE_CONSOLE` registered next to `GOD_MODE`, `ENABLE_DEBUG_VIEW` and `QUICK_GAME_RELOAD`, and a script `scripts/console.lua`.
- On creation it checks whether the game is running from packaged files and, if so, logs "The console cannot be used in package mode" and gives up. The shipped game is packaged, so the console is off for players.
- Not pursued: the bridge already does what the console would.

### Mods on existing saves

The main menu text has "Edit Save Game Mods" and "Edit Mods" next to "Load Game" (`localization/en/menu.json`), and loading has a "Load Game Mod Warning" dialog offering "Edit Mods" and "Load Anyway". So the game itself can change a save's mod list. Not tried yet.

## The property filter (2026-10-11)

### The reflection system

- The engine registers every C++ property through a small function, one per property: 10,880 of them. Each fills a descriptor: vtable at `+0`, name at `+8`, display name at `+0x20`, a flags word at `+0x60`. The vtable's RTTI name is `GeneratedPrivateAccessor<UAutoCProperty_<Class>_<Property>_arg>`, which gives class and property.
- `docs/reflection/properties.json` lists them as class -> property -> flags, produced by `tools/re/props_scan.py`.
- Lua may read a property only if `(flags & 0x40 or flags & 0x8000) and not (flags & 0x400)`. Checked against what Lua shows: the rule fits all 223 properties we had seen.
- Common flag values: `0x46` (asset data, visible), `0x18` (runtime state that is saved, hidden), `0x5E` (both), `0x8018` (runtime, explicitly visible), `0x0` (hidden).

### Where the test is made

| Place | Address in 1.12.0.14 | Instruction | Effect of lifting it |
|---|---|---|---|
| Building a class's Lua interface | `foundation.exe+0x230106` | `je`, bytes `0F 84 A7 00 00 00` | None observed on its own. |
| Reading a property for Lua (function at `+0x1F8B00`) | `+0x1F8B31` | `jae`, bytes `0F 83 8D 00 00 00` | Hidden properties become readable at once, with no restart. |
| Writing a property (function at `+0x1FFC90`) | not touched | | Hidden properties stay read-only. |

The bridge replaces the first two jumps with no-ops in the running process at load (`LIFT_PROPERTY_FILTER` in `bridge/bridge.lua`). It checks the bytes first and does nothing if they differ, so a game update disables it instead of corrupting code. Nothing on disk changes. Properties flagged `0x400` stay hidden; that test was left in place.

Whether the first lift is needed at all has not been tested; the read lift was added while the first was already active.

The game ran a full `pnpm probe-api --properties` with the filter lifted, which calls every newly visible getter on 150 classes, without a problem.

### What became readable (confirmed live)

| Data | Where |
|---|---|
| A villager's needs | `owner:getComponent("COMP_AGENT_NEED_PROCESSOR").NeedInstanceList`; each has `.AssetAgentNeed.NeedTypeName` (WATER, FOOD, FOOD_ADVANCED, HOUSING, SERVICE, ...), `.WasFilled`, `.TimeLeftBeforeApplyingHappinessFactor`, `.SelectedResource` |
| A villager's happiness factors | `PlaCCompHappinessFactorProcessor` on the villager object: `.HappinessFactorList`, each with `.AssetHappinessFactor.Name` and `.TotalValue` (for example TAXES, -15) |
| Villager extras | `COMP_VILLAGER`: `.HasNothingToDo`, `.IsLeavingVillage`, `.ThoughtString` |
| Building warnings | `PlaCCompBuildingStatus.BuildingStatus` on the building object: a table keyed by `BUILDING_STATUS` values, such as `WORKPLACE_STORAGE_FULL`, `WORKPLACE_LACK_WORKER`, `WORKPLACE_LACK_RESOURCE` |
| Workplace detail | `COMP_WORKPLACE`: `.CurrentWorkerCapacity`, `.LackingResourceList`, `.ResourceProducedThisWeek`, `.UpkeepCostThisWeek`, `.WorkplaceStatus`, `.SelectedWorkplaceRecipe` |
| Money | `PlaCCompEconomyManager`: `.DailyWealthAverage`, `.TimeToNextPayment`, `.DailyBudgetInfoList` and `.WeeklyBudgetInfoList` (one entry per period since the village began; each has `.IncomeTransactionList` and `.ExpenseTransactionList` of transactions with `.Category` and `.Collection`), `.ResourceStatList` |
| Village | `COMP_MAIN_GAME_LOOP`: `.VillageName`, `.RulerName`, `.VillageLevel`, `.GameTimeInSecond`, `.CurrentDay`, `.UnlockedSystemList` |
| Scores | `PlaCCompGlobalScore.TotalScoreValue`; `PlaCCompEstateManager.TotalSplendor` |
| Deposits | `COMP_RESOURCE_CONTAINER`: `.AvailableQuantity`, `.ReservedQuantity`, `.DaysSinceReplenish` |
| Building extras | `COMP_BUILDING`: `.CustomName`, `.UpkeepCost`, `.IsFunctionActive`, `.BeautificationValue`, `.AreAllBuildingFunctionRequirementsMet` |

Still hidden because they are flagged `0x400`: `PlaCCompVillager.VillagerData` and `.Family`. Not found by the object walk yet: house components (occupancy) and the territory manager.

### Other facts from this session

- The bridge's ticker object is written into saves made in a modded game ("ticker already in this level" on load).
- `tools/re/` has the Python scripts used for the analysis (they need `pip install capstone`): `xref.py` (functions that reference a string), `disasm.py` (disassemble a range), `callers.py` (who calls a function), `props_scan.py` (all property registrations), `crash_site.py` (locate a crash address).

## Second data sweep with the filter lifted (2026-10-11)

`pnpm inspect "<lua expression>"` prints everything a live value answers to, a few levels deep; the dumps from this sweep are in `docs/dumps/inspect/`.

### Where things live

Top-level objects, all reachable with `foundation.findGameObject(name)`: `Manager`, `Buildings`, `Agents`, `Environment`, `Trees`, `Props`, `Terrain`, `Camera`, `Territory Manager`.

- The `Manager` object itself carries about 28 manager components, including `PlaCCompEconomyManager`, `PlaCCompResourceManager`, `PlaCCompNeedManager`, `PlaCCompJobManager`, `PlaCCompHouseManager`, `PlaCCompUnlockableManager`, `PlaCCompEstateManager`, `PlaCCompEventManager`, `PlaCCompQuestManager`, `PlaCCompZoneManager`, `PlaCCompVillageManager` and `PlaCCompGlobalScore`. Others sit on its children: `Notification Manager`, `Trade Manager`, the state machine.
- `Terrain` carries `PlaCCompTerrain` (`.PlayableSize` 1024 x 1024, `.VisualSize` 3072 x 3072, `.RegionShapeArray`), `PlaCCompZoneGrid` (1024 x 1024 tiles of size 1; `.AvailableZones`, `.AvailableDesirability`) and `PlaCCompNavMesh`.
- `Camera` carries `GamCCompCamera` (`.FovY` 45, perspective) and `PlaCCompNavigationController`.
- With the filter lifted, every asset also answers to `AssetName`, `AssetPath` and `AssetGuid`, for example `Notification_NoHousing.data`. That is a real identity for assets that have no `Name`.

### What was added to the snapshot

| Data | Where |
|---|---|
| Village mood | `COMP_VILLAGER_MANAGER`: `.GlobalHappiness`, `.GlobalNeedListPercentageFilled`, `.BaseMinimumHappinessForVillagerLeaving` plus `.AdditionalMinimumHappinessForVillagerLeaving`, `.VillagerLeavingCount` |
| Unlocked game systems | `COMP_MAIN_GAME_LOOP.UnlockedSystemList` (BUILD, TERRITORY, ESTATE, TAXATION, ...) |
| The player's current tool | `PlaCCompStateMachine.CurrentState.Name` ("Manage", "Zoning", ...) |
| Houses | `PlaCCompHouse` on a child of each `HOUSE` building: `.VillagerList`, `.VillagerAtHomeList`, `.Density`, `.Status`, `.IsReadyForUpgrade`, `.IsReadyForStatusUpgrade`, and `.Lot.LotShapePolygon` in world coordinates |
| Territory | `PlaCCompTerritoryManager.RegionList`: `PlaCCompTerritoryRegion` components on objects named `region N`, each with `.NonHolePolygon` (world coordinates), `.IsUnlocked`, `.IsTerritory`, `.NeighborList`; the manager has `.NextTaxValue`, `.TerritoryUpkeepMultiplier`. 73 regions on this map. |
| Per-resource state | `PlaCCompResourceManager.ResourceInstanceList`: `.IsKnown`, `.IsLocked`, `.TradeState` (NO_TRADE, SELL, ...), `.AmountToTrade` |
| Per-resource flow | `PlaCCompEconomyManager.ResourceStatList`: `.QuantityConsumed`, `.QuantityTraded`, `.TradeRevenue`, `.CostPerUnit`, and `.WorkplaceStatList` with `.AmountProduced` per building function |
| Progress purchases | `PlaCCompUnlockableManager.UnlockableInstanceList`: `.Unlockable`, `.NumTimeBought`, `.DaysLeftBeforeAvailable` (110 entries) |
| Taxes | `COMP_TAXATION_MANAGER.InstTaxationFunctionList`: `.TaxationFunction.NameKey`, `.IsActive`, `.Bracket`, `.Multiplier` |
| The game's own notifications | `PlaCCompNotificationManager.ActiveNotificationList`: `.Notification.Title` (HOUSING_INSUFFICIENT, WORKPLACE_STORAGE_FULL, ...), `.NotificationCategory`, `.NotificationTargetList` |
| Estates | `PlaCCompEstateManager.EstateInstanceList`: `.Estate`, `.CurrentInfluence`, `.InfluenceGainPerWeek`, `.Splendor` |
| Trade route detail | `PlaCCompTradingVillage`: `.TradeRouteLevel`, `.IsCurrentlyTrading`, `.IsTradeRouteBlocked`, `.IsReadyToUpgradeTradeRoute` |
| Exact camera | `PlaCCompNavigationController`: `.LookAt` (world point), `.RotationY` and `.RotationX` in degrees, `.Distance`. A top-down map should be rotated by minus `RotationY`. |

### Seen but not used yet

- Villager status (serf, commoner, ...): the agent `Profile.StatusList` gives the possible statuses with `.StatusName` and their need lists; which status a villager currently has was not found.
- `COMP_VILLAGER_MANAGER.VillagerStatusQuota`, `PlaCCompJobManager.JobInstanceList` (which jobs are unlocked), `PlaCCompZoneManager.ZoneStateList` (which zone types are unlocked).
- Painted zones: the zone grid's per-tile contents were not found among its properties.
- `PlaCCompEventManager` (upcoming events, `.DaysToNextEvent`), `PlaCCompMilitaryManager`, `PlaCCompFortification`, `PlaCCompRoadManager` and road segments, `PlaCCompDesirabilityManager`, `COMP_TAX_COLLECTABLE.CumulatedTax`, `COMP_FARM` (`.FarmState`, `.CurrentCycleDay`), `COMP_BUILDING.UpkeepCost` and `.BeautificationValue`.

## Corrections and the advisor (2026-10-11)

### Which needs are unmet

`WasFilled` and `TimeLeftBeforeApplyingHappinessFactor` do not say whether a need is currently unmet; reading them that way claimed every villager lacked water while the game reported 94% of needs met. The working signals:

- Needs met by going somewhere (housing): `need.IsLacking`.
- Needs met by a resource (water, food, service): `IsLacking` is not reachable on them. `need.DelayBeforeNextFillnessTry > 0` means the last attempt to fetch the resource failed and a retry is pending.

Counted over a village, these two came to 16 of 220 when the game's `GlobalNeedListPercentageFilled` said 92.7%, an exact match. Later samples were within a few needs of the game's figure, since the retry delay is briefly zero between attempts.

The reflection table shows where the rest is: `PlaIInstAgentNeedFillness` (`IsLacking`, `TimeUntilUnfill`, `FillDuration`) and `PlaCDataVillager` (`CurrentHappiness`, `NeedListFillnessPercentage`, `CurrentStatusAsset`, `House`, `Age`, `TraitList`). The second is reached through `PlaCCompVillager.VillagerData`, which is flagged hidden (`0x400`) and so still unreadable. That is where a villager's status (serf, commoner, ...) lives.

### Time

`COMP_MAIN_GAME_LOOP:getDay()` is a running day count (171 in the test village), not a day of the week. `getWeek()` did not track it (it read 3 on day 167), so only the day is shown.

### Other

- The well's water stock reads 2147483647, meaning unlimited.
- Gathering buildings are written in the rules as consuming the resource they collect ("1 wood into 2 wood"); the input stands for what is taken from the map.

### The advisor

- `server/src/briefing.ts` turns a snapshot into a text briefing of about 6,000 characters: overview, the game's warnings, building problems, unmet needs, happiness factors, money for this week and last, stock and flow per resource, jobs, buildings, housing, options, recent events, and the rules for buildings that are present or make something the village is short of. `GET /briefing` returns it and needs no API key.
- `server/src/advisor.ts` sends it to Claude and gets back a summary and up to five tips, each with a priority, the reason with figures, a concrete action and the things it concerns. `POST /advise` with an optional `{"question": "..."}`.
- It needs `ANTHROPIC_API_KEY` in the server's environment. The model is `claude-sonnet-5-5` unless `ADVISOR_MODEL` says otherwise. Not yet run against the API: no key was available when it was written.
