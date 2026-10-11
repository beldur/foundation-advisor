-- All logic lives in moddev/bridge.lua, which the game loads unsandboxed at startup.
-- This mod only hands it a mod object so it can register what it needs.
local mod = foundation.createMod()

local function findBridge()
	local ok, found = pcall(function() return __bridge end)
	if ok and found then return found end
	return foundation.__bridge or ("").__bridge
end

local bridge = findBridge()
if not bridge then
	mod:logError("Companion bridge is not loaded. Run `pnpm install-bridge` and restart the game.")
	return
end

-- Pick up an updated moddev/bridge.lua without restarting the game: the mod
-- reload shortcut (Ctrl+Shift+R) runs this file again.
if bridge.reload then
	local reloaded, result = pcall(bridge.reload)
	if reloaded and result then
		bridge = result
	else
		mod:logError("Companion bridge failed to reload: " .. tostring(result))
	end
end

local ok, err = pcall(bridge.attachMod, mod)
if not ok then mod:logError("Companion bridge failed to attach: " .. tostring(err)) end
