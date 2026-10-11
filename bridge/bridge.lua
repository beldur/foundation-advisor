-- Foundation bridge (phase 0 spike).
-- Installed into Documents/Polymorph Games/Foundation/moddev, where the game
-- runs it unsandboxed when it creates the Lua VM.
-- It connects to the local bridge server and executes Lua the server sends.
-- The companion mod in bridge/mod gets it called every frame; see "Getting called".

local HOST, PORT = "127.0.0.1", 47800
local GAME_DIR = "C:/Program Files (x86)/Steam/steamapps/common/Foundation"
local TICK_INTERVAL = 0.05      -- seconds between socket pumps
local RECONNECT_INTERVAL = 5    -- seconds between connection attempts
local CONNECT_TIMEOUT = 0.02    -- a blocked attempt stalls the game this long
local STATUS_INTERVAL = 5
local SNAPSHOT_INTERVAL = 2     -- seconds between state snapshots sent to the server
local CAMERA_INTERVAL = 0.2     -- seconds between camera updates
local TERRAIN_REFRESH = 600     -- seconds between surveys of trees and deposits
local TERRAIN_CELLS = 256       -- the terrain grid is this many cells on each side
local HOOK_COUNT = 2000         -- VM instructions between hook calls

local loadstring = loadstring or load
local unpack = unpack or table.unpack

-- A reload (B.reload) runs this file again in the same VM: retire the old copy
-- first and keep what it had learned.
local previous = rawget(_G, "__bridge")
if previous and previous.shutdown then pcall(previous.shutdown) end

local B = {
	startedAt = os.time(),
	hookCalls = 0,
	ticks = 0,
	tickSources = {},  -- how many ticks each caller delivered
	tickThreads = {},  -- and which OS threads they arrived on
	newGlobals = {},   -- globals defined after this script ran, in order
	level = previous and previous.level or nil,  -- LEVEL object, once we are handed one
	mod = previous and previous.mod or nil,
	state = "idle",
}
rawset(_G, "__bridge", B)
-- Also reachable as ("").__bridge and foundation.__bridge, in case the mod
-- sandbox hides globals defined here.
string.__bridge = B
if type(foundation) == "table" then pcall(rawset, foundation, "__bridge", B) end

-- Windows calls through LuaJIT's FFI. Declaring a struct twice is an error, so
-- after a reload the declarations fail harmlessly and the earlier ones are used.
local currentThread = function() return 0 end
local gameWindowSize = function() return nil end
do
	local ok, ffi = pcall(require, "ffi")
	if ok then
		for _, declaration in ipairs({
			"typedef struct { long left, top, right, bottom; } BRIDGE_RECT;",
			"unsigned long GetCurrentThreadId(void);",
			"unsigned long GetCurrentProcessId(void);",
			"void* GetForegroundWindow(void);",
			"unsigned long GetWindowThreadProcessId(void* window, unsigned long* processId);",
			"int GetClientRect(void* window, BRIDGE_RECT* rect);",
		}) do
			pcall(ffi.cdef, declaration)
		end
		-- Lift the game's filter on which reflected properties Lua may see.
		--
		-- Every C++ property has a flags word. When the game builds a class's Lua
		-- interface it keeps a property only if (flags & 0x40 or flags & 0x8000)
		-- and not flags & 0x400. Runtime state such as villager needs, the budget
		-- and deposit quantities has neither bit, so Lua never sees it. The filter
		-- is one conditional jump; replacing it with no-ops keeps everything that
		-- is not explicitly hidden (0x400). Interfaces are built per class, so
		-- this has to happen before the game hands Lua its first object, which is
		-- why it runs here at load. It changes the running process only, never
		-- the file on disk, and refuses unless the bytes are exactly what
		-- Foundation 1.12.0.14 has at that address.
		-- Set to false to switch it off.
		local LIFT_PROPERTY_FILTER = true
		-- The same test sits in two places; each is a six-byte conditional jump
		-- taken when a property has neither visibility bit:
		--   interface: where a class's Lua interface is built (+0x230106, je).
		--              Lifting this one alone changed nothing we could observe.
		--   read:      in the function that reads a property for Lua, checked on
		--              every access (+0x1F8B31, jae). The write path has its own
		--              check, which is left in place: hidden properties stay
		--              read-only.
		local GATES = {
			{ name = "interface", rva = 0x230106, bytes = "\15\132\167\0\0\0" },
			{ name = "read", rva = 0x1F8B31, bytes = "\15\131\141\0\0\0" },
		}
		local function liftPropertyFilter()
			for _, declaration in ipairs({
				"void* GetModuleHandleA(const char* name);",
				"void* GetCurrentProcess(void);",
				"int VirtualProtect(void* address, size_t size, unsigned long protection, unsigned long* previous);",
				"int FlushInstructionCache(void* process, const void* address, size_t size);",
			}) do
				pcall(ffi.cdef, declaration)
			end
			local base = ffi.cast("uint8_t*", ffi.C.GetModuleHandleA(nil))
			local outcomes = {}
			for _, gate in ipairs(GATES) do
				local at = base + gate.rva
				local current = ffi.string(at, 6)
				local outcome
				if current == string.rep("\144", 6) then
					outcome = "already lifted"
				elseif current ~= gate.bytes then
					outcome = "left alone (unexpected bytes: different game version)"
				else
					local protection = ffi.new("unsigned long[1]")
					if ffi.C.VirtualProtect(at, 6, 0x40, protection) == 0 then
						outcome = "left alone (could not make the code writable)"
					else
						ffi.fill(at, 6, 0x90)
						ffi.C.VirtualProtect(at, 6, protection[0], protection)
						ffi.C.FlushInstructionCache(ffi.C.GetCurrentProcess(), at, 6)
						outcome = "lifted"
					end
				end
				outcomes[#outcomes + 1] = gate.name .. " " .. outcome
			end
			return table.concat(outcomes, "; ")
		end
		if LIFT_PROPERTY_FILTER then
			local ran, outcome = pcall(liftPropertyFilter)
			B.propertyFilter = ran and outcome or ("failed: " .. tostring(outcome))
		else
			B.propertyFilter = "switched off"
		end

		if pcall(function() return ffi.C.GetCurrentThreadId() end) then
			currentThread = function() return tonumber(ffi.C.GetCurrentThreadId()) end
		end

		-- Width and height of the game's window contents, in pixels. The window is
		-- found the first time the game is in the foreground.
		local window = previous and previous.gameWindow or nil
		local usable = pcall(function() return ffi.new("BRIDGE_RECT"), ffi.C.GetForegroundWindow() end)
		if usable then
			gameWindowSize = function()
				if window == nil then
					local foreground = ffi.C.GetForegroundWindow()
					local owner = ffi.new("unsigned long[1]")
					ffi.C.GetWindowThreadProcessId(foreground, owner)
					if foreground ~= nil and owner[0] == ffi.C.GetCurrentProcessId() then
						window = foreground
						B.gameWindow = window
					end
				end
				if window == nil then return nil end
				local rect = ffi.new("BRIDGE_RECT")
				if ffi.C.GetClientRect(window, rect) == 0 or rect.right <= 0 then return nil end
				return tonumber(rect.right), tonumber(rect.bottom)
			end
		end
	end
end
B.loadThread = currentThread()

--------------------------------------------------------------------------
-- Turning values into text without crashing the game.
--
-- The game replaces tostring() with its own formatter. For some of its own
-- userdata (a COMPONENT_MANAGER, for one) that formatter reads through a null
-- pointer and the game crashes; pcall cannot catch that. Nothing here ever
-- calls tostring() on userdata. Use documented getters to identify objects.

local function isGameObject(value)
	if type(value) ~= "userdata" then return false end
	local meta = debug.getmetatable(value)
	return type(meta) == "table"
		and rawget(meta, "__index") ~= nil
		and rawget(meta, "__newindex") ~= nil
		and rawget(meta, "__eq") ~= nil
end

local function safeString(value)
	local kind = type(value)
	if kind == "string" then return value end
	if kind == "number" then return string.format("%.14g", value) end
	if kind == "boolean" then return value and "true" or "false" end
	if isGameObject(value) then return "game object" end
	return kind
end
B.isGameObject = isGameObject
B.str = safeString

--------------------------------------------------------------------------
-- Logging: a file next to foundation.log

local userDir = (os.getenv("USERPROFILE") or ".") .. "\\Documents\\Polymorph Games\\Foundation\\"
do
	local source = debug.getinfo(1, "S").source or ""
	local dir = source:match("^@(.*)[/\\]moddev[/\\][^/\\]*$")
	if dir then userDir = dir .. "\\" end
end
local scriptPath = userDir .. "moddev\\bridge.lua"

local logFile = io.open(userDir .. "bridge.log", previous and "a" or "w")
local function log(...)
	if not logFile then return end
	local parts = {}
	for i = 1, select("#", ...) do parts[i] = safeString((select(i, ...))) end
	logFile:write(os.date("%H:%M:%S"), "  ", table.concat(parts, " "), "\n")
	logFile:flush()
end
B.log = log

--------------------------------------------------------------------------
-- JSON encoding, tolerant of anything Lua can hold

local escapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
local function encodeString(s)
	return '"' .. s:gsub('[%c"\\]', function(c)
		return escapes[c] or string.format("\\u%04x", c:byte())
	end) .. '"'
end

-- Marks a table as a list, so that it is encoded as [] even when empty.
local ARRAY = {}
local function array(t)
	return setmetatable(t or {}, ARRAY)
end
B.array = array

local function encode(value, depth, seen)
	local kind = type(value)
	if kind == "nil" then return "null" end
	if kind == "boolean" then return value and "true" or "false" end
	if kind == "number" then
		if value ~= value or value == math.huge or value == -math.huge then return "null" end
		if value == math.floor(value) and math.abs(value) < 1e15 then return string.format("%d", value) end
		return string.format("%.14g", value)
	end
	if kind == "string" then return encodeString(value) end
	if kind ~= "table" then return encodeString("<" .. safeString(value) .. ">") end

	depth = depth or 0
	seen = seen or {}
	if seen[value] then return '"<cycle>"' end
	if depth > 8 then return '"<too deep>"' end
	seen[value] = true

	local out = {}
	local count = 0
	for _ in pairs(value) do count = count + 1 end
	if getmetatable(value) == ARRAY or (count > 0 and count == #value) then
		count = #value
		for i = 1, count do out[i] = encode(value[i], depth + 1, seen) end
		seen[value] = nil
		return "[" .. table.concat(out, ",") .. "]"
	end
	for k, v in pairs(value) do
		out[#out + 1] = encodeString(safeString(k)) .. ":" .. encode(v, depth + 1, seen)
	end
	seen[value] = nil
	if count == 0 then return "{}" end
	return "{" .. table.concat(out, ",") .. "}"
end
B.encode = encode

--------------------------------------------------------------------------
-- Introspection helpers, used at startup and from evaluated code

local function sortedKeys(t, limit)
	local keys = {}
	for k in pairs(t) do
		keys[#keys + 1] = safeString(k)
		if limit and #keys >= limit then break end
	end
	table.sort(keys)
	return keys
end

-- Every global with its type; tables also list their keys.
function B.globals()
	local out = {}
	for k, v in pairs(_G) do
		local entry = { type = type(v) }
		if type(v) == "table" and v ~= _G then entry.keys = sortedKeys(v, 500) end
		out[safeString(k)] = entry
	end
	return out
end

-- Named tables in the Lua registry. Binding libraries keep one metatable per
-- exposed C++ class there, so this lists the scripting API.
function B.registry()
	local out, unnamed = {}, 0
	for k, v in pairs(debug.getregistry()) do
		if type(k) == "string" and type(v) == "table" then
			local entry = { keys = sortedKeys(v, 500) }
			local index = rawget(v, "__index")
			if type(index) == "table" and index ~= v then entry.index = sortedKeys(index, 500) end
			out[k] = entry
		else
			unnamed = unnamed + 1
		end
	end
	return { named = out, otherEntries = unnamed }
end

-- What a value is and what can be called on it.
function B.describe(value)
	local out = { type = type(value), string = safeString(value) }
	local meta = debug.getmetatable(value)
	local chain = {}
	local guard = 0
	while type(meta) == "table" and guard < 10 do
		guard = guard + 1
		local entry = { keys = sortedKeys(meta, 500) }
		local index = rawget(meta, "__index")
		if type(index) == "table" and index ~= meta then entry.index = sortedKeys(index, 500) end
		chain[#chain + 1] = entry
		meta = debug.getmetatable(meta)
	end
	out.metatables = chain
	if type(value) == "table" then out.keys = sortedKeys(value, 500) end
	return out
end

function B.status()
	return {
		state = B.state,
		hookCalls = B.hookCalls,
		ticks = B.ticks,
		tickSources = B.tickSources,
		loadThread = B.loadThread,
		tickThreads = B.tickThreads,
		mod = B.mod and "attached" or nil,
		propertyFilter = B.propertyFilter,
		uptime = os.time() - B.startedAt,
		level = B.level and safeString(B.level) or nil,
		newGlobals = B.newGlobals,
	}
end

--------------------------------------------------------------------------
-- State snapshot: what the dashboard shows. Uses only members confirmed by
-- `pnpm probe-api` (see docs/api). Each part is read on its own, so a call that
-- fails costs that part and is reported in `errors`.

local function each(list, visit)
	if list ~= nil and list.forEach then list:forEach(visit) end
end

local function components(level, componentType)
	return level:getComponentManager(componentType):getAllComponent()
end

local function enumName(enum, number)
	local ok, name = pcall(function() return enum:fromNumber(number):toString() end)
	return ok and name or number
end

local function place(entry, object)
	local position = object:getGlobalPosition()
	entry.x, entry.y, entry.z = position[1], position[2], position[3]
	return entry
end

-- Resource name -> quantity held by an inventory component.
local function inventory(component)
	local items = {}
	local data = component and component.Inventory
	each(data and data.Collection, function(pair)
		local resource = pair.Resource
		if resource then
			local name = resource.ResourceName
			items[name] = (items[name] or 0) + pair.Quantity
		end
	end)
	return items
end

-- Id of the building an object belongs to, if any.
local function buildingId(object)
	local building = object:findFirstObjectWithComponentUp("COMP_BUILDING")
	return building and building:getOwner():getId() or nil
end

-- Rotates the local ground point (x, z) by a quaternion {x, y, z, w} and
-- returns the rotated x and z.
local function rotateGround(q, x, z)
	local qx, qy, qz, qw = q[1], q[2], q[3], q[4]
	-- t = 2 * cross(q.xyz, v) with v = (x, 0, z)
	local tx, ty, tz = 2 * (qy * z), 2 * (qz * x - qx * z), 2 * (-qy * x)
	-- v' = v + w * t + cross(q.xyz, t)
	return x + qw * tx + (qy * tz - qz * ty), z + qw * tz + (qx * ty - qy * tx)
end

-- Ground outlines of a building, as flat lists {x1, z1, x2, z2, ...} in world
-- coordinates, from the zone polygons of its parts. They don't change once a
-- building is finished, so they are cached per building and part count.
local footprintCache = {}

local function footprints(owner, id, parts)
	local key = id .. ":" .. parts
	local cached = footprintCache[key]
	if cached then return cached end
	local outlines = array()
	owner:forEachChildRecursive(function(child)
		local zone = child:getComponent("COMP_BUILDING_ZONE")
		local data = zone and zone.BuildingZone
		if not data then return end
		local origin, orientation = child:getGlobalPosition(), child:getGlobalOrientation()
		each(data.ZoneEntryList, function(entry)
			local polygon = entry.Polygon
			if type(polygon) ~= "table" or #polygon < 3 then return end
			local outline = array()
			for i = 1, #polygon do
				local x, z = rotateGround(orientation, polygon[i][1], polygon[i][2])
				outline[#outline + 1] = math.floor((origin[1] + x) * 10 + 0.5) / 10
				outline[#outline + 1] = math.floor((origin[3] + z) * 10 + 0.5) / 10
			end
			outlines[#outlines + 1] = outline
		end)
	end)
	if #outlines == 0 then
		-- Most buildings carry no zone polygons; fall back to the bounding box.
		-- The out-arguments must be three-element tables.
		local low, high = { 0, 0, 0 }, { 0, 0, 0 }
		if owner:buildMinMaxBounding(low, high) then
			local function round(value) return math.floor(value * 10 + 0.5) / 10 end
			local x1, z1, x2, z2 = round(low[1]), round(low[3]), round(high[1]), round(high[3])
			outlines[1] = array({ x1, z1, x2, z1, x2, z2, x1, z2 })
		end
	end
	footprintCache[key] = outlines
	return outlines
end

-- The parts below marked "hidden" read properties the game does not normally
-- show to Lua. They only return data while the property filter is lifted (see
-- the top of this file); otherwise the properties are nil and the fields are
-- simply absent. Each is read under pcall so that a surprise there cannot cost
-- the documented data next to it.

-- First component on an object with the given engine type name.
local function componentOf(object, kind)
	local found
	object:forEachComponent(function(component)
		if found == nil and component:getComponentType() == kind then found = component end
	end)
	return found
end

-- Names of the flags that are set, from a table keyed by enum values.
local function flagsSet(flags, ignore)
	local out = array()
	if type(flags) ~= "table" then return out end
	for flag, on in pairs(flags) do
		if on then
			local name = type(flag) == "userdata" and flag.toString and flag:toString() or flag
			if name ~= ignore then out[#out + 1] = name end
		end
	end
	table.sort(out)
	return out
end

-- Resource name -> quantity from a resource collection (or a bare list of pairs).
local function amounts(collection, into)
	into = into or {}
	local list = collection and (collection.forEach and collection or collection.Collection)
	each(list, function(pair)
		local resource = pair.Resource
		if resource then
			local name = resource.ResourceName
			into[name] = (into[name] or 0) + pair.Quantity
		end
	end)
	return into
end

-- A readable name for an asset. Most have Name; the rest are known by the file
-- they were made from, such as "Notification_NoHousing.data".
local function assetName(asset)
	if type(asset) ~= "userdata" then return nil end
	local name = asset.Name
	if type(name) == "string" and name ~= "" then return name end
	name = asset.AssetName
	if type(name) == "string" and name ~= "" then return (name:gsub("%.data$", "")) end
	return nil
end

local function enumText(value)
	if type(value) == "userdata" and value.toString then return value:toString() end
	return value
end

-- A list of {x, z} points as a flat list rounded to one decimal.
local function flatPolygon(polygon)
	local out = array()
	if type(polygon) ~= "table" then return out end
	for i = 1, #polygon do
		out[#out + 1] = math.floor(polygon[i][1] * 10 + 0.5) / 10
		out[#out + 1] = math.floor(polygon[i][2] * 10 + 0.5) / 10
	end
	return out
end

local function guarded(read, ...)
	local ok, value = pcall(read, ...)
	if ok then return value end
	return nil
end

-- Hidden: what a villager needs and whether each need is currently met.
local function villagerNeeds(owner)
	local processor = owner:getComponent("COMP_AGENT_NEED_PROCESSOR")
	local list = processor and processor.NeedInstanceList
	if not list then return nil end
	local out = array()
	each(list, function(need)
		local asset = need.AssetAgentNeed
		local wanted = need.SelectedResource
		-- Whether the need is going unmet right now. Needs met by visiting a
		-- place (housing, for one) say so in IsLacking. Needs met by a resource
		-- do not expose that flag; for those, a running retry delay means the
		-- last attempt to fetch the resource failed. Summed over a village this
		-- reproduced the game's own "needs met" percentage exactly.
		local lacking = need.IsLacking
		if lacking == nil then lacking = (need.DelayBeforeNextFillnessTry or 0) > 0 end
		out[#out + 1] = {
			need = asset and asset.NeedTypeName or nil,
			lacking = lacking,
			-- Seconds until going unmet starts to cost happiness.
			penaltyInSeconds = lacking and need.TimeLeftBeforeApplyingHappinessFactor or nil,
			wants = wanted and wanted.ResourceName or nil,
		}
	end)
	return out
end

-- Hidden: the things currently adding to or taking from a villager's happiness.
local function villagerHappiness(owner)
	local processor = componentOf(owner, "PlaCCompHappinessFactorProcessor")
	local list = processor and processor.HappinessFactorList
	if not list then return nil end
	local out = array()
	each(list, function(factor)
		local asset = factor.AssetHappinessFactor
		out[#out + 1] = { factor = asset and asset.Name or nil, value = factor.TotalValue }
	end)
	return out
end

local snapshotParts = {}

function snapshotParts.time(level)
	local loop = level:find("COMP_MAIN_GAME_LOOP")
	return {
		day = loop:getDay(),
		week = loop:getWeek(),
		month = loop:getMonth(),
		dayLengthSeconds = loop:getDayDurationInSeconds(),
		timeScale = level:getTimeScale(),
	}
end

function snapshotParts.villagers(level)
	local out = array()
	each(components(level, "COMP_VILLAGER"), function(villager)
		local owner = villager:getOwner()
		local job = villager:getAssetJob()
		local instance = villager:getJobInstance()
		out[#out + 1] = place({
			id = owner:getId(),
			name = owner.Name,
			job = job and job.JobName or nil,
			jobLevel = instance and instance.CurrentLevel or nil,
			jobExperience = instance and instance.Experience or nil,
			idle = villager.HasNothingToDo,
			leaving = villager.IsLeavingVillage,
			thought = villager.ThoughtString,
			needs = guarded(villagerNeeds, owner),
			happiness = guarded(villagerHappiness, owner),
			state = enumName(VILLAGER_BEHAVIOR_STATE, villager:getVillagerBehaviorState()),
		}, owner)
	end)
	return out
end

function snapshotParts.buildings(level)
	local out = array()
	each(components(level, "COMP_BUILDING"), function(building)
		local owner = building:getOwner()
		local asset = building.AssetBuilding
		local parts, built = 0, 0
		each(building:getBuildingPartList(), function(part)
			parts = parts + 1
			if part:getIsBuilt() then built = built + 1 end
		end)
		local id = owner:getId()
		local ok, outlines = pcall(footprints, owner, id, parts)
		out[#out + 1] = place({
			id = id,
			name = asset and asset.Name or owner.Name,
			type = asset and asset.BuildingType and asset.BuildingType:toString() or nil,
			parts = parts,
			partsBuilt = built,
			footprints = ok and outlines or array(),
			-- Hidden: the warnings the game shows on the building.
			status = guarded(function()
				local component = componentOf(owner, "PlaCCompBuildingStatus")
				return component and flagsSet(component.BuildingStatus, "PART_NORMAL") or nil
			end),
			customName = building.CustomName,
		}, owner)
	end)
	return out
end

function snapshotParts.depots(level)
	local out = array()
	each(components(level, "COMP_RESOURCE_DEPOT"), function(depot)
		local owner = depot:getOwner()
		out[#out + 1] = place({
			building = buildingId(owner),
			name = owner.Name,
			capacity = depot.Capacity,
			warehouse = depot.IsWarehouse,
			input = inventory(depot.InputInventory),
			output = inventory(depot.OutputInventory),
		}, owner)
	end)
	return out
end

function snapshotParts.workplaces(level)
	local out = array()
	each(components(level, "COMP_WORKPLACE"), function(workplace)
		local owner = workplace:getOwner()
		local workers = array()
		each(workplace.AssignedWorkerList, function(worker)
			local ok, id = pcall(function() return worker:getOwner():getId() end)
			workers[#workers + 1] = ok and id or "?"
		end)
		-- Finished goods waiting to be carried away, summed over the queue.
		local waiting = {}
		each(workplace.CurrentlyProducedResourcesQueue, function(batch)
			each(batch.Collection, function(pair)
				local name = pair.Resource and pair.Resource.ResourceName
				if name then waiting[name] = (waiting[name] or 0) + pair.Quantity end
			end)
		end)
		out[#out + 1] = {
			building = buildingId(owner),
			name = owner.Name,
			paused = workplace.IsPaused,
			workers = workers,
			cyclesDone = workplace.CurrentProductionCycleCount,
			waiting = waiting,
			-- Hidden from here on.
			workerCapacity = workplace.CurrentWorkerCapacity,
			lacking = guarded(function()
				local out = array()
				each(workplace.LackingResourceList, function(resource)
					out[#out + 1] = type(resource) == "userdata" and resource.ResourceName or resource
				end)
				return out
			end),
			producedThisWeek = guarded(amounts, workplace.ResourceProducedThisWeek),
			upkeepThisWeek = workplace.UpkeepCostThisWeek,
		}
	end)
	return out
end

function snapshotParts.immigration(level)
	local manager = level:find("COMP_IMMIGRATION_MANAGER")
	if not manager then return nil end
	return { daysUntilNext = manager:getDaysUntilImmigration(), enabled = manager:getIsImmigrationEnabled() }
end

function snapshotParts.visitors(level)
	local out = array()
	each(components(level, "COMP_VISITOR"), function(visitor)
		local purpose = visitor.VisitorPurpose
		out[#out + 1] = place({
			name = visitor.Name,
			purpose = purpose and purpose.toString and purpose:toString() or nil,
			arrived = visitor.HasArrived,
			leaving = visitor.IsLeaving,
		}, visitor:getOwner())
	end)
	return out
end

-- Components outside the documented COMP_* list cannot be asked for by type.
-- They all live under the "Manager" object at the top of the level, so that
-- tree is walked once per level and the ones we use are kept. These objects
-- exist for as long as the level does.
local managers = { level = nil }

local function findManagers(level)
	if rawequal(managers.level, level) then return managers end
	managers = { level = level, tradingVillages = {} }
	local anchor = level:find("COMP_BUILDING_MANAGER")
	local root = anchor and anchor:getOwner()
	while root and root:getParent() do root = root:getParent() end
	if not root then return managers end
	local function look(object)
		object:forEachComponent(function(component)
			local kind = component:getComponentType()
			if kind == "PlaCCompQuestManager" then
				managers.quests = component
			elseif kind == "PlaCCompEdictsManager" then
				managers.edicts = component
			elseif kind == "PlaCCompTradingVillage" then
				managers.tradingVillages[#managers.tradingVillages + 1] = component
			end
		end)
	end
	local function walk(object, depth)
		look(object)
		if depth < 3 then object:forEachChild(function(child) walk(child, depth + 1) end) end
	end
	walk(root, 0)
	return managers
end

function snapshotParts.quests(level)
	local out = array()
	local manager = findManagers(level).quests
	each(manager and manager.QuestList, function(quest)
		-- No quest was active when this was written, so the field names are guesses
		-- taken from the quest asset; unknown names simply come back nil.
		local asset = quest.AssetQuest or quest.Quest
		local state = quest.QuestState or quest.State
		out[#out + 1] = {
			name = asset and asset.Name or quest.Name,
			state = type(state) == "userdata" and state.toString and state:toString() or nil,
		}
	end)
	return out
end

local function resourceNames(list)
	local out = array()
	each(list, function(resource) out[#out + 1] = resource.ResourceName end)
	return out
end

function snapshotParts.tradeRoutes(level)
	local out = array()
	for _, component in ipairs(findManagers(level).tradingVillages) do
		local village = component.TradingVillage
		if village then
			out[#out + 1] = {
				name = village.VillageName,
				open = component.IsTradeRouteEnabled,
				level = component.TradeRouteLevel,
				trading = component.IsCurrentlyTrading,
				blocked = component.IsTradeRouteBlocked,
				readyToUpgrade = component.IsReadyToUpgradeTradeRoute,
				buys = resourceNames(village.BuyingResourceList),
				sells = resourceNames(village.SellingResourceList),
			}
		end
	end
	return out
end

function snapshotParts.edicts(level)
	local manager = findManagers(level).edicts
	if not manager then return nil end
	return { edictSlots = manager.MaxEdictSlotCount, privilegeSlots = manager.MaxPrivilegeSlotCount }
end

local managerComponent  -- defined below

-- Hidden: the village itself.
function snapshotParts.village(level)
	local loop = level:find("COMP_MAIN_GAME_LOOP")
	if not loop or loop.VillageName == nil then return nil end
	local out = {
		name = loop.VillageName,
		ruler = loop.RulerName,
		level = loop.VillageLevel,
		gameSeconds = loop.GameTimeInSecond,
	}
	out.unlockedSystems = guarded(function()
		local systems = array()
		each(loop.UnlockedSystemList, function(system) systems[#systems + 1] = enumText(system) end)
		return systems
	end)
	local villagers = level:find("COMP_VILLAGER_MANAGER")
	if villagers then
		out.happiness = villagers.GlobalHappiness
		out.needsFilledPercent = villagers.GlobalNeedListPercentageFilled
		-- Villagers start leaving when their happiness is below this.
		out.leaveBelowHappiness = (villagers.BaseMinimumHappinessForVillagerLeaving or 0) + (villagers.AdditionalMinimumHappinessForVillagerLeaving or 0)
		out.villagersLeaving = villagers.VillagerLeavingCount
	end
	-- The tool the player has in hand: Manage, Build Monument, Zoning, ...
	out.tool = guarded(function()
		local machine = managerComponent(level, "PlaCCompStateMachine")
		local state = machine and machine.CurrentState
		return state and state.Name or nil
	end)
	return out
end

-- Hidden: money. Each budget entry lists transactions with a category and the
-- resources moved; they are summed per category here.
local function budgetSide(transactions)
	local out = {}
	each(transactions, function(transaction)
		local category = transaction.Category
		local name = category and category.toString and category:toString() or "OTHER"
		out[name] = amounts(transaction.Collection, out[name])
	end)
	return out
end

-- The game keeps every day since the village began; only the newest few are sent.
local function budgetList(list, keep)
	local total = 0
	each(list, function() total = total + 1 end)
	local out, index = array(), 0
	each(list, function(entry)
		index = index + 1
		if index > total - keep then
			out[#out + 1] = { income = budgetSide(entry.IncomeTransactionList), expenses = budgetSide(entry.ExpenseTransactionList) }
		end
	end)
	return out
end

function managerComponent(level, kind)
	local found = findManagers(level)
	found.byKind = found.byKind or {}
	if found.byKind[kind] == nil then
		local anchor = level:find("COMP_BUILDING_MANAGER")
		local root = anchor and anchor:getOwner()
		while root and root:getParent() do root = root:getParent() end
		local component = false
		if root then
			component = componentOf(root, kind) or false
			if not component then
				root:forEachChildRecursive(function(child)
					if component then return false end
					component = componentOf(child, kind) or false
				end)
			end
		end
		found.byKind[kind] = component
	end
	return found.byKind[kind] or nil
end

function snapshotParts.economy(level)
	local economy = managerComponent(level, "PlaCCompEconomyManager")
	if not economy or economy.DailyWealthAverage == nil then return nil end
	local weekly = guarded(budgetList, economy.WeeklyBudgetInfoList, 4) or array()
	local daily = guarded(budgetList, economy.DailyBudgetInfoList, 7) or array()
	return {
		dailyWealthAverage = economy.DailyWealthAverage,
		secondsToNextPayment = economy.TimeToNextPayment,
		nextRevenueFromConsumption = economy.NextRevenueFromConsumption,
		-- Oldest first, as the game keeps them; the last entry is the current period.
		weeks = weekly,
		days = daily,
	}
end

function snapshotParts.scores(level)
	local out = {}
	local score = managerComponent(level, "PlaCCompGlobalScore")
	if score then out.total = score.TotalScoreValue end
	local estate = managerComponent(level, "PlaCCompEstateManager")
	if estate then
		out.splendor = estate.TotalSplendor
		out.estatesUnlocked = estate.IsUnlocked
	end
	if next(out) == nil then return nil end
	return out
end

-- Hidden: houses, who lives in them and the lot each stands on.
function snapshotParts.houses(level)
	local out = array()
	each(components(level, "COMP_BUILDING"), function(building)
		local asset = building.AssetBuilding
		if not asset or asset.Name ~= "HOUSE" then return end
		local owner = building:getOwner()
		local house
		owner:forEachChildRecursive(function(child)
			if house then return false end
			house = componentOf(child, "PlaCCompHouse")
		end)
		if not house then return end
		local residents = array()
		each(house.VillagerList, function(villager)
			local ok, id = pcall(function() return villager:getOwner():getId() end)
			residents[#residents + 1] = ok and id or "?"
		end)
		local lot = house.Lot
		out[#out + 1] = place({
			building = owner:getId(),
			density = house.Density,
			status = house.Status,
			residents = residents,
			readyForUpgrade = house.IsReadyForUpgrade,
			readyForStatusUpgrade = house.IsReadyForStatusUpgrade,
			lot = lot and flatPolygon(lot.LotShapePolygon) or array(),
		}, house:getOwner())
	end)
	return out
end

-- Hidden: which map regions the village owns. Their outlines go with the
-- terrain survey, since they never change.
local function territoryManager()
	local object = foundation.findGameObject("Territory Manager")
	return object and componentOf(object, "PlaCCompTerritoryManager") or nil
end

function snapshotParts.territory()
	local manager = territoryManager()
	if not manager or manager.RegionList == nil then return nil end
	local owned = array()
	each(manager.RegionList, function(region)
		if region.IsTerritory or region.IsUnlocked then owned[#owned + 1] = region:getOwner().Name end
	end)
	return { owned = owned, nextTax = manager.NextTaxValue, upkeepMultiplier = manager.TerritoryUpkeepMultiplier }
end

-- Hidden: per resource, whether it is unlocked, how it is traded and what the
-- village used and sold in the current period.
function snapshotParts.resources(level)
	local out = {}
	local manager = managerComponent(level, "PlaCCompResourceManager")
	each(manager and manager.ResourceInstanceList, function(instance)
		local resource = instance.Resource
		if resource and instance.IsKnown and not instance.IsLocked then
			out[resource.ResourceName] = { trade = enumText(instance.TradeState), tradeAmount = instance.AmountToTrade }
		end
	end)
	local economy = managerComponent(level, "PlaCCompEconomyManager")
	each(economy and economy.ResourceStatList, function(stat)
		local resource = stat.Resource
		local entry = resource and out[resource.ResourceName]
		if entry then
			entry.consumed = stat.QuantityConsumed
			entry.traded = stat.QuantityTraded
			entry.tradeRevenue = stat.TradeRevenue
			entry.costPerUnit = stat.CostPerUnit
			local produced = 0
			each(stat.WorkplaceStatList, function(workplace) produced = produced + (workplace.AmountProduced or 0) end)
			entry.produced = produced
		end
	end)
	if next(out) == nil then return nil end
	return out
end

-- Hidden: what has been bought on the progress screen and what could be.
function snapshotParts.unlockables(level)
	local manager = managerComponent(level, "PlaCCompUnlockableManager")
	if not manager or manager.UnlockableInstanceList == nil then return nil end
	local out = array()
	each(manager.UnlockableInstanceList, function(instance)
		out[#out + 1] = { name = assetName(instance.Unlockable), bought = instance.NumTimeBought, daysUntilAvailable = instance.DaysLeftBeforeAvailable }
	end)
	return out
end

-- Hidden: the taxes in force.
function snapshotParts.taxes(level)
	local manager = level:find("COMP_TAXATION_MANAGER")
	if not manager or manager.InstTaxationFunctionList == nil then return nil end
	local out = array()
	each(manager.InstTaxationFunctionList, function(instance)
		local asset = instance.TaxationFunction
		out[#out + 1] = {
			name = asset and (asset.NameKey ~= "" and asset.NameKey or assetName(asset)) or nil,
			active = instance.IsActive,
			available = instance.IsAvailable,
			bracket = instance.Bracket,
			multiplier = instance.Multiplier,
		}
	end)
	return out
end

-- Hidden: the notifications the game is currently showing the player.
function snapshotParts.notifications(level)
	local manager = managerComponent(level, "PlaCCompNotificationManager")
	if not manager or manager.ActiveNotificationList == nil then return nil end
	local out = array()
	each(manager.ActiveNotificationList, function(notification)
		local asset = notification.Notification
		local targets = 0
		each(notification.NotificationTargetList, function() targets = targets + 1 end)
		out[#out + 1] = {
			title = asset and (asset.Title ~= "" and asset.Title or assetName(asset)) or nil,
			category = enumText(notification.NotificationCategory),
			text = notification.Text,
			targets = targets,
		}
	end)
	return out
end

-- Hidden: the estates (labour, clergy, kingdom) and the village's standing with each.
function snapshotParts.estates(level)
	local manager = managerComponent(level, "PlaCCompEstateManager")
	if not manager or manager.EstateInstanceList == nil then return nil end
	local out = array()
	each(manager.EstateInstanceList, function(instance)
		out[#out + 1] = {
			name = assetName(instance.Estate),
			influence = instance.CurrentInfluence,
			influencePerWeek = instance.InfluenceGainPerWeek,
			splendor = instance.Splendor,
		}
	end)
	return out
end

function B.snapshot()
	local level = B.level
	if not level then return nil end
	local out = { errors = array() }
	for name, read in pairs(snapshotParts) do
		local ok, value = pcall(read, level)
		if ok then
			out[name] = value
		else
			out.errors[#out.errors + 1] = name .. ": " .. safeString(value)
		end
	end
	return out
end

--------------------------------------------------------------------------
-- Terrain survey: ground height and water on a grid, tree density, and natural
-- deposits. Heights never change, so they are measured once per level; trees
-- and deposits are recounted every TERRAIN_REFRESH seconds.
--
-- It runs as a coroutine that the pump resumes once per tick, so the ray casts
-- and the encoding are spread over many frames. The one part that cannot be
-- spread is the pass over all resource containers (every tree is one): game
-- objects must not be held across frames, in case they are destroyed. That
-- pass took 73 ms for 34,634 containers.

local terrain = { level = nil, job = nil, payload = nil, builtAt = 0, heights = nil, water = nil, grid = nil }

local function numberList(list)
	local parts = {}
	for i = 1, #list do parts[i] = string.format("%d", list[i]) end
	return "[" .. table.concat(parts, ",") .. "]"
end

local function surveyTerrain(level, cache)
	local work = 0
	local function breathe(amount)
		work = work + amount
		if work >= 6000 then
			work = 0
			coroutine.yield()
		end
	end

	-- Every tree and deposit, in one pass.
	local treeX, treeZ, deposits = {}, {}, {}
	local fullQuantity = {}  -- what one untouched deposit of each kind holds
	local minX, maxX, minZ, maxZ = math.huge, -math.huge, math.huge, -math.huge
	each(components(level, "COMP_RESOURCE_CONTAINER"), function(container)
		local data = container.ResourceContainerData
		local resource = data and data.ResourceData
		if not resource then return end
		local name = resource.ResourceName
		local position = container:getOwner():getGlobalPosition()
		local x, z = position[1], position[3]
		if x < minX then minX = x end
		if x > maxX then maxX = x end
		if z < minZ then minZ = z end
		if z > maxZ then maxZ = z end
		if name == "WOOD" then
			treeX[#treeX + 1], treeZ[#treeZ + 1] = x, z
		else
			local list = deposits[name]
			if not list then
				list = {}
				deposits[name] = list
				fullQuantity[name] = data.InitialQuantity
			end
			-- Hidden: what is left in it; -1 when the filter is not lifted.
			list[#list + 1], list[#list + 2], list[#list + 3] = x, z, container.AvailableQuantity or -1
		end
	end)
	coroutine.yield()
	if minX > maxX then return nil end

	-- A square grid over everything found, on a 64-unit boundary so that it
	-- stays put between surveys.
	local grid = cache.grid
	if not grid then
		local originX, originZ = math.floor(minX / 64) * 64, math.floor(minZ / 64) * 64
		local size = math.max(math.ceil(maxX / 64) * 64 - originX, math.ceil(maxZ / 64) * 64 - originZ, 64)
		grid = { x = originX, z = originZ, cell = size / TERRAIN_CELLS, cells = TERRAIN_CELLS }
		cache.grid = grid
	end
	local cells, cell = grid.cells, grid.cell

	-- Ground height and water surface at the centre of each cell, in tenths of
	-- a unit. Water is 0 where there is none above the ground.
	if not cache.heights then
		local terrainFlag = 2 ^ OBJECT_FLAG.TERRAIN:toNumber()
		local waterFlag = 2 ^ OBJECT_FLAG.WATER:toNumber()
		local heights, water = {}, {}
		local hit = {}
		for row = 0, cells - 1 do
			local z = grid.z + (row + 0.5) * cell
			for column = 0, cells - 1 do
				local x = grid.x + (column + 0.5) * cell
				local index = row * cells + column + 1
				local ground = 0
				if level:rayCast({ x, 2000, z }, { x, -1000, z }, hit, terrainFlag) then ground = hit.Position[2] end
				heights[index] = math.floor(ground * 10 + 0.5)
				local surface = 0
				if level:rayCast({ x, 2000, z }, { x, -1000, z }, hit, waterFlag) and hit.Position[2] > ground then
					surface = math.max(1, math.floor((hit.Position[2] - ground) * 10 + 0.5))
				end
				water[index] = surface
			end
			breathe(cells * 2)
		end
		cache.heights, cache.water = numberList(heights), nil
		coroutine.yield()
		cache.water = numberList(water)
		coroutine.yield()
	end

	local trees = {}
	for i = 1, cells * cells do trees[i] = 0 end
	for i = 1, #treeX do
		local column = math.floor((treeX[i] - grid.x) / cell)
		local row = math.floor((treeZ[i] - grid.z) / cell)
		if column >= 0 and column < cells and row >= 0 and row < cells then
			local index = row * cells + column + 1
			trees[index] = trees[index] + 1
		end
	end
	coroutine.yield()
	local treeText = numberList(trees)
	coroutine.yield()

	-- Hidden: the outline of every map region.
	local regionParts = {}
	pcall(function()
		local manager = territoryManager()
		each(manager and manager.RegionList, function(region)
			local outline = flatPolygon(region.NonHolePolygon)
			for i = 1, #outline do outline[i] = string.format("%.1f", outline[i]) end
			regionParts[#regionParts + 1] = encodeString(region:getOwner().Name) .. ":[" .. table.concat(outline, ",") .. "]"
		end)
	end)
	coroutine.yield()

	local depositParts = {}
	for name, list in pairs(deposits) do
		for i = 1, #list do list[i] = math.floor(list[i] + 0.5) end
		depositParts[#depositParts + 1] = encodeString(name) .. ":" .. numberList(list)
	end
	return string.format(
		'{"x":%d,"z":%d,"cell":%.6f,"cells":%d,"treeCount":%d,"heights":%s,"water":%s,"trees":%s,"deposits":{%s},"depositQuantity":%s,"depositStride":3,"regions":{%s}}',
		grid.x, grid.z, cell, cells, #treeX, cache.heights, cache.water, treeText, table.concat(depositParts, ","), encode(fullQuantity),
		table.concat(regionParts, ",")
	)
end

-- Advances the survey a little. Returns the encoded result when a new one is
-- ready, otherwise nil.
function B.terrainStep(now)
	local level = B.level
	if not level then return nil end
	if not rawequal(terrain.level, level) then
		terrain = { level = level, job = nil, payload = nil, builtAt = 0, heights = nil, water = nil, grid = nil }
	end
	if not terrain.job then
		if terrain.payload ~= nil and now - terrain.builtAt < TERRAIN_REFRESH then return nil end
		terrain.job = coroutine.create(surveyTerrain)
	end
	local ok, result = coroutine.resume(terrain.job, level, terrain)
	if coroutine.status(terrain.job) ~= "dead" then return nil end
	terrain.job, terrain.builtAt = nil, now
	if not ok then
		log("terrain survey failed:", result)
		terrain.payload = terrain.payload or false
		return nil
	end
	terrain.payload = result or false
	return result
end

-- The last finished survey, for a server that connects later.
function B.terrainPayload()
	return rawequal(terrain.level, B.level) and terrain.payload or nil
end

--------------------------------------------------------------------------
-- Where the game's camera is looking, for the dashboard's "follow camera" mode.
--
-- The API has no camera object, but level:worldToScreenCoordinates tells us
-- where any world point lands on screen. Near a point that mapping is close to
-- linear, so we measure it with three points and solve for the ground point
-- that lands on the centre of the window, repeating from the new estimate.

local cameraTarget = nil  -- last solution; the next search starts here

-- Hidden: the game's own camera controller knows exactly where it is looking.
local function exactCamera(width, height)
	local object = foundation.findGameObject("Camera")
	local controller = object and componentOf(object, "PlaCCompNavigationController")
	local lookAt = controller and controller.LookAt
	if type(lookAt) ~= "table" then return nil end
	local lens = componentOf(object, "GamCCompCamera")
	local fieldOfView = math.rad(lens and lens.FovY or 45)
	return {
		x = lookAt[1],
		z = lookAt[3],
		-- The map turns the opposite way to the camera's yaw.
		rotation = -math.rad(controller.RotationY),
		pixelsPerUnit = (height / 2) / (controller.Distance * math.tan(fieldOfView / 2)),
		width = width,
		height = height,
		exact = true,
	}
end

function B.camera()
	local level = B.level
	local width, height = gameWindowSize()
	if not level or not width then return nil end
	local ok, exact = pcall(exactCamera, width, height)
	if ok and exact then return exact end

	local x, y, z
	if cameraTarget then
		x, y, z = cameraTarget[1], cameraTarget[2], cameraTarget[3]
	else
		local first = level:getComponentManager("COMP_BUILDING"):getFirst()
		if not first then return nil end
		local position = first:getOwner():getGlobalPosition()
		x, y, z = position[1], position[2], position[3]
	end

	local span = 10
	local ax, ay, bx, by  -- screen pixels per world unit along +x (a) and +z (b)
	for _ = 1, 6 do
		local origin = level:worldToScreenCoordinates({ x, y, z })
		local alongX = level:worldToScreenCoordinates({ x + span, y, z })
		local alongZ = level:worldToScreenCoordinates({ x, y, z + span })
		ax, ay = (alongX[1] - origin[1]) / span, (alongX[2] - origin[2]) / span
		bx, by = (alongZ[1] - origin[1]) / span, (alongZ[2] - origin[2]) / span
		local det = ax * by - ay * bx
		if det ~= det or math.abs(det) < 1e-6 then return nil end
		local ex, ey = width / 2 - origin[1], height / 2 - origin[2]
		local dx, dz = (ex * by - ey * bx) / det, (ax * ey - ay * ex) / det
		-- Far from the solution the linear guess overshoots; take bounded steps.
		local length = math.sqrt(dx * dx + dz * dz)
		if length > 150 then dx, dz = dx * 150 / length, dz * 150 / length end
		x, z = x + dx, z + dz
		if length < 0.5 then break end
	end
	if x ~= x or z ~= z then
		cameraTarget = nil
		return nil
	end
	cameraTarget = { x, y, z }
	return {
		x = x,
		z = z,
		rotation = math.atan2(ay, ax),           -- direction of world +x on screen, y down
		pixelsPerUnit = math.sqrt(ax * ax + ay * ay),
		width = width,
		height = height,
	}
end

--------------------------------------------------------------------------
-- Socket transport. Frames are "TYPE id length\n" followed by length bytes.

package.cpath = (package.cpath or "") .. ";mods/libs/?.dll;" .. GAME_DIR .. "/mods/libs/?.dll"
local socketOk, socket = pcall(require, "socket.core")
if not socketOk then
	log("socket.core failed to load:", socket)
	socket = nil
end

local clock = (socket and socket.gettime) or os.clock
local sock, buffer = nil, ""
local lastTick, lastConnect, lastStatus, lastSnapshot, lastCamera = 0, -math.huge, 0, 0, 0
local busy = false

local function disconnect(reason)
	if sock then pcall(sock.close, sock) end
	sock, buffer = nil, ""
	B.state = "idle"
	log("disconnected:", reason)
end

local retired = false

-- Stops this copy for good: a reloaded copy is about to take over.
function B.shutdown()
	retired = true
	disconnect("reloading")
	if logFile then logFile:close() end
	logFile = nil
end

-- Runs the installed bridge.lua again and returns the new bridge.
function B.reload()
	dofile(scriptPath)
	return rawget(_G, "__bridge")
end

local function send(kind, id, payload)
	if not sock then return end
	sock:settimeout(2)
	local ok, err = sock:send(string.format("%s %s %d\n", kind, tostring(id), #payload) .. payload)
	if sock then sock:settimeout(0) end
	if not ok then disconnect("send failed: " .. safeString(err)) end
end

local function hello()
	return encode({
		lua = _VERSION,
		jit = jit and jit.version or nil,
		cpath = package.cpath,
		path = package.path,
		userDir = userDir,
		status = B.status(),
		globals = B.globals(),
		registry = B.registry(),
	})
end

local function connect()
	local now = clock()
	if now - lastConnect < RECONNECT_INTERVAL then return end
	lastConnect = now
	local candidate = socket.tcp()
	candidate:settimeout(CONNECT_TIMEOUT)
	local ok, err = candidate:connect(HOST, PORT)
	if not ok then
		candidate:close()
		if B.lastConnectError ~= err then log("connect failed:", err) end
		B.lastConnectError = err
		return
	end
	candidate:settimeout(0)
	pcall(candidate.setoption, candidate, "tcp-nodelay", true)
	sock, buffer = candidate, ""
	B.state, B.lastConnectError = "connected", nil
	log("connected to", HOST .. ":" .. PORT)
	send("HELLO", 0, hello())
	local survey = B.terrainPayload()
	if survey then send("TERRAIN", 0, survey) end
end

local function evaluate(id, code)
	local chunk, syntaxError = loadstring(code, "=eval")
	if not chunk then return send("ERR", id, encode({ error = syntaxError })) end
	local results = { xpcall(chunk, debug.traceback) }
	if not results[1] then return send("ERR", id, encode({ error = safeString(results[2]) })) end
	local encoded = {}
	for i = 2, table.maxn and table.maxn(results) or #results do
		local ok, text = pcall(encode, results[i])
		encoded[#encoded + 1] = ok and text or encodeString("<encode failed: " .. safeString(text) .. ">")
	end
	send("RES", id, "[" .. table.concat(encoded, ",") .. "]")
end

local function receive()
	while sock do
		local data, err, partial = sock:receive(65536)
		local chunk = data or partial
		if chunk and #chunk > 0 then buffer = buffer .. chunk end
		if err == "closed" then return disconnect("server closed the connection") end
		if not data then break end
	end
	while sock do
		local lineEnd = buffer:find("\n", 1, true)
		if not lineEnd then break end
		local kind, id, length = buffer:sub(1, lineEnd - 1):match("^(%u+) (%S+) (%d+)$")
		if not kind then return disconnect("bad frame header") end
		length = tonumber(length)
		if #buffer < lineEnd + length then break end
		local payload = buffer:sub(lineEnd + 1, lineEnd + length)
		buffer = buffer:sub(lineEnd + length + 1)
		if kind == "EVAL" then evaluate(id, payload) end
	end
end

local function pump()
	if not socket then return end
	if not sock then connect() end
	if not sock then return end
	receive()
	local now = clock()
	if sock and now - lastStatus >= STATUS_INTERVAL then
		lastStatus = now
		send("STATUS", 0, encode(B.status()))
	end
	if sock and B.level and now - lastCamera >= CAMERA_INTERVAL then
		lastCamera = now
		local ok, camera = pcall(B.camera)
		if ok and camera then send("CAMERA", 0, encode(camera)) end
	end
	if sock and B.level then
		local survey = B.terrainStep(now)
		if survey then send("TERRAIN", 0, survey) end
	end
	if sock and B.level and now - lastSnapshot >= SNAPSHOT_INTERVAL then
		lastSnapshot = now
		local ok, snapshot = pcall(B.snapshot)
		if ok and snapshot then
			send("STATE", 0, encode(snapshot))
		elseif not ok then
			log("snapshot failed:", snapshot)
		end
	end
end

-- Called as often as we can arrange; does real work at most every TICK_INTERVAL.
function B.tick(source)
	local now = clock()
	if retired or busy or now - lastTick < TICK_INTERVAL then return false end
	busy, lastTick = true, now
	B.ticks = B.ticks + 1
	B.tickSources[source] = (B.tickSources[source] or 0) + 1
	local thread = currentThread()
	B.tickThreads[thread] = (B.tickThreads[thread] or 0) + 1
	local ok, err = pcall(pump)
	if not ok then log("tick error:", err) end
	busy = false
	return true
end

--------------------------------------------------------------------------
-- Getting called.
--
-- The unmodded game runs no Lua after startup, and its Lua VM lives on a worker
-- thread with no message loop, so on its own this script runs once and never
-- again. The companion mod fixes that: it hands us its mod object, and through
-- it we register
--   * a component whose update() the game calls every frame, and
--   * two things the game calls with a way to reach the LEVEL, which we need
--     in order to put that component into it: a game action run by a daily
--     event, and a taxation function (only once the village has taxation).
-- A count hook stays installed as a second way in whenever other Lua runs.

local TICKER = "COMP_COMPANION_BRIDGE_TICKER"
local TAXATION = "TAXATION_FUNCTION_COMPANION_BRIDGE"
local ACTION = "GAME_ACTION_COMPANION_BRIDGE"

local function enterLevel(level)
	B.level = level
	local found, existing = pcall(level.find, level, TICKER)
	if found and existing then return log("ticker already in this level") end
	local ok, err = pcall(function()
		level:createObject(function(object)
			object.Name = "CompanionBridgeTicker"
			object:addComponent(TICKER)
		end)
	end)
	log(ok and "ticker object created" or ("could not create ticker: " .. safeString(err)))
end

B.enterLevel = enterLevel

-- Classes handed to the game outlive a reload, so their functions look up the
-- current bridge each time instead of holding on to this copy.
local function bridge()
	return rawget(_G, "__bridge") or B
end

local function step(name, action)
	local ok, err = pcall(action)
	log(name .. ":", ok and "ok" or safeString(err))
	return ok
end

function B.attachMod(mod)
	B.mod = mod
	log("mod attached on thread", currentThread())

	local ticker = { TypeName = TICKER, ParentType = "COMPONENT", Properties = {} }
	function ticker:update()
		local current = bridge()
		if not current.level then current.level = self:getLevel() end
		current.tick("component")
	end
	function ticker:onFinalize()
		bridge().level = nil
		bridge().log("ticker finalized")
	end

	local taxation = { TypeName = TAXATION, ParentType = "TAXATION_FUNCTION_BRACKET", Properties = {} }
	function taxation:init(instance)
		local current = bridge()
		current.log("taxation function init")
		local ok, level = pcall(function() return instance:getTaxationManager():getLevel() end)
		if ok and level then current.enterLevel(level) else current.log("no level from the taxation manager:", level) end
		current.tick("init")
	end
	function taxation:finalize()
		bridge().level = nil
		bridge().log("taxation function finalize")
	end
	function taxation:getMaximumAmountToCollect()
		return 0
	end

	local action = { TypeName = ACTION, ParentType = "GAME_ACTION", Properties = {} }
	function action:execute(level)
		local current = bridge()
		current.log("game action executed")
		if level then current.enterLevel(level) end
		current.tick("action")
	end

	step("register ticker class", function() mod:registerClass(ticker) end)
	step("register game action class", function() mod:registerClass(action) end)
	step("register daily event", function()
		mod:registerAsset({
			DataType = "EVENT",
			Id = "COMPANION_BRIDGE_EVENT",
			Title = "COMPANION_BRIDGE_EVENT_TITLE",
			Description = "COMPANION_BRIDGE_EVENT_DESCRIPTION",
			DaysToFirst = 0,
			Delay = 0,
			DaysBetweenOccurences = 1,
			IsRecurrent = true,
			ConditionList = {},
			ActionList = { { DataType = ACTION, IsHidden = true } },
		})
	end)
	-- The game only runs events that its balancing settings list.
	step("add daily event to the game's balancing", function()
		mod:overrideAsset({
			Id = "DEFAULT_BALANCING",
			EventListGlobal = { Action = "APPEND", "COMPANION_BRIDGE_EVENT" },
		})
	end)
	step("register taxation class", function() mod:registerClass(taxation) end)
	step("register taxation asset", function()
		mod:registerAsset({
			DataType = TAXATION,
			Id = "COMPANION_BRIDGE_TAXATION_FUNCTION",
			NameKey = "COMPANION_BRIDGE_TAXATION_NAME",
			DescriptionKey = "COMPANION_BRIDGE_TAXATION_DESCRIPTION",
			CategoryKey = "COMPANION_BRIDGE_TAXATION_CATEGORY",
			TaxedNameKey = "COMPANION_BRIDGE_TAXATION_TAXED",
			TaxationBracketList = { { DataType = "TAXATION_BRACKET", TaxPercentage = 0.0 } },
		})
	end)
	step("add taxation function to the game's settings", function()
		mod:overrideAsset({
			Id = "DEFAULT_TAXATION_SETTINGS",
			AssetTaxationFunctionList = { Action = "APPEND", "COMPANION_BRIDGE_TAXATION_FUNCTION" },
		})
	end)
	B.tick("mod-load")
end

-- The hook only ticks. It must not poke at whatever the interrupted code holds:
-- indexing a game object with a name it lacks is logged as an error by the
-- game, and doing that to a mod object makes the game reject the mod.
local function onHook()
	B.hookCalls = B.hookCalls + 1
	B.tick("hook")
end

if getmetatable(_G) == nil then
	setmetatable(_G, {
		__newindex = function(t, k, v)
			rawset(t, k, v)
			local seen = bridge().newGlobals
			if #seen < 2000 then seen[#seen + 1] = safeString(k) end
		end,
	})
elseif not previous then
	log("_G already has a metatable; not tracking new globals")
end

debug.sethook(onHook, "", HOOK_COUNT)

log("property filter:", B.propertyFilter or "not attempted (no FFI)")
log(previous and "bridge reloaded;" or "bridge loaded;", _VERSION, jit and jit.version or "no jit", "socket:", socket and "ok" or "missing")
log("args:", ...)
do
	local file = io.open(userDir .. "bridge-startup.json", "w")
	if file then
		file:write(encode({ globals = B.globals(), registry = B.registry() }))
		file:close()
	end
end
B.tick("load")
