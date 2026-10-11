// The state snapshot the bridge sends every two seconds (B.snapshot in bridge/bridge.lua).
// Only the fields the server itself reads are typed; the dashboard gets the whole thing.

export interface Positioned {
  x: number;
  y: number;
  z: number;
}

export interface Villager extends Positioned {
  id: string;
  name: string;
  job?: string;
  jobLevel?: number;
  jobExperience?: number;
  state: string | number;
}

export interface Building extends Positioned {
  id: string;
  name: string;
  type?: string;
  parts: number;
  partsBuilt: number;
}

export interface Visitor extends Positioned {
  name: string;
  purpose?: string;
  arrived: boolean;
  leaving: boolean;
}

export interface TradeRoute {
  name: string;
  open: boolean;
  buys: string[];
  sells: string[];
}

export interface Quest {
  name?: string;
  state?: string;
}

export interface GameState {
  time?: { day: number; week: number; month: number; dayLengthSeconds: number; timeScale: number };
  villagers?: Villager[];
  buildings?: Building[];
  visitors?: Visitor[];
  tradeRoutes?: TradeRoute[];
  quests?: Quest[];
  errors?: string[];
}
