import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Riftbound Duel Emulator (rules-based core)
 * - Loads card data from the provided JSON (riftbound_data_expert.json format)
 * - Implements Duel (1v1) board: 2 Battlefields, 1 Base per player, Rune decks, Rune pools
 * - Implements: Setup (legend/champion/battlefield auto), Mulligan (up to 2 Recycle), Turn structure,
 *              Rune channel/draw, Rune pool empty timing, Standard Move, Showdowns, Combat (simplified but rules-aligned),
 *              Hold/Conquer scoring + Final Point rule, Burn Out, Hidden/Legion/Accelerate (core constraints),
 *              Deflect additional cost (single-target), Stun timing, and a lightweight effect resolver for common verbs.
 *
 * Notes:
 * - Card effect parsing is intentionally conservative: it covers the most common templated effects but
 *   does not fully automate every unique card text.
 * - Where automation is ambiguous, the UI offers “Manual resolve” helpers rather than guessing.
 */

// ----------------------------- Types -----------------------------

type PlayerId = "P1" | "P2";


type MatchFormat = "BO1" | "BO3";

type BattlefieldPick = string; // card id

type MatchState = {
  format: MatchFormat;
  gamesCompleted: number; // 0..2
  wins: Record<PlayerId, number>;
  usedBattlefieldIds: Record<PlayerId, string[]>;
  lastGameWinner: PlayerId | null;
};


type Step =
    | "SETUP"
    | "MULLIGAN"
    | "AWAKEN"
    | "SCORING"
    | "CHANNEL"
    | "DRAW"
    | "ACTION"
    | "ENDING"
    | "GAME_OVER";

type WindowKind = "NONE" | "SHOWDOWN" | "COMBAT";

type CombatStep = "SHOWDOWN" | "DAMAGE" | "RESOLUTION";

type Domain =
    | "Body"
    | "Calm"
    | "Chaos"
    | "Fury"
    | "Mind"
    | "Order"
    | "Colorless";

type CardType = "Unit" | "Spell" | "Gear" | "Rune" | "Battlefield" | "Legend";

interface CardData {
  id: string;
  name: string;
  image?: string;
  image_url?: string;
  rarity?: string;
  domain: string; // can be "Fury" or "Fury, Mind"
  cost: number; // energy
  type: CardType;
  tags?: string[];
  ability?: {
    trigger?: string;
    effect_text?: string;
    reminder_text?: string[];
    raw_text?: string;
    keywords?: string[];
  };
  stats: {
    might: number | null;
    power: number | null; // "colored" power icons count
  };
}

interface ExpertRulesText {
  raw?: string;
  keywords?: string[];
}

interface ExpertCardData {
  id: string;
  name: string;
  rarity?: string;
  domain?: string; // Domain directly from CSV (e.g., "Fury", "Calm, Mind")
  type_line?: string;
  stats?: {
    energy?: number;
    might?: number;
    power?: number | string;
  };
  rules_text?: ExpertRulesText;
  game_logic?: {
    chain?: Array<{
      type?: string;
      condition?: string;
      effects?: Array<Record<string, unknown>>;
    }>;
  };
  image_url?: string; // Image URL from CSV
  supertypes?: string; // e.g., "basic" for runes
  tags?: string[]; // Additional tags from CSV
}

interface CardInstance extends CardData {
  instanceId: string;
  owner: PlayerId;
  controller: PlayerId;

  // unit-specific state
  isReady: boolean;
  damage: number;
  buffs: number; // permanent +1 might buffs
  tempMightBonus: number; // "this turn" might
  stunned: boolean;
  stunnedUntilTurn: number; // Turn number when stun expires (0 = not stunned)

  // Dynamic keyword grants
  extraKeywords?: string[]; // permanent (rare; used by some effects)
  tempKeywords?: string[]; // cleared end of turn
  conditionalKeywords?: string[]; // computed from conditional text (buffed, mighty, etc.)

  // bookkeeping
  createdTurn: number;
  moveCountThisTurn: number;
  killOnDamageUntilTurn?: number;
  deathReplacement?: {
    untilTurn: number;
    recallExhausted: boolean;
    payRuneDomain?: Domain;
    payRuneAny?: boolean;
    optional?: boolean;
  };
}

interface RuneInstance {
  instanceId: string;
  owner: PlayerId;
  controller: PlayerId;
  domain: Domain;
  isReady: boolean;
  createdTurn: number;

  // Visual / provenance (optional but used by Arena UI)
  cardId?: string;
  name?: string;
  image_url?: string;
  image?: string;
}

type RunePayKind = "EXHAUST" | "RECYCLE" | "BOTH";

interface AutoPayPlan {
  runeUses: Record<string, RunePayKind>; // key = rune.instanceId
  recycleCount: number;
  exhaustCount: number;
  exhaustOnlyCount: number;
  addsEnergy: number;
  addsPower: Record<Domain, number>;
}

interface FacedownCard {
  card: CardInstance;
  owner: PlayerId;
  hiddenOnTurn: number;
  markedForRemoval: boolean;
  // The battlefield this facedown is associated with is implicit (the container battlefield index)
}

interface BattlefieldState {
  index: number;
  card: CardData; // battlefield card (public)
  owner: PlayerId; // who contributed it
  controller: PlayerId | null; // who controls it (can be null if uncontrolled)
  contestedBy: PlayerId | null; // who is contesting it (if any)
  facedown: FacedownCard | null; // only one total, duel rules
  units: Record<PlayerId, CardInstance[]>;
  gear: Record<PlayerId, CardInstance[]>;
}

interface RunePool {
  energy: number;
  power: Record<Domain, number>;
}

interface PlayerState {
  id: PlayerId;
  legend: CardData | null;
  legendReady: boolean;
  championZone: CardInstance | null; // chosen champion starts here
  base: {
    units: CardInstance[];
    gear: CardInstance[];
  };

  mainDeck: CardInstance[];
  hand: CardInstance[];
  trash: CardInstance[];
  banishment: CardInstance[];

  runeDeck: RuneInstance[];
  runesInPlay: RuneInstance[];

  runePool: RunePool;

  points: number;

  // Bookkeeping for costs/keywords
  domains: Domain[]; // Domain Identity (derived from Legend for this emulator)
  mainDeckCardsPlayedThisTurn: number; // for Legion condition (724)
  scoredBattlefieldsThisTurn: number[]; // indices scored by this player this turn (630)
  discardedThisTurn: number;
  enemyUnitsDiedThisTurn: number;

  // Mulligan (setup)
  mulliganSelectedIds: string[];
  mulliganDone: boolean;
}

type Target =
    | { kind: "UNIT"; owner: PlayerId; instanceId: string; battlefieldIndex?: number | null; zone?: "BASE" | "BF" }
    | { kind: "BATTLEFIELD"; index: number }
    | { kind: "NONE" };


type EngineAction =
    | { type: "NEXT_STEP"; player: PlayerId }
    | { type: "PASS_PRIORITY"; player: PlayerId }
    | { type: "MULLIGAN_CONFIRM"; player: PlayerId; recycleIds: string[] }
    | { type: "SET_CHAIN_TARGETS"; player: PlayerId; chainItemId: string; targets: Target[] }
    | {
  type: "PLAY_CARD";
  player: PlayerId;
  source: "HAND" | "CHAMPION" | "FACEDOWN";
  cardInstanceId: string;
  fromBattlefieldIndex?: number;
  destination?: { kind: "BASE" } | { kind: "BF"; index: number } | null;
  accelerate?: { pay: boolean; domain: Domain };
  targets?: Target[];
  autoPay?: boolean;
}
    | { type: "HIDE_CARD"; player: PlayerId; cardInstanceId: string; battlefieldIndex: number; autoPay?: boolean }
    | {
  type: "STANDARD_MOVE";
  player: PlayerId;
  from: { kind: "BASE" } | { kind: "BF"; index: number };
  to: { kind: "BASE" } | { kind: "BF"; index: number };
  unitIds: string[];
}
    | { type: "RUNE_EXHAUST"; player: PlayerId; runeInstanceId: string }
    | { type: "RUNE_RECYCLE"; player: PlayerId; runeInstanceId: string }
    | { type: "SEAL_EXHAUST"; player: PlayerId; gearInstanceId: string }
    | { type: "LEGEND_ACTIVATE"; player: PlayerId; targets?: Target[]; autoPay?: boolean };

interface ChainItem {
  id: string;
  controller: PlayerId;
  kind: "PLAY_CARD" | "TRIGGERED_ABILITY" | "ACTIVATED_ABILITY";
  label: string;

  sourceCard?: CardInstance; // for play-card
  sourceZone?: "HAND" | "FACEDOWN" | "CHAMPION";
  playDestination?: { kind: "BASE" } | { kind: "BF"; index: number } | null;

  // ability resolution
  effectText?: string;
  contextBattlefieldIndex?: number | null;

  targets: Target[];
  // Target-selection gate for triggered/activated items (or weird spells)
  needsTargets?: boolean;
  targetRequirement?: TargetRequirement;
  restrictTargetsToBattlefieldIndex?: number | null;
  sourceInstanceId?: string;

  // Special flags captured at play time (so later resolution is correct)
  legionActive?: boolean;
  additionalCostPaid?: boolean;

  // costs already paid before putting onto chain
  // (except some manual helpers)
}

interface GameState {
  step: Step;
  turnNumber: number;
  turnPlayer: PlayerId;
  startingPlayer: PlayerId;

  // windows
  windowKind: WindowKind;
  windowBattlefieldIndex: number | null;
  focusPlayer: PlayerId | null; // focus holder during showdowns (551-553)
  combat: null | {
    battlefieldIndex: number;
    attacker: PlayerId;
    defender: PlayerId;
    step: CombatStep;
  };

  // chain + priority
  chain: ChainItem[];
  priorityPlayer: PlayerId;
  passesInRow: number; // consecutive passes in the current closed/open window
  state: "OPEN" | "CLOSED";

  // victory score for duel
  victoryScore: number;

  // misc
  log: string[];
  actionHistory: EngineAction[];
  // players + battlefields
  players: Record<PlayerId, PlayerState>;
  battlefields: BattlefieldState[];
  damageKillEffects: { controller: PlayerId; untilTurn: number }[];
  lastCombatExcessDamage: Record<PlayerId, number>;
  lastCombatExcessDamageTurn: number;
}

// ----------------------------- Helpers -----------------------------

let __id = 1;
const makeId = (prefix: string) => `${prefix}_${__id++}`;

const isPlayerId = (v: any): v is PlayerId => v === "P1" || v === "P2";

const deepClone = <T,>(obj: T): T => {
  // structuredClone is supported in modern browsers; fallback for older environments.
  // NOTE: Certain browser objects (e.g., PointerEvent) cannot be cloned and can accidentally
  // leak into state via unsafely-bound React handlers. If that happens, fall back to a JSON
  // clone that strips unserializable values so the app keeps running.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sc: any = (globalThis as any).structuredClone;
  if (typeof sc === "function") {
    try {
      return sc(obj);
    } catch {
      // fall through to JSON clone
    }
  }
  try {
    return JSON.parse(JSON.stringify(obj)) as T;
  } catch {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(obj, (_k, v) => {
      if (typeof v === "function") return undefined;
      // Strip DOM / browser objects that are not safely serializable.
      if (typeof Event !== "undefined" && v instanceof Event) return undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const NodeAny: any = (globalThis as any).Node;
      if (typeof NodeAny !== "undefined" && v instanceof NodeAny) return undefined;

      if (v && typeof v === "object") {
        if (seen.has(v as object)) return undefined;
        seen.add(v as object);
      }
      return v;
    });
    return JSON.parse(json) as T;
  }
};

type ViewerId = PlayerId | "SPECTATOR";

interface PrivacySettings {
  revealHands: boolean; // reveal all hands to this viewer (debug / hotseat)
  revealFacedown: boolean; // reveal all facedown cards to this viewer (debug / hotseat)
  revealDecks: boolean; // reveal decks (and their randomized order!) to this viewer (debug)
}

const makeHiddenCardStub = (owner: PlayerId, ctx: string, idx: number): CardInstance => ({
  id: "HIDDEN",
  name: "Hidden Card",
  domain: "Colorless",
  cost: 0,
  type: "Spell",
  stats: { might: null, power: null },
  tags: [],
  ability: undefined,
  rarity: "Unknown",
  image: undefined,
  image_url: undefined,

  instanceId: `HIDDEN_${owner}_${ctx}_${idx}`,
  owner,
  controller: owner,

  isReady: false,
  damage: 0,
  buffs: 0,
  tempMightBonus: 0,
  stunned: false,
  stunnedUntilTurn: 0,
  moveCountThisTurn: 0,
  conditionalKeywords: [],

  createdTurn: 0,
});

const makeHiddenRuneStub = (owner: PlayerId, ctx: string, idx: number): RuneInstance => ({
  instanceId: `HIDDEN_RUNE_${owner}_${ctx}_${idx}`,
  owner,
  controller: owner,
  domain: "Colorless",
  isReady: false,
  createdTurn: 0,
});

/**
 * Viewer-safe projection of the full game state.
 * This is designed to be "server-side redaction": the authoritative state stays intact,
 * while each client receives only information they're allowed to know.
 */
const projectGameStateForViewer = (game: GameState, viewerId: ViewerId, privacy: PrivacySettings): GameState => {
  const g = deepClone(game);

  const canSeeHand = (pid: PlayerId) => (viewerId === pid ? true : privacy.revealHands);
  const canSeeFacedown = (pid: PlayerId) => (viewerId === pid ? true : privacy.revealFacedown);

  // Deck order is secret information; for network-safety we hide decks for everyone unless explicitly revealed.
  const canSeeDecks = () => privacy.revealDecks;

  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const p = g.players[pid];

    if (!canSeeHand(pid)) {
      p.hand = p.hand.map((_c, i) => makeHiddenCardStub(pid, "HAND", i));
    }

    if (!canSeeDecks()) {
      p.mainDeck = p.mainDeck.map((_c, i) => makeHiddenCardStub(pid, "MAIN_DECK", i));
      p.runeDeck = p.runeDeck.map((_r, i) => makeHiddenRuneStub(pid, "RUNE_DECK", i));
    }
  }

  for (let i = 0; i < g.battlefields.length; i++) {
    const bf = g.battlefields[i];
    if (bf.facedown && !canSeeFacedown(bf.facedown.owner)) {
      bf.facedown = {
        ...bf.facedown,
        card: makeHiddenCardStub(bf.facedown.owner, `FACEDOWN_BF${i}`, 0),
      };
    }
  }

  return g;
};

const otherPlayer = (p: PlayerId): PlayerId => (p === "P1" ? "P2" : "P1");

const parseDomains = (domainStr: string): Domain[] =>
    domainStr
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => d as Domain);

const clampDomain = (d: string): Domain => {
  const x = d.trim();
  if (["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"].includes(x)) return x as Domain;
  return "Colorless";
};

const DEFAULT_DOMAINS: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order"];

// Champion/subtype to domain mapping for cards without legacy data
// Derived from riftbound_card_data.json Legend cards and champion associations
const CHAMPION_DOMAIN_MAP: Record<string, string> = {
  // Legends (primary champions)
  "ahri": "Calm, Mind",
  "annie": "Fury, Chaos",
  "azir": "Mind, Order",
  "darius": "Fury, Order",
  "draven": "Fury, Chaos",
  "ezreal": "Mind, Chaos",
  "fiora": "Body, Order",
  "garen": "Body, Order",
  "irelia": "Calm, Body",
  "jax": "Body, Fury",
  "jinx": "Fury, Chaos",
  "kaisa": "Fury, Mind",
  "leesin": "Calm, Body",
  "leona": "Calm, Order",
  "lucian": "Order, Fury",
  "lux": "Mind, Order",
  "masteryi": "Calm, Body",
  "missfortune": "Body, Chaos",
  "ornn": "Body, Fury",
  "reksai": "Fury, Chaos",
  "renataglasc": "Mind, Chaos",
  "rumble": "Fury, Mind",
  "sett": "Body, Order",
  "sivir": "Fury, Body",
  "teemo": "Mind, Chaos",
  "viktor": "Mind, Order",
  "volibear": "Fury, Body",
  "yasuo": "Calm, Chaos",
  // Regions/factions
  "bandlecity": "Mind, Chaos",
  "bilgewater": "Fury, Chaos",
  "demacia": "Order, Body",
  "freljord": "Fury, Body",
  "ionia": "Calm, Mind",
  "ixtal": "Body, Calm",
  "mounttargon": "Calm, Order",
  "noxus": "Fury, Order",
  "piltover": "Mind, Order",
  "shadowisles": "Chaos, Mind",
  "shurima": "Mind, Order",
  "thevoid": "Fury, Chaos",
  "zaun": "Mind, Chaos",
  // Unit types/tribes
  "bird": "Calm",
  "cat": "Body",
  "dog": "Body",
  "dragon": "Fury",
  "elite": "Order",
  "fae": "Calm",
  "mech": "Mind, Fury",
  "pirate": "Fury, Chaos",
  "poro": "Calm",
  "recruit": "Colorless",
  "spirit": "Calm",
  "trifarian": "Fury",
  "yordle": "Mind",
  // Additional champions from expert data
  "akshan": "Body, Order",
  "aphelios": "Calm, Mind",
  "bard": "Calm, Mind",
  "blitzcrank": "Mind",
  "caitlyn": "Mind, Order",
  "dr.mundo": "Body, Chaos",
  "ekko": "Mind, Chaos",
  "heimerdinger": "Mind",
  "janna": "Calm",
  "jayce": "Mind, Order",
  "karthus": "Chaos, Mind",
  "kayn": "Chaos, Body",
  "kogmaw": "Fury, Chaos",
  "malzahar": "Mind, Chaos",
  "nocturne": "Chaos",
  "qiyana": "Body, Calm",
  "rell": "Order, Body",
  "shen": "Order, Calm",
  "sona": "Calm, Mind",
  "soraka": "Calm, Order",
  "taric": "Calm, Order",
  "tryndamere": "Fury, Body",
  "twistedfate": "Chaos, Mind",
  "udyr": "Body, Fury",
  "vayne": "Order, Fury",
  "vi": "Fury, Body",
  "warwick": "Body, Chaos",
  "yone": "Calm, Chaos",
  // Equipment subtype (gear cards)
  "equipment": "Colorless",
};

// Infer domain from type_line subtype (e.g., "legend - annie" -> "Fury, Chaos")
const inferDomainFromTypeLine = (typeLine: string): string | null => {
  if (!typeLine || !typeLine.includes("-")) return null;
  const [, subtypesRaw] = typeLine.split("-", 2);
  if (!subtypesRaw) return null;
  
  // Split by comma/slash for multiple subtypes and find first match
  const subtypes = subtypesRaw.split(/[,/]/).map(s => 
    s.trim().toLowerCase().replace(/\s+/g, "").replace(/'/g, "")
  ).filter(s => s && s !== "nan");
  
  for (const subtype of subtypes) {
    const domain = CHAMPION_DOMAIN_MAP[subtype];
    if (domain) return domain;
  }
  return null;
};

const sanitizeJsonText = (text: string): string => text.replace(/\bNaN\b/g, "null");

const normalizeNameKey = (name: string): string =>
    name
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[^\w\s-]/g, "")
        .trim();

const normalizeIdKey = (id: string): string =>
    id
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .trim();

const parseExpertPower = (value: number | string | undefined): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^c+$/i.test(trimmed)) return trimmed.length;
  return null;
};

const toTitleCase = (word: string): string =>
    word
        .split(/\s+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")
        .trim();

const extractSubtypeTags = (typeLine: string | undefined): string[] => {
  if (!typeLine || !typeLine.includes("-")) return [];
  const [, subtypesRaw] = typeLine.split("-", 2);
  if (!subtypesRaw) return [];
  return subtypesRaw
      .split(/[,/]/)
      .map((s) => toTitleCase(s.trim()))
      .filter((s) => s && s.toLowerCase() !== "nan");
};

const inferDomainFromName = (name: string): Domain | null => {
  const lower = name.toLowerCase();
  const match = DEFAULT_DOMAINS.find((dom) => lower.includes(dom.toLowerCase()));
  return match || null;
};

const stripLeadingBracketKeywords = (raw: string): string =>
    raw.replace(/^(\s*\[[^\]]+\]\s*)+/g, "").trim();

const deriveTriggerAndEffect = (
    rawText: string,
    chain: ExpertCardData["game_logic"] | undefined
): { trigger?: string; effectText?: string } => {
  const raw = rawText.trim();
  if (!raw) return {};

  const triggerCandidates = (chain?.chain || [])
      .map((item) => (item.type === "TRIGGERED_ABILITY" ? item.condition?.trim() : ""))
      .filter(Boolean) as string[];

  const triggerPattern = /^(when|whenever|at the start|at the beginning|at the end|after)\b/i;

  let trigger = triggerCandidates.find((t) => triggerPattern.test(t));

  if (!trigger) {
    const cleaned = stripLeadingBracketKeywords(raw);
    const match = cleaned.match(/^(when|whenever|at the start|at the beginning|at the end|after)\b[^.,]*[.,]/i);
    if (match) {
      trigger = match[0].replace(/[.,]$/, "").trim();
    }
  }

  if (!trigger) return { effectText: raw };

  const cleaned = stripLeadingBracketKeywords(raw);
  if (cleaned.toLowerCase().startsWith(trigger.toLowerCase())) {
    let remainder = cleaned.slice(trigger.length).trim();
    if (/^[,–—-]/.test(remainder)) remainder = remainder.slice(1).trim();
    return { trigger, effectText: remainder || raw };
  }

  return { trigger, effectText: raw };
};

const normalizeExpertCards = (cards: ExpertCardData[], legacyCards: CardData[] = []): CardData[] => {
  const legacyById = new Map<string, CardData>();
  const legacyByName = new Map<string, CardData>();
  legacyCards.forEach((card) => {
    legacyById.set(normalizeIdKey(card.id), card);
    legacyByName.set(normalizeNameKey(card.name), card);
  });

  return cards.map((card) => {
    const idBase = card.id?.split("/")[0] ?? card.id;
    const legacy =
        legacyById.get(normalizeIdKey(idBase)) ||
        legacyById.get(normalizeIdKey(card.id)) ||
        legacyByName.get(normalizeNameKey(card.name));

    const typeLine = card.type_line || "";
    const primaryType = typeLine.split("-")[0]?.trim().toLowerCase();
    const typeMap: Record<string, CardType> = {
      unit: "Unit",
      spell: "Spell",
      gear: "Gear",
      rune: "Rune",
      battlefield: "Battlefield",
      legend: "Legend",
    };

    const rawText = (card.rules_text?.raw?.toString() ?? "").replace(/\\/g, "").trim();
    const keywords = [
      ...(card.rules_text?.keywords || []),
      ...extractBracketKeywords(rawText),
    ].filter(Boolean);

    const { trigger, effectText } = deriveTriggerAndEffect(rawText, card.game_logic);
    const subtypeTags = extractSubtypeTags(typeLine);
    const mergedTags = Array.from(new Set([...(legacy?.tags || []), ...subtypeTags]));

    // Domain inference priority:
    // 1. Domain directly from expert data (CSV source)
    // 2. Legacy card data (if matched by ID or name)
    // 3. Type line subtype mapping (e.g., "legend - annie" -> "Fury, Chaos")
    // 4. Rune card name inference (e.g., "Fury Rune" -> "Fury")
    // 5. Fallback to "Colorless"
    const inferredDomain =
        card.domain ||
        legacy?.domain ||
        inferDomainFromTypeLine(typeLine) ||
        (typeMap[primaryType] === "Rune" ? inferDomainFromName(card.name) : null) ||
        "Colorless";

    return {
      id: card.id,
      name: card.name,
      rarity: card.rarity || legacy?.rarity,
      domain: inferredDomain,
      cost: Number.isFinite(card.stats?.energy) ? Number(card.stats?.energy) : legacy?.cost ?? 0,
      type: typeMap[primaryType] || legacy?.type || "Unit",
      tags: mergedTags,
      image_url: card.image_url || legacy?.image_url,
      image: legacy?.image,
      stats: {
        might: Number.isFinite(card.stats?.might) ? Number(card.stats?.might) : legacy?.stats.might ?? null,
        power: parseExpertPower(card.stats?.power) ?? legacy?.stats.power ?? null,
      },
      ability: rawText || keywords.length
          ? {
            trigger: trigger || legacy?.ability?.trigger,
            effect_text: effectText?.trim() || rawText.trim(),
            raw_text: rawText.trim(),
            keywords: Array.from(new Set(keywords)),
          }
          : legacy?.ability,
    };
  });
};

const emptyRunePool = (): RunePool => ({
  energy: 0,
  power: { Body: 0, Calm: 0, Chaos: 0, Fury: 0, Mind: 0, Order: 0, Colorless: 0 },
});

const classDomainsForPlayer = (game: GameState, player: PlayerId): Domain[] => {
  const doms = (game.players[player]?.domains || []).map(clampDomain).filter((d) => d !== "Colorless");
  return doms.length > 0 ? doms : DEFAULT_DOMAINS;
};

const shuffle = <T,>(arr: T[], seed = 0): T[] => {
  // deterministic-ish: seed is not cryptographic; just to reduce rerenders from random changes if needed
  const a = [...arr];
  // Mix in fresh entropy so repeated games don't produce identical opening hands.
  let s = (seed || Date.now()) + Math.floor(Math.random() * 1000000000);
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    const j = Math.floor(r * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const getKeywords = (card: any | null | undefined): string[] => {
  const base: string[] = (card?.ability?.keywords || []).filter((x: any) => typeof x === "string");
  const extra: string[] = ((card as any)?.extraKeywords || []).filter((x: any) => typeof x === "string");
  const temp: string[] = ((card as any)?.tempKeywords || []).filter((x: any) => typeof x === "string");
  const conditional: string[] = ((card as any)?.conditionalKeywords || []).filter((x: any) => typeof x === "string");
  return [...base, ...extra, ...temp, ...conditional];
};

const hasKeyword = (card: any | null | undefined, kw: string): boolean => {
  const ks = getKeywords(card);
  const needle = kw.toLowerCase();
  return ks.some((k) => (k || "").toLowerCase().startsWith(needle));
};

const isHiddenCard = (card: CardInstance | null | undefined): boolean => {
  return !!card && hasKeyword(card, "Hidden");
};

const keywordValue = (card: any | null | undefined, kw: string): number => {
  const ks = getKeywords(card);
  const needle = kw.toLowerCase();
  let total = 0;
  for (const k of ks) {
    if (!k) continue;
    if (k.toLowerCase().startsWith(needle)) {
      const parts = k.split(" ").filter(Boolean);
      const n = parseInt(parts[parts.length - 1], 10);
      total += Number.isFinite(n) ? n : 1;
    }
  }
  return total;
};

// In combat, "Assault X" applies only to attackers; "Shield X" applies only to defenders.
const effectiveMight = (
    unit: CardInstance,
    ctx?: { role?: "ATTACKER" | "DEFENDER" | "NONE"; alone?: boolean; game?: GameState; battlefieldIndex?: number | null }
): number => {
  const base = unit.stats.might ?? 0;
  const perm = unit.buffs || 0;
  const temp = unit.tempMightBonus || 0;
  let mod = 0;
  if (ctx?.role === "ATTACKER") mod += keywordValue(unit, "Assault");
  if (ctx?.role === "DEFENDER") mod += keywordValue(unit, "Shield");
  const raw = `${unit.ability?.effect_text || ""} ${unit.ability?.raw_text || ""}`;
  const baseBonusMatch = raw.match(/(?:^|[.!?]\s*)i have (?:an additional )?\+(\d+) might\b/i);
  if (baseBonusMatch) {
    const n = parseInt(baseBonusMatch[1], 10);
    if (Number.isFinite(n)) mod += n;
  }
  if (unit.buffs > 0) {
    const buffedBonus = raw.match(/while i'm buffed,?\s*i have (?:an additional )?\+(\d+) might\b/i);
    if (buffedBonus) {
      const n = parseInt(buffedBonus[1], 10);
      if (Number.isFinite(n)) mod += n;
    }
  }
  if (ctx?.alone) {
    const aloneBonus = raw.match(/while i'm attacking or defending alone,?\s*i have \+(\d+) might\b/i);
    if (aloneBonus) {
      const n = parseInt(aloneBonus[1], 10);
      if (Number.isFinite(n)) mod += n;
    }
  }
  if (ctx?.game) {
    const p = ctx.game.players[unit.controller];
    const runeCount = p.runesInPlay.length;
    if (/while you have 8\+ runes/i.test(raw) && runeCount >= 8) {
      const m = raw.match(/while you have 8\+ runes,?\s*i have \+(\d+) might/i);
      const n = m ? parseInt(m[1], 10) : 0;
      if (Number.isFinite(n)) mod += n;
    }
    if (ctx.battlefieldIndex != null && unit.stunned) {
      const bf = ctx.game.battlefields[ctx.battlefieldIndex];
      const enemy = otherPlayer(unit.controller);
      const aura = bf.units[enemy].find((u) =>
          /stunned enemy units here have -\d+ might/i.test(`${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`)
      );
      if (aura) {
        const rawAura = `${aura.ability?.effect_text || ""} ${aura.ability?.raw_text || ""}`;
        if (/within 3 points of the victory score/i.test(rawAura)) {
          const opp = otherPlayer(aura.controller);
          if (ctx.game.players[opp].points < ctx.game.victoryScore - 3) {
            return Math.max(0, base + perm + temp + mod);
          }
        }
        const m = rawAura.match(/stunned enemy units here have -(\d+) might/i);
        const n = m ? parseInt(m[1], 10) : 0;
        if (Number.isFinite(n) && n > 0) mod -= n;
        const minMatch = rawAura.match(/minimum of (\d+) might/i);
        if (minMatch) {
          const minVal = parseInt(minMatch[1], 10);
          const total = base + perm + temp + mod;
          return Math.max(minVal, total);
        }
      }
    }
  }
  return Math.max(0, base + perm + temp + mod);
};

const summarizeCard = (c: CardData | CardInstance): string => {
  const p = c.stats?.power ?? 0;
  const m = c.stats?.might ?? 0;
  const cost = `${c.cost ?? 0}${p ? ` + ${p}P` : ""}`;
  return `${c.name} (${c.type}, ${c.domain}, ${cost}${c.type === "Unit" ? `, Might ${m}` : ""})`;
};

const isMainDeckType = (t: CardType) => t === "Unit" || t === "Spell" || t === "Gear";

const isDuelBattlefieldCount = 2;
const duelVictoryScore = 8; // Duel victory score (mode of play).
const isMighty = (unit: CardInstance, game?: GameState) => effectiveMight(unit, { role: "NONE", game }) >= 5;

const getUnitsInPlay = (game: GameState, player: PlayerId): CardInstance[] => [
  ...game.players[player].base.units,
  ...game.battlefields.flatMap((b) => b.units[player]),
];

const extractBracketKeywords = (text: string): string[] => {
  const out: string[] = [];
  const regex = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text))) {
    const kw = (m[1] || "").trim();
    if (kw) out.push(kw);
  }
  return out;
};

const refreshConditionalKeywords = (game: GameState) => {
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const discardedThisTurn = game.players[pid].discardedThisTurn > 0;
    const units = getUnitsInPlay(game, pid);
    for (const u of units) {
      const rawText = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`;
      const conditional: string[] = [];

      if (u.buffs > 0 && /while i'm buffed/i.test(rawText)) {
        const clause = rawText.split(/while i'm buffed/i)[1] || "";
        conditional.push(...extractBracketKeywords(clause));
      }

      if (isMighty(u, game) && /while i'm\s*\[mighty\]/i.test(rawText)) {
        const clause = rawText.split(/while i'm\s*\[mighty\]/i)[1] || "";
        conditional.push(...extractBracketKeywords(clause));
      }

      if (discardedThisTurn && /if you've discarded a card this turn/i.test(rawText)) {
        const clause = rawText.split(/if you've discarded a card this turn/i)[1] || "";
        conditional.push(...extractBracketKeywords(clause));
      }

      u.conditionalKeywords = conditional;
    }
  }
};

// ----------------------------- Core rules helpers -----------------------------

const canPlaySpellOutsideShowdown = (card: CardInstance, game: GameState, player: PlayerId): boolean => {
  // Spells without Action/Reaction can only be played on their controller's turn outside showdowns,
  // when state is OPEN and chain empty. (Simplified enforcement)
  if (card.type !== "Spell") return false;
  if (hasKeyword(card, "Reaction")) return true;
  if (hasKeyword(card, "Action")) return true;
  return game.turnPlayer === player && game.windowKind === "NONE" && game.state === "OPEN" && game.chain.length === 0;
};

const canPlayNonspellOutsideShowdown = (
    card: CardInstance,
    game: GameState,
    player: PlayerId,
    source: "HAND" | "CHAMPION" | "FACEDOWN" = "HAND"
): boolean => {
  if (card.type === "Spell") return canPlaySpellOutsideShowdown(card, game, player);
  if (!["Unit", "Gear"].includes(card.type)) return false;

  // Hidden cards gain Reaction beginning on the next player's turn; allow FACEDOWN plays during showdown timing.
  const inShowdown = game.windowKind === "SHOWDOWN" || (game.windowKind === "COMBAT" && game.combat?.step === "SHOWDOWN");
  if (source === "FACEDOWN" && inShowdown) return true;

  // Units/Gear are played on your turn in OPEN state outside showdowns (simplified),
  // unless card has Action/Reaction keywords giving showdown timing.
  if (hasKeyword(card, "Reaction")) return true;
  if (hasKeyword(card, "Action")) return game.turnPlayer === player || game.windowKind !== "NONE";
  return game.turnPlayer === player && game.windowKind === "NONE" && game.state === "OPEN" && game.chain.length === 0;
};

const canStandardMoveNow = (game: GameState): boolean => {
  // Standard Move is a Limited Action in Action phase, does not use chain and cannot be reacted to.
  return game.step === "ACTION" && game.windowKind === "NONE" && game.state === "OPEN" && game.chain.length === 0;
};

const canHideNow = (game: GameState): boolean => {
  // Hide is a Discretionary Action in Action phase. We'll keep it Action-phase only.
  return game.step === "ACTION" && game.windowKind === "NONE" && game.state === "OPEN" && game.chain.length === 0;
};

const runePoolTotalPower = (pool: RunePool, allowed?: Domain[]): number => {
  const domains = allowed && allowed.length > 0 ? allowed : (Object.keys(pool.power) as Domain[]);
  return domains.reduce((s, d) => s + (pool.power[d] || 0), 0);
};

const choosePowerPaymentDomains = (pool: RunePool, need: number, allowed: Domain[]): { payment: Record<Domain, number> } | null => {
  // Greedy payment: spend from the domain with most available first.
  const payment: Record<Domain, number> = { Body: 0, Calm: 0, Chaos: 0, Fury: 0, Mind: 0, Order: 0, Colorless: 0 };
  let remaining = need;
  const sorted = [...allowed].sort((a, b) => (pool.power[b] || 0) - (pool.power[a] || 0));
  for (const d of sorted) {
    if (remaining <= 0) break;
    const avail = pool.power[d] || 0;
    if (avail <= 0) continue;
    const spend = Math.min(avail, remaining);
    payment[d] += spend;
    remaining -= spend;
  }
  if (remaining > 0) return null;
  return { payment };
};

// ----------------------------- Effect parsing (lightweight) -----------------------------

type TargetRequirement =
    | { kind: "NONE" }
    | { kind: "UNIT_ANYWHERE"; count: number }
    | { kind: "UNIT_HERE_ENEMY"; count: number }
    | { kind: "UNIT_HERE_FRIENDLY"; count: number }
    | { kind: "UNIT_FRIENDLY"; count: number }  // Friendly unit anywhere (e.g., "a friendly unit")
    | { kind: "UNIT_ENEMY"; count: number }     // Enemy unit anywhere (e.g., "an enemy unit")
    | { kind: "BATTLEFIELD"; count: number };

const inferTargetRequirement = (effectTextRaw: string | undefined, ctx?: { here?: boolean }): TargetRequirement => {
  const text = (effectTextRaw || "").toLowerCase();
  if (!text.trim()) return { kind: "NONE" };

  // Heuristic patterns – deliberately conservative.
  const needsUnit =
      /\b(stun|kill|banish|ready|buff|deal|give|move|return|recall|heal|double)\b/.test(text) && /\bunit\b/.test(text);
  const needsBattlefield = /\bbattlefield\b/.test(text) && /\bchoose\b/.test(text);
  const needsBattlefieldForAoE =
      /\bat\s+a\s+battlefield\b/.test(text) && /\b(all|each)\s+enemy\s+units?\b/.test(text);

  if (needsBattlefield || needsBattlefieldForAoE) return { kind: "BATTLEFIELD", count: 1 };

  if (!needsUnit) return { kind: "NONE" };

  // Check for "here" targeting first
  const wantsEnemyHere = /\benemy unit here\b/.test(text) || (/\bunit here\b/.test(text) && /\benemy\b/.test(text));
  const wantsFriendlyHere = /\byour unit here\b/.test(text) || (/\bunit here\b/.test(text) && /\byour\b/.test(text)) ||
      /\bfriendly unit here\b/.test(text);

  if (wantsEnemyHere) return { kind: "UNIT_HERE_ENEMY", count: 1 };
  if (wantsFriendlyHere) return { kind: "UNIT_HERE_FRIENDLY", count: 1 };

  // Check for friendly/enemy unit targeting (anywhere)
  // Patterns: "a friendly unit", "friendly unit's", "your unit"
  const wantsFriendly = /\ba\s+friendly\s+unit\b/.test(text) || /\bfriendly\s+unit's\b/.test(text) ||
      /\byour\s+unit\b/.test(text) || /\bone\s+of\s+your\s+units\b/.test(text);
  // Patterns: "an enemy unit", "enemy unit's"
  const wantsEnemy = /\ban?\s+enemy\s+unit\b/.test(text) || /\benemy\s+unit's\b/.test(text);

  if (wantsFriendly && !wantsEnemy) return { kind: "UNIT_FRIENDLY", count: 1 };
  if (wantsEnemy && !wantsFriendly) return { kind: "UNIT_ENEMY", count: 1 };

  const moveCount = text.match(/\bmove\s+(?:up\s+to\s+)?(\d+|one|two|three|four|five)\s+(?:friendly|your)?\s*units?\b/);
  if (moveCount) {
    const wordToNum: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const raw = moveCount[1];
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : wordToNum[raw] ?? 1;
    return { kind: "UNIT_FRIENDLY", count: Number.isFinite(n) ? n : 1 };
  }

  return { kind: "UNIT_ANYWHERE", count: 1 };
};

const checkGlobalTriggers = (
  game: GameState,
  eventType: "PLAY_CARD" | "KILL_UNIT" | "DISCARD_CARD",
  ctx: { player: PlayerId; card: CardInstance }
) => {
  // Scan all units/gear on board for triggers responding to this event.
  const triggerSources: CardInstance[] = [];

  (["P1", "P2"] as PlayerId[]).forEach((pid) => {
    const p = game.players[pid];
    triggerSources.push(...p.base.units, ...p.base.gear);
    game.battlefields.forEach((bf) => {
      triggerSources.push(...bf.units[pid], ...bf.gear[pid]);
    });
  });

  const isSelf = (u: CardInstance) => u.instanceId === ctx.card.instanceId;

  for (const source of triggerSources) {
    if (isSelf(source)) continue; // "When you play me" handled elsewhere.

    const trig = (source.ability?.trigger || "").toLowerCase();
    const eff = source.ability?.effect_text;
    if (!trig || !eff) continue;

    let matches = false;

    if (eventType === "PLAY_CARD" && source.controller === ctx.player) {
      if (trig.includes("when you play a spell") && ctx.card.type === "Spell") matches = true;
      if (trig.includes("when you play a spell that costs 5 energy or more") && ctx.card.type === "Spell" && (ctx.card.cost || 0) >= 5)
        matches = true;
      if (trig.includes("when you play a gear") && ctx.card.type === "Gear") matches = true;
      if (trig.includes("when you play another unit") && ctx.card.type === "Unit") matches = true;
      if (trig.includes("when you play a unit") && ctx.card.type === "Unit") matches = true;
      if (trig.includes("when you play a [mighty] unit") && ctx.card.type === "Unit" && isMighty(ctx.card, game)) matches = true;
      if (trig.includes("play your second card") && game.players[ctx.player].mainDeckCardsPlayedThisTurn === 2) matches = true;
      if (trig.includes("when you play a card on an opponent's turn") && game.turnPlayer !== ctx.player) matches = true;
    }

    if (eventType === "DISCARD_CARD" && source.controller === ctx.player) {
      if (trig.includes("when you discard one or more cards")) matches = true;
      if (trig.includes("when you discard a card")) matches = true;
    }

    if (eventType === "KILL_UNIT" && source.controller === ctx.player) {
      if (trig.includes("when you kill")) {
        const victim = ctx.card;
        const isStunned = victim.stunned;
        if (trig.includes("stunned") && !isStunned) matches = false;
        else matches = true;
      }
    }

    if (matches) {
      const req = inferTargetRequirement(eff);
      game.chain.push({
        id: makeId("chain"),
        controller: source.controller,
        kind: "TRIGGERED_ABILITY",
        label: `Trigger: ${source.name}`,
        effectText: eff,
        targets: [{ kind: "NONE" }],
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
      });
      game.state = "CLOSED";
      game.priorityPlayer = source.controller;
      game.passesInRow = 0;
      game.log.unshift(`${source.name} triggered.`);
    }
  }
};

const queueTriggersForEvent = (
    game: GameState,
    controller: PlayerId,
    match: (trigger: string, source: CardInstance) => boolean,
    effectText: (source: CardInstance) => string | undefined,
    targets?: Target[],
    ctxBf?: number | null,
    includeTrash: boolean = false
) => {
  const sources: CardInstance[] = [];
  const p = game.players[controller];
  sources.push(...p.base.units, ...p.base.gear);
  game.battlefields.forEach((bf) => sources.push(...bf.units[controller], ...bf.gear[controller]));
  if (p.legend) {
    sources.push({ ...(p.legend as CardInstance), instanceId: `legend_${controller}`, owner: controller, controller } as CardInstance);
  }
  if (includeTrash) {
    sources.push(...p.trash);
  }

  for (const source of sources) {
    const trig = (source.ability?.trigger || "").toLowerCase();
    if (!trig) continue;
    if (!match(trig, source)) continue;
    const eff = effectText(source);
    if (!eff) continue;
    const req = inferTargetRequirement(eff, { here: ctxBf != null });
    game.chain.push({
      id: makeId("chain"),
      controller,
      kind: "TRIGGERED_ABILITY",
      label: `Trigger: ${source.name}`,
      effectText: eff,
      contextBattlefieldIndex: ctxBf ?? null,
      targets: targets && targets.length > 0 ? targets : [{ kind: "NONE" }],
      needsTargets: req.kind !== "NONE",
      targetRequirement: req,
      sourceInstanceId: source.instanceId,
    });
    game.state = "CLOSED";
    game.priorityPlayer = controller;
    game.passesInRow = 0;
    game.log.unshift(`${source.name} triggered.`);
  }
};

const extractDamageAmount = (effectTextRaw: string | undefined): number | null => {
  const text = (effectTextRaw || "").toLowerCase();
  // "Deal 2 ..." or "deal 3 ..."
  const m = text.match(/\bdeal\s+(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
};

const extractDrawAmount = (effectTextRaw: string | undefined): number | null => {
  const text = (effectTextRaw || "").toLowerCase();
  const m = text.match(/\bdraw\s+(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
};

const extractChannelAmount = (effectTextRaw: string | undefined): number | null => {
  const text = (effectTextRaw || "").toLowerCase();
  const m = text.match(/\bchannel\s+(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
};


const extractDiscardAmount = (effectTextRaw: string | undefined): number | null => {
  const text = (effectTextRaw || "").toLowerCase();
  const m = text.match(/\bdiscard\s+(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
};

const extractLegionEnergyDiscount = (card: CardData | CardInstance): number => {
  const txt = `${(card as any)?.ability?.effect_text || ""} ${(card as any)?.ability?.raw_text || ""}`
      .replace(/_/g, " ")
      .toLowerCase();

  // Common template: "I cost 2 energy less."
  const m1 = txt.match(/\bcost\s+(\d+)\s+energy\s+less\b/);
  if (m1) {
    const n = parseInt(m1[1], 10);
    return Number.isFinite(n) ? n : 0;
  }

  // Sometimes: "I cost 2 less."
  const m2 = txt.match(/\bcost\s+(\d+)\s+less\b/);
  if (m2) {
    const n = parseInt(m2[1], 10);
    return Number.isFinite(n) ? n : 0;
  }

  // Or: "Reduce my cost by 2 energy."
  const m3 = txt.match(/\breduce\s+my\s+cost\s+by\s+(\d+)\s+energy\b/);
  if (m3) {
    const n = parseInt(m3[1], 10);
    return Number.isFinite(n) ? n : 0;
  }

  return 0;
};

const extractLegionClauseText = (card: CardData | CardInstance): string => {
  // Prefer effect_text because it typically contains the "— ..." clause; fall back to raw_text.
  const raw = ((card as any)?.ability?.effect_text || "").trim() || ((card as any)?.ability?.raw_text || "").trim();
  if (!raw) return "";

  let t = raw.replace(/_/g, " ").trim();
  // Strip the keyword tag
  t = t.replace(/\[\s*legion\s*\]\s*/gi, "").trim();
  // Strip trailing reminder text like "(Get the effect if you've played another card this turn.)"
  t = t.replace(/\(\s*get\s+the\s+effect[\s\S]*?\)\s*$/i, "").trim();
  // Remove a leading dash
  t = t.replace(/^[—-]\s*/, "").trim();
  return t;
};


const effectMentionsStun = (effectTextRaw: string | undefined) => /\bstun\b/i.test(effectTextRaw || "");
const effectMentionsReady = (effectTextRaw: string | undefined) => /\bready\b/i.test(effectTextRaw || "");
const effectMentionsKill = (effectTextRaw: string | undefined) => /\bkill\b/i.test(effectTextRaw || "");
const effectMentionsBanish = (effectTextRaw: string | undefined) => /\bbanish\b/i.test(effectTextRaw || "");
const effectMentionsBuff = (effectTextRaw: string | undefined) => /\bbuff\b/i.test(effectTextRaw || "");
const effectMentionsReturn = (effectTextRaw: string | undefined) => /\breturn\b/i.test(effectTextRaw || "") || /\brecall\b/i.test(effectTextRaw || "");
const effectMentionsAddRune = (effectTextRaw: string | undefined) =>
    /\badd\s+(\d+)?\s*(body|calm|chaos|fury|mind|order|class)\s+rune\b/i.test(effectTextRaw || "");
const unitIgnoresDamageThisTurn = (unit: CardInstance): boolean => {
  const raw = `${unit.ability?.effect_text || ""} ${unit.ability?.raw_text || ""}`.toLowerCase();
  return unit.moveCountThisTurn >= 2 && raw.includes("if i have moved twice this turn") && raw.includes("don't take damage");
};

const damageKillEffectActive = (game: GameState): boolean =>
    game.damageKillEffects.some((e) => e.untilTurn >= game.turnNumber);

// ----------------------------- Engine operations -----------------------------

const locateUnit = (
    game: GameState,
    owner: PlayerId,
    instanceId: string
): { zone: "BASE" | "BF"; battlefieldIndex?: number; unit: CardInstance } | null => {
  const p = game.players[owner];
  const inBase = p.base.units.find((u) => u.instanceId === instanceId);
  if (inBase) return { zone: "BASE", unit: inBase };
  for (const bf of game.battlefields) {
    const u = bf.units[owner].find((x) => x.instanceId === instanceId);
    if (u) return { zone: "BF", battlefieldIndex: bf.index, unit: u };
  }
  return null;
};

const removeUnitFromWherever = (game: GameState, owner: PlayerId, instanceId: string): CardInstance | null => {
  const p = game.players[owner];
  const bi = p.base.units.findIndex((u) => u.instanceId === instanceId);
  if (bi >= 0) return p.base.units.splice(bi, 1)[0];

  for (const bf of game.battlefields) {
    const idx = bf.units[owner].findIndex((u) => u.instanceId === instanceId);
    if (idx >= 0) return bf.units[owner].splice(idx, 1)[0];
  }
  return null;
};

const addUnitToZone = (game: GameState, owner: PlayerId, unit: CardInstance, dest: { kind: "BASE" } | { kind: "BF"; index: number }) => {
  const p = game.players[owner];
  if (dest.kind === "BASE") {
    p.base.units.push(unit);
  } else {
    // Static Ability: "Other friendly units enter ready" (e.g. Magma Wurm).
    let enterReadyMod = false;
    const scanLocations = [p.base.units, ...game.battlefields.map((b) => b.units[owner])];
    for (const list of scanLocations) {
      for (const existing of list) {
        if (existing.instanceId === unit.instanceId) continue;
        const raw = (existing.ability?.raw_text || "").toLowerCase();
        if (raw.includes("other friendly units enter ready")) enterReadyMod = true;
      }
    }
    if (enterReadyMod) {
      unit.isReady = true;
    }

    const bf = game.battlefields[dest.index];
    bf.units[owner].push(unit);
  }
};

const killUnit = (game: GameState, owner: PlayerId, unit: CardInstance, reason = "killed") => {
  // Units go to Trash, not Banishment. (Rules distinguish Trash vs Banishment zones)
  const p = game.players[owner];
  const opp = otherPlayer(owner);
  const wasBuffed = unit.buffs > 0;
  const wasRecruit = (unit.tags || []).some((t) => String(t || "").toLowerCase() === "recruit");

  if (unit.deathReplacement && game.turnNumber <= unit.deathReplacement.untilTurn) {
    const repl = unit.deathReplacement;
    const payDom = repl.payRuneDomain;
    const pool = game.players[unit.controller].runePool;
    const canPayDomain = payDom ? (pool.power[payDom] || 0) >= 1 : false;
    const canPayAny = repl.payRuneAny ? Object.values(pool.power).some((v) => v > 0) : false;
    const canPay = payDom ? canPayDomain : repl.payRuneAny ? canPayAny : true;

    if (canPay) {
      if (payDom) pool.power[payDom] -= 1;
      if (!payDom && repl.payRuneAny) {
        const dom = (Object.keys(pool.power) as Domain[]).find((d) => pool.power[d] > 0);
        if (dom) pool.power[dom] -= 1;
      }
      unit.isReady = false;
      unit.damage = 0;
      unit.deathReplacement = undefined;
      game.players[owner].base.units.push(unit);
      game.log.unshift(`${unit.name} was recalled to base instead of dying.`);
      return;
    }
  }

  // Legend replacement: The Boss (Sett).
  const legend = game.players[owner].legend;
  if (
      legend?.name === "The Boss" &&
      unit.controller === owner &&
      unit.buffs > 0 &&
      game.players[owner].legendReady
  ) {
    const pool = game.players[owner].runePool;
    const canPayAny = Object.values(pool.power).some((v) => v > 0);
    if (canPayAny) {
      const dom = (Object.keys(pool.power) as Domain[]).find((d) => pool.power[d] > 0);
      if (dom) {
        pool.power[dom] -= 1;
        game.players[owner].legendReady = false;
        unit.buffs = Math.max(0, unit.buffs - 1);
        unit.isReady = false;
        unit.damage = 0;
        game.players[owner].base.units.push(unit);
        game.log.unshift(`${unit.name} was recalled to base by The Boss instead of dying.`);
        return;
      }
    }
  }

  // Check for Deathknell ability before moving to trash
  if (hasKeyword(unit, "Deathknell")) {
    const effectText = unit.ability?.effect_text || "";
    if (effectText) {
      // Create a triggered ability chain item for Deathknell
      const deathknellItem: ChainItem = {
        id: makeId("chain"),
        controller: unit.controller,
        kind: "TRIGGERED_ABILITY",
        label: `Deathknell: ${unit.name}`,
        effectText,
        contextBattlefieldIndex: null, // Deathknell triggers from trash, no battlefield context
        targets: [],
        needsTargets: false,
        sourceInstanceId: unit.instanceId,
      };
      game.chain.push(deathknellItem);
      game.log.unshift(`${unit.name}'s Deathknell ability triggered.`);
    }
  }

  p.trash.push({ ...unit, isReady: false }); // dead cards not ready
  game.log.unshift(`${unit.name} (${owner}) was ${reason} and put into Trash.`);
  game.players[opp].enemyUnitsDiedThisTurn += 1;
  checkGlobalTriggers(game, "KILL_UNIT", { player: owner, card: unit });

  if (wasBuffed) {
    queueTriggersForEvent(
        game,
        owner,
        (trig) => trig.includes("when a buffed friendly unit dies"),
        (source) => source.ability?.effect_text
    );
  }

  if (!wasRecruit) {
    queueTriggersForEvent(
        game,
        owner,
        (trig, source) => trig.includes("when another non-recruit unit you control dies") && source.instanceId !== unit.instanceId,
        (source) => source.ability?.effect_text
    );
  }
};

const checkMoveTriggers = (game: GameState, player: PlayerId, units: CardInstance[], toIndex: number | "BASE") => {
  for (const u of units) {
    const trig = (u.ability?.trigger || "").toLowerCase();
    if (trig.includes("when i move")) {
      const eff = u.ability?.effect_text;
      if (eff) {
        const destBf = typeof toIndex === "number" ? toIndex : null;
        const req = inferTargetRequirement(eff, { here: destBf !== null });
        game.chain.push({
          id: makeId("chain"),
          controller: player,
          kind: "TRIGGERED_ABILITY",
          label: `Move Trigger: ${u.name}`,
          effectText: eff,
          contextBattlefieldIndex: destBf,
          targets: [{ kind: "NONE" }],
          needsTargets: req.kind !== "NONE",
          targetRequirement: req,
        });
        game.log.unshift(`${u.name} triggered on move.`);
      }
    }
    if (trig.includes("when i move to a battlefield") && typeof toIndex === "number") {
      const eff = u.ability?.effect_text;
      if (eff) {
        const req = inferTargetRequirement(eff, { here: true });
        game.chain.push({
          id: makeId("chain"),
          controller: player,
          kind: "TRIGGERED_ABILITY",
          label: `Move Trigger: ${u.name}`,
          effectText: eff,
          contextBattlefieldIndex: toIndex,
          targets: [{ kind: "NONE" }],
          needsTargets: req.kind !== "NONE",
          targetRequirement: req,
          sourceInstanceId: u.instanceId,
        });
        game.log.unshift(`${u.name} triggered on move to battlefield.`);
      }
    }
  }
};

const checkMoveFromLocationTriggers = (
    game: GameState,
    controller: PlayerId,
    movedUnits: CardInstance[],
    from: { kind: "BASE" } | { kind: "BF"; index: number },
    to: { kind: "BASE" } | { kind: "BF"; index: number }
) => {
  if (movedUnits.length === 0) return;

  if (from.kind === "BF") {
    const bf = game.battlefields[from.index];
    const trig = (bf.card.ability?.trigger || "").toLowerCase();
    if (trig.includes("when a unit moves from here") && bf.card.ability?.effect_text) {
      for (const u of movedUnits) {
        const effectText = bf.card.ability.effect_text.trim();
        if (!effectText) continue;
        const req = inferTargetRequirement(effectText, { here: true });
        game.chain.push({
          id: makeId("chain"),
          controller,
          kind: "TRIGGERED_ABILITY",
          label: `${bf.card.name} — Trigger`,
          effectText,
          contextBattlefieldIndex: from.index,
          restrictTargetsToBattlefieldIndex: from.index,
          targets: [{ kind: "UNIT", owner: u.owner, instanceId: u.instanceId, battlefieldIndex: from.index, zone: "BF" }],
          needsTargets: true,
          targetRequirement: { kind: "UNIT_ANYWHERE", count: 1 },
          sourceInstanceId: u.instanceId,
        });
      }
    }
  }

  const checkFollowers = (pid: PlayerId) => {
    const sources = getUnitsInPlay(game, pid);
    for (const source of sources) {
      const trig = (source.ability?.trigger || "").toLowerCase();
      if (!trig.includes("when a friendly unit moves from my location")) continue;
      const srcLoc = locateUnit(game, pid, source.instanceId);
      if (!srcLoc) continue;
      const movedFromSame =
          from.kind === "BASE"
              ? srcLoc.zone === "BASE"
              : srcLoc.zone === "BF" && srcLoc.battlefieldIndex === from.index;
      if (!movedFromSame) continue;
      for (const moved of movedUnits) {
        if (moved.owner !== pid) continue;
        const removed = removeUnitFromWherever(game, pid, source.instanceId);
        if (!removed) continue;
        removed.isReady = false;
        removed.moveCountThisTurn += 1;
        addUnitToZone(game, pid, removed, to);
        game.log.unshift(`${source.name} moved with a friendly unit.`);
      }
    }
  };

  checkFollowers(controller);

  if (to.kind === "BF") {
    const opponent = otherPlayer(controller);
    const sources = getUnitsInPlay(game, opponent);
    for (const source of sources) {
      const trig = (source.ability?.trigger || "").toLowerCase();
      if (!trig.includes("when an opponent moves to a battlefield other than mine")) continue;
      const loc = locateUnit(game, opponent, source.instanceId);
      if (!loc || loc.zone !== "BF") continue;
      if (loc.battlefieldIndex === to.index) continue;
      if (source.ability?.effect_text) {
        const req = inferTargetRequirement(source.ability.effect_text);
        game.chain.push({
          id: makeId("chain"),
          controller: opponent,
          kind: "TRIGGERED_ABILITY",
          label: `Move Trigger: ${source.name}`,
          effectText: source.ability.effect_text,
          targets: [{ kind: "NONE" }],
          needsTargets: req.kind !== "NONE",
          targetRequirement: req,
        });
        game.state = "CLOSED";
        game.priorityPlayer = opponent;
        game.passesInRow = 0;
      }
    }
  }
};

const banishCardToBanishment = (game: GameState, owner: PlayerId, card: CardInstance, reason = "banished") => {
  const p = game.players[owner];
  p.banishment.push(card);
  game.log.unshift(`${card.name} (${owner}) was ${reason} and put into Banishment.`);
};

const cleanupStateBased = (game: GameState) => {
  // 1) kill units with lethal damage (>= effective might outside combat role). In rules, damage is checked as SBA.
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const p = game.players[pid];
    // base
    const stillBase: CardInstance[] = [];
    for (const u of p.base.units) {
      const lethal = effectiveMight(u, { role: "NONE", game });
      if (u.damage >= lethal && lethal > 0) {
        killUnit(game, pid, u, "destroyed (lethal damage)");
      } else {
        stillBase.push(u);
      }
    }
    p.base.units = stillBase;

    // battlefields
    for (const bf of game.battlefields) {
      const still: CardInstance[] = [];
      for (const u of bf.units[pid]) {
        const lethal = effectiveMight(u, { role: "NONE", game });
        if (u.damage >= lethal && lethal > 0) {
          killUnit(game, pid, u, "destroyed (lethal damage)");
        } else {
          still.push(u);
        }
      }
      bf.units[pid] = still;
    }
  }

  // 2) Update controller when NOT in combat and NOT contested.
  if (game.windowKind === "NONE") {
    for (const bf of game.battlefields) {
      if (bf.contestedBy) continue; // contested controller stays as-is until combat/showdown resolves
      const p1 = bf.units.P1.length > 0;
      const p2 = bf.units.P2.length > 0;
      if (p1 && !p2) bf.controller = "P1";
      else if (p2 && !p1) bf.controller = "P2";
      else if (!p1 && !p2) bf.controller = null;
      // if both, controller stays (contested should have been set by move; treat as combat pending)
    }
  }

  // 3) Facedown zone legality: a facedown card can only remain while its controller controls the battlefield.
  // If the Hidden card's controller loses control of the battlefield, remove the card during the next Cleanup.
  for (const bf of game.battlefields) {
    if (!bf.facedown) continue;
    const owner = bf.facedown.owner;
    const stillControls = bf.controller === owner;
    bf.facedown.markedForRemoval = !stillControls;

    if (!stillControls) {
      const card = bf.facedown.card;
      bf.facedown = null;
      game.players[owner].trash.push(card);
      game.log.unshift(`Facedown card ${card.name} was removed from Battlefield ${bf.index + 1} (lost control).`);
    }
  }

  // 4) Gear corrective recall: Gear can only be played to a base, and if it is ever at a battlefield it is recalled during Cleanup.
  for (const bf of game.battlefields) {
    for (const pid of ["P1", "P2"] as PlayerId[]) {
      if (bf.gear[pid].length === 0) continue;
      const recalled = bf.gear[pid].splice(0, bf.gear[pid].length);
      game.players[pid].base.gear.push(...recalled);
      game.log.unshift(`${pid} recalled ${recalled.length} gear to base (gear can't remain at a battlefield).`);
    }
  }

  // 5) Ensure no negative rune pool values
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const pool = game.players[pid].runePool;
    pool.energy = Math.max(0, pool.energy);
    for (const d of Object.keys(pool.power) as Domain[]) pool.power[d] = Math.max(0, pool.power[d] || 0);
  }

  refreshConditionalKeywords(game);
};

const queueCombatTriggers = (game: GameState, bfIndex: number, player: PlayerId, mode: "ATTACK" | "DEFEND") => {
  const bf = game.battlefields[bfIndex];
  const units = bf.units[player];

  for (const u of units) {
    const trig = (u.ability?.trigger || "").toLowerCase();
    const matches =
        mode === "ATTACK"
            ? trig.includes("when i attack") || trig.includes("when i attack or defend")
            : trig.includes("when i defend") || trig.includes("when i attack or defend") || trig.includes("when i defend or i'm played from");

    if (matches && u.ability?.effect_text) {
      const eff = u.ability.effect_text;
      const req = inferTargetRequirement(eff, { here: true });

      game.chain.push({
        id: makeId("chain"),
        controller: player,
        kind: "TRIGGERED_ABILITY",
        label: `${u.name} (${mode === "ATTACK" ? "Attack" : "Defend"})`,
        effectText: eff,
        contextBattlefieldIndex: bfIndex,
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
        targets: [{ kind: "NONE" }],
        sourceInstanceId: u.instanceId,
      });
      game.state = "CLOSED";
      game.priorityPlayer = player;
      game.passesInRow = 0;
      game.log.unshift(`Triggered ability: ${u.name} (Combat).`);
    }
  }
};


const pendingShowdowns = (game: GameState): number[] =>
    game.battlefields
        .filter((bf) => bf.contestedBy && bf.controller === null)
        .map((bf) => bf.index);

const pendingCombats = (game: GameState): number[] =>
    game.battlefields
        .filter((bf) => bf.units.P1.length > 0 && bf.units.P2.length > 0 && bf.contestedBy !== null)
        .map((bf) => bf.index);

const maybeOpenNextWindow = (game: GameState) => {
  if (game.windowKind !== "NONE") return;
  if (game.state !== "OPEN") return;
  if (game.chain.length !== 0) return;

  const showdowns = pendingShowdowns(game);
  if (showdowns.length > 0) {
    const idx = showdowns[0];
    game.windowKind = "SHOWDOWN";
    game.windowBattlefieldIndex = idx;
    // Showdowns opened by Standard Move: non-turn player gets Focus and priority first (per rules).
    const nonTurnPlayer = otherPlayer(game.turnPlayer);
    game.focusPlayer = nonTurnPlayer;
    game.priorityPlayer = nonTurnPlayer;
    game.passesInRow = 0;
    game.log.unshift(`Showdown opened at Battlefield ${idx + 1}. ${nonTurnPlayer} has Focus.`);
    return;
  }

  const combats = pendingCombats(game);
  if (combats.length > 0) {
    const idx = combats[0];
    const bf = game.battlefields[idx];
    const attacker = bf.contestedBy!;
    const defender = otherPlayer(attacker);
    game.windowKind = "COMBAT";
    game.windowBattlefieldIndex = idx;
    game.combat = { battlefieldIndex: idx, attacker, defender, step: "SHOWDOWN" };
    // Combat showdown: attacker gets Focus/priority first.
    game.focusPlayer = attacker;
    game.priorityPlayer = attacker;
    game.passesInRow = 0;
    game.log.unshift(`Combat begins at Battlefield ${idx + 1} (Attacker: ${attacker}, Defender: ${defender}).`);

    // Queue "When I attack" triggers.
    queueCombatTriggers(game, idx, attacker, "ATTACK");

    const attackerUnits = bf.units[attacker].filter((u) => !u.stunned);
    const defenderUnits = bf.units[defender].filter((u) => !u.stunned);
    const queueAloneTriggers = (pid: PlayerId, soloUnit: CardInstance, mode: "ATTACK" | "DEFEND") => {
      const sources = [...game.players[pid].base.units, ...game.players[pid].base.gear, ...game.battlefields.flatMap((b) => b.units[pid])];
      for (const source of sources) {
        const trig = (source.ability?.trigger || "").toLowerCase();
        if (!trig.includes("when a friendly unit attacks or defends alone")) continue;
        if (source.ability?.effect_text) {
          const effectText = source.ability.effect_text.trim().replace(/^[—-]\s*/, "").trim();
          if (!effectText) continue;
          const req = inferTargetRequirement(effectText);
          game.chain.push({
            id: makeId("chain"),
            controller: pid,
            kind: "TRIGGERED_ABILITY",
            label: `${source.name} — Trigger`,
            effectText,
            contextBattlefieldIndex: idx,
            targets: [{ kind: "UNIT", owner: pid, instanceId: soloUnit.instanceId, battlefieldIndex: idx, zone: "BF" }],
            needsTargets: true,
            targetRequirement: { kind: "UNIT_ANYWHERE", count: 1 },
            sourceInstanceId: source.instanceId,
          });
          game.state = "CLOSED";
          game.priorityPlayer = pid;
          game.passesInRow = 0;
          game.log.unshift(`${source.name} triggered (${mode} alone).`);
        }
      }
    };

    if (attackerUnits.length === 1) queueAloneTriggers(attacker, attackerUnits[0], "ATTACK");
    if (defenderUnits.length === 1) queueAloneTriggers(defender, defenderUnits[0], "DEFEND");
  }
};

const attemptScore = (game: GameState, scorer: PlayerId, battlefieldIndex: number, method: "Hold" | "Conquer") => {
  const p = game.players[scorer];
  if (p.scoredBattlefieldsThisTurn.includes(battlefieldIndex)) return;

  const current = p.points;
  const finalPointAttempt = current === game.victoryScore - 1;

  let pointsAwarded = 1;
  let finalPointReplacedWithDraw = false;

  if (finalPointAttempt && method === "Conquer") {
    // Final Point restriction (Conquer must have scored every battlefield this turn).
    const allBattlefields = game.battlefields.map((b) => b.index);
    const wouldHaveScored = [...p.scoredBattlefieldsThisTurn, battlefieldIndex];
    const scoredAll = allBattlefields.every((i) => wouldHaveScored.includes(i));
    if (!scoredAll) {
      pointsAwarded = 0;
      finalPointReplacedWithDraw = true;
      game.log.unshift(`${scorer} would score the Final Point via Conquer, but hasn't scored every battlefield this turn. Draw 1 instead.`);
    }
  }

  // Final Point rule for Hold: player must control more battlefields than opponent
  if (finalPointAttempt && method === "Hold") {
    const opp = otherPlayer(scorer);
    const scorerControlled = game.battlefields.filter((bf) => bf.controller === scorer).length;
    const oppControlled = game.battlefields.filter((bf) => bf.controller === opp).length;
    if (scorerControlled <= oppControlled) {
      pointsAwarded = 0;
      finalPointReplacedWithDraw = true;
      game.log.unshift(`${scorer} would score the Final Point via Hold, but doesn't control more battlefields than opponent. Draw 1 instead.`);
    }
  }

  if (method === "Conquer" || method === "Hold") {
    const myUnits = [...p.base.units, ...game.battlefields.flatMap((b) => b.units[scorer])];
    for (const u of myUnits) {
      const trig = (u.ability?.trigger || "").toLowerCase();
      const matches =
          method === "Conquer"
              ? trig.includes("when i conquer") || trig.includes("when i'm played and when i conquer")
              : trig.includes("when i hold");
      if (matches && u.ability?.effect_text) {
        const req = inferTargetRequirement(u.ability.effect_text);
        game.chain.push({
          id: makeId("chain"),
          controller: scorer,
          kind: "TRIGGERED_ABILITY",
          label: `Trigger: ${u.name} (${method})`,
          effectText: u.ability.effect_text,
          targets: [{ kind: "NONE" }],
          needsTargets: req.kind !== "NONE",
          targetRequirement: req,
        });
        game.state = "CLOSED";
        game.priorityPlayer = scorer;
        game.passesInRow = 0;
        game.log.unshift(`${u.name} triggered (${method}).`);
      }
    }
  }

  if (method === "Conquer") {
    const legend = game.players[scorer].legend;
    if (legend?.ability?.trigger && legend.ability.trigger.toLowerCase().includes("when you conquer") && legend.ability.effect_text) {
      const req = inferTargetRequirement(legend.ability.effect_text);
      game.chain.push({
        id: makeId("chain"),
        controller: scorer,
        kind: "TRIGGERED_ABILITY",
        label: `Trigger: ${legend.name} (Conquer)`,
        effectText: legend.ability.effect_text,
        targets: [{ kind: "NONE" }],
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
      });
      game.state = "CLOSED";
      game.priorityPlayer = scorer;
      game.passesInRow = 0;
      game.log.unshift(`${legend.name} triggered (Conquer).`);
    }
  }

  p.scoredBattlefieldsThisTurn.push(battlefieldIndex);

  // Battlefield triggered ability: "When you hold here" / "When you conquer here" (best-effort).
  const bf = game.battlefields[battlefieldIndex];
  const trig = (bf.card.ability?.trigger || "").toLowerCase();
  const effect = bf.card.ability?.effect_text;
  const wantsHold = trig.includes("hold here");
  const wantsConquer = trig.includes("conquer here");
  if ((method === "Hold" && wantsHold && effect) || (method === "Conquer" && wantsConquer && effect)) {
    // Put battlefield trigger on chain (simplified).
    const req = inferTargetRequirement(effect, { here: true });
    game.chain.push({
      id: makeId("chain"),
      controller: scorer,
      kind: "TRIGGERED_ABILITY",
      label: `Battlefield Trigger: ${bf.card.name} (${method})`,
      effectText: effect,
      contextBattlefieldIndex: battlefieldIndex,
      needsTargets: req.kind !== "NONE",
      targetRequirement: req,
      restrictTargetsToBattlefieldIndex: null,
      targets: [{ kind: "NONE" }],
    });
    game.state = "CLOSED";
    game.priorityPlayer = scorer;
    game.passesInRow = 0;
    game.log.unshift(`Triggered ability added to chain: ${bf.card.name} (${method}).`);
  }

  if (pointsAwarded > 0) {
    p.points += pointsAwarded;
    game.log.unshift(`${scorer} scored 1 point by ${method} at Battlefield ${battlefieldIndex + 1}. (Total: ${p.points})`);
  } else if (finalPointReplacedWithDraw) {
    drawCards(game, scorer, 1);
  }

  // Win check
  if (p.points >= game.victoryScore) {
    game.step = "GAME_OVER";
    game.log.unshift(`${scorer} wins! Reached ${p.points} points.`);
  }
};

const resolveHoldScoring = (game: GameState, player: PlayerId) => {
  // In Scoring Step: score each battlefield you control by Hold (once per battlefield per turn).
  for (const bf of game.battlefields) {
    if (bf.controller === player) {
      attemptScore(game, player, bf.index, "Hold");
      if (game.step === "GAME_OVER") return;
    }
  }
};

const burnOutIfNeeded = (game: GameState, player: PlayerId): boolean => {
  const p = game.players[player];
  if (p.mainDeck.length > 0) return true;

  // Burn Out: shuffle Trash into main deck, opponent scores 1 point, then draw. If trash empty too, opponent wins (simplified).
  if (p.trash.length === 0) {
    const opp = otherPlayer(player);
    game.step = "GAME_OVER";
    game.log.unshift(`${player} tried to draw with empty deck and empty trash. ${opp} wins by Burn Out.`);
    return false;
  }

  const opp = otherPlayer(player);
  p.mainDeck = shuffle(p.trash.map((c) => ({ ...c })), game.turnNumber);
  p.trash = [];
  game.log.unshift(`${player} Burned Out! Shuffled Trash into main deck. ${opp} scores 1 point.`);
  game.players[opp].points += 1;

  if (game.players[opp].points >= game.victoryScore) {
    game.step = "GAME_OVER";
    game.log.unshift(`${opp} wins! (Burn Out point reached victory score)`);
    return false;
  }
  return true;
};

const drawCards = (game: GameState, player: PlayerId, count: number) => {
  const p = game.players[player];
  for (let i = 0; i < count; i++) {
    if (!burnOutIfNeeded(game, player)) return;
    if (p.mainDeck.length === 0) return; // after burn out with empty trash, game over
    const card = p.mainDeck.shift()!;
    p.hand.push(card);
    game.log.unshift(`${player} drew a card.`);
  }
};

const channelRunes = (game: GameState, player: PlayerId, count: number) => {
  const p = game.players[player];
  const n = Math.min(count, p.runeDeck.length);
  for (let i = 0; i < n; i++) {
    const rune = p.runeDeck.shift()!;
    p.runesInPlay.push({ ...rune, isReady: true });
  }
  if (n > 0) game.log.unshift(`${player} channeled ${n} rune(s).`);
};

const channelRunesExhausted = (game: GameState, player: PlayerId, count: number): number => {
  const p = game.players[player];
  const n = Math.min(count, p.runeDeck.length);
  for (let i = 0; i < n; i++) {
    const rune = p.runeDeck.shift()!;
    p.runesInPlay.push({ ...rune, isReady: false });
  }
  if (n > 0) game.log.unshift(`${player} channeled ${n} rune(s) exhausted.`);
  return n;
};

const emptyPoolsAtEndOfDraw = (game: GameState) => {
  // Rune Pool empties at the end of the active player's Draw Phase.
  const pid = game.turnPlayer;
  game.players[pid].runePool = emptyRunePool();
  game.log.unshift(`${pid}'s Rune Pool emptied (end of Draw Phase).`);
};

const emptyPoolAtEndOfTurn = (game: GameState, player: PlayerId) => {
  // Rune Pool empties at end of turn (Expiration).
  game.players[player].runePool = emptyRunePool();
  game.log.unshift(`${player}'s Rune Pool emptied (end of turn).`);
};

const clearEndOfTurnStatuses = (game: GameState) => {
  // Stunned ends at end of the turn specified by stunnedUntilTurn (per rules: stun lasts until end of NEXT turn).
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const p = game.players[pid];
    for (const u of p.base.units) {
      if (u.stunned && game.turnNumber >= u.stunnedUntilTurn) {
        u.stunned = false;
        u.stunnedUntilTurn = 0;
      }
    }
    for (const bf of game.battlefields) {
      for (const u of bf.units[pid]) {
        if (u.stunned && game.turnNumber >= u.stunnedUntilTurn) {
          u.stunned = false;
          u.stunnedUntilTurn = 0;
        }
      }
    }
  }
};

const clearDamageAndTempBonusesEndOfTurn = (game: GameState) => {
  // First, kill units with Ephemeral keyword (they are killed at end of turn)
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const p = game.players[pid];

    // Kill Ephemeral units in base
    const ephemeralBase = p.base.units.filter((u) => hasKeyword(u, "Ephemeral"));
    for (const u of ephemeralBase) {
      const idx = p.base.units.findIndex((x) => x.instanceId === u.instanceId);
      if (idx >= 0) {
        p.base.units.splice(idx, 1);
        killUnit(game, pid, u, "killed (Ephemeral)");
      }
    }

    // Kill Ephemeral units at battlefields
    for (const bf of game.battlefields) {
      const ephemeralBf = bf.units[pid].filter((u) => hasKeyword(u, "Ephemeral"));
      for (const u of ephemeralBf) {
        const idx = bf.units[pid].findIndex((x) => x.instanceId === u.instanceId);
        if (idx >= 0) {
          bf.units[pid].splice(idx, 1);
          killUnit(game, pid, u, "killed (Ephemeral)");
        }
      }
    }
  }

  // Units heal at end of turn (damage removed).
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const p = game.players[pid];
    for (const u of p.base.units) {
      u.damage = 0;
      u.tempMightBonus = 0;
      u.tempKeywords = [];
    }
    for (const bf of game.battlefields) {
      for (const u of bf.units[pid]) {
        u.damage = 0;
        u.tempMightBonus = 0;
        u.tempKeywords = [];
      }
    }
  }
};

const awakenPlayer = (game: GameState, player: PlayerId) => {
  // Awaken Step readies permanents and runes (simplified).
  const p = game.players[player];

  // First, kill units with Temporary keyword (they are killed at start of Beginning Phase)
  const temporaryUnitsBase = p.base.units.filter((u) => hasKeyword(u, "Temporary"));
  for (const u of temporaryUnitsBase) {
    const idx = p.base.units.findIndex((x) => x.instanceId === u.instanceId);
    if (idx >= 0) {
      p.base.units.splice(idx, 1);
      killUnit(game, player, u, "killed (Temporary)");
    }
  }

  for (const bf of game.battlefields) {
    const temporaryUnitsBf = bf.units[player].filter((u) => hasKeyword(u, "Temporary"));
    for (const u of temporaryUnitsBf) {
      const idx = bf.units[player].findIndex((x) => x.instanceId === u.instanceId);
      if (idx >= 0) {
        bf.units[player].splice(idx, 1);
        killUnit(game, player, u, "killed (Temporary)");
      }
    }
  }

  // Now ready all permanents and runes
  p.legendReady = true;
  for (const u of p.base.units) u.isReady = true;
  for (const g of p.base.gear) g.isReady = true;
  for (const bf of game.battlefields) {
    for (const u of bf.units[player]) u.isReady = true;
  }
  for (const r of p.runesInPlay) r.isReady = true;
  game.log.unshift(`${player} awoke: readied legend/units/gear/runes.`);
};

// ----------------------------- Costs -----------------------------

const computeDeflectTax = (targetUnit: CardInstance | null): number => {
  if (!targetUnit) return 0;
  return keywordValue(targetUnit, "Deflect");
};

const canAffordCardWithChoices = (
    game: GameState,
    player: PlayerId,
    card: CardInstance,
    opts: {
      powerDomainsAllowed: Domain[];
      overrideEnergyCost?: number;
      overridePowerCost?: number;

      // optional add-ons
      additionalEnergy?: number;
      additionalPowerByDomain?: Partial<Record<Domain, number>>;
      additionalPowerAny?: number; // any-domain power (Deflect, some misc costs)
    }
): boolean => {
  const p = game.players[player];

  const energyNeed = (opts.overrideEnergyCost ?? card.cost) + (opts.additionalEnergy ?? 0);
  const basePowerNeed = opts.overridePowerCost ?? (card.stats.power ?? 0);
  const addByDomain = opts.additionalPowerByDomain || {};
  const extraAny = opts.additionalPowerAny ?? 0;

  if (p.runePool.energy < energyNeed) return false;

  // 1) Pay the base power (domain-restricted)
  const pool = p.runePool;
  const canPayBase = choosePowerPaymentDomains(pool, basePowerNeed, opts.powerDomainsAllowed) !== null;
  if (!canPayBase) return false;

  // 2) Simulate paying base power to get remaining pool
  const remainingPool = deepClone(pool);
  const payBase = choosePowerPaymentDomains(pool, basePowerNeed, opts.powerDomainsAllowed)!;
  for (const d of Object.keys(payBase.payment) as Domain[]) remainingPool.power[d] -= payBase.payment[d];

  // 3) Pay additional domain-specific power (e.g., Accelerate requires matching domain)
  for (const dom of Object.keys(addByDomain) as Domain[]) {
    const need = addByDomain[dom] || 0;
    if (need <= 0) continue;
    if ((remainingPool.power[dom] || 0) < need) return false;
    remainingPool.power[dom] -= need;
  }

  // 4) Pay any-domain power
  const ALL_DOMAINS: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];
  const canPayAny = choosePowerPaymentDomains(remainingPool, extraAny, ALL_DOMAINS) !== null;
  return canPayAny;
};

const payCost = (
    game: GameState,
    player: PlayerId,
    card: CardInstance,
    opts: {
      powerDomainsAllowed: Domain[];
      overrideEnergyCost?: number;
      overridePowerCost?: number;

      additionalEnergy?: number;
      additionalPowerByDomain?: Partial<Record<Domain, number>>;
      additionalPowerAny?: number;
    }
) => {
  const p = game.players[player];

  const energyNeed = (opts.overrideEnergyCost ?? card.cost) + (opts.additionalEnergy ?? 0);
  const basePowerNeed = opts.overridePowerCost ?? (card.stats.power ?? 0);
  const addByDomain = opts.additionalPowerByDomain || {};
  const extraAny = opts.additionalPowerAny ?? 0;

  p.runePool.energy -= energyNeed;

  // Base power
  const basePay = choosePowerPaymentDomains(p.runePool, basePowerNeed, opts.powerDomainsAllowed);
  if (!basePay) throw new Error("Cost payment failed (base power).");
  for (const d of Object.keys(basePay.payment) as Domain[]) p.runePool.power[d] -= basePay.payment[d];

  // Additional domain-specific power (e.g., Accelerate)
  for (const dom of Object.keys(addByDomain) as Domain[]) {
    const need = addByDomain[dom] || 0;
    if (need <= 0) continue;
    if ((p.runePool.power[dom] || 0) < need) throw new Error("Cost payment failed (domain-specific add-on).");
    p.runePool.power[dom] -= need;
  }

  // Any-domain power
  const ALL_DOMAINS: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];
  const anyPay = choosePowerPaymentDomains(p.runePool, extraAny, ALL_DOMAINS);
  if (!anyPay) throw new Error("Cost payment failed (any power).");
  for (const d of Object.keys(anyPay.payment) as Domain[]) p.runePool.power[d] -= anyPay.payment[d];
};

const normalizeEffectText = (text: string): string =>
    (text || "")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const removeAdditionalCostClause = (text: string): string =>
    text.replace(/^as\s+[^.]*additional\s+cost[^.]*\.\s*/i, "").trim();

const extractOptionalCostSentence = (text: string): string => {
  const m = text.match(/as\s+[^.]*additional\s+cost[^.]*\./i);
  return m ? m[0] : "";
};

const spendBuffsFromUnits = (units: CardInstance[], count: number): number => {
  let remaining = count;
  for (const u of units) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, u.buffs || 0);
    if (take > 0) {
      u.buffs -= take;
      remaining -= take;
    }
  }
  return count - remaining;
};

const discardFromHandForCost = (game: GameState, player: PlayerId, excludeId: string, count: number): CardInstance[] => {
  const p = game.players[player];
  const discarded: CardInstance[] = [];
  const candidates = p.hand.filter((c) => c.instanceId !== excludeId);
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const c = candidates[i];
    const idx = p.hand.findIndex((x) => x.instanceId === c.instanceId);
    if (idx >= 0) {
      p.hand.splice(idx, 1);
      p.trash.push(c);
      discarded.push(c);
      p.discardedThisTurn += 1;
      game.log.unshift(`${player} discarded ${c.name} (additional cost).`);
      const trig = (c.ability?.trigger || "").toLowerCase();
      if (trig.includes("when you discard me") && c.ability?.effect_text) {
        game.chain.push({
          id: makeId("chain"),
          controller: player,
          kind: "TRIGGERED_ABILITY",
          label: `Discard Trigger: ${c.name}`,
          effectText: c.ability.effect_text,
          targets: [{ kind: "NONE" }],
          needsTargets: false,
          sourceCard: c,
        });
        game.log.unshift(`${c.name} triggered from discard.`);
      }
      checkGlobalTriggers(game, "DISCARD_CARD", { player, card: c });
    }
  }
  return discarded;
};

const resolveAdditionalCostsForPlay = (
    game: GameState,
    player: PlayerId,
    card: CardInstance,
    effectTextRaw: string,
    baseEnergyCost: number,
    basePowerCost: number
): {
  effectText: string;
  additionalCostPaid: boolean;
  additionalPowerByDomain: Partial<Record<Domain, number>>;
  overrideEnergyCost?: number;
  overridePowerCost?: number;
  error?: string;
} => {
  const text = normalizeEffectText(effectTextRaw || "");
  const lower = text.toLowerCase();
  const addClause = extractOptionalCostSentence(text);
  if (!addClause || !lower.includes("additional cost")) {
    return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {} };
  }

  const clauseLower = addClause.toLowerCase();
  const isOptional = /\byou may\b/.test(clauseLower);

  let additionalCostPaid = false;
  let additionalPowerByDomain: Partial<Record<Domain, number>> = {};
  let overrideEnergyCost: number | undefined;
  let overridePowerCost: number | undefined;

  const payOptional = (canPay: boolean) => {
    if (!isOptional) return canPay;
    return canPay;
  };

  // 1) Discard as additional cost
  const discardMatch = clauseLower.match(/\bdiscard\s+(\d+)/);
  if (discardMatch) {
    const n = parseInt(discardMatch[1], 10);
    const canPay = game.players[player].hand.length - 1 >= n;
    if (!canPay && !isOptional) return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: discard unavailable" };
    if (payOptional(canPay) && n > 0) {
      discardFromHandForCost(game, player, card.instanceId, n);
      additionalCostPaid = true;
    }
  }

  // 2) Pay rune as additional cost
  const runeMatch = clauseLower.match(/\bpay\s+(\d+)\s+(body|calm|chaos|fury|mind|order)\s+rune\b/);
  if (runeMatch) {
    const n = parseInt(runeMatch[1], 10);
    const dom = clampDomain(runeMatch[2]);
    if (n > 0) {
      const available = game.players[player].runePool.power[dom] || 0;
      const canPay = available >= n;
      if (!canPay && !isOptional) return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: rune unavailable" };
      if (payOptional(canPay)) {
        additionalPowerByDomain = { ...additionalPowerByDomain, [dom]: (additionalPowerByDomain[dom] || 0) + n };
        additionalCostPaid = true;
      }
    }
  }

  // 2b) Pay class rune as additional cost (any domain in identity)
  const classMatch = clauseLower.match(/\bpay\s+(\d+)?\s*class\s+rune\b/);
  if (classMatch) {
    const n = classMatch[1] ? parseInt(classMatch[1], 10) : 1;
    if (n > 0) {
      const allowed = classDomainsForPlayer(game, player);
      const pay = choosePowerPaymentDomains(game.players[player].runePool, n, allowed);
      const canPay = !!pay;
      if (!canPay && !isOptional) {
        return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: class rune unavailable" };
      }
      if (payOptional(canPay) && pay) {
        additionalPowerByDomain = { ...additionalPowerByDomain };
        for (const dom of allowed) {
          const spend = pay.payment[dom] || 0;
          if (spend > 0) additionalPowerByDomain[dom] = (additionalPowerByDomain[dom] || 0) + spend;
        }
        additionalCostPaid = true;
      }
    }
  }

  // 2c) Pay rune of any type as additional cost
  const anyRuneMatch = clauseLower.match(/\bpay\s+(\d+)\s+rune\s+of\s+any\s+type\b/);
  if (anyRuneMatch) {
    const n = parseInt(anyRuneMatch[1], 10);
    if (n > 0) {
      const allowed = [...DEFAULT_DOMAINS, "Colorless"] as Domain[];
      const pay = choosePowerPaymentDomains(game.players[player].runePool, n, allowed);
      const canPay = !!pay;
      if (!canPay && !isOptional) {
        return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: any rune unavailable" };
      }
      if (payOptional(canPay) && pay) {
        additionalPowerByDomain = { ...additionalPowerByDomain };
        for (const dom of allowed) {
          const spend = pay.payment[dom] || 0;
          if (spend > 0) additionalPowerByDomain[dom] = (additionalPowerByDomain[dom] || 0) + spend;
        }
        additionalCostPaid = true;
      }
    }
  }

  // 3) Exhaust friendly unit as additional cost
  if (clauseLower.includes("exhaust a friendly unit")) {
    const p = game.players[player];
    const allUnits = [...p.base.units, ...game.battlefields.flatMap((b) => b.units[player])];
    const target = allUnits.find((u) => u.isReady);
    const canPay = !!target;
    if (!canPay && !isOptional) return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: no ready unit to exhaust" };
    if (payOptional(canPay) && target) {
      target.isReady = false;
      additionalCostPaid = true;
      game.log.unshift(`${player} exhausted ${target.name} (additional cost).`);
    }
  }

  // 4) Spend buff(s) as additional cost
  if (clauseLower.includes("spend a buff") || clauseLower.includes("spend any number of buffs")) {
    const units = [...game.players[player].base.units, ...game.battlefields.flatMap((b) => b.units[player])];
    const totalBuffs = units.reduce((sum, u) => sum + (u.buffs || 0), 0);
    const wantsAny = clauseLower.includes("any number of buffs");
    const spendCount = wantsAny ? Math.min(totalBuffs, basePowerCost) : Math.min(totalBuffs, 1);
    const canPay = spendCount > 0;
    if (!canPay && !isOptional) return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: no buffs to spend" };
    if (payOptional(canPay) && spendCount > 0) {
      const spent = spendBuffsFromUnits(units, spendCount);
      additionalCostPaid = true;
      if (clauseLower.includes("reduce my cost")) {
        overridePowerCost = Math.max(0, basePowerCost - spent);
      }
      game.log.unshift(`${player} spent ${spent} buff(s) (additional cost).`);
    }
  }

  // 5) Kill friendly unit(s) as additional cost
  if (clauseLower.includes("kill a friendly unit") || clauseLower.includes("kill any number of friendly units")) {
    const units = [...game.players[player].base.units, ...game.battlefields.flatMap((b) => b.units[player])];
    const wantsAny = clauseLower.includes("any number of friendly units");
    const maxKill = wantsAny ? Math.min(units.length, basePowerCost) : Math.min(units.length, 1);
    const canPay = maxKill > 0;
    if (!canPay && !isOptional) return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: no friendly unit to kill" };
    if (payOptional(canPay) && maxKill > 0) {
      const killed = units.slice(0, maxKill);
      for (const u of killed) {
        removeUnitFromWherever(game, u.owner, u.instanceId);
        killUnit(game, u.owner, u, "sacrificed (additional cost)");
      }
      additionalCostPaid = true;
      if (clauseLower.includes("reduce my cost")) {
        overridePowerCost = Math.max(0, basePowerCost - killed.length);
      }
    }
  }

  if (additionalCostPaid && /ignore this spell's cost/i.test(lower)) {
    overrideEnergyCost = 0;
    overridePowerCost = 0;
  } else if (additionalCostPaid) {
    const reduceEnergy = lower.match(/reduce my cost by (\d+) energy/);
    if (reduceEnergy) {
      const n = parseInt(reduceEnergy[1], 10);
      if (Number.isFinite(n)) overrideEnergyCost = Math.max(0, baseEnergyCost - n);
    }
  }

  let effectText = removeAdditionalCostClause(text);
  effectText = effectText.replace(/if you do,?\s*reduce my cost[^.]*\.\s*/i, "");
  effectText = effectText.replace(/if you do,?\s*ignore this spell's cost\.\s*/i, "");
  effectText = effectText.replace(/reduce my cost by [^.]*\.\s*/i, "");

  if (/if you do/i.test(effectText)) {
    const m = effectText.match(/if you do,?\s*([^]*?)(?:otherwise,?\s*([^]*))?$/i);
    if (m) {
      const ifText = (m[1] || "").trim().replace(/\.$/, "");
      const otherwiseText = (m[2] || "").trim().replace(/\.$/, "");
      effectText = additionalCostPaid ? ifText : otherwiseText;
    }
  }

  return {
    effectText,
    additionalCostPaid,
    additionalPowerByDomain,
    overrideEnergyCost,
    overridePowerCost,
  };
};

// ----------------------------- Auto-pay planning (UI convenience) -----------------------------

const ALL_POWER_DOMAINS: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];

const clonePool = (pool: RunePool): RunePool => ({
  energy: pool.energy,
  power: { ...pool.power },
});

const addPowerRecord = (a: Record<Domain, number>, b: Partial<Record<Domain, number>>): Record<Domain, number> => {
  const out: Record<Domain, number> = { ...a };
  for (const d of Object.keys(b) as Domain[]) out[d] = (out[d] || 0) + (b[d] || 0);
  return out;
};

const emptyPowerAdds = (): Record<Domain, number> => ({
  Body: 0,
  Calm: 0,
  Chaos: 0,
  Fury: 0,
  Mind: 0,
  Order: 0,
  Colorless: 0,
});

const canAffordWithPool = (
    pool: RunePool,
    spec: {
      energyNeed: number;
      basePowerNeed: number;
      powerDomainsAllowed: Domain[];
      additionalPowerByDomain: Partial<Record<Domain, number>>;
      additionalPowerAny: number;
    }
): boolean => {
  if (pool.energy < spec.energyNeed) return false;

  // 1) Base power (domain-restricted)
  const basePay = choosePowerPaymentDomains(pool, spec.basePowerNeed, spec.powerDomainsAllowed);
  if (!basePay) return false;

  // 2) Remaining pool after base payment
  const remaining = clonePool(pool);
  for (const d of Object.keys(basePay.payment) as Domain[]) remaining.power[d] -= basePay.payment[d];

  // 3) Additional domain-specific power (e.g., Accelerate)
  for (const dom of Object.keys(spec.additionalPowerByDomain) as Domain[]) {
    const need = spec.additionalPowerByDomain[dom] || 0;
    if (need <= 0) continue;
    if ((remaining.power[dom] || 0) < need) return false;
    remaining.power[dom] -= need;
  }

  // 4) Any-domain power (Deflect, Hide)
  const anyPay = choosePowerPaymentDomains(remaining, spec.additionalPowerAny, ALL_POWER_DOMAINS);
  return anyPay !== null;
};

/**
 * Compute a minimal-ish rune auto-payment plan that generates enough resources in Rune Pool to pay a cost spec.
 *
 * We search over subsets of runes to recycle (<= 12 in Duel) and then use the smallest number of
 * ready runes to exhaust for any remaining energy shortfall, preferring to "EXHAUST+RECYCLE" the same rune.
 */
const buildAutoPayPlan = (
    pool: RunePool,
    runesInPlay: RuneInstance[],
    spec: {
      energyNeed: number;
      basePowerNeed: number;
      powerDomainsAllowed: Domain[];
      additionalPowerByDomain: Partial<Record<Domain, number>>;
      additionalPowerAny: number;
    }
): AutoPayPlan | null => {
  // Already affordable with existing pool
  if (canAffordWithPool(pool, spec)) {
    return {
      runeUses: {},
      recycleCount: 0,
      exhaustCount: 0,
      exhaustOnlyCount: 0,
      addsEnergy: 0,
      addsPower: emptyPowerAdds(),
    };
  }

  const n = runesInPlay.length;
  if (n === 0) return null;

  const energyShortfall = Math.max(0, spec.energyNeed - pool.energy);
  const readyIdsAll: string[] = runesInPlay.filter((r) => r.isReady).map((r) => r.instanceId);
  if (energyShortfall > readyIdsAll.length) {
    // Can't generate enough energy even if we exhaust all ready runes.
    return null;
  }

  const maxMask = 1 << n;
  let best: { plan: AutoPayPlan; score: [number, number, number] } | null = null;

  const popcount = (x: number): number => {
    let c = 0;
    while (x) {
      x &= x - 1;
      c++;
    }
    return c;
  };

  for (let mask = 0; mask < maxMask; mask++) {
    const recycleCount = popcount(mask);

    // quick pruning: if we already have a plan with fewer recycles, skip
    if (best && recycleCount > best.score[0]) continue;

    const powerAdds = emptyPowerAdds();
    const recycledIds: string[] = [];
    const readyRecycledIds: string[] = [];
    const readyNonRecycledIds: string[] = [];

    for (let i = 0; i < n; i++) {
      const r = runesInPlay[i];
      const isRecycled = (mask & (1 << i)) !== 0;
      if (isRecycled) {
        recycledIds.push(r.instanceId);
        powerAdds[r.domain] = (powerAdds[r.domain] || 0) + 1;
        if (r.isReady) readyRecycledIds.push(r.instanceId);
      } else {
        if (r.isReady) readyNonRecycledIds.push(r.instanceId);
      }
    }

    // Decide exhaust assignments (exactly the energy shortfall), preferring to exhaust runes we already recycle.
    let remainingEnergy = energyShortfall;
    const bothIds: string[] = [];
    const exhaustOnlyIds: string[] = [];

    const takeBoth = Math.min(remainingEnergy, readyRecycledIds.length);
    for (let i = 0; i < takeBoth; i++) bothIds.push(readyRecycledIds[i]);
    remainingEnergy -= takeBoth;

    if (remainingEnergy > readyNonRecycledIds.length) {
      // Not enough ready non-recycled runes to cover the remaining energy shortfall.
      continue;
    }
    for (let i = 0; i < remainingEnergy; i++) exhaustOnlyIds.push(readyNonRecycledIds[i]);

    const addsEnergy = bothIds.length + exhaustOnlyIds.length;

    const newPool = clonePool(pool);
    newPool.energy += addsEnergy;
    newPool.power = addPowerRecord(newPool.power as any, powerAdds);

    if (!canAffordWithPool(newPool, spec)) continue;

    // Build mapping (for UI glow + application)
    const runeUses: Record<string, RunePayKind> = {};
    for (const rid of recycledIds) runeUses[rid] = "RECYCLE";
    for (const rid of bothIds) runeUses[rid] = "BOTH";
    for (const rid of exhaustOnlyIds) runeUses[rid] = "EXHAUST";

    const plan: AutoPayPlan = {
      runeUses,
      recycleCount,
      exhaustCount: addsEnergy,
      exhaustOnlyCount: exhaustOnlyIds.length,
      addsEnergy,
      addsPower: powerAdds,
    };

    // Score: (1) fewer recycled runes, (2) fewer exhaust-only (use BOTH when possible), (3) fewer total used runes
    const score: [number, number, number] = [recycleCount, exhaustOnlyIds.length, recycleCount + addsEnergy];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1]) || (score[0] === best.score[0] && score[1] === best.score[1] && score[2] < best.score[2])) {
      best = { plan, score };
    }
  }

  return best ? best.plan : null;
};

const applyAutoPayPlan = (game: GameState, player: PlayerId, plan: AutoPayPlan) => {
  const p = game.players[player];

  const uses = plan.runeUses;
  const entries = Object.entries(uses) as Array<[string, RunePayKind]>;

  // Apply exhausts first so "BOTH" behaves like Exhaust then Recycle.
  for (const [runeId, kind] of entries) {
    if (kind !== "EXHAUST" && kind !== "BOTH") continue;
    const r = p.runesInPlay.find((x) => x.instanceId === runeId);
    if (!r) continue;
    if (!r.isReady) continue;
    r.isReady = false;
    p.runePool.energy += 1;
  }

  // Apply recycles (including BOTH)
  for (const [runeId, kind] of entries) {
    if (kind !== "RECYCLE" && kind !== "BOTH") continue;
    const idx = p.runesInPlay.findIndex((x) => x.instanceId === runeId);
    if (idx < 0) continue;
    const r = p.runesInPlay.splice(idx, 1)[0];
    p.runePool.power[r.domain] = (p.runePool.power[r.domain] || 0) + 1;
    // Put the rune card back at the bottom of the rune deck, readied.
    p.runeDeck.push({ ...r, isReady: true });
  }
};

// ----------------------------- Resolving effects -----------------------------

const resolveEffectText = (
    game: GameState,
    controller: PlayerId,
    effectTextRaw: string,
    targets: Target[],
    ctx: { battlefieldIndex?: number | null; sourceInstanceId?: string; sourceCardName?: string; sourceCardType?: CardType }
): boolean => {
  const opp = otherPlayer(controller);
  const p = game.players[controller];
  const hereBf = ctx?.battlefieldIndex ?? null;

  const normalize = (s: string) =>
      (s || "")
          .replace(/_/g, " ")
          .replace(/\[\s*add\s*\]\s*/gi, "add ")
          .replace(/\s+/g, " ")
          .trim();

  const text = normalize(effectTextRaw || "");
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasPoro = getUnitsInPlay(game, controller).some((u) => (u.tags || []).some((t) => String(t || "").toLowerCase() === "poro"));
  const hasFacedownAtBattlefield = game.battlefields.some((bf) => bf.facedown && bf.facedown.owner === controller);
  const unitCountAtHere = hereBf != null ? game.battlefields[hereBf].units[controller].length : 0;

  const rawTargets: Target[] = Array.isArray(targets) ? targets : [];
  const firstTarget: Target = (rawTargets.length > 0 ? rawTargets[0] : { kind: "NONE" }) as any;

  // Multi-target support: collect all selected UNIT targets that currently exist.
  const selectedUnitTargets = rawTargets.filter((t): t is Extract<Target, { kind: "UNIT" }> => (t as any)?.kind === "UNIT");
  const selectedUnitLocs = selectedUnitTargets
      .map((t) => ({ t, loc: locateUnit(game, t.owner, t.instanceId) }))
      .filter(
          (x): x is {
            t: Extract<Target, { kind: "UNIT" }>;
            loc: { zone: "BASE" | "BF"; battlefieldIndex?: number; unit: CardInstance };
          } => !!x.loc
      );

  const selectedUnits: CardInstance[] = selectedUnitLocs.map((x) => x.loc.unit);
  const unitTarget = selectedUnits.length > 0 ? selectedUnits[0] : null;

  const bfTargetIndex = firstTarget.kind === "BATTLEFIELD" ? firstTarget.index : null;

  const isUpTo = /\bup\s+to\b/i.test(text);

  const forEachSelectedUnit = (
      fn: (
          u: CardInstance,
          t: Extract<Target, { kind: "UNIT" }>,
          loc: { zone: "BASE" | "BF"; battlefieldIndex?: number; unit: CardInstance }
      ) => void
  ) => {
    for (const x of selectedUnitLocs) fn(x.loc.unit, x.t, x.loc);
  };

  const sourceLoc =
      ctx?.sourceInstanceId
          ? locateUnit(game, controller, ctx.sourceInstanceId) || locateUnit(game, opp, ctx.sourceInstanceId)
          : null;
  const sourceUnit = sourceLoc?.unit || null;

  let did = false;

  const payEnergy = (amount: number): boolean => {
    if (p.runePool.energy < amount) return false;
    p.runePool.energy -= amount;
    return true;
  };

  const payPowerAny = (amount: number): boolean => {
    for (let i = 0; i < amount; i++) {
      const dom = (Object.keys(p.runePool.power) as Domain[]).find((d) => p.runePool.power[d] > 0);
      if (!dom) return false;
      p.runePool.power[dom] -= 1;
    }
    return true;
  };

  const payPowerDomain = (dom: Domain, amount: number): boolean => {
    if ((p.runePool.power[dom] || 0) < amount) return false;
    p.runePool.power[dom] -= amount;
    return true;
  };

  const prepareUnitForPlayFromEffect = (card: CardInstance) => {
    card.isReady = false;
    card.damage = 0;
    const raw = `${card.ability?.effect_text || ""} ${card.ability?.raw_text || ""}`.toLowerCase();
    if (raw.includes("if an opponent controls a battlefield") && raw.includes("i enter ready")) {
      const opponent = otherPlayer(controller);
      const opponentControls = game.battlefields.some((bf) => bf.controller === opponent);
      if (opponentControls) card.isReady = true;
    }
    if (raw.includes("if an opponent's score is within 3 points of the victory score") && raw.includes("i enter ready")) {
      const opponent = otherPlayer(controller);
      if (game.players[opponent].points >= game.victoryScore - 3) card.isReady = true;
    }
  };

  if (/if it is stunned, kill it\. otherwise, stun it/i.test(lower)) {
    const targets = selectedUnits.length > 0 ? selectedUnits : unitTarget ? [unitTarget] : [];
    if (targets.length > 0) {
      for (const u of targets) {
        if (u.stunned) {
          u.damage = 999;
        } else {
          u.stunned = true;
          u.isReady = false;
          u.stunnedUntilTurn = game.turnNumber + 1;
        }
      }
      cleanupStateBased(game);
      did = true;
    }
  }

  // --------------------- Reveal / Look at top cards (Teemo, TF) ---------------------
  const revealMatch = text.match(/\b(?:reveal|look at)\s+(?:the\s+)?top\s+(\d+)\s+(?:cards?|runes?)/i);
  if (revealMatch) {
    const n = parseInt(revealMatch[1], 10);
    const isRunes = text.toLowerCase().includes("rune");
    const deck = isRunes ? p.runeDeck : p.mainDeck;
    const revealed = deck.slice(0, n);

    const names = revealed.map((c) => (isRunes ? (c as RuneInstance).domain : c.name)).join(", ");
    game.log.unshift(`${controller} revealed top ${n}: ${names}.`);

    if (!isRunes) {
      for (const card of revealed as CardInstance[]) {
        const trig = (card.ability?.trigger || "").toLowerCase();
        const eff = card.ability?.effect_text;
        if (trig.includes("when you look at cards from the top of your deck and see me") && eff) {
          const req = inferTargetRequirement(eff);
          game.chain.push({
            id: makeId("chain"),
            controller,
            kind: "TRIGGERED_ABILITY",
            label: `Trigger: ${card.name}`,
            effectText: eff,
            targets: [{ kind: "NONE" }],
            needsTargets: req.kind !== "NONE",
            targetRequirement: req,
            sourceInstanceId: card.instanceId,
          });
          game.state = "CLOSED";
          game.priorityPlayer = controller;
          game.passesInRow = 0;
          game.log.unshift(`${card.name} triggered from the top of the deck.`);
        }
      }
    }
    did = true;
  }

  // --------------------- Discard (some effects reference the discarded card) ---------------------
  const discarded: CardInstance[] = [];
  const discN = extractDiscardAmount(text);
  if (discN && discN > 0) {
    const n = Math.min(discN, p.hand.length);
    for (let i = 0; i < n; i++) {
      const c = p.hand.pop();
      if (c) {
        p.trash.push(c);
        discarded.push(c);
        p.discardedThisTurn += 1;
        did = true;
        game.log.unshift(`${controller} discarded ${c.name}.`);

        const trig = (c.ability?.trigger || "").toLowerCase();
        if (trig.includes("when you discard me") && c.ability?.effect_text) {
          game.chain.push({
            id: makeId("chain"),
            controller: controller,
            kind: "TRIGGERED_ABILITY",
            label: `Discard Trigger: ${c.name}`,
            effectText: c.ability.effect_text,
            targets: [{ kind: "NONE" }],
            needsTargets: false,
            sourceCard: c,
          });
          game.log.unshift(`${c.name} triggered from discard.`);
        }

        checkGlobalTriggers(game, "DISCARD_CARD", { player: controller, card: c });
      }
    }
  }

  // --------------------- Draw / Channel / Add resources ---------------------
  const drawN = extractDrawAmount(text);
  if (drawN && drawN > 0) {
    const poroGate = lower.includes("if you control a poro") ? hasPoro : true;
    const facedownGate = lower.includes("if you control a facedown card at a battlefield") ? hasFacedownAtBattlefield : true;
    const handGate = /draw 1 if you have one or fewer cards in your hand/i.test(lower) ? p.hand.length <= 1 : true;
    const fourUnitsGate =
        /if you have 4\+ units at that battlefield/i.test(lower) && hereBf != null
            ? game.battlefields[hereBf].units[controller].length >= 4
            : true;
    if (poroGate && facedownGate && handGate && fourUnitsGate) {
      drawCards(game, controller, drawN);
      did = true;
    }
  }

  if (/\bdraw\s+1\s+for\s+each\s+of\s+your\s+mighty\s+units\b/i.test(lower)) {
    let mightyCount = 0;
    [p.base.units, ...game.battlefields.map((b) => b.units[controller])].forEach((list) => {
      list.forEach((u) => {
        if (isMighty(u)) mightyCount += 1;
      });
    });
    if (mightyCount > 0) {
      drawCards(game, controller, mightyCount);
      game.log.unshift(`${controller} drew ${mightyCount} (Mighty scaling).`);
      did = true;
    }
  }

  const chN = extractChannelAmount(text);
  if (chN && chN > 0) {
    const wantsExhausted = /\bchannel\s+\d+\s+runes?\s+exhausted\b/i.test(lower);
    const actual = wantsExhausted ? channelRunesExhausted(game, controller, chN) : (channelRunes(game, controller, chN), chN);
    did = true;
    if (actual < chN && /\bif\s+you\s+can't\b|\bif\s+you\s+couldn't\b/i.test(lower)) {
      drawCards(game, controller, 1);
      game.log.unshift(`${controller} drew 1 (failed to channel enough runes).`);
    }
  }

  if (/exhaust me to channel \d+ rune(?:s)? exhausted/i.test(lower) && sourceUnit && sourceUnit.isReady) {
    const m = lower.match(/exhaust me to channel (\d+) rune/);
    const n = m ? parseInt(m[1], 10) : 1;
    sourceUnit.isReady = false;
    channelRunesExhausted(game, controller, Number.isFinite(n) ? n : 1);
    did = true;
  }

  if (/spend any number of buffs/i.test(lower) && /for each buff spent, channel/i.test(lower)) {
    const units = getUnitsInPlay(game, controller);
    const totalBuffs = units.reduce((sum, u) => sum + (u.buffs || 0), 0);
    if (totalBuffs > 0) {
      spendBuffsFromUnits(units, totalBuffs);
      channelRunesExhausted(game, controller, totalBuffs);
      game.log.unshift(`${controller} spent ${totalBuffs} buff(s) to channel runes.`);
      did = true;
    }
  }

  // Add Energy
  const addEnergyMatch = lower.match(/\badd\s+(\d+)\s+energy\b/);
  if (addEnergyMatch) {
    const amt = parseInt(addEnergyMatch[1], 10);
    if (Number.isFinite(amt) && amt > 0) {
      p.runePool.energy += amt;
      game.log.unshift(`${controller} added ${amt} Energy to the Rune Pool.`);
      did = true;
    }
  }

  // Add X rune(s)
  const addRuneMatch = lower.match(/\badd\s+(\d+)?\s*([a-z]+)\s+rune\b/);
  if (addRuneMatch) {
    const amt = addRuneMatch[1] ? parseInt(addRuneMatch[1], 10) : 1;
    const domWord = addRuneMatch[2];
    if (Number.isFinite(amt) && amt > 0) {
      if (domWord === "class") {
        const allowed = classDomainsForPlayer(game, controller);
        const chosen = allowed[0] || "Colorless";
        p.runePool.power[chosen] += amt;
        game.log.unshift(`${controller} added ${amt} ${chosen} power (class rune).`);
      } else {
        const dom = clampDomain(domWord);
        p.runePool.power[dom] += amt;
        game.log.unshift(`${controller} added ${amt} ${dom} Power to the Rune Pool.`);
      }
      did = true;
    }
  }

  // Add X rune of any type (simplified as Colorless power)
  const addAnyRuneMatch = lower.match(/\badd\s+(\d+)\s+rune\s+of\s+any\s+type\b/);
  if (addAnyRuneMatch) {
    const amt = parseInt(addAnyRuneMatch[1], 10);
    if (Number.isFinite(amt) && amt > 0) {
      p.runePool.power.Colorless += amt;
      game.log.unshift(`${controller} added ${amt} power (any-type rune simplified as Colorless).`);
      did = true;
    }
  }

  // --------------------- Tokens ---------------------
  const wordToNum = (w: string): number | null => {
    const m: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
    };
    if (!w) return null;
    if (/^\d+$/.test(w)) {
      const n = parseInt(w, 10);
      return Number.isFinite(n) ? n : null;
    }
    return m[w.toLowerCase()] ?? null;
  };

  const tokenM = text.match(/\bplay\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:an?\s+)?(\d+)\s+might\s+([a-z]+)\s+unit\s+token(?:s)?\b/i);
  if (tokenM) {
    const countWord = tokenM[1] || "";
    const count = wordToNum(countWord) ?? 1;
    const mightVal = parseInt(tokenM[2], 10);
    const tokenTypeRaw = tokenM[3] || "Token";
    const safeCount = Number.isFinite(count) && count > 0 ? count : 1;
    const safeMight = Number.isFinite(mightVal) && mightVal >= 0 ? mightVal : 1;
    const tokenType = tokenTypeRaw[0].toUpperCase() + tokenTypeRaw.slice(1).toLowerCase();

    const tokenCard: CardData = createTokenCard(`${tokenType} Token`, safeMight, tokenType);
    const tokenInstances = Array.from({ length: safeCount }, () => instantiateCard(tokenCard, controller, game.turnNumber));

    // Destination defaults to Base; "here" means the source context (battlefield if present, else Base).
    const wantHere = /\bhere\b/i.test(text);
    const destBf =
        bfTargetIndex != null ? bfTargetIndex : wantHere ? hereBf : null;

    if (destBf != null) {
      game.battlefields[destBf].units[controller].push(...tokenInstances);
      game.log.unshift(`${controller} played ${safeCount} ${safeMight} might ${tokenType} token(s) at Battlefield ${destBf + 1}.`);
    } else {
      p.base.units.push(...tokenInstances);
      game.log.unshift(`${controller} played ${safeCount} ${safeMight} might ${tokenType} token(s) at Base.`);
    }
    did = true;
  }

  // --------------------- Play me from trash / deck ---------------------
  if (/play me from your trash/i.test(lower)) {
    const idx =
        ctx.sourceInstanceId != null
            ? p.trash.findIndex((c) => c.instanceId === ctx.sourceInstanceId)
            : p.trash.findIndex((c) => c.name === ctx.sourceCardName);
    if (idx >= 0) {
      const card = p.trash[idx];
      const needEnergy = /\bpay\s+1\s+energy\b/i.test(text) ? 1 : 0;
      const domainMatch = text.match(/\bpay\s+1\s+([a-z]+)\s+rune\b/i);
      const needDomain = domainMatch ? clampDomain(domainMatch[1]) : null;
      const needAny = /\bpay\s+1\s+rune\s+of\s+any\s+type\b/i.test(text);
      const canPayEnergy = needEnergy === 0 || p.runePool.energy >= needEnergy;
      const canPayDomain = !needDomain || (p.runePool.power[needDomain] || 0) >= 1;
      const canPayAny = !needAny || Object.values(p.runePool.power).some((v) => v > 0);
      if (canPayEnergy && canPayDomain && canPayAny) {
        if (needEnergy > 0) payEnergy(needEnergy);
        if (needDomain) payPowerDomain(needDomain, 1);
        if (needAny) payPowerAny(1);
        p.trash.splice(idx, 1);
        const dest = /\bhere\b/i.test(text) && hereBf != null ? ({ kind: "BF", index: hereBf } as const) : ({ kind: "BASE" } as const);
        if (card.type === "Unit") {
          prepareUnitForPlayFromEffect(card);
        } else if (card.type === "Gear") {
          card.isReady = true;
        }
        p.mainDeckCardsPlayedThisTurn += 1;
        game.chain.push({
          id: makeId("chain"),
          controller,
          kind: "PLAY_CARD",
          label: `Play ${card.name}`,
          sourceCard: card,
          sourceZone: "HAND",
          playDestination: card.type === "Unit" || card.type === "Gear" ? dest : null,
          effectText: card.ability?.effect_text || "",
          contextBattlefieldIndex: dest.kind === "BF" ? dest.index : null,
          targets: [{ kind: "NONE" }],
        });
        game.state = "CLOSED";
        game.priorityPlayer = controller;
        game.passesInRow = 0;
        checkGlobalTriggers(game, "PLAY_CARD", { player: controller, card });
        game.log.unshift(`${controller} played ${card.name} from Trash.`);
        did = true;
      }
    }
  }

  if (/play me for 1 rune of any type/i.test(lower)) {
    const idx =
        ctx.sourceInstanceId != null
            ? p.mainDeck.findIndex((c) => c.instanceId === ctx.sourceInstanceId)
            : p.mainDeck.findIndex((c) => c.name === ctx.sourceCardName);
    if (idx >= 0 && payPowerAny(1)) {
      const card = p.mainDeck.splice(idx, 1)[0];
      const dest = /\bhere\b/i.test(text) && hereBf != null ? ({ kind: "BF", index: hereBf } as const) : ({ kind: "BASE" } as const);
      if (card.type === "Unit") {
        prepareUnitForPlayFromEffect(card);
      } else if (card.type === "Gear") {
        card.isReady = true;
      }
      p.mainDeckCardsPlayedThisTurn += 1;
      game.chain.push({
        id: makeId("chain"),
        controller,
        kind: "PLAY_CARD",
        label: `Play ${card.name}`,
        sourceCard: card,
        sourceZone: "HAND",
        playDestination: card.type === "Unit" || card.type === "Gear" ? dest : null,
        effectText: card.ability?.effect_text || "",
        contextBattlefieldIndex: dest.kind === "BF" ? dest.index : null,
        targets: [{ kind: "NONE" }],
      });
      game.state = "CLOSED";
      game.priorityPlayer = controller;
      game.passesInRow = 0;
      checkGlobalTriggers(game, "PLAY_CARD", { player: controller, card });
      game.log.unshift(`${controller} played ${card.name} from the top of the deck.`);
      did = true;
    }
  }

  // --------------------- Keyword grants: "Give a unit [Assault 3] this turn." ---------------------
  const bracketKw = text.match(/\[([^\]]+)\]/);
  if ((/\bgive\b/i.test(text) || /\bgains\b/i.test(text)) && bracketKw) {
    const kw = bracketKw[1].trim();
    if (kw) {
      const isTemp = /\bthis\s+turn\b/i.test(text) || /\bthis\s+combat\b/i.test(text);

      const targetsToApply: CardInstance[] = [];
      if (selectedUnits.length > 0) targetsToApply.push(...selectedUnits);
      else if (/\bme\b/i.test(text) || /\bthis\b/i.test(text)) {
        if (sourceUnit) targetsToApply.push(sourceUnit);
      }

      if (targetsToApply.length > 0) {
        for (const target of targetsToApply) {
          if (isTemp) target.tempKeywords = [...(target.tempKeywords || []), kw];
          else target.extraKeywords = [...(target.extraKeywords || []), kw];
        }
        if (targetsToApply.length === 1) {
          game.log.unshift(`${controller} granted [${kw}] ${isTemp ? "this turn" : ""} to ${targetsToApply[0].name}.`);
        } else {
          game.log.unshift(`${controller} granted [${kw}] ${isTemp ? "this turn" : ""} to ${targetsToApply.length} unit(s).`);
        }
        did = true;
      } else if (isUpTo) {
        // Valid: "up to" effects may choose 0 targets.
        did = true;
      }
    }
  }

  // --------------------- Move Enemy (Charm, Blitzcrank) ---------------------
  if (/\bmove\s+(?:an?\s+)?(?:enemy|opposing)\s+unit\b/i.test(text)) {
    const moveTarget = unitTarget;
    if (moveTarget && moveTarget.owner !== controller) {
      const fromLoc = locateUnit(game, moveTarget.owner, moveTarget.instanceId);
      let dest: { kind: "BASE" } | { kind: "BF"; index: number } | null = null;

      if (/\bto\s+here\b/i.test(text) && hereBf != null) {
        dest = { kind: "BF", index: hereBf };
      } else if (/\bto\s+(?:its\s+)?base\b/i.test(text)) {
        dest = { kind: "BASE" };
      } else if (hereBf != null) {
        dest = { kind: "BF", index: hereBf };
      }

      if (dest) {
        const removed = removeUnitFromWherever(game, moveTarget.owner, moveTarget.instanceId);
        if (removed) {
          removed.moveCountThisTurn += 1;
          addUnitToZone(game, moveTarget.owner, removed, dest);
          if (fromLoc) {
            const from = fromLoc.zone === "BASE" ? ({ kind: "BASE" } as const) : ({ kind: "BF", index: fromLoc.battlefieldIndex! } as const);
            checkMoveFromLocationTriggers(game, moveTarget.owner, [removed], from, dest);
          }
          game.log.unshift(`${controller} moved enemy ${moveTarget.name}.`);
          did = true;
        }
      }
    }
  }

  if (/\bmove\s+(?:up\s+to\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(?:friendly|your)?\s+units?\b/i.test(text)) {
    let moved = 0;
    const wantsBase = /\bto\s+(?:their\s+)?base\b/i.test(text);
    const wantsHere = /\bto\s+here\b/i.test(text) && hereBf != null;

    forEachSelectedUnit((u, t, loc) => {
      if (t.owner !== controller) return;
      const dest = wantsHere && hereBf != null ? { kind: "BF" as const, index: hereBf } : wantsBase ? { kind: "BASE" as const } : null;
      if (!dest) return;
      const from = loc.zone === "BASE" ? ({ kind: "BASE" } as const) : ({ kind: "BF", index: loc.battlefieldIndex! } as const);
      const removed = removeUnitFromWherever(game, t.owner, u.instanceId);
      if (!removed) return;
      removed.moveCountThisTurn += 1;
      addUnitToZone(game, t.owner, removed, dest);
      checkMoveFromLocationTriggers(game, t.owner, [removed], from, dest);
      moved += 1;
    });

    if (moved > 0) {
      game.log.unshift(`${controller} moved ${moved} friendly unit(s).`);
      did = true;
    } else if (isUpTo) {
      did = true;
    }
  }

  // --------------------- Stun / Ready ---------------------
  if (effectMentionsStun(text)) {
    const targetsToApply: CardInstance[] = [];

    if (selectedUnits.length > 0) {
      targetsToApply.push(...selectedUnits);
    } else if (/\bme\b/i.test(text)) {
      if (sourceUnit) targetsToApply.push(sourceUnit);
    } else {
      // Mass stun patterns (no explicit targets)
      const wantsAll = /\ball\b/i.test(text) || /\beach\b/i.test(text);
      if (wantsAll) {
        const wantHere = /\bhere\b/i.test(text) && hereBf != null;
        const isEnemy = /\benemy\b/i.test(text) || /\bopposing\b/i.test(text);
        const isFriendly = /\bfriendly\b/i.test(text) || /\byour\b/i.test(text);

        if (wantHere && hereBf != null) {
          if (isEnemy) targetsToApply.push(...game.battlefields[hereBf].units[opp]);
          else if (isFriendly) targetsToApply.push(...game.battlefields[hereBf].units[controller]);
          else {
            targetsToApply.push(...game.battlefields[hereBf].units.P1);
            targetsToApply.push(...game.battlefields[hereBf].units.P2);
          }
        } else {
          if (isEnemy) {
            targetsToApply.push(...game.players[opp].base.units);
            for (const bf of game.battlefields) targetsToApply.push(...bf.units[opp]);
          } else if (isFriendly) {
            targetsToApply.push(...p.base.units);
            for (const bf of game.battlefields) targetsToApply.push(...bf.units[controller]);
          }
        }
      }
    }

    if (targetsToApply.length > 0) {
      for (const target of targetsToApply) {
        target.stunned = true;
        target.isReady = false;
        target.stunnedUntilTurn = game.turnNumber + 1; // Stun lasts until end of NEXT turn
      }
      if (targetsToApply.length === 1) game.log.unshift(`${targetsToApply[0].name} was stunned.`);
      else game.log.unshift(`${controller} stunned ${targetsToApply.length} unit(s).`);
      did = true;
      const stunnedEnemy = targetsToApply.filter((u) => u.owner === opp).length;
      if (stunnedEnemy > 0) {
        queueTriggersForEvent(
            game,
            controller,
            (trig) => trig.includes("when you stun an enemy unit") || trig.includes("when you stun one or more enemy units"),
            (source) => source.ability?.effect_text
        );
      }
    } else if (isUpTo) {
      // Valid: "up to" effects may choose 0 targets.
      did = true;
    }
  }

  if (effectMentionsReady(text)) {
    const targetsToApply: CardInstance[] = [];
    const enemyReadyLock = game.battlefields.some((bf) =>
        bf.units[opp].some((u) => {
          const raw = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`.toLowerCase();
          return raw.includes("while i'm at a battlefield") && raw.includes("spells and abilities can't ready enemy units and gear");
        })
    );

    if (selectedUnits.length > 0) {
      targetsToApply.push(...selectedUnits);
    } else if (/\bme\b/i.test(text)) {
      if (sourceUnit) targetsToApply.push(sourceUnit);
    } else {
      const wantsAll = /\ball\b/i.test(text) || /\beach\b/i.test(text);
      if (wantsAll) {
        const wantHere = /\bhere\b/i.test(text) && hereBf != null;
        const isEnemy = /\benemy\b/i.test(text) || /\bopposing\b/i.test(text);
        const isFriendly = /\bfriendly\b/i.test(text) || /\byour\b/i.test(text);

        if (wantHere && hereBf != null) {
          if (isEnemy) targetsToApply.push(...game.battlefields[hereBf].units[opp]);
          else if (isFriendly) targetsToApply.push(...game.battlefields[hereBf].units[controller]);
          else {
            targetsToApply.push(...game.battlefields[hereBf].units.P1);
            targetsToApply.push(...game.battlefields[hereBf].units.P2);
          }
        } else {
          if (isEnemy) {
            targetsToApply.push(...game.players[opp].base.units);
            for (const bf of game.battlefields) targetsToApply.push(...bf.units[opp]);
          } else if (isFriendly) {
            targetsToApply.push(...p.base.units);
            for (const bf of game.battlefields) targetsToApply.push(...bf.units[controller]);
          }
        }
      }
    }

    if (targetsToApply.length > 0) {
      for (const target of targetsToApply) {
        if (enemyReadyLock && target.owner === opp) continue;
        target.isReady = true;
        target.stunned = false;
      }
      if (targetsToApply.length === 1) game.log.unshift(`${targetsToApply[0].name} was readied.`);
      else game.log.unshift(`${controller} readied ${targetsToApply.length} unit(s).`);
      did = true;
      const friendlyReadied = targetsToApply.filter((u) => u.owner === controller);
      if (friendlyReadied.length > 0) {
        for (const u of friendlyReadied) {
          queueTriggersForEvent(
              game,
              controller,
              (trig) => trig.includes("when you ready a friendly unit"),
              (source) => source.ability?.effect_text,
              [{ kind: "UNIT", owner: controller, instanceId: u.instanceId }],
              hereBf
          );
        }
      }
    } else if (/\bready me\b/i.test(text) && p.legend) {
      p.legendReady = true;
      game.log.unshift(`${controller} readied their legend.`);
      did = true;
    } else if (isUpTo) {
      did = true;
    }
  }

  if (/for each friendly unit, you may spend its buff to ready it/i.test(lower)) {
    const units = getUnitsInPlay(game, controller);
    let readied = 0;
    for (const u of units) {
      if (u.buffs > 0) {
        u.buffs -= 1;
        u.isReady = true;
        readied += 1;
      }
    }
    if (readied > 0) {
      game.log.unshift(`${controller} spent buffs to ready ${readied} unit(s).`);
      did = true;
    }
    for (const u of units) u.buffs += 1;
    game.log.unshift(`${controller} buffed all friendly units.`);
    did = true;
  }

  const readyRuneMatch = lower.match(/\bready\s+(\d+)\s+(?:friendly\s+)?runes?\b/);
  if (readyRuneMatch) {
    const n = parseInt(readyRuneMatch[1], 10);
    if (Number.isFinite(n) && n > 0) {
      const runes = p.runesInPlay.filter((r) => !r.isReady).slice(0, n);
      for (const r of runes) r.isReady = true;
      game.log.unshift(`${controller} readied ${runes.length} rune(s).`);
      did = true;
    }
  }


// --------------------- Might modifiers ---------------------
  // "Give a unit -1 might this turn, to a minimum of 1 might."
  const minM = (() => {
    const mm = lower.match(/\bminimum\s+of\s+(\d+)\s+might\b/);
    if (!mm) return null;
    const n = parseInt(mm[1], 10);
    return Number.isFinite(n) ? n : null;
  })();

  const giveMightThisTurn = lower.match(/\bgive\s+(?:a\s+)?(?:friendly\s+|enemy\s+|your\s+|opposing\s+)?(unit|units|me|it|this)\s+([+-])\s*(\d+)\s+might\s+this\s+turn\b/);
  if (giveMightThisTurn) {
    const who = giveMightThisTurn[1];
    const sign = giveMightThisTurn[2] === "-" ? -1 : 1;
    const n = parseInt(giveMightThisTurn[3], 10);
    const delta = sign * (Number.isFinite(n) ? n : 0);

    const applyTo = (u: CardInstance) => {
      const wantsOnlyUnitBonus = /additional \+1 might this turn if it is the only unit you control there/i.test(lower);
      if (/if there is a ready enemy unit here/i.test(lower)) {
        if (hereBf == null) return;
        const hasReadyEnemy = game.battlefields[hereBf].units[opp].some((x) => x.isReady);
        if (!hasReadyEnemy) return;
      }
      if (!wantsOnlyUnitBonus && /only unit you control there/i.test(lower)) {
        const loc = locateUnit(game, controller, u.instanceId);
        if (!loc || loc.zone !== "BF" || loc.battlefieldIndex == null) return;
        const countHere = game.battlefields[loc.battlefieldIndex].units[controller].length;
        if (countHere !== 1) return;
      }
      const cur = effectiveMight(u, { role: "NONE", game });
      const desired = minM != null ? Math.max(minM, cur + delta) : cur + delta;
      const actual = desired - cur;
      u.tempMightBonus += actual;
      game.log.unshift(`${u.name} gets ${actual >= 0 ? "+" : ""}${actual} might this turn.`);
      did = true;

      if (wantsOnlyUnitBonus) {
        const loc = locateUnit(game, controller, u.instanceId);
        const countHere =
            loc && loc.zone === "BF" && loc.battlefieldIndex != null
                ? game.battlefields[loc.battlefieldIndex].units[controller].length
                : 0;
        if (countHere === 1) {
          u.tempMightBonus += 1;
          game.log.unshift(`${u.name} gets +1 additional might (only unit there).`);
        }
      }
    };

    if (who === "me" || who === "this") {
      if (sourceUnit) applyTo(sourceUnit);
    } else if (who === "unit" || who === "it") {
      if (selectedUnits.length > 0) {
        for (const u of selectedUnits) applyTo(u);
      } else if (unitTarget) {
        applyTo(unitTarget);
      } else if (isUpTo) {
        // Valid: "up to" effects may choose 0 targets.
        did = true;
      }
    } else if (who === "units") {
      const looksNumberedUnits =
          /\b(?:up\s+to\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:friendly\s+|enemy\s+|opposing\s+)?units?\b/i.test(lower);

      // If we have explicit selected targets (multi-target), prefer those over mass inference.
      if (selectedUnits.length > 0 || looksNumberedUnits) {
        if (selectedUnits.length > 0) {
          for (const u of selectedUnits) applyTo(u);
        } else if (isUpTo) {
          did = true;
        }
      } else {
        // Mass might effects ("units")
        const units: CardInstance[] = [];
        const wantHere = /\bhere\b/.test(lower);
        const isEnemy = /\benemy\b/.test(lower) || /\bopposing\b/.test(lower);
        const isFriendly = /\bfriendly\b/.test(lower) || /\byour\b/.test(lower);

        if (isEnemy) {
          if (wantHere && hereBf != null) {
            units.push(...game.battlefields[hereBf].units[opp]);
          } else {
            units.push(...game.players[opp].base.units);
            for (const bf of game.battlefields) units.push(...bf.units[opp]);
          }
        } else if (isFriendly) {
          if (wantHere && hereBf != null) {
            units.push(...game.battlefields[hereBf].units[controller]);
          } else {
            units.push(...p.base.units);
            for (const bf of game.battlefields) units.push(...bf.units[controller]);
          }
        } else {
          // If neither friendly nor enemy is specified, treat "units here" as ALL units at that battlefield.
          if (wantHere && hereBf != null) {
            units.push(...game.battlefields[hereBf].units.P1);
            units.push(...game.battlefields[hereBf].units.P2);
          } else {
            // Ambiguous global "units" (no qualifier) — do nothing rather than guess.
          }
        }

        for (const u of units) applyTo(u);
      }
    }
  }

  // --------------------- Buff (permanent +1 might) ---------------------
  if (effectMentionsBuff(text)) {
    const targetsToApply: CardInstance[] = [];

    if (selectedUnits.length > 0) targetsToApply.push(...selectedUnits);
    else if (/\bme\b/i.test(text) || /\bthis\b/i.test(text)) {
      if (sourceUnit) targetsToApply.push(sourceUnit);
    } else if (unitTarget) {
      targetsToApply.push(unitTarget);
    }

    const poroGate = lower.includes("if you control a poro") ? hasPoro : true;
    if (targetsToApply.length > 0 && poroGate) {
      for (const u of targetsToApply) u.buffs += 1;
      if (targetsToApply.length === 1) game.log.unshift(`${targetsToApply[0].name} got +1 might permanently (buff).`);
      else game.log.unshift(`${controller} buffed ${targetsToApply.length} unit(s) (+1 might permanently).`);
      did = true;
      const friendlyBuffed = targetsToApply.filter((u) => u.owner === controller);
      if (friendlyBuffed.length > 0) {
        for (const u of friendlyBuffed) {
          queueTriggersForEvent(
              game,
              controller,
              (trig) => trig.includes("when you buff a friendly unit"),
              (source) => source.ability?.effect_text,
              [{ kind: "UNIT", owner: controller, instanceId: u.instanceId }],
              hereBf
          );
        }
      }
    } else if (isUpTo) {
      did = true;
    }

    if (/buff all other friendly units there/i.test(lower) && sourceUnit) {
      const loc = locateUnit(game, controller, sourceUnit.instanceId);
      if (loc && loc.zone === "BF" && loc.battlefieldIndex != null) {
        const units = game.battlefields[loc.battlefieldIndex].units[controller].filter((u) => u.instanceId !== sourceUnit.instanceId);
        for (const u of units) u.buffs += 1;
        if (units.length > 0) {
          game.log.unshift(`${controller} buffed ${units.length} other friendly unit(s) there.`);
          did = true;
        }
      }
    }
  }

  // --------------------- Copy/Set Might (Convergent Mutation) ---------------------
  if (/its might becomes the might of that friendly unit this turn/i.test(lower)) {
    const targetUnit = selectedUnits.length > 0 ? selectedUnits[0] : unitTarget;
    if (targetUnit) {
      const friendlies = getUnitsInPlay(game, controller).filter((u) => u.instanceId !== targetUnit.instanceId);
      const targetBase = effectiveMight(targetUnit, { role: "NONE", game });
      const best = friendlies.reduce((m, u) => Math.max(m, effectiveMight(u, { role: "NONE", game })), 0);
      if (best > targetBase) {
        targetUnit.tempMightBonus += best - targetBase;
        game.log.unshift(`${targetUnit.name}'s Might became ${best} this turn.`);
      } else {
        game.log.unshift(`${targetUnit.name} had no higher friendly Might to copy.`);
      }
      did = true;
    }
  }


// --------------------- Return / Kill / Banish ---------------------
  if (effectMentionsReturn(text)) {
    let moved = 0;

    forEachSelectedUnit((u, t, loc) => {
      if (loc.zone !== "BF") return; // Return effects in this emulator assume "return ... to base" from a battlefield.
      const removed = removeUnitFromWherever(game, t.owner, u.instanceId);
      if (!removed) return;
      removed.isReady = false;
      game.players[t.owner].base.units.push(removed);
      moved += 1;
    });

    if (moved > 0) {
      if (moved === 1 && selectedUnits.length === 1) game.log.unshift(`${selectedUnits[0].name} returned to Base.`);
      else game.log.unshift(`${controller} returned ${moved} unit(s) to Base.`);
      did = true;
    } else if (isUpTo) {
      // Valid: "up to" effects may choose 0 targets (or no battlefield target existed).
      did = true;
    }
  }

  if (/\bnext time it dies this turn\b/i.test(text)) {
    const payDom = (() => {
      const m = lower.match(/\bpay\s+1\s+([a-z]+)\s+rune\b/);
      return m ? clampDomain(m[1]) : null;
    })();
    const payAny = /\bpay\s+1\s+rune\s+of\s+any\s+type\b/i.test(text);
    forEachSelectedUnit((u, t) => {
      if (t.owner !== controller) return;
      u.deathReplacement = {
        untilTurn: game.turnNumber,
        recallExhausted: true,
        payRuneDomain: payDom ?? undefined,
        payRuneAny: payAny,
        optional: /\byou may\b/i.test(text),
      };
    });
    if (selectedUnits.length > 0) {
      game.log.unshift(`${controller} set a death replacement effect (${selectedUnits.length} unit(s)).`);
      did = true;
    }
  }

  if (effectMentionsKill(text)) {
    let killedMarked = 0;

    if (selectedUnits.length > 0) {
      for (const u of selectedUnits) {
        u.damage = 999;
        killedMarked += 1;
      }
    } else if (unitTarget) {
      unitTarget.damage = 999;
      killedMarked += 1;
    }

    if (killedMarked > 0) {
      cleanupStateBased(game);
      if (killedMarked === 1 && unitTarget) game.log.unshift(`${unitTarget.name} was killed.`);
      else game.log.unshift(`${controller} killed ${killedMarked} unit(s).`);
      did = true;
      if (ctx.sourceCardType === "Spell") {
        queueTriggersForEvent(
            game,
            controller,
            (trig) => trig.includes("when you kill a unit with a spell"),
            (source) => source.ability?.effect_text,
            [{ kind: "NONE" }],
            undefined,
            true
        );
      }
      if ((unitTarget?.stunned || selectedUnits.some((u) => u.stunned)) && (unitTarget || selectedUnits.length > 0)) {
        queueTriggersForEvent(
            game,
            controller,
            (trig) => trig.includes("when you kill a stunned enemy unit"),
            (source) => source.ability?.effect_text
        );
      }
    } else if (isUpTo) {
      did = true;
    }
  }

  if (effectMentionsBanish(text)) {
    let banished = 0;

    forEachSelectedUnit((u, t) => {
      const removed = removeUnitFromWherever(game, t.owner, u.instanceId);
      if (!removed) return;
      game.players[t.owner].banishment.push(removed);
      banished += 1;
    });

    if (banished > 0) {
      if (banished === 1 && selectedUnits.length === 1) game.log.unshift(`${selectedUnits[0].name} was banished.`);
      else game.log.unshift(`${controller} banished ${banished} unit(s).`);
      did = true;
    } else if (isUpTo) {
      did = true;
    }
  }

  // --------------------- Turn-scoped damage hooks ---------------------
  if (/\bwhen any unit takes damage this turn, kill it\b/i.test(text)) {
    game.damageKillEffects.push({ controller, untilTurn: game.turnNumber });
    game.log.unshift(`${controller} set a damage-kill effect for this turn.`);
    did = true;
  }

  if (/\bkill it the next time it takes damage this turn\b/i.test(text)) {
    forEachSelectedUnit((u) => {
      u.killOnDamageUntilTurn = game.turnNumber;
    });
    if (selectedUnits.length > 0) {
      game.log.unshift(`${controller} set a kill-on-damage effect for ${selectedUnits.length} unit(s).`);
      did = true;
    }
  }


// --------------------- Damage ---------------------
  const conditionalDrawOnKill = (() => {
    const m = lower.match(/\bif\s+this\s+kills\s+it,\s*draw\s+(\d+)\b/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  })();

  const damageFromDiscard =
      /\bdeal\s+its\s+energy\s+cost\s+as\s+damage\b/i.test(text) && discarded.length > 0 ? discarded[0].cost : null;

  const dmg = damageFromDiscard != null ? damageFromDiscard : extractDamageAmount(text);

  if (dmg != null && dmg > 0) {
    // --------------------- Damage ---------------------
    // Support: single-target, multi-target, and common AoE patterns (including enemy-only).
    const dmgTargetsSnapshot: { owner: PlayerId; instanceId: string; name: string; existed: boolean; wasStunned: boolean }[] = [];
    const applyDamageToUnit = (u: CardInstance) => {
      if (unitIgnoresDamageThisTurn(u)) {
        game.log.unshift(`${u.name} ignored damage (moved twice this turn).`);
        return;
      }
      u.damage += dmg;
      if (u.killOnDamageUntilTurn && u.killOnDamageUntilTurn >= game.turnNumber) {
        u.damage = 999;
        u.killOnDamageUntilTurn = 0;
      } else if (damageKillEffectActive(game)) {
        u.damage = 999;
      }
    };

    // Helper to mark "before" existence for conditional kill checks.
    const recordBefore = (owner: PlayerId, unit: CardInstance) => {
      const existed = !!locateUnit(game, owner, unit.instanceId)?.unit;
      dmgTargetsSnapshot.push({ owner, instanceId: unit.instanceId, name: unit.name, existed, wasStunned: unit.stunned });
    };

    // 1) Explicit AoE patterns
    if (/\ball\s+units\s+at\s+battlefields\b/i.test(text)) {
      for (const bf of game.battlefields) {
        for (const pid of ["P1", "P2"] as PlayerId[]) {
          for (const u of bf.units[pid]) applyDamageToUnit(u);
        }
      }
      game.log.unshift(`${controller} dealt ${dmg} to all units at battlefields.`);
      did = true;
    } else if (
        (/\ball\s+enemy\s+units\s+at\s+battlefields\b/i.test(text) ||
            /\beach\s+enemy\s+unit\s+at\s+battlefields\b/i.test(text) ||
            /\ball\s+enemy\s+creatures\s+at\s+battlefields\b/i.test(text) ||
            /\beach\s+enemy\s+creature\s+at\s+battlefields\b/i.test(text))
    ) {
      for (const bf of game.battlefields) for (const u of bf.units[opp]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all enemy units at battlefields.`);
      did = true;
    } else if (
        (/\ball\s+enemy\s+units\s+at\s+a\s+battlefield\b/i.test(text) ||
            /\beach\s+enemy\s+unit\s+at\s+a\s+battlefield\b/i.test(text)) &&
        (bfTargetIndex != null || hereBf != null)
    ) {
      const idx = bfTargetIndex != null ? bfTargetIndex : hereBf!;
      const bf = game.battlefields[idx];
      for (const u of bf.units[opp]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all enemy units at Battlefield ${idx + 1}.`);
      did = true;
    } else if (
        (/\ball\s+enemy\s+units\s+at\s+a\s+battlefield\b/i.test(text) ||
            /\beach\s+enemy\s+unit\s+at\s+a\s+battlefield\b/i.test(text)) &&
        (bfTargetIndex != null || hereBf != null)
    ) {
      const idx = bfTargetIndex != null ? bfTargetIndex : hereBf!;
      const bf = game.battlefields[idx];
      for (const u of bf.units[opp]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all enemy units at Battlefield ${idx + 1}.`);
      did = true;
    } else if (
        (/\ball\s+friendly\s+units\s+at\s+battlefields\b/i.test(text) ||
            /\beach\s+friendly\s+unit\s+at\s+battlefields\b/i.test(text))
    ) {
      for (const bf of game.battlefields) for (const u of bf.units[controller]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all friendly units at battlefields.`);
      did = true;
    } else if (/\ball\s+units\s+here\b/i.test(text) && hereBf != null) {
      const bf = game.battlefields[hereBf];
      for (const pid of ["P1", "P2"] as PlayerId[]) for (const u of bf.units[pid]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all units here (Battlefield ${hereBf + 1}).`);
      did = true;
    } else if (
        (/(?:\ball\s+enemy\s+units\s+here\b|\beach\s+enemy\s+unit\s+here\b)/i.test(text) ||
            /\ball\s+enemy\s+creatures\s+here\b/i.test(text) ||
            /\beach\s+enemy\s+creature\s+here\b/i.test(text)) &&
        hereBf != null
    ) {
      const bf = game.battlefields[hereBf];
      for (const u of bf.units[opp]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all enemy units here (Battlefield ${hereBf + 1}).`);
      did = true;
    } else if (
        (/(?:\ball\s+friendly\s+units\s+here\b|\beach\s+friendly\s+unit\s+here\b)/i.test(text)) &&
        hereBf != null
    ) {
      const bf = game.battlefields[hereBf];
      for (const u of bf.units[controller]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all friendly units here (Battlefield ${hereBf + 1}).`);
      did = true;
    } else if (
        (/\ball\s+enemy\s+units\b/i.test(text) || /\beach\s+enemy\s+unit\b/i.test(text) || /\ball\s+enemy\s+creatures\b/i.test(text)) &&
        !/\bat\s+battlefields\b/i.test(text) &&
        !/\bhere\b/i.test(text)
    ) {
      // Enemy-only global (base + battlefields)
      for (const u of game.players[opp].base.units) applyDamageToUnit(u);
      for (const bf of game.battlefields) for (const u of bf.units[opp]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all enemy units.`);
      did = true;
    } else if (selectedUnits.length > 0) {
      // 2) Multi-target or single-target via explicit targets
      for (const x of selectedUnitLocs) recordBefore(x.t.owner, x.loc.unit);
      forEachSelectedUnit((u) => {
        applyDamageToUnit(u);
      });

      if (selectedUnits.length === 1) game.log.unshift(`${controller} dealt ${dmg} to ${selectedUnits[0].name}.`);
      else game.log.unshift(`${controller} dealt ${dmg} to ${selectedUnits.length} unit(s).`);
      did = true;
    } else if (unitTarget) {
      // 3) Fallback: single target
      const targetOwner = firstTarget.kind === "UNIT" ? firstTarget.owner : opp;
      recordBefore(targetOwner, unitTarget);
      applyDamageToUnit(unitTarget);
      game.log.unshift(`${controller} dealt ${dmg} to ${unitTarget.name}.`);
      did = true;
    } else if (isUpTo && /\bunit\b/i.test(text)) {
      // Valid: "up to" effects may choose 0 targets.
      did = true;
    }

    // Conditional draw on kill (after damage is marked, before this effect is considered fully resolved)
    if (did && conditionalDrawOnKill && dmgTargetsSnapshot.length > 0) {
      cleanupStateBased(game);
      let killedCount = 0;
      let killedStunnedCount = 0;
      for (const snap of dmgTargetsSnapshot) {
        if (!snap.existed) continue;
        const after = !!locateUnit(game, snap.owner, snap.instanceId)?.unit;
        if (!after) {
          killedCount += 1;
          if (snap.wasStunned) killedStunnedCount += 1;
        }
      }
      if (killedCount > 0) {
        drawCards(game, controller, conditionalDrawOnKill * killedCount);
        game.log.unshift(`${controller} drew ${conditionalDrawOnKill * killedCount} (killed by effect).`);
      }
      if (killedCount > 0 && ctx.sourceCardType === "Spell") {
        queueTriggersForEvent(
            game,
            controller,
            (trig) => trig.includes("when you kill a unit with a spell"),
            (source) => source.ability?.effect_text,
            [{ kind: "NONE" }],
            undefined,
            true
        );
      }
      if (killedStunnedCount > 0) {
        queueTriggersForEvent(
            game,
            controller,
            (trig) => trig.includes("when you kill a stunned enemy unit"),
            (source) => source.ability?.effect_text
        );
      }
    }
  }

  if (!did) {
    if (/\bscore\s+1\s+point\b/i.test(lower)) {
      const excessMatch = /excess damage/i.test(lower);
      const excess = game.lastCombatExcessDamageTurn === game.turnNumber ? game.lastCombatExcessDamage[controller] || 0 : 0;
      if (!excessMatch || excess >= 5) {
        game.players[controller].points += 1;
        game.log.unshift(`${controller} scored 1 point.`);
        if (game.players[controller].points >= game.victoryScore) {
          game.step = "GAME_OVER";
          game.log.unshift(`${controller} wins! Reached ${game.players[controller].points} points.`);
        }
      } else {
        game.log.unshift(`${controller} did not score (insufficient excess damage).`);
      }
      did = true;
    }
    if (/\byou win the game\b/i.test(lower)) {
      const needsSevenHere = /if you have 7\+ units here/i.test(lower);
      const meetsSeven = !needsSevenHere || (hereBf != null && game.battlefields[hereBf].units[controller].length >= 7);
      if (meetsSeven) {
        game.players[controller].points = game.victoryScore;
        game.step = "GAME_OVER";
        game.log.unshift(`${controller} wins the game.`);
        return true;
      }
    }
    // Surface unsupported effects to help implementation/debugging.
    const src = ctx?.sourceCardName ? ` from ${ctx.sourceCardName}` : "";
    game.log.unshift(`UNSUPPORTED effect${src}: ${text}`);
  }

  return did;
};


const assignCombatDamageAuto = (game: GameState, battlefieldIndex: number, attacker: PlayerId, defender: PlayerId) => {
  const bf = game.battlefields[battlefieldIndex];

  const attackerUnits = bf.units[attacker].filter((u) => !u.stunned);
  const defenderUnits = bf.units[defender].filter((u) => !u.stunned);

  const attackerAlone = attackerUnits.length === 1;
  const defenderAlone = defenderUnits.length === 1;
  const attackerDamage = attackerUnits.reduce(
      (s, u) => s + effectiveMight(u, { role: "ATTACKER", alone: attackerAlone, game, battlefieldIndex }),
      0
  );
  const defenderDamage = defenderUnits.reduce(
      (s, u) => s + effectiveMight(u, { role: "DEFENDER", alone: defenderAlone, game, battlefieldIndex }),
      0
  );

  const applyDamageToSide = (damage: number, units: CardInstance[], role: "ATTACKER" | "DEFENDER", alone: boolean) => {
    if (damage <= 0) return;

    // Tank rule (simplified): must assign to Tanks first when possible.
    const tanks = units.filter((u) => hasKeyword(u, "Tank"));
    const rest = units.filter((u) => !hasKeyword(u, "Tank"));
    const order = tanks.length > 0 ? [...tanks, ...rest] : [...units];

    let remaining = damage;
    let excess = 0;
    for (const u of order) {
      if (remaining <= 0) break;
      if (unitIgnoresDamageThisTurn(u)) {
        game.log.unshift(`${u.name} ignored combat damage (moved twice this turn).`);
        continue;
      }
      const lethal = effectiveMight(u, { role, alone, game, battlefieldIndex });
      const need = Math.max(0, lethal - u.damage);
      if (need <= 0) continue;
      const assign = Math.min(need, remaining);
      u.damage += assign;
      remaining -= assign;
    }

    // If still remaining, spill onto the last unit (rules allow “over-assign”; simplified).
    if (remaining > 0 && order.length > 0) {
      order[order.length - 1].damage += remaining;
      excess += remaining;
    }

    if (damageKillEffectActive(game)) {
      for (const u of order) {
        if (u.damage > 0) u.damage = 999;
      }
    } else {
      for (const u of order) {
        if (u.killOnDamageUntilTurn && u.killOnDamageUntilTurn >= game.turnNumber && u.damage > 0) {
          u.damage = 999;
          u.killOnDamageUntilTurn = 0;
        }
      }
    }
    return excess;
  };

  const attackerExcess = applyDamageToSide(attackerDamage, bf.units[defender], "DEFENDER", defenderAlone) || 0;
  const defenderExcess = applyDamageToSide(defenderDamage, bf.units[attacker], "ATTACKER", attackerAlone) || 0;

  game.lastCombatExcessDamage = {
    [attacker]: attackerExcess,
    [defender]: defenderExcess,
  } as Record<PlayerId, number>;
  game.lastCombatExcessDamageTurn = game.turnNumber;

  game.log.unshift(
      `Combat damage assigned at Battlefield ${battlefieldIndex + 1}: ${attacker} dealt ${attackerDamage}, ${defender} dealt ${defenderDamage}.`
  );
};



const healUnitsEndOfCombat = (game: GameState, battlefieldIndex: number) => {
  // Units heal at end of combat (damage removed).
  const bf = game.battlefields[battlefieldIndex];
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    for (const u of bf.units[pid]) u.damage = 0;
  }
  game.log.unshift(`Units healed at end of combat (Battlefield ${battlefieldIndex + 1}).`);
};

const recallUnitsToBaseExhausted = (game: GameState, battlefieldIndex: number, player: PlayerId) => {
  const bf = game.battlefields[battlefieldIndex];
  const p = game.players[player];
  const recalled = bf.units[player].splice(0, bf.units[player].length);
  for (const u of recalled) {
    u.isReady = false;
    u.damage = 0;
    p.base.units.push(u);
  }
  if (recalled.length > 0) game.log.unshift(`${player} recalled ${recalled.length} unit(s) to base exhausted (Battlefield ${battlefieldIndex + 1}).`);
};

const resolveCombatResolution = (game: GameState) => {
  if (!game.combat) return;
  const { battlefieldIndex, attacker, defender } = game.combat;
  const bf = game.battlefields[battlefieldIndex];

  // Kill lethal (SBAs) before healing (simplified sequence).
  cleanupStateBased(game);

  // Determine survivors
  const aHas = bf.units[attacker].length > 0;
  const dHas = bf.units[defender].length > 0;

  if (aHas && dHas) {
    const tieRecallAll = getUnitsInPlay(game, attacker).some((u) => {
      const trig = (u.ability?.trigger || "").toLowerCase();
      const raw = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`.toLowerCase();
      return trig.includes("if a combat where you are the attacker ends in a tie") && raw.includes("recall all units instead");
    });
    if (tieRecallAll) {
      recallUnitsToBaseExhausted(game, battlefieldIndex, attacker);
      recallUnitsToBaseExhausted(game, battlefieldIndex, defender);
      game.log.unshift(`Combat tie: recalled all units due to tie-recall effect.`);
    } else {
      // Tie / both survived -> attacker recalled, defender retains control (FAQ)
      recallUnitsToBaseExhausted(game, battlefieldIndex, attacker);
    }
    // control remains as-is (defender maintains)
    bf.contestedBy = null;
    game.log.unshift(`Combat ended with both sides surviving. Attacker recalled; defender retains/keeps control.`);
    healUnitsEndOfCombat(game, battlefieldIndex);
    cleanupStateBased(game);
  } else if (aHas && !dHas) {
    // Attacker wins -> conquer
    const prev = bf.controller;
    bf.controller = attacker;
    bf.contestedBy = null;
    game.log.unshift(`${attacker} conquered Battlefield ${battlefieldIndex + 1}.`);
    healUnitsEndOfCombat(game, battlefieldIndex);
    cleanupStateBased(game);

    // Conquer scoring
    if (prev !== attacker) attemptScore(game, attacker, battlefieldIndex, "Conquer");
  } else if (!aHas && dHas) {
    // Defender wins (or attacker wiped) -> defender keeps/gets control
    const prev = bf.controller;
    bf.controller = defender;
    bf.contestedBy = null;
    game.log.unshift(`${defender} defended Battlefield ${battlefieldIndex + 1}.`);
    healUnitsEndOfCombat(game, battlefieldIndex);
    cleanupStateBased(game);

    if (prev !== defender) attemptScore(game, defender, battlefieldIndex, "Conquer");

    const trig = (bf.card.ability?.trigger || "").toLowerCase();
    if (trig.includes("when you defend here") && bf.card.ability?.effect_text) {
      const req = inferTargetRequirement(bf.card.ability.effect_text, { here: true });
      game.chain.push({
        id: makeId("chain"),
        controller: defender,
        kind: "TRIGGERED_ABILITY",
        label: `Battlefield Trigger: ${bf.card.name} (Defend)`,
        effectText: bf.card.ability.effect_text,
        contextBattlefieldIndex: battlefieldIndex,
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
        restrictTargetsToBattlefieldIndex: battlefieldIndex,
        targets: [{ kind: "NONE" }],
      });
      game.state = "CLOSED";
      game.priorityPlayer = defender;
      game.passesInRow = 0;
    }
  } else {
    // Nobody left
    bf.controller = null;
    bf.contestedBy = null;
    game.log.unshift(`Battlefield ${battlefieldIndex + 1} ended empty after combat.`);
    healUnitsEndOfCombat(game, battlefieldIndex);
    cleanupStateBased(game);
  }

  // close combat window
  game.windowKind = "NONE";
  game.windowBattlefieldIndex = null;
  game.combat = null;
  game.priorityPlayer = game.turnPlayer;
  game.state = "OPEN";
  game.passesInRow = 0;

  maybeOpenNextWindow(game);
};

// ----------------------------- Setup builders -----------------------------

const instantiateCard = (card: CardData, owner: PlayerId, turn: number): CardInstance => ({
  ...card,
  instanceId: makeId("card"),
  owner,
  controller: owner,
  isReady: false,
  damage: 0,
  buffs: 0,
  tempMightBonus: 0,
  stunned: false,
  stunnedUntilTurn: 0,
  extraKeywords: [],
  tempKeywords: [],
  conditionalKeywords: [],
  createdTurn: turn,
  moveCountThisTurn: 0,
  killOnDamageUntilTurn: 0,
});

function createTokenCard(name: string, might: number, tokenType?: string): CardData {
  const slug = (tokenType || name || "token")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  return {
    id: `token_${slug || "token"}_${might}`,
    name,
    rarity: "Token",
    domain: "Colorless",
    cost: 0,
    type: "Unit",
    tags: ["Token", ...(tokenType ? [tokenType] : [])],
    image_url: "",
    image: "",
    stats: { might, power: null },
    ability: { raw_text: `${name}.`, keywords: [] },
  };
}

const createRuneInstance = (runeCard: CardData, owner: PlayerId, turn: number): RuneInstance => {
  const domRaw = (parseDomains(runeCard.domain)[0] || runeCard.domain || "Colorless").trim();
  const dom = clampDomain(domRaw);
  return {
    instanceId: makeId("rune"),
    owner,
    controller: owner,
    domain: dom,
    isReady: true,
    createdTurn: turn,

    cardId: runeCard.id,
    name: runeCard.name,
    image_url: (runeCard as any).image_url,
    image: (runeCard as any).image,
  };
};

const autoBuildPlayer = (allCards: CardData[], playerId: PlayerId, turn: number): { legend: CardData; champion: CardInstance; domains: Domain[]; mainDeck: CardInstance[]; runeDeck: RuneInstance[]; } => {
  const legends = allCards.filter((c) => c.type === "Legend");
  const battlefields = allCards.filter((c) => c.type === "Battlefield");
  const runes = allCards.filter((c) => c.type === "Rune");

  if (legends.length === 0) throw new Error("No Legend cards found.");
  if (battlefields.length === 0) throw new Error("No Battlefield cards found.");
  if (runes.length === 0) throw new Error("No Rune cards found.");

  const legend = legends[Math.floor(Math.random() * legends.length)];
  const domains = parseDomains(legend.domain).map(clampDomain).filter((d): d is Exclude<Domain, "Colorless"> => d !== "Colorless");
  const champTag = (legend.tags || [])[0];

  const candidateChampions = allCards.filter(
      (c) => c.type === "Unit" && champTag && (c.tags || []).includes(champTag)
  );
  const champData = candidateChampions.length > 0 ? candidateChampions[Math.floor(Math.random() * candidateChampions.length)] : allCards.find((c) => c.type === "Unit")!;
  const champion = instantiateCard(champData, playerId, turn);

  // Main deck pool: units/spells/gear that are within domain identity OR Colorless.
  const pool = allCards.filter(
      (c) =>
          isMainDeckType(c.type) &&
          (c.domain === "Colorless" ||
              parseDomains(c.domain).every((d) => {
                const dom = clampDomain(d);
                return dom === "Colorless" || domains.includes(dom);
              }))
  );
  const poolNonEmpty = pool.length > 0 ? pool : allCards.filter((c) => isMainDeckType(c.type));

  // Basic duplicate cap
  const maxCopies = 3;
  const counts: Record<string, number> = {};
  const chosen: CardInstance[] = [];
  while (chosen.length < 40 && poolNonEmpty.length > 0) {
    const pick = poolNonEmpty[Math.floor(Math.random() * poolNonEmpty.length)];
    const n = counts[pick.id] || 0;
    if (n >= maxCopies) continue;
    counts[pick.id] = n + 1;
    chosen.push(instantiateCard(pick, playerId, turn));
  }
  const mainDeck = shuffle(chosen, turn + (playerId === "P1" ? 1 : 2));

  // Rune deck (12): distribute across domains of identity (or all runes if identity empty).
  const idDomains = domains.length > 0 ? domains : (DEFAULT_DOMAINS as Domain[]);

  // Choose a specific rune card art for each domain (for visuals).
  const runeByDomain: Partial<Record<Domain, CardData>> = {};
  for (const rc of runes) {
    const domRaw = (parseDomains(rc.domain)[0] || rc.domain || "Colorless").trim();
    const dom = clampDomain(domRaw);
    if (!runeByDomain[dom]) runeByDomain[dom] = rc;
  }

  const per = Math.floor(12 / idDomains.length);
  const remainder = 12 % idDomains.length;
  const runeDeck: RuneInstance[] = [];
  for (let i = 0; i < idDomains.length; i++) {
    const dom = idDomains[i];
    const count = per + (i < remainder ? 1 : 0);
    const runeCard = runeByDomain[dom] || runeByDomain["Colorless"] || runes[0];
    for (let j = 0; j < count; j++) runeDeck.push(createRuneInstance(runeCard, playerId, turn));
  }
  const runeDeckShuffled = shuffle(runeDeck, turn + 99);

  return { legend, champion, domains: idDomains, mainDeck, runeDeck: runeDeckShuffled };
};

const autoBuildBattlefields = (allCards: CardData[]): { p1: CardData; p2: CardData } => {
  const b = allCards.filter((c) => c.type === "Battlefield");
  if (b.length < 2) throw new Error("Need at least 2 Battlefields.");
  const shuffled = shuffle(b, 12345);
  return { p1: shuffled[0], p2: shuffled[1] };
};

type DeckCardId = string;

interface DeckSpec {
  legendId: DeckCardId | null;
  championId: DeckCardId | null;
  battlefields: DeckCardId[]; // choose 3; a random 1 is used in-duel
  runes: Record<DeckCardId, number>; // exactly 12 total
  main: Record<DeckCardId, number>; // >= 40 total, max 3 per card (including chosen champion)
}

// ----------------------------- Deck Library + AI Config -----------------------------

export type AiDifficulty = "EASY" | "MEDIUM" | "HARD" | "VERY_HARD";

export interface AiConfig {
  enabled: boolean;
  difficulty: AiDifficulty;
  thinkMs: number;
}

export interface DeckLibraryEntry {
  id: string;
  name: string;
  tags?: string[];
  spec: DeckSpec;
  createdAt: number;
  updatedAt: number;
}

const emptyDeckSpec = (): DeckSpec => ({
  legendId: null,
  championId: null,
  battlefields: [],
  runes: {},
  main: {},
});

const countTotal = (counts: Record<string, number>): number =>
    Object.values(counts).reduce((a, b) => a + (Number.isFinite(b) ? (b as number) : 0), 0);

const getCardById = (allCards: CardData[], id: string): CardData | null => allCards.find((c) => c.id === id) || null;

const defaultDeckNameFromSpec = (allCards: CardData[], s: DeckSpec): string => {
  const lg = s.legendId ? getCardById(allCards, s.legendId) : null;
  const champ = s.championId ? getCardById(allCards, s.championId) : null;
  const lgName = lg?.name ? lg.name.replace(/\s*\(.*\)\s*$/g, "").trim() : "Legend";
  const champName = champ?.name ? champ.name.replace(/\s*\(.*\)\s*$/g, "").trim() : "Champion";
  return `${lgName} — ${champName}`;
};


const domainIdentityFromLegend = (legend: CardData): Domain[] => {
  const doms = parseDomains(legend.domain)
      .map(clampDomain)
      .filter((d) => d !== "Colorless") as Domain[];
  return doms.length > 0 ? doms : (DEFAULT_DOMAINS as Domain[]);
};

const cardWithinIdentity = (card: CardData, identity: Domain[]): boolean => {
  const doms = parseDomains(card.domain).map(clampDomain);
  if (doms.length === 0) return true;
  return doms.every((d) => d === "Colorless" || identity.includes(d));
};

const isLikelyChampionUnit = (card: CardData, champTag: string | null): boolean => {
  if (card.type !== "Unit") return false;
  if (!champTag) return false;
  const tags = card.tags || [];
  return tags.includes(champTag) && (card.name || "").includes(",");
};

const pickOne = <T,>(arr: T[], seedTurn: number): T => {
  // deterministic-ish pick that still varies per game by turnNumber seed
  const idx = Math.abs(Math.floor(Math.sin(seedTurn * 9973) * 1000000)) % arr.length;
  return arr[idx];
};

const buildPlayerFromDeckSpec = (
    allCards: CardData[],
    playerId: PlayerId,
    spec: DeckSpec,
    turn: number
): { legend: CardData; champion: CardInstance; domains: Domain[]; mainDeck: CardInstance[]; runeDeck: RuneInstance[]; battlefields: CardData[] } => {
  const legend = spec.legendId ? getCardById(allCards, spec.legendId) : null;
  if (!legend || legend.type !== "Legend") throw new Error(`${playerId}: Select a Legend.`);
  const identity = domainIdentityFromLegend(legend);
  const champTag = (legend.tags || [])[0] || null;

  const champCard = spec.championId ? getCardById(allCards, spec.championId) : null;
  if (!champCard || champCard.type !== "Unit") throw new Error(`${playerId}: Select a chosen Champion (Unit).`);
  if (champTag && !(champCard.tags || []).includes(champTag))
    throw new Error(`${playerId}: Chosen Champion must match Legend tag (${champTag}).`);
  if (!cardWithinIdentity(champCard, identity)) throw new Error(`${playerId}: Chosen Champion is outside the Legend's domain identity.`);

  const champion = instantiateCard(champCard, playerId, turn);

  // Main deck
  const mainCounts = { ...(spec.main || {}) };
  const totalMain = countTotal(mainCounts);

  if ((mainCounts[champCard.id] || 0) < 1) throw new Error(`${playerId}: Main deck must include at least 1 copy of the chosen Champion.`);
  if (totalMain < 40) throw new Error(`${playerId}: Main deck must have at least 40 cards (currently ${totalMain}).`);

  for (const [id, nRaw] of Object.entries(mainCounts)) {
    const n = Math.floor(nRaw || 0);
    if (n < 0) throw new Error(`${playerId}: Negative card count for ${id}.`);
    if (n > 3) throw new Error(`${playerId}: Max 3 copies per card (exceeded on ${id}).`);
  }

  const mainDeck: CardInstance[] = [];
  for (const [id, nRaw] of Object.entries(mainCounts)) {
    const n = Math.floor(nRaw || 0);
    if (n <= 0) continue;
    const cd = getCardById(allCards, id);
    if (!cd) throw new Error(`${playerId}: Unknown card id in main deck: ${id}`);
    if (!isMainDeckType(cd.type)) throw new Error(`${playerId}: ${cd.name} is not a main-deck card.`);
    if (!cardWithinIdentity(cd, identity)) throw new Error(`${playerId}: ${cd.name} is outside the Legend's domain identity.`);

    const copiesToDeck = cd.id === champCard.id ? Math.max(0, n - 1) : n;
    for (let i = 0; i < copiesToDeck; i++) mainDeck.push(instantiateCard(cd, playerId, turn));
  }

  const mainDeckShuffled = shuffle(mainDeck, turn + (playerId === "P1" ? 11 : 22));

  // Rune deck (exactly 12 total)
  const runeCounts = { ...(spec.runes || {}) };
  const runeTotal = countTotal(runeCounts);
  if (runeTotal !== 12) throw new Error(`${playerId}: Rune deck must have exactly 12 cards (currently ${runeTotal}).`);

  const runeDeck: RuneInstance[] = [];
  for (const [id, nRaw] of Object.entries(runeCounts)) {
    const n = Math.floor(nRaw || 0);
    if (n <= 0) continue;
    const cd = getCardById(allCards, id);
    if (!cd || cd.type !== "Rune") throw new Error(`${playerId}: Invalid rune card id: ${id}`);
    const domRaw = (parseDomains(cd.domain)[0] || cd.domain || "Colorless").trim();
    const dom = clampDomain(domRaw);
    if (dom !== "Colorless" && !identity.includes(dom)) throw new Error(`${playerId}: Rune ${cd.name} (${dom}) is outside domain identity.`);
    for (let i = 0; i < n; i++) runeDeck.push(createRuneInstance(cd, playerId, turn));
  }
  const runeDeckShuffled = shuffle(runeDeck, turn + (playerId === "P1" ? 99 : 199));

  // Battlefields (pick 3 in builder, use 1 in duel)
  const bfs = spec.battlefields || [];
  if (bfs.length !== 3) throw new Error(`${playerId}: Choose exactly 3 battlefields (currently ${bfs.length}).`);
  const bfCards: CardData[] = bfs.map((id) => getCardById(allCards, id)).filter(Boolean) as CardData[];
  if (bfCards.length !== 3) throw new Error(`${playerId}: One or more chosen battlefields were not found in the database.`);
  for (const b of bfCards) {
    if (b.type !== "Battlefield") throw new Error(`${playerId}: ${b.name} is not a Battlefield.`);
    if (!cardWithinIdentity(b, identity)) throw new Error(`${playerId}: Battlefield ${b.name} is outside domain identity.`);
  }

  return { legend, champion, domains: identity, mainDeck: mainDeckShuffled, runeDeck: runeDeckShuffled, battlefields: bfCards };
};

// ----------------------------- React Component -----------------------------

export default function RiftboundGame() {
  const [allCards, setAllCards] = useState<CardData[]>([]);
  const [game, setGame] = useState<GameState | null>(null);

  // ----------------------------- Deck Builder (pre-game) -----------------------------

  const DECK_STORAGE_KEY = "riftbound.deckbuilder.v1";
  const DECK_LIBRARY_KEY = "riftbound.decklibrary.v1";
  const [preGameView, setPreGameView] = useState<"SETUP" | "DECK_BUILDER">("SETUP");
  const [builderActivePlayer, setBuilderActivePlayer] = useState<PlayerId>("P1");

// ----------------------------- Match settings -----------------------------
  const [matchFormat, setMatchFormat] = useState<MatchFormat>("BO1");
  const [matchState, setMatchState] = useState<MatchState | null>(null);
// For BO3: chosen battlefield for the *next* game (per player).
  const [matchNextBattlefieldPick, setMatchNextBattlefieldPick] = useState<Record<PlayerId, BattlefieldPick | null>>({
    P1: null,
    P2: null,
  });



  const [builderDecks, setBuilderDecks] = useState<Record<PlayerId, DeckSpec>>(() => {
    if (typeof window === "undefined") return { P1: emptyDeckSpec(), P2: emptyDeckSpec() };
    try {
      const raw = window.localStorage.getItem(DECK_STORAGE_KEY);
      if (!raw) return { P1: emptyDeckSpec(), P2: emptyDeckSpec() };
      const parsed = JSON.parse(raw);
      const p1 = parsed?.P1 ? parsed.P1 : emptyDeckSpec();
      const p2 = parsed?.P2 ? parsed.P2 : emptyDeckSpec();
      return { P1: p1, P2: p2 };
    } catch {
      return { P1: emptyDeckSpec(), P2: emptyDeckSpec() };
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(DECK_STORAGE_KEY, JSON.stringify(builderDecks));
    } catch {}
  }, [builderDecks]);

  // Saved Deck Library (persistent list of named DeckSpecs)
  const makeDeckLibraryId = () => `deck_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

  const [deckLibrary, setDeckLibrary] = useState<DeckLibraryEntry[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(DECK_LIBRARY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // sanitize
      return parsed
          .filter((x) => x && typeof x === "object")
          .map((x: any) => ({
            id: String(x.id || makeDeckLibraryId()),
            name: String(x.name || "Untitled Deck"),
            tags: Array.isArray(x.tags) ? x.tags.map((t: any) => String(t)).filter(Boolean) : [],
            spec: (x.spec as DeckSpec) || emptyDeckSpec(),
            createdAt: Number.isFinite(x.createdAt) ? Number(x.createdAt) : Date.now(),
            updatedAt: Number.isFinite(x.updatedAt) ? Number(x.updatedAt) : Date.now(),
          })) as DeckLibraryEntry[];
    } catch {
      return [];
    }
  });

  const [selectedLibraryDeckId, setSelectedLibraryDeckId] = useState<string | null>(null);

  const [librarySearch, setLibrarySearch] = useState<string>("");
  const [libraryTagFilter, setLibraryTagFilter] = useState<string>("");
  const [libraryDragId, setLibraryDragId] = useState<string | null>(null);

  // "Save current as..." helper inputs
  const [saveAsName, setSaveAsName] = useState<string>("");
  const [saveAsTags, setSaveAsTags] = useState<string>("");


  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(DECK_LIBRARY_KEY, JSON.stringify(deckLibrary));
    } catch {}
  }, [deckLibrary]);

  // Library UX: auto-fill "Save current as..." with the selected library deck name, or a suggested name.
  useEffect(() => {
    if (preGameView !== "DECK_BUILDER") return;
    const selected = selectedLibraryDeckId ? deckLibrary.find((d) => d.id === selectedLibraryDeckId) || null : null;
    if (selected) {
      setSaveAsName(selected.name || "");
      setSaveAsTags(Array.isArray(selected.tags) ? selected.tags.join(", ") : "");
      return;
    }
    const spec = builderDecks[builderActivePlayer] || emptyDeckSpec();
    const suggested = defaultDeckNameFromSpec(allCards, spec);
    setSaveAsName((prev) => (prev && prev.trim().length > 0 ? prev : suggested));
  }, [preGameView, selectedLibraryDeckId, deckLibrary, builderDecks, builderActivePlayer, allCards]);

  const [builderSearch, setBuilderSearch] = useState<string>("");
  const [builderTypeFilter, setBuilderTypeFilter] = useState<"All" | "Unit" | "Spell" | "Gear" | "Rune" | "Battlefield">("All");

  const moveDeckInLibrary = (fromId: string, toId: string) => {
    setDeckLibrary((prev) => {
      const from = prev.findIndex((d) => d.id === fromId);
      const to = prev.findIndex((d) => d.id === toId);
      if (from < 0 || to < 0 || from === to) return prev;
      const next = prev.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  // Simple undo stack (stores previous immutable GameState snapshots).
  const undoRef = useRef<GameState[]>([]);
  const MAX_UNDO = 40;

  // Arena convenience options
  const [autoPayEnabled, setAutoPayEnabled] = useState<boolean>(true);
  const [hoverPayPlan, setHoverPayPlan] = useState<null | { cardInstanceId: string; plan: AutoPayPlan }>(null);

  // ----------------------------- AI Settings (optional) -----------------------------

  const AI_STORAGE_KEY = "riftbound.ai.v1";
  const defaultAiState: Record<PlayerId, AiConfig> = {
    P1: { enabled: false, difficulty: "MEDIUM", thinkMs: 650 },
    P2: { enabled: false, difficulty: "MEDIUM", thinkMs: 650 },
  };

  const [aiByPlayer, setAiByPlayer] = useState<Record<PlayerId, AiConfig>>(() => {
    if (typeof window === "undefined") return defaultAiState;
    try {
      const raw = window.localStorage.getItem(AI_STORAGE_KEY);
      if (!raw) return defaultAiState;
      const parsed = JSON.parse(raw);
      const out: Record<PlayerId, AiConfig> = { ...defaultAiState };
      (['P1', 'P2'] as PlayerId[]).forEach((pid) => {
        if (parsed?.[pid]) {
          const p = parsed[pid];
          out[pid] = {
            enabled: !!p.enabled,
            difficulty: (p.difficulty as AiDifficulty) || defaultAiState[pid].difficulty,
            thinkMs: Number.isFinite(p.thinkMs) ? Number(p.thinkMs) : defaultAiState[pid].thinkMs,
          };
        }
      });
      return out;
    } catch {
      return defaultAiState;
    }
  });

  const [aiPaused, setAiPaused] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(aiByPlayer));
    } catch {}
  }, [aiByPlayer]);

  const isAiControlled = (pid: PlayerId) => !!aiByPlayer[pid]?.enabled && !aiPaused;

  // UI state
  const [selectedHandCardId, setSelectedHandCardId] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<PlayerId>("P1");
  const [revealAllHands, setRevealAllHands] = useState<boolean>(false);
  const [revealAllFacedown, setRevealAllFacedown] = useState<boolean>(false);
  const [revealAllDecks, setRevealAllDecks] = useState<boolean>(false);
  const [pendingPlay, setPendingPlay] = useState<null | {
    player: PlayerId;
    cardId: string;
    from: "HAND" | "FACEDOWN" | "CHAMPION";
    fromBattlefieldIndex?: number;
  }>(null);

  const [pendingDestination, setPendingDestination] = useState<null | { kind: "BASE" } | { kind: "BF"; index: number }>(null);
  const [pendingAccelerate, setPendingAccelerate] = useState<boolean>(false);
  const [pendingAccelerateDomain, setPendingAccelerateDomain] = useState<Domain>("Fury");
  const [pendingTargets, setPendingTargets] = useState<Target[]>([{ kind: "NONE" }]);
  const [pendingChainChoice, setPendingChainChoice] = useState<null | { chainItemId: string; targets?: Target[] }>(null);
  const [hideChoice, setHideChoice] = useState<{ cardId: string | null; battlefieldIndex: number | null }>(() => ({ cardId: null, battlefieldIndex: null }));

  const [moveSelection, setMoveSelection] = useState<{
    from: { kind: "BASE" } | { kind: "BF"; index: number } | null;
    unitIds: string[];
    to: { kind: "BASE" } | { kind: "BF"; index: number } | null;
  }>({ from: null, unitIds: [], to: null });

  // UI mode: "Arena" = board-centric visuals, "Classic" = debug panels
  const [uiMode, setUiMode] = useState<"Arena" | "Classic">("Arena");
  const [hoverCard, setHoverCard] = useState<CardData | CardInstance | null>(null);
  const [pileViewer, setPileViewer] = useState<null | { player: PlayerId; zone: "TRASH" }>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagSearch, setDiagSearch] = useState("");
  const [diagTab, setDiagTab] = useState<"UNSUPPORTED" | "AUDIT">("UNSUPPORTED");
  const [auditStatusFilter, setAuditStatusFilter] = useState<"PROBLEMS" | "ALL" | "FULL" | "PARTIAL" | "UNSUPPORTED" | "NO_TEXT">("PROBLEMS");
  const [auditExpandedId, setAuditExpandedId] = useState<string | null>(null);

  // Arena interactions
  const [arenaMove, setArenaMove] = useState<{
    from: { kind: "BASE" } | { kind: "BF"; index: number };
    unitIds: string[];
  } | null>(null);

  const [arenaHideCardId, setArenaHideCardId] = useState<string | null>(null);

  const loadLegacyCardData = async (): Promise<CardData[]> => {
    try {
      const res = await fetch("riftbound_card_data.json");
      if (!res.ok) return [];
      const legacyText = sanitizeJsonText(await res.text());
      const legacyParsed = JSON.parse(legacyText);
      return Array.isArray(legacyParsed) ? (legacyParsed as CardData[]) : [];
    } catch {
      return [];
    }
  };

  const loadCardData = async (file: File) => {
    const text = await file.text();
    const parsed = JSON.parse(sanitizeJsonText(text));
    if (!Array.isArray(parsed)) throw new Error("Card JSON must be an array.");

    const isExpert = parsed.length > 0 && typeof parsed[0] === "object" && "type_line" in (parsed[0] as any);
    if (isExpert) {
      const legacy = await loadLegacyCardData();
      const normalized = normalizeExpertCards(parsed as ExpertCardData[], legacy);
      setAllCards(normalized);
      return;
    }

    setAllCards(parsed as CardData[]);
  };

  const startAutoDuel = () => {
    if (allCards.length === 0) return;

    // New game => clear undo history
    undoRef.current = [];

    const turn = 1;
    const p1Built = autoBuildPlayer(allCards, "P1", turn);
    const p2Built = autoBuildPlayer(allCards, "P2", turn);
    const bfs = autoBuildBattlefields(allCards);

    const players: Record<PlayerId, PlayerState> = {
      P1: {
        id: "P1",
        legend: p1Built.legend,
        legendReady: true,
        championZone: p1Built.champion,
        base: { units: [], gear: [] },
        mainDeck: p1Built.mainDeck,
        hand: [],
        trash: [],
        banishment: [],
        runeDeck: p1Built.runeDeck,
        runesInPlay: [],
        runePool: emptyRunePool(),
        points: 0,
        domains: p1Built.domains,
        mainDeckCardsPlayedThisTurn: 0,
        scoredBattlefieldsThisTurn: [],
        discardedThisTurn: 0,
        enemyUnitsDiedThisTurn: 0,
        mulliganSelectedIds: [],
        mulliganDone: false,
      },
      P2: {
        id: "P2",
        legend: p2Built.legend,
        legendReady: true,
        championZone: p2Built.champion,
        base: { units: [], gear: [] },
        mainDeck: p2Built.mainDeck,
        hand: [],
        trash: [],
        banishment: [],
        runeDeck: p2Built.runeDeck,
        runesInPlay: [],
        runePool: emptyRunePool(),
        points: 0,
        domains: p2Built.domains,
        mainDeckCardsPlayedThisTurn: 0,
        scoredBattlefieldsThisTurn: [],
        discardedThisTurn: 0,
        enemyUnitsDiedThisTurn: 0,
        mulliganSelectedIds: [],
        mulliganDone: false,
      },
    };

    const battlefields: BattlefieldState[] = [
      {
        index: 0,
        card: bfs.p1,
        owner: "P1",
        controller: null,
        contestedBy: null,
        facedown: null,
        units: { P1: [], P2: [] },
        gear: { P1: [], P2: [] },
      },
      {
        index: 1,
        card: bfs.p2,
        owner: "P2",
        controller: null,
        contestedBy: null,
        facedown: null,
        units: { P1: [], P2: [] },
        gear: { P1: [], P2: [] },
      },
    ];

    const first: PlayerId = Math.random() < 0.5 ? "P1" : "P2";

    const g: GameState = {
      step: "MULLIGAN",
      turnNumber: 1,
      turnPlayer: first,
      startingPlayer: first,
      windowKind: "NONE",
      windowBattlefieldIndex: null,
      focusPlayer: null,
      combat: null,
      chain: [],
      priorityPlayer: first,
      passesInRow: 0,
      state: "OPEN",
      victoryScore: duelVictoryScore,
      log: [
        `Auto Duel setup complete. First player: ${first}.`,
        `P1 Legend: ${p1Built.legend.name} | Champion: ${p1Built.champion.name}`,
        `P2 Legend: ${p2Built.legend.name} | Champion: ${p2Built.champion.name}`,
        `Battlefield 1: ${bfs.p1.name} | Battlefield 2: ${bfs.p2.name}`,
      ],
      actionHistory: [],
      damageKillEffects: [],
      lastCombatExcessDamage: { P1: 0, P2: 0 },
      lastCombatExcessDamageTurn: 0,
      players,
      battlefields,
    };

    // Initial hand: draw 4 each (setup).
    drawCards(g, "P1", 4);
    drawCards(g, "P2", 4);

    // Start of Game Triggers (Obelisk of Power, Arena's Greatest)
    battlefields.forEach((bf) => {
      const trig = (bf.card.ability?.trigger || "").toLowerCase();
      if (trig.includes("at the start of each player's first beginning phase")) {
        if (bf.card.ability?.effect_text?.includes("channel 1 rune")) {
          channelRunes(g, "P1", 1);
          channelRunes(g, "P2", 1);
          g.log.unshift(`${bf.card.name}: Both players channeled 1 rune.`);
        }
        if (bf.card.ability?.effect_text?.includes("gains 1 point")) {
          g.players.P1.points += 1;
          g.players.P2.points += 1;
          g.log.unshift(`${bf.card.name}: Both players gained 1 point.`);
        }
      }
    });

    cleanupStateBased(g);

    setGame(g);
    setViewerId(first);
    setSelectedHandCardId(null);
    setPendingPlay(null);
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
    setHideChoice({ cardId: null, battlefieldIndex: null });
    setMoveSelection({ from: null, unitIds: [], to: null });
    setArenaMove(null);
    setArenaHideCardId(null);
    setHoverCard(null);
  };


  const pickBattlefieldForPlayer = (pool: CardData[], usedIds: string[], desiredId: string | null): CardData => {
    const remaining = pool.filter((b) => !usedIds.includes(b.id));
    const candidates = remaining.length > 0 ? remaining : pool;
    if (candidates.length === 0) throw new Error("Deck has no battlefields.");
    if (desiredId) {
      const found = candidates.find((b) => b.id === desiredId);
      if (found) return found;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  };

  const getGameWinner = (gs: GameState): PlayerId | null => {
    const p1Win = gs.players.P1.points >= gs.victoryScore;
    const p2Win = gs.players.P2.points >= gs.victoryScore;
    if (p1Win && !p2Win) return "P1";
    if (p2Win && !p1Win) return "P2";
    // In unusual edge cases, fall back to no winner.
    return null;
  };

  const deckBattlefieldsFor = (pid: PlayerId): CardData[] => {
    const ids = builderDecks[pid]?.battlefields || [];
    return ids.map((id) => getCardById(allCards, id)).filter((x): x is CardData => Boolean(x));
  };

  const startDeckBuilderDuel = (overrideFormat?: MatchFormat) => {
    if (allCards.length === 0) return;

    // New game => clear undo history
    undoRef.current = [];
    clearTransientUI();

    const turn = 1;

    try {
      const p1Built = buildPlayerFromDeckSpec(allCards, "P1", builderDecks.P1, turn);
      const p2Built = buildPlayerFromDeckSpec(allCards, "P2", builderDecks.P2, turn);

      const fmt: MatchFormat = overrideFormat ?? matchFormat;

      // Match init (only BO3 is a multi-game match; BO1 is a single game).
      let ms: MatchState | null =
          fmt === "BO3"
              ? {
                format: "BO3",
                gamesCompleted: 0,
                wins: { P1: 0, P2: 0 },
                usedBattlefieldIds: { P1: [], P2: [] },
                lastGameWinner: null,
              }
              : null;
      const initialUsedBattlefieldIds = ms?.usedBattlefieldIds ?? { P1: [], P2: [] };

      // Battlefield selection
      const bf1 =
          fmt === "BO1"
              ? p1Built.battlefields[Math.floor(Math.random() * p1Built.battlefields.length)]
              : pickBattlefieldForPlayer(p1Built.battlefields, initialUsedBattlefieldIds.P1, matchNextBattlefieldPick.P1);
      const bf2 =
          fmt === "BO1"
              ? p2Built.battlefields[Math.floor(Math.random() * p2Built.battlefields.length)]
              : pickBattlefieldForPlayer(p2Built.battlefields, initialUsedBattlefieldIds.P2, matchNextBattlefieldPick.P2);

      if (fmt === "BO3") {
        ms = {
          ...ms!,
          usedBattlefieldIds: {
            P1: [...ms!.usedBattlefieldIds.P1, bf1.id],
            P2: [...ms!.usedBattlefieldIds.P2, bf2.id],
          },
        };
        setMatchState(ms);
        setMatchNextBattlefieldPick({ P1: null, P2: null });
      } else {
        setMatchState(null);
        setMatchNextBattlefieldPick({ P1: null, P2: null });
      }

      const players: Record<PlayerId, PlayerState> = {
        P1: {
          id: "P1",
          legend: p1Built.legend,
          legendReady: true,
          championZone: p1Built.champion,
          base: { units: [], gear: [] },
          mainDeck: p1Built.mainDeck,
          hand: [],
          trash: [],
          banishment: [],
          runeDeck: p1Built.runeDeck,
          runesInPlay: [],
          runePool: emptyRunePool(),
          points: 0,
          domains: p1Built.domains,
          mainDeckCardsPlayedThisTurn: 0,
          scoredBattlefieldsThisTurn: [],
          discardedThisTurn: 0,
          enemyUnitsDiedThisTurn: 0,
          mulliganSelectedIds: [],
          mulliganDone: false,
        },
        P2: {
          id: "P2",
          legend: p2Built.legend,
          legendReady: true,
          championZone: p2Built.champion,
          base: { units: [], gear: [] },
          mainDeck: p2Built.mainDeck,
          hand: [],
          trash: [],
          banishment: [],
          runeDeck: p2Built.runeDeck,
          runesInPlay: [],
          runePool: emptyRunePool(),
          points: 0,
          domains: p2Built.domains,
          mainDeckCardsPlayedThisTurn: 0,
          scoredBattlefieldsThisTurn: [],
          discardedThisTurn: 0,
          enemyUnitsDiedThisTurn: 0,
          mulliganSelectedIds: [],
          mulliganDone: false,
        },
      };

      const battlefields: BattlefieldState[] = [
        {
          index: 0,
          card: bf1,
          owner: "P1",
          controller: null,
          contestedBy: null,
          units: { P1: [], P2: [] },
          gear: { P1: [], P2: [] },
          facedown: null,
        },
        {
          index: 1,
          card: bf2,
          owner: "P2",
          controller: null,
          contestedBy: null,
          units: { P1: [], P2: [] },
          gear: { P1: [], P2: [] },
          facedown: null,
        },
      ];

      const first: PlayerId = Math.random() < 0.5 ? "P1" : "P2";

      const matchLine =
          fmt === "BO3" && ms
              ? [`Match: Best of 3 • Game ${ms.gamesCompleted + 1} • Score P1 ${ms.wins.P1}-${ms.wins.P2} P2`]
              : [];

      const g: GameState = {
        step: "MULLIGAN",
        turnNumber: 1,
        turnPlayer: first,
        startingPlayer: first,
        priorityPlayer: first,
        passesInRow: 0,
        state: "OPEN",
        windowKind: "NONE",
        windowBattlefieldIndex: null,
        focusPlayer: null,
        combat: null,
        chain: [],
        victoryScore: duelVictoryScore,
        log: [
          ...matchLine,
          `Deck Builder Duel setup complete. First player: ${first}.`,
          `P1 Legend: ${p1Built.legend.name} | Champion: ${p1Built.champion.name}`,
          `P2 Legend: ${p2Built.legend.name} | Champion: ${p2Built.champion.name}`,
          `Battlefield 1 (P1 choice): ${bf1.name}`,
          `Battlefield 2 (P2 choice): ${bf2.name}`,
        ],
        actionHistory: [],
        damageKillEffects: [],
        lastCombatExcessDamage: { P1: 0, P2: 0 },
        lastCombatExcessDamageTurn: 0,
        players,
        battlefields,
      };

      // Initial hand: draw 4 each (setup).
      drawCards(g, "P1", 4);
      drawCards(g, "P2", 4);

      // Start of Game Triggers (Obelisk of Power, Arena's Greatest)
    battlefields.forEach((bf) => {
      const trig = (bf.card.ability?.trigger || "").toLowerCase();
      if (trig.includes("at the start of each player's first beginning phase")) {
        if (bf.card.ability?.effect_text?.includes("channel 1 rune")) {
          channelRunes(g, "P1", 1);
          channelRunes(g, "P2", 1);
          g.log.unshift(`${bf.card.name}: Both players channeled 1 rune.`);
        }
        if (bf.card.ability?.effect_text?.includes("gains 1 point")) {
          g.players.P1.points += 1;
          g.players.P2.points += 1;
          g.log.unshift(`${bf.card.name}: Both players gained 1 point.`);
        }
      }
    });

    cleanupStateBased(g);

      setGame(g);
      setViewerId(first);
      setPreGameView("SETUP");
      setSelectedHandCardId(null);
      setPendingPlay(null);
      setPendingDestination(null);
      setPendingTargets([{ kind: "NONE" }]);
      setPendingChainChoice(null);
      setPendingAccelerate(false);
      setHideChoice({ cardId: null, battlefieldIndex: null });
      setMoveSelection({ from: null, unitIds: [], to: null });
      setArenaMove(null);
      setArenaHideCardId(null);
      setHoverCard(null);
    } catch (err: any) {
      alert(String(err?.message || err));
    }
  };

  const startNextBo3Game = () => {
    if (!g) return;
    if (!matchState || matchState.format !== "BO3") return;
    if (g.step !== "GAME_OVER") return;

    // First, commit the just-finished game's result into matchState.
    const winner = getGameWinner(g);
    const wins = { ...matchState.wins };
    if (winner) wins[winner] = (wins[winner] || 0) + 1;

    const msAfter: MatchState = {
      ...matchState,
      wins,
      gamesCompleted: matchState.gamesCompleted + 1,
      lastGameWinner: winner,
    };

    // If match is complete, just record it.
    if (wins.P1 >= 2 || wins.P2 >= 2) {
      setMatchState(msAfter);
      return;
    }

    // Start next game
    undoRef.current = [];
    clearTransientUI();

    const turn = 1;

    try {
      const p1Built = buildPlayerFromDeckSpec(allCards, "P1", builderDecks.P1, turn);
      const p2Built = buildPlayerFromDeckSpec(allCards, "P2", builderDecks.P2, turn);

      const bf1 = pickBattlefieldForPlayer(p1Built.battlefields, msAfter.usedBattlefieldIds.P1, matchNextBattlefieldPick.P1);
      const bf2 = pickBattlefieldForPlayer(p2Built.battlefields, msAfter.usedBattlefieldIds.P2, matchNextBattlefieldPick.P2);

      const msNext: MatchState = {
        ...msAfter,
        usedBattlefieldIds: {
          P1: [...msAfter.usedBattlefieldIds.P1, bf1.id],
          P2: [...msAfter.usedBattlefieldIds.P2, bf2.id],
        },
      };

      setMatchState(msNext);
      setMatchNextBattlefieldPick({ P1: null, P2: null });

      const players: Record<PlayerId, PlayerState> = {
        P1: {
          id: "P1",
          legend: p1Built.legend,
          legendReady: true,
          championZone: p1Built.champion,
          base: { units: [], gear: [] },
          mainDeck: p1Built.mainDeck,
          hand: [],
          trash: [],
          banishment: [],
          runeDeck: p1Built.runeDeck,
          runesInPlay: [],
          runePool: emptyRunePool(),
          points: 0,
          domains: p1Built.domains,
          mainDeckCardsPlayedThisTurn: 0,
          scoredBattlefieldsThisTurn: [],
          discardedThisTurn: 0,
          enemyUnitsDiedThisTurn: 0,
          mulliganSelectedIds: [],
          mulliganDone: false,
        },
        P2: {
          id: "P2",
          legend: p2Built.legend,
          legendReady: true,
          championZone: p2Built.champion,
          base: { units: [], gear: [] },
          mainDeck: p2Built.mainDeck,
          hand: [],
          trash: [],
          banishment: [],
          runeDeck: p2Built.runeDeck,
          runesInPlay: [],
          runePool: emptyRunePool(),
          points: 0,
          domains: p2Built.domains,
          mainDeckCardsPlayedThisTurn: 0,
          scoredBattlefieldsThisTurn: [],
          discardedThisTurn: 0,
          enemyUnitsDiedThisTurn: 0,
          mulliganSelectedIds: [],
          mulliganDone: false,
        },
      };

      const battlefields: BattlefieldState[] = [
        {
          index: 0,
          card: bf1,
          owner: "P1",
          controller: null,
          contestedBy: null,
          units: { P1: [], P2: [] },
          gear: { P1: [], P2: [] },
          facedown: null,
        },
        {
          index: 1,
          card: bf2,
          owner: "P2",
          controller: null,
          contestedBy: null,
          units: { P1: [], P2: [] },
          gear: { P1: [], P2: [] },
          facedown: null,
        },
      ];

      const first: PlayerId = Math.random() < 0.5 ? "P1" : "P2";

      const matchLine = [`Match: Best of 3 • Game ${msNext.gamesCompleted + 1} • Score P1 ${msNext.wins.P1}-${msNext.wins.P2} P2`];

      const nextGame: GameState = {
        step: "MULLIGAN",
        turnNumber: 1,
        turnPlayer: first,
        startingPlayer: first,
        priorityPlayer: first,
        passesInRow: 0,
        state: "OPEN",
        windowKind: "NONE",
        windowBattlefieldIndex: null,
        focusPlayer: null,
        combat: null,
        chain: [],
        victoryScore: duelVictoryScore,
        log: [
          ...matchLine,
          `Previous game winner: ${winner ?? "Unknown"}.`,
          `Next game setup complete. First player: ${first}.`,
          `P1 Legend: ${p1Built.legend.name} | Champion: ${p1Built.champion.name}`,
          `P2 Legend: ${p2Built.legend.name} | Champion: ${p2Built.champion.name}`,
          `Battlefield 1 (P1 choice): ${bf1.name}`,
          `Battlefield 2 (P2 choice): ${bf2.name}`,
        ],
        actionHistory: [],
        damageKillEffects: [],
        lastCombatExcessDamage: { P1: 0, P2: 0 },
        lastCombatExcessDamageTurn: 0,
        players,
        battlefields,
      };

      drawCards(nextGame, "P1", 4);
      drawCards(nextGame, "P2", 4);

      cleanupStateBased(nextGame);

      setGame(nextGame);
      setViewerId(first);
      setPreGameView("SETUP");
      setSelectedHandCardId(null);
      setPendingPlay(null);
      setPendingDestination(null);
      setPendingTargets([{ kind: "NONE" }]);
      setPendingChainChoice(null);
      setPendingAccelerate(false);
      setHideChoice({ cardId: null, battlefieldIndex: null });
      setMoveSelection({ from: null, unitIds: [], to: null });
      setArenaMove(null);
      setArenaHideCardId(null);
      setHoverCard(null);
    } catch (err: any) {
      setMatchState(msAfter);
      alert(String(err?.message || err));
    }
  };


  const updateDeck = (pid: PlayerId, fn: (d: DeckSpec) => DeckSpec) => {
    setBuilderDecks((prev) => ({ ...prev, [pid]: fn(prev[pid] || emptyDeckSpec()) }));
  };

  const bumpCount = (counts: Record<string, number>, id: string, delta: number, min = 0, max: number | null = null) => {
    const next = { ...counts };
    const cur = Math.floor(next[id] || 0);
    let v = cur + delta;
    if (v < min) v = min;
    if (max != null) v = Math.min(max, v);
    if (v === 0) delete next[id];
    else next[id] = v;
    return next;
  };

  const privacy: PrivacySettings = useMemo(
      () => ({
        revealHands: revealAllHands,
        revealFacedown: revealAllFacedown,
        revealDecks: revealAllDecks,
      }),
      [revealAllHands, revealAllFacedown, revealAllDecks]
  );

  const viewGame = useMemo(() => (game ? projectGameStateForViewer(game, viewerId, privacy) : null), [game, viewerId, privacy]);

  const g = viewGame;

  const currentPlayer = g ? g.players[viewerId] : null;
  const turnPlayerState = g ? g.players[g.turnPlayer] : null;

  const canActAs = (pid: PlayerId): boolean => {
    if (!g) return false;
    // If a side is AI-controlled, treat the UI as spectator mode for that player (pause AI to take over).
    if (isAiControlled(pid)) return false;
    // Hot-seat: allow controlling both sides; but enforce priority for chain/showdowns.
    if (g.chain.length > 0 || g.state === "CLOSED" || g.windowKind !== "NONE") {
      return g.priorityPlayer === pid;
    }
    // Mulligan is simultaneous; allow both players.
    if (g.step === "MULLIGAN") return true;

    // Otherwise, only the turn player can take main actions in ACTION step.
    if (g.step === "ACTION") return g.turnPlayer === pid;
    // Outside action, only turn player should click "Next Step"
    return g.turnPlayer === pid;
  };

  const getUnitTargetOptions = (
      d: GameState,
      controller: PlayerId,
      req: TargetRequirement,
      ctxBf: number | null,
      restrictBf: number | null
  ): { label: string; t: Target }[] => {
    const all: { label: string; t: Target }[] = [];
    (["P1", "P2"] as PlayerId[]).forEach((owner) => {
      d.players[owner].base.units.forEach((u) => {
        all.push({ label: `${owner} Base: ${u.name}`, t: { kind: "UNIT", owner, instanceId: u.instanceId, zone: "BASE" } });
      });
      d.battlefields.forEach((bf, battlefieldIndex) => {
        bf.units[owner].forEach((u) => {
          all.push({
            label: `${owner} BF${battlefieldIndex + 1}: ${u.name}`,
            t: { kind: "UNIT", owner, instanceId: u.instanceId, zone: "BF", battlefieldIndex },
          });
        });
      });
    });

    const baseFiltered = all.filter((opt) => {
      if (opt.t.kind !== "UNIT") return false;
      const loc = locateUnit(d, opt.t.owner, opt.t.instanceId);
      if (!loc) return false;

      const owner = opt.t.owner;
      const isFriendly = owner === controller;
      const isEnemy = owner !== controller;

      const hereBf = ctxBf != null ? ctxBf : restrictBf;
      const hereMatches = hereBf != null && loc.zone === "BF" && loc.battlefieldIndex === hereBf;

      switch (req.kind) {
        case "UNIT_HERE_FRIENDLY":
          return hereMatches && isFriendly;
        case "UNIT_HERE_ENEMY":
          return hereMatches && isEnemy;
        case "UNIT_FRIENDLY":
          return isFriendly;
        case "UNIT_ENEMY":
          return isEnemy;
        case "UNIT_ANYWHERE":
          return true;
        case "NONE":
        case "BATTLEFIELD":
          return false;
        default:
          return true;
      }
    });

    if (restrictBf != null) {
      const restricted = baseFiltered.filter((opt) => {
        if (opt.t.kind !== "UNIT") return false;
        const loc = locateUnit(d, opt.t.owner, opt.t.instanceId);
        return loc && loc.zone === "BF" && loc.battlefieldIndex === restrictBf;
      });
      return restricted.length > 0 ? restricted : baseFiltered;
    }

    return baseFiltered;
  };

  const getBattlefieldTargetOptions = (d: GameState, restrictBf: number | null): { label: string; t: Target }[] => {
    const all = d.battlefields.map((bf, i) => ({
      label: `Battlefield ${i + 1}: ${bf.card.name}`,
      t: { kind: "BATTLEFIELD", index: i } as Target,
    }));
    if (restrictBf != null) {
      const restricted = all.filter((x) => x.t.kind === "BATTLEFIELD" && x.t.index === restrictBf);
      return restricted.length > 0 ? restricted : all;
    }
    return all;
  };

  const pickTargetForAi = (
      d: GameState,
      controller: PlayerId,
      req: TargetRequirement,
      ctxBf: number | null,
      restrictBf: number | null,
      difficulty: AiDifficulty
  ): Target[] => {
    // If no target needed, return NONE.
    if (req.kind === "NONE") return [{ kind: "NONE" }];

    // Battlefield targets (rare; mostly unsupported effects today, but keep engine flowing).
    if (req.kind === "BATTLEFIELD") {
      const opts = getBattlefieldTargetOptions(d, restrictBf);
      if (opts.length === 0) return [{ kind: "NONE" }];
      // Prefer battlefields with enemy presence for higher tiers.
      if (difficulty === "HARD" || difficulty === "VERY_HARD") {
        const scored = opts
            .map((o) => {
              const idx = (o.t as any).index as number;
              const bf = d.battlefields[idx];
              const opp = otherPlayer(controller);
              const enemyMight = bf.units[opp].reduce((a, u) => a + effectiveMight(u, { role: "NONE", game: d, battlefieldIndex: bf.index }), 0);
              const myMight = bf.units[controller].reduce((a, u) => a + effectiveMight(u, { role: "NONE", game: d, battlefieldIndex: bf.index }), 0);
              const want = enemyMight * 10 - myMight * 2;
              return { o, want };
            })
            .sort((a, b) => b.want - a.want);
        return [scored[0].o.t];
      }
      return [opts[0].t];
    }

    // Unit targets
    const opts = getUnitTargetOptions(d, controller, req, ctxBf, restrictBf);
    if (opts.length === 0) return [{ kind: "NONE" }];

    // EASY / MEDIUM: first legal target.
    if (difficulty === "EASY" || difficulty === "MEDIUM") return [opts[0].t];

    // HARD+: pick the highest-might relevant unit (enemy or friendly depending on req).
    const wantEnemy = req.kind === "UNIT_HERE_ENEMY" || req.kind === "UNIT_ENEMY";
    const wantFriendly = req.kind === "UNIT_HERE_FRIENDLY" || req.kind === "UNIT_FRIENDLY";

    const scored = opts
        .map((o) => {
          const t = o.t;
          if (t.kind !== "UNIT") return { o, score: -9999 };
          const u = locateUnit(d, t.owner, t.instanceId)?.unit || null;
          const might = u ? effectiveMight(u, { role: "NONE", game: d }) : 0;
          const isEnemy = t.owner !== controller;
          const isFriendly = t.owner === controller;
          let score = might;
          if (wantEnemy && !isEnemy) score -= 9999;
          if (wantFriendly && !isFriendly) score -= 9999;
          // For UNIT_ANYWHERE: mildly prefer enemy targets.
          if (!wantFriendly && isEnemy) score += 2;
          return { o, score };
        })
        .sort((a, b) => b.score - a.score);

    return [scored[0].o.t];
  };

  // Track which chain items have already had AI target selection dispatched to prevent infinite loops
  const aiTargetDispatchedRef = useRef<Set<string>>(new Set());

  // Auto-prompt for target selection on the top Chain item (triggered / activated abilities).
  useEffect(() => {
    if (!game) return;
    if (pendingPlay) return;
    if (pendingChainChoice) return;
    const top = game.chain[game.chain.length - 1];
    if (!top) return;
    if (top.needsTargets && (!top.targets?.[0] || top.targets[0].kind === "NONE")) {
      // If the Chain item is controlled by an AI, auto-select targets to avoid blocking priority.
      if (isAiControlled(top.controller)) {
        // Guard: prevent re-dispatching for the same chain item
        if (aiTargetDispatchedRef.current.has(top.id)) {
          return;
        }
        aiTargetDispatchedRef.current.add(top.id);

        const diff = aiByPlayer[top.controller]?.difficulty || "MEDIUM";
        const chosen = pickTargetForAi(game, top.controller, top.targetRequirement, top.contextBattlefieldIndex, top.restrictTargetsToBattlefieldIndex, diff);
        dispatchEngineAction({ type: "SET_CHAIN_TARGETS", player: top.controller, chainItemId: top.id, targets: chosen });
        return;
      }

      setPendingChainChoice({ chainItemId: top.id });
      setPendingTargets(top.targets && top.targets.length > 0 ? top.targets : [{ kind: "NONE" }]);
    } else {
      // Clean up dispatched IDs for items that no longer need targets
      if (top && !top.needsTargets) {
        aiTargetDispatchedRef.current.delete(top.id);
      }
    }
  }, [game, pendingPlay, pendingChainChoice, aiByPlayer, aiPaused]);

  const confirmChainChoice = () => {
    if (!g || !pendingChainChoice) return;
    const chainItem = g.chain.find((x) => x.id === pendingChainChoice.chainItemId);
    if (!chainItem) {
      setPendingChainChoice(null);
      return;
    }
    // Only the controller of the chain item can set its targets.
    if (chainItem.controller !== viewerId) return;

    dispatchEngineAction({ type: "SET_CHAIN_TARGETS", player: viewerId, chainItemId: pendingChainChoice.chainItemId, targets: pendingChainChoice.targets });
    setPendingChainChoice(null);
  };



  const updateGame = (fn: (draft: GameState) => void) => {
    setGame((prev) => {
      if (!prev) return prev;
      // Record undo snapshot
      undoRef.current.push(prev);
      if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();

      const d = deepClone(prev);
      fn(d);
      // keep log from growing forever
      d.log = d.log.slice(0, 400);
      return d;
    });
  };

  // ----------------------------- Engine Action Layer (UI + AI + Replays) -----------------------------

  const engineNextStep = (d: GameState, pid: PlayerId): boolean => {
    if (d.step === "GAME_OVER") return false;
    if (d.turnPlayer !== pid) {
      d.log.unshift("Only the turn player can advance the step.");
      return false;
    }
    if (d.chain.length > 0 || d.windowKind !== "NONE" || d.state !== "OPEN") {
      d.log.unshift("Cannot advance step while a chain/window is active.");
      return false;
    }

    // New turn reset (per-turn scoring limit applies each turn for each player).
    const resetPerTurn = () => {
      d.players.P1.scoredBattlefieldsThisTurn = [];
      d.players.P2.scoredBattlefieldsThisTurn = [];
      d.players.P1.mainDeckCardsPlayedThisTurn = 0;
      d.players.P2.mainDeckCardsPlayedThisTurn = 0;
      d.players.P1.discardedThisTurn = 0;
      d.players.P2.discardedThisTurn = 0;
      d.players.P1.enemyUnitsDiedThisTurn = 0;
      d.players.P2.enemyUnitsDiedThisTurn = 0;
      for (const pid of ["P1", "P2"] as PlayerId[]) {
        for (const u of getUnitsInPlay(d, pid)) {
          u.moveCountThisTurn = 0;
          u.killOnDamageUntilTurn = 0;
        }
      }
      d.damageKillEffects = [];
    };

    switch (d.step) {
      case "MULLIGAN":
        d.log.unshift("Use Confirm Mulligan for each player (or confirm with 0 selected) to start the game.");
        break;
      case "AWAKEN":
        awakenPlayer(d, d.turnPlayer);
        d.step = "SCORING";
        break;
      case "SCORING":
        resolveHoldScoring(d, d.turnPlayer);
        d.step = "CHANNEL";
        break;
      case "CHANNEL": {
        // Channel 2 runes; second player's first channel phase channels +1 in Duel.
        const secondPlayersFirstChannel = d.turnNumber === 1 && d.turnPlayer !== d.startingPlayer;
        const count = 2 + (secondPlayersFirstChannel ? 1 : 0);
        channelRunes(d, d.turnPlayer, count);
        d.step = "DRAW";
        break;
      }
      case "DRAW":
        drawCards(d, d.turnPlayer, 1);
        if ((d as any).step === "GAME_OVER") return true;
        emptyPoolsAtEndOfDraw(d);
        d.step = "ACTION";
        break;
      case "ACTION":
        d.step = "ENDING";
        (["P1", "P2"] as PlayerId[]).forEach((pid) => {
          [...d.players[pid].base.units, ...d.players[pid].base.gear, ...d.battlefields.flatMap((b) => b.units[pid])].forEach((u) => {
            if ((u.ability?.trigger || "").toLowerCase().includes("at the end of your turn") && pid === d.turnPlayer) {
              if (u.ability?.effect_text) {
                d.chain.push({
                  id: makeId("chain"),
                  controller: pid,
                  kind: "TRIGGERED_ABILITY",
                  label: `End Turn: ${u.name}`,
                  effectText: u.ability.effect_text,
                  targets: [{ kind: "NONE" }],
                  needsTargets: false,
                });
                d.state = "CLOSED";
                d.priorityPlayer = pid;
                d.passesInRow = 0;
              }
            }
            const raw = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`.toLowerCase();
            if (pid === d.turnPlayer && raw.includes("while i'm at a battlefield") && raw.includes("ready 4 friendly runes at the end of your turn")) {
              const loc = locateUnit(d, pid, u.instanceId);
              if (loc && loc.zone === "BF" && u.ability?.effect_text) {
                d.chain.push({
                  id: makeId("chain"),
                  controller: pid,
                  kind: "TRIGGERED_ABILITY",
                  label: `End Turn: ${u.name}`,
                  effectText: u.ability.effect_text,
                  contextBattlefieldIndex: loc.battlefieldIndex ?? null,
                  targets: [{ kind: "NONE" }],
                  needsTargets: false,
                });
                d.state = "CLOSED";
                d.priorityPlayer = pid;
                d.passesInRow = 0;
              }
            }
          });
        });
        clearEndOfTurnStatuses(d); // stunned ends at beginning of Ending Step
        d.log.unshift(`Ending Step begins for ${d.turnPlayer}.`);
        break;
      case "ENDING": {
        clearDamageAndTempBonusesEndOfTurn(d);
        emptyPoolAtEndOfTurn(d, d.turnPlayer);

        // Next turn
        d.turnPlayer = otherPlayer(d.turnPlayer);
        d.turnNumber += 1;
        resetPerTurn();
        d.step = "AWAKEN";
        d.priorityPlayer = d.turnPlayer;
        d.state = "OPEN";
        d.passesInRow = 0;
        (["P1", "P2"] as PlayerId[]).forEach((pid) => {
          if (pid !== d.turnPlayer) return;
          [...d.players[pid].base.units, ...d.players[pid].base.gear, ...d.battlefields.flatMap((b) => b.units[pid])].forEach((u) => {
            const trig = (u.ability?.trigger || "").toLowerCase();
            if (trig.includes("at the start of your beginning phase") || trig.includes("at start of your beginning phase")) {
              if (u.ability?.effect_text) {
                d.chain.push({
                  id: makeId("chain"),
                  controller: pid,
                  kind: "TRIGGERED_ABILITY",
                  label: `Start Phase: ${u.name}`,
                  effectText: u.ability.effect_text,
                  targets: [{ kind: "NONE" }],
                  needsTargets: false,
                });
                d.state = "CLOSED";
                d.priorityPlayer = pid;
                d.passesInRow = 0;
              }
            }
          });
        });
        d.log.unshift(`Turn ${d.turnNumber} begins for ${d.turnPlayer}.`);
        break;
      }
      default:
        break;
    }

    cleanupStateBased(d);
    maybeOpenNextWindow(d);
    return true;
  };

  const enginePassPriority = (d: GameState, pid: PlayerId): boolean => {
    if (d.priorityPlayer !== pid) return false;

    const top = d.chain[d.chain.length - 1];
    if (top && top.needsTargets && top.controller === pid) {
      const t0 = top.targets?.[0];
      if (!t0 || t0.kind === "NONE") {
        d.log.unshift("Choose targets before passing.");
        return false;
      }
    }

    d.passesInRow += 1;
    d.log.unshift(`${pid} passes.`);

    const inShowdown = d.windowKind === "SHOWDOWN" || (d.windowKind === "COMBAT" && d.combat?.step === "SHOWDOWN");

    // One pass: either pass Priority (closed) or pass Focus (open showdown with empty chain)
    if (d.passesInRow < 2) {
      if (inShowdown && d.chain.length === 0 && d.state === "OPEN") {
        d.focusPlayer = otherPlayer(pid);
        d.priorityPlayer = d.focusPlayer;
        d.log.unshift(`Focus passes to ${d.focusPlayer}.`);
      } else {
        d.priorityPlayer = otherPlayer(pid);
      }
      return true;
    }

    // Two consecutive passes
    if (d.chain.length > 0) {
      resolveTopOfChain(d);
      return true;
    }

    // No chain items: we're passing to end a showdown step
    if (d.windowKind === "SHOWDOWN") {
      const idx = d.windowBattlefieldIndex!;
      const bf = d.battlefields[idx];

      d.log.unshift(`Showdown at Battlefield ${idx + 1} ends (all players passed).`);
      d.windowKind = "NONE";
      d.windowBattlefieldIndex = null;
      d.focusPlayer = null;
      d.passesInRow = 0;
      d.state = "OPEN";
      d.priorityPlayer = d.turnPlayer;

      const p1 = bf.units.P1.length;
      const p2 = bf.units.P2.length;

      // If both sides have units, begin combat immediately
      if (p1 > 0 && p2 > 0) {
        const attacker = bf.contestedBy!;
        const defender = otherPlayer(attacker);
        d.windowKind = "COMBAT";
        d.windowBattlefieldIndex = idx;
        d.combat = { battlefieldIndex: idx, attacker, defender, step: "SHOWDOWN" };
        d.focusPlayer = attacker;
        d.priorityPlayer = attacker;
        d.passesInRow = 0;
        d.log.unshift(`Combat begins at Battlefield ${idx + 1}: ${attacker} attacks, ${defender} defends.`);
      } else {
        // Unopposed: the remaining player takes control and (if newly controlled) conquers for 1 point.
        const winner: PlayerId | null = p1 > 0 ? "P1" : p2 > 0 ? "P2" : null;
        const prev = bf.controller;

        if (winner) {
          bf.controller = winner;
          bf.contestedBy = null;
          d.log.unshift(`${winner} took control of Battlefield ${idx + 1} (unopposed).`);
          if (prev !== winner) attemptScore(d, winner, idx, "Conquer");
        } else {
          // No units left; battlefield becomes uncontrolled.
          bf.controller = null;
          bf.contestedBy = null;
        }

        cleanupStateBased(d);
        maybeOpenNextWindow(d);
      }
      return true;
    }

    if (d.windowKind === "COMBAT" && d.combat && d.combat.step === "SHOWDOWN") {
      d.passesInRow = 0;
      d.focusPlayer = null;
      d.log.unshift("Combat showdown ends. Assigning damage...");
      const bfi = d.combat.battlefieldIndex;
      const attacker = d.combat.attacker;
      const defender = d.combat.defender;
      assignCombatDamageAuto(d, bfi, attacker, defender);
      d.combat.step = "DAMAGE";
      resolveCombatResolution(d);
      return true;
    }

    // Fallback
    d.passesInRow = 0;
    d.priorityPlayer = d.turnPlayer;
    return true;
  };

  const engineExhaustRuneForEnergy = (d: GameState, pid: PlayerId, runeId: string): boolean => {
    const p = d.players[pid];
    const r = p.runesInPlay.find((x) => x.instanceId === runeId);
    if (!r) return false;
    if (!r.isReady) {
      d.log.unshift("Rune is exhausted.");
      return false;
    }
    // Rune ability: Exhaust: Add 1 Energy. This is a Reaction + Add and does not use chain (cannot be reacted to).
    r.isReady = false;
    p.runePool.energy += 1;
    d.log.unshift(`${pid} exhausted a ${r.domain} rune to add 1 energy.`);
    return true;
  };

  const engineRecycleRuneForPower = (d: GameState, pid: PlayerId, runeId: string): boolean => {
    const p = d.players[pid];
    const idx = p.runesInPlay.findIndex((x) => x.instanceId === runeId);
    if (idx < 0) return false;
    const r = p.runesInPlay[idx];
    p.runesInPlay.splice(idx, 1);
    p.runePool.power[r.domain] += 1;
    p.runeDeck.push({ ...r, isReady: true }); // bottom of rune deck
    d.log.unshift(`${pid} recycled a ${r.domain} rune to add 1 ${r.domain} power.`);
    return true;
  };

  const engineExhaustSealForPower = (d: GameState, pid: PlayerId, gearId: string): boolean => {
    const p = d.players[pid];
    const gidx = p.base.gear.findIndex((x) => x.instanceId === gearId);
    if (gidx < 0) return false;
    const gear = p.base.gear[gidx];
    if (!gear.isReady) {
      d.log.unshift("Gear is exhausted.");
      return false;
    }

    // Many seals are templated like:
    //   "Exhaust: [Reaction] — [Add] 1 order rune."
    // Card data often includes bracketed tags ([Add]) and punctuation (—) that can break naive regex parsing.
    const raw = (gear.ability?.raw_text || gear.ability?.effect_text || "").toString();

    const clean = raw
        .toLowerCase()
        .replace(/_/g, " ")
        .replace(/\[[^\]]+\]/g, (m) => m.slice(1, -1)) // [Add] -> Add
        .replace(/[—–]/g, "-")
        .replace(/[:.]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    // 1) Energy add (rare, but supported)
    const mEnergy = clean.match(/\badd\s+(\d+)\s+energy\b/);
    if (mEnergy) {
      const amt = Math.max(0, parseInt(mEnergy[1], 10) || 0);
      if (amt <= 0) return false;
      gear.isReady = false;
      p.runePool.energy += amt;
      d.log.unshift(`${pid} exhausted ${gear.name} to add ${amt} energy.`);
      return true;
    }

    // 2) Domain-specific "rune" add => add power of that domain.
    //    (Costs and effects often use "fury rune" to mean 1 Fury power.)
    const mDom = clean.match(/\badd\s+(\d+)?\s*(body|calm|chaos|fury|mind|order|class)\s+(?:rune|power)\b/);
    if (mDom) {
      const amt = Math.max(0, parseInt(mDom[1] || "1", 10) || 0);
      if (amt <= 0) return false;
      gear.isReady = false;
      if (mDom[2] === "class") {
        const allowed = classDomainsForPlayer(d, pid);
        const chosen = allowed[0] || "Colorless";
        p.runePool.power[chosen] += amt;
        d.log.unshift(`${pid} exhausted ${gear.name} to add ${amt} ${chosen} power (class rune).`);
      } else {
        const dom = clampDomain(mDom[2]);
        p.runePool.power[dom] += amt;
        d.log.unshift(`${pid} exhausted ${gear.name} to add ${amt} ${dom} power.`);
      }
      return true;
    }

    // 3) Any-domain add (fallback). If we can't infer a domain, assume it adds power matching the gear's domain
    //    (most seals are single-domain), otherwise default to the player's first domain.
    const mAny = clean.match(/\badd\s+(\d+)\s+(?:rune|power)\s+of\s+any\s+(?:type|domain|color)\b/) ||
        clean.match(/\badd\s+(\d+)\s+any\s+(?:rune|power)\b/);
    if (mAny) {
      const amt = Math.max(0, parseInt(mAny[1], 10) || 0);
      if (amt <= 0) return false;
      const doms = parseDomains(gear.domain).map(clampDomain).filter((x) => x !== "Colorless");
      const dom = doms[0] || p.domains[0] || "Fury";
      gear.isReady = false;
      p.runePool.power[dom] += amt;
      d.log.unshift(`${pid} exhausted ${gear.name} to add ${amt} ${dom} power (any-domain add).`);
      return true;
    }

    // Conservative fallback: if it looks like a Seal, try using its printed domain as the power domain.
    const looksLikeSeal = gear.name.toLowerCase().includes("seal") || /\bseal\b/i.test(raw) || (gear.ability?.keywords || []).some((k) => k.toLowerCase().includes("add"));
    if (looksLikeSeal) {
      const doms = parseDomains(gear.domain).map(clampDomain).filter((x) => x !== "Colorless");
      const dom = doms[0] || p.domains[0] || "Fury";
      gear.isReady = false;
      p.runePool.power[dom] += 1;
      d.log.unshift(`${pid} exhausted ${gear.name} to add 1 ${dom} power (fallback parse).`);
      return true;
    }

    d.log.unshift("This gear doesn't look like a Seal that adds resources (auto-detect failed).");
    return false;
  };

  type LegendActivatedParse = {
    rawLine: string;
    effectText: string;
    req: TargetRequirement;
    cost: {
      energy: number;
      powerByDomain: Partial<Record<Domain, number>>;
      powerClass: number;
      powerAny: number;
    };
  };

  const legendActivatedEffect = (legend: CardData | null): LegendActivatedParse | null => {
    if (!legend) return null;
    const rawAll = ((legend.ability?.raw_text || "") + "\n" + (legend.ability?.effect_text || "")).trim();
    if (!rawAll) return null;

    const lines = rawAll
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean);

    const pickLine =
        lines.find((l) => /\bexhaust\b\s*:/i.test(l)) ||
        lines.find((l) => /^\s*\[e\]\s*:/i.test(l)) ||
        lines.find((l) => /^\s*\[t\]\s*:/i.test(l)) ||  // [T]: is tap/exhaust notation
        lines.find((l) => /\bexhaust\b/i.test(l) && l.includes(":")) ||
        lines.find((l) => /,\s*\[t\]\s*:/i.test(l)) ||  // cost, [T]: pattern
        null;

    if (!pickLine) return null;

    const ex = /\bexhaust\b\s*:/i.exec(pickLine) || /^\s*\[e\]\s*:/i.exec(pickLine) || /^\s*\[t\]\s*:/i.exec(pickLine) || /,\s*\[t\]\s*:/i.exec(pickLine);
    if (!ex) return null;

    // Everything before "exhaust:" is treated as an activation cost (e.g. "1 energy,").
    const costPart = pickLine.slice(0, ex.index).trim();

    const cost: LegendActivatedParse["cost"] = {
      energy: 0,
      powerByDomain: {},
      powerClass: 0,
      powerAny: 0,
    };

    const energyM = costPart.match(/(\d+)\s*energy\b/i);
    if (energyM) {
      const n = parseInt(energyM[1], 10);
      if (Number.isFinite(n) && n > 0) cost.energy += n;
    }

    // Domain-specific rune costs (rare; but some legends/spells may have them)
    const runeRe = /(\d+)\s*(body|calm|chaos|fury|mind|order)\s*rune\b/gi;
    let rm: RegExpExecArray | null;
    while ((rm = runeRe.exec(costPart))) {
      const n = parseInt(rm[1], 10);
      const dom = clampDomain(rm[2]);
      if (Number.isFinite(n) && n > 0) cost.powerByDomain[dom] = (cost.powerByDomain[dom] || 0) + n;
    }

    const classCost = costPart.match(/(\d+)?\s*class\s*rune\b/i);
    if (classCost) {
      const n = classCost[1] ? parseInt(classCost[1], 10) : 1;
      if (Number.isFinite(n) && n > 0) cost.powerClass += n;
    }

    const anyM = costPart.match(/(\d+)\s*rune\s+of\s+any\s+type\b/i);
    if (anyM) {
      const n = parseInt(anyM[1], 10);
      if (Number.isFinite(n) && n > 0) cost.powerAny += n;
    }

    // Effect is everything after "exhaust:" or "[T]:" (cleaned up a bit)
    let eff = pickLine;

    // Remove any leading "[E]:" or "[T]:" shorthand for Exhaust/Tap.
    eff = eff.replace(/^\s*\[e\]\s*:/i, "").trim();
    eff = eff.replace(/^\s*\[t\]\s*:/i, "").trim();

    // Remove leading "exhaust:" (with optional costs before it).
    eff = eff.replace(/^[\s\S]*?\bexhaust\b\s*:/i, "").trim();
    
    // Remove cost + [T]: pattern (e.g., "[2], [T]:")
    eff = eff.replace(/^[\s\S]*?,\s*\[t\]\s*:/i, "").trim();

    // Remove leading "Action —" / "Reaction —" and also "[Reaction], [Legion] —" style labels.
    eff = eff.replace(/^\s*(action|reaction)\s*[—-]\s*/i, "").trim();
    eff = eff.replace(/^\s*(?:\[[^\]]+\]\s*,?\s*)+—\s*/i, "").trim();
    eff = eff.replace(/^\s*(?:\[[^\]]+\]\s*,?\s*)+/i, "").trim();
    eff = eff.replace(/^\s*[—-]\s*/i, "").trim();

    if (!eff) return null;

    const req = inferTargetRequirement(eff, { here: false });
    return { rawLine: pickLine, effectText: eff, req, cost };
  };


  const engineActivateLegend = (
      d: GameState,
      pid: PlayerId,
      targets?: Target[],
      opts?: { autoPay?: boolean }
  ): boolean => {
    const p = d.players[pid];
    if (!p.legend) return false;

    if (d.priorityPlayer !== pid) {
      d.log.unshift("You must have priority to activate your Legend.");
      return false;
    }

    const top = d.chain[d.chain.length - 1];
    if (top && top.needsTargets && top.controller === pid) {
      const t0 = top.targets?.[0];
      if (!t0 || t0.kind === "NONE") {
        d.log.unshift("Choose targets for your pending chain item first.");
        return false;
      }
    }

    if (!p.legendReady) {
      d.log.unshift("Legend is exhausted.");
      return false;
    }

    const parsed = legendActivatedEffect(p.legend);
    if (!parsed) {
      d.log.unshift("Legend has no activated Exhaust ability the emulator can parse yet.");
      return false;
    }

    const eff = parsed.effectText;
    const req = parsed.req;
    const chosen: Target[] = targets && targets.length ? targets : [{ kind: "NONE" }];

    const autoPay = !!opts?.autoPay;

    // ---- Pay activation costs (besides exhausting the legend itself) ----
    // Energy
    const energyNeed = parsed.cost.energy || 0;
    if (energyNeed > 0) {
      if (p.runePool.energy < energyNeed && autoPay) {
        // Auto-exhaust ready runes to generate energy
        let missing = energyNeed - p.runePool.energy;
        const readyRunes = p.runesInPlay.filter((r) => r.isReady);
        let used = 0;
        for (const r of readyRunes) {
          if (missing <= 0) break;
          r.isReady = false;
          p.runePool.energy += 1;
          missing -= 1;
          used += 1;
        }
        if (used > 0) d.log.unshift(`${pid} auto-exhausted ${used} rune(s) to pay Legend energy cost.`);
      }

      if (p.runePool.energy < energyNeed) {
        d.log.unshift(`Not enough energy to activate Legend (need ${energyNeed}).`);
        return false;
      }
      p.runePool.energy -= energyNeed;
      d.log.unshift(`${pid} paid ${energyNeed} energy for Legend activation.`);
    }

    // Domain-specific power (rare)
    const byDom = parsed.cost.powerByDomain || {};
    for (const dom of Object.keys(byDom) as Domain[]) {
      const need = byDom[dom] || 0;
      if (need <= 0) continue;

      if ((p.runePool.power[dom] || 0) < need && autoPay) {
        // Auto-recycle runes of that domain to generate power
        let missing = need - (p.runePool.power[dom] || 0);
        const candidates = p.runesInPlay.filter((r) => r.domain === dom);
        let used = 0;
        for (const r of candidates) {
          if (missing <= 0) break;
          engineRecycleRuneForPower(d, pid, r.instanceId);
          missing -= 1;
          used += 1;
        }
        if (used > 0) d.log.unshift(`${pid} auto-recycled ${used} ${dom} rune(s) to pay Legend power cost.`);
      }

      if ((p.runePool.power[dom] || 0) < need) {
        d.log.unshift(`Not enough ${dom} power to activate Legend (need ${need}).`);
        return false;
      }

      p.runePool.power[dom] -= need;
      d.log.unshift(`${pid} paid ${need} ${dom} power for Legend activation.`);
    }

    // Class power (any domain in identity)
    const classNeed = parsed.cost.powerClass || 0;
    if (classNeed > 0) {
      const allowed = classDomainsForPlayer(d, pid);
      if (runePoolTotalPower(p.runePool, allowed) < classNeed && autoPay) {
        let missing = classNeed - runePoolTotalPower(p.runePool, allowed);
        const candidates = p.runesInPlay.filter((r) => allowed.includes(r.domain));
        let used = 0;
        for (const r of candidates) {
          if (missing <= 0) break;
          engineRecycleRuneForPower(d, pid, r.instanceId);
          missing -= 1;
          used += 1;
        }
        if (used > 0) d.log.unshift(`${pid} auto-recycled ${used} rune(s) to pay Legend class power cost.`);
      }

      const pay = choosePowerPaymentDomains(p.runePool, classNeed, allowed);
      if (!pay) {
        d.log.unshift(`Not enough class power to activate Legend (need ${classNeed}).`);
        return false;
      }
      for (const dom of allowed) {
        const spend = pay.payment[dom] || 0;
        if (spend > 0) p.runePool.power[dom] -= spend;
      }
      d.log.unshift(`${pid} paid ${classNeed} class power for Legend activation.`);
    }

    // Any-domain power (very rare in activation costs)
    const anyNeed = parsed.cost.powerAny || 0;
    if (anyNeed > 0) {
      const ALL_DOMAINS: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];

      if (sumPower(p.runePool) < anyNeed && autoPay) {
        let missing = anyNeed - sumPower(p.runePool);
        const candidates = [...p.runesInPlay];
        let used = 0;
        for (const r of candidates) {
          if (missing <= 0) break;
          engineRecycleRuneForPower(d, pid, r.instanceId);
          missing -= 1;
          used += 1;
        }
        if (used > 0) d.log.unshift(`${pid} auto-recycled ${used} rune(s) to pay Legend any-power cost.`);
      }

      const pay = choosePowerPaymentDomains(p.runePool, anyNeed, ALL_DOMAINS);
      if (!pay) {
        d.log.unshift(`Not enough power to activate Legend (need ${anyNeed}).`);
        return false;
      }
      for (const dom of ALL_DOMAINS) {
        const spend = pay.payment[dom] || 0;
        if (spend > 0) p.runePool.power[dom] -= spend;
      }
      d.log.unshift(`${pid} paid ${anyNeed} power (any) for Legend activation.`);
    }

    // ---- Exhaust the legend (always part of the activation cost) ----
    p.legendReady = false;

    // If the activated effect is a pure resource-add ability, it can't be reacted to and resolves immediately.
    const detectEff = eff.replace(/\[\s*add\s*\]\s*/gi, "add ");
    const isUnreactableResourceAdd =
        /\badd\s+\d+\s+energy\b/i.test(detectEff) ||
        /\badd\s+(?:\d+\s+)?(body|calm|chaos|fury|mind|order|class)\s+rune\b/i.test(detectEff) ||
        /\badd\s+\d+\s+rune\s+of\s+any\s+type\b/i.test(detectEff);

    if (isUnreactableResourceAdd) {
      resolveEffectText(d, pid, eff, chosen, { battlefieldIndex: d.windowBattlefieldIndex ?? null, sourceCardName: p.legend.name });
      d.log.unshift(`${pid} activated Legend ability (${p.legend.name}).`);
      cleanupStateBased(d);
      maybeOpenNextWindow(d);

      d.state = "OPEN";
      d.passesInRow = 0;
      d.priorityPlayer = pid;
      return true;
    }

    // Target-selection gate (if needed)
    // (We still allow queuing the item so the UI can prompt for targets.)
    const item: ChainItem = {
      id: makeId("chain"),
      controller: pid,
      kind: "ACTIVATED_ABILITY",
      label: `Legend — ${p.legend.name}`,
      effectText: eff,
      contextBattlefieldIndex: d.windowBattlefieldIndex ?? null,
      targets: chosen,
      needsTargets: req.kind !== "NONE" && (!chosen[0] || chosen[0].kind === "NONE"),
      targetRequirement: req,
    };

    d.chain.push(item);
    d.state = "CLOSED";
    d.passesInRow = 0;
    d.priorityPlayer = pid;
    d.log.unshift(`${pid} activated Legend ability (${p.legend.name}).`);

    // No immediate resolution; abilities can be responded to.
    cleanupStateBased(d);
    maybeOpenNextWindow(d);
    return true;
  };


  const applyEngineAction = (d: GameState, action: EngineAction): void => {
    switch (action.type) {
      case "NEXT_STEP":
        engineNextStep(d, action.player);
        return;
      case "PASS_PRIORITY":
        enginePassPriority(d, action.player);
        return;
      case "MULLIGAN_CONFIRM":
        engineConfirmMulligan(d, action.player, action.recycleIds);
        return;
      case "SET_CHAIN_TARGETS":
        engineSetChainTargets(d, action.player, action.chainItemId, action.targets);
        return;
      case "HIDE_CARD":
        engineHideCard(d, action.player, action.cardInstanceId, action.battlefieldIndex, { autoPay: action.autoPay });
        cleanupStateBased(d);
        maybeOpenNextWindow(d);
        return;
      case "STANDARD_MOVE":
        engineStandardMove(d, action.player, action.from, action.unitIds, action.to);
        cleanupStateBased(d);
        maybeOpenNextWindow(d);
        return;
      case "PLAY_CARD": {
        const res = enginePlayCard(
            d,
            action.player,
            {
              source: action.source,
              cardInstanceId: action.cardInstanceId,
              fromBattlefieldIndex: action.fromBattlefieldIndex,
              destination: action.destination ?? null,
              accelerate: action.accelerate,
              targets: action.targets,
            },
            { autoPay: action.autoPay }
        );
        if (!res.ok && res.reason) d.log.unshift(`Play failed: ${res.reason}`);
        return;
      }
      case "RUNE_EXHAUST":
        engineExhaustRuneForEnergy(d, action.player, action.runeInstanceId);
        return;
      case "RUNE_RECYCLE":
        engineRecycleRuneForPower(d, action.player, action.runeInstanceId);
        return;
      case "SEAL_EXHAUST":
        engineExhaustSealForPower(d, action.player, action.gearInstanceId);
        return;
      case "LEGEND_ACTIVATE":
        engineActivateLegend(d, action.player, action.targets, { autoPay: action.autoPay });
        return;
      default:
        return;
    }
  };

  const sanitizeEngineAction = (actionAny: any): EngineAction | null => {
    if (!actionAny || typeof actionAny !== "object") return null;
    const t = (actionAny as any).type;
    const p = (actionAny as any).player;
    if (typeof t !== "string") return null;
    if (!isPlayerId(p)) return null;

    // NOTE: We intentionally keep these checks lightweight. The goal is to prevent
    // non-game objects (e.g., DOM events) from leaking into the state/action history.
    switch (t) {
      case "NEXT_STEP":
      case "PASS_PRIORITY":
        return { type: t, player: p } as EngineAction;

      case "MULLIGAN_CONFIRM": {
        const recycleIdsRaw = (actionAny as any).recycleIds;
        const recycleIds = Array.isArray(recycleIdsRaw) ? recycleIdsRaw.filter((x: any) => typeof x === "string") : [];
        return { type: "MULLIGAN_CONFIRM", player: p, recycleIds };
      }

      case "SET_CHAIN_TARGETS": {
        const chainItemId = typeof (actionAny as any).chainItemId === "string" ? (actionAny as any).chainItemId : "";
        const targets = Array.isArray((actionAny as any).targets) ? (actionAny as any).targets : [{ kind: "NONE" }];
        if (!chainItemId) return null;
        return { type: "SET_CHAIN_TARGETS", player: p, chainItemId, targets } as EngineAction;
      }

      case "PLAY_CARD": {
        const source = (actionAny as any).source;
        if (source !== "HAND" && source !== "CHAMPION" && source !== "FACEDOWN") return null;
        const cardInstanceId = typeof (actionAny as any).cardInstanceId === "string" ? (actionAny as any).cardInstanceId : "";
        if (!cardInstanceId) return null;
        const fromBattlefieldIndex =
            typeof (actionAny as any).fromBattlefieldIndex === "number" ? (actionAny as any).fromBattlefieldIndex : undefined;
        const destination = (actionAny as any).destination ?? null;
        const accelerate = (actionAny as any).accelerate;
        const targets = Array.isArray((actionAny as any).targets) ? (actionAny as any).targets : undefined;
        const autoPay = !!(actionAny as any).autoPay;
        return {
          type: "PLAY_CARD",
          player: p,
          source,
          cardInstanceId,
          fromBattlefieldIndex,
          destination,
          accelerate,
          targets,
          autoPay,
        } as EngineAction;
      }

      case "HIDE_CARD": {
        const cardInstanceId = typeof (actionAny as any).cardInstanceId === "string" ? (actionAny as any).cardInstanceId : "";
        const battlefieldIndex = typeof (actionAny as any).battlefieldIndex === "number" ? (actionAny as any).battlefieldIndex : NaN;
        if (!cardInstanceId || !Number.isFinite(battlefieldIndex)) return null;
        const autoPay = !!(actionAny as any).autoPay;
        return { type: "HIDE_CARD", player: p, cardInstanceId, battlefieldIndex, autoPay } as EngineAction;
      }

      case "STANDARD_MOVE": {
        const from = (actionAny as any).from;
        const to = (actionAny as any).to;
        const unitIdsRaw = (actionAny as any).unitIds;
        const unitIds = Array.isArray(unitIdsRaw) ? unitIdsRaw.filter((x: any) => typeof x === "string") : [];
        if (!from || !to || unitIds.length === 0) return null;
        return { type: "STANDARD_MOVE", player: p, from, to, unitIds } as EngineAction;
      }

      case "RUNE_EXHAUST":
      case "RUNE_RECYCLE": {
        const runeInstanceId = typeof (actionAny as any).runeInstanceId === "string" ? (actionAny as any).runeInstanceId : "";
        if (!runeInstanceId) return null;
        return { type: t, player: p, runeInstanceId } as EngineAction;
      }

      case "SEAL_EXHAUST": {
        const gearInstanceId = typeof (actionAny as any).gearInstanceId === "string" ? (actionAny as any).gearInstanceId : "";
        if (!gearInstanceId) return null;
        return { type: "SEAL_EXHAUST", player: p, gearInstanceId } as EngineAction;
      }

      case "LEGEND_ACTIVATE": {
        const targets = Array.isArray((actionAny as any).targets) ? (actionAny as any).targets : undefined;
        const autoPay = !!(actionAny as any).autoPay;
        return { type: "LEGEND_ACTIVATE", player: p, targets, autoPay } as EngineAction;
      }

      default:
        return null;
    }
  };

  const dispatchEngineAction = (actionAny: any) => {
    if (!g) return;
    const action = sanitizeEngineAction(actionAny);
    if (!action) return;

    updateGame((d) => {
      applyEngineAction(d, action);
      if (!(d as any).actionHistory) (d as any).actionHistory = [];
      d.actionHistory.push(action);
      if (d.actionHistory.length > 4000) d.actionHistory.shift();
    });
  };





  // ----------------------------- AI engine action layer -----------------------------

  type AiIntent =
      | { type: "PASS" }
      | { type: "NEXT_STEP" }
      | { type: "MULLIGAN"; recycleIds: string[] }
      | {
    type: "PLAY";
    source: "HAND" | "CHAMPION" | "FACEDOWN";
    cardInstanceId: string;
    fromBattlefieldIndex?: number;
    destination?: { kind: "BASE" } | { kind: "BF"; index: number } | null;
    accelerate?: { pay: boolean; domain: Domain };
    targets?: Target[];
  }
      | { type: "HIDE"; cardInstanceId: string; battlefieldIndex: number }
      | {
    type: "MOVE";
    from: { kind: "BASE" } | { kind: "BF"; index: number };
    to: { kind: "BASE" } | { kind: "BF"; index: number };
    unitIds: string[];
  }
      | { type: "SET_CHAIN_TARGETS"; chainItemId: string; targets: Target[] };

  const canSpellTimingNow = (
      d: GameState,
      pid: PlayerId,
      card: CardInstance,
      source: "HAND" | "CHAMPION" | "FACEDOWN" = "HAND"
  ): boolean => {
    if (card.type !== "Spell") return true;

    const outOfCombat = d.windowKind === "NONE" && d.chain.length === 0 && d.state === "OPEN";
    if (outOfCombat) {
      return d.step === "ACTION" && d.turnPlayer === pid;
    }

    // Hidden cards gain Reaction beginning on the next player's turn; emulate that by allowing
    // FACEDOWN plays during showdown timing (but not during the owner's "main" open state unless it's their turn).
    const inShowdown = d.windowKind === "SHOWDOWN" || (d.windowKind === "COMBAT" && d.combat?.step === "SHOWDOWN");

    const kws = card.ability?.keywords || [];
    const hasAction = kws.some((k) => k.toLowerCase().startsWith("action"));
    const hasReaction =
        kws.some((k) => k.toLowerCase().startsWith("reaction")) || (source === "FACEDOWN" && inShowdown);

    return hasAction || hasReaction;
  };

  const engineSetChainTargets = (d: GameState, pid: PlayerId, chainItemId: string, targets: Target[]) => {
    const item = d.chain.find((x) => x.id === chainItemId);
    if (!item) return;
    if (item.controller !== pid) return;
    const noneT: Target = { kind: "NONE" };
    const chosen: Target[] = targets && targets.length > 0 ? targets : [noneT];
    if (item.needsTargets && (!chosen[0] || chosen[0].kind === "NONE")) {
      d.log.unshift("AI: no valid targets; skipping target selection.");
      item.targets = [{ kind: "NONE" }];
      item.needsTargets = false;
      return;
    }
    // Enforce hidden restriction (target must be at source battlefield if restricted).
    const rbf = item.restrictTargetsToBattlefieldIndex ?? null;
    if (rbf != null && chosen[0]) {
      if (chosen[0].kind === "UNIT") {
        const loc = locateUnit(d, chosen[0].owner, chosen[0].instanceId);
        if (!loc || loc.zone !== "BF" || loc.battlefieldIndex !== rbf) {
          d.log.unshift("AI: hidden restriction prevented illegal target; choosing NONE.");
          item.targets = [{ kind: "NONE" }];
          item.needsTargets = false;
          return;
        }
      }
      if (chosen[0].kind === "BATTLEFIELD" && chosen[0].index !== rbf) {
        d.log.unshift("AI: hidden restriction prevented illegal battlefield target; choosing NONE.");
        item.targets = [{ kind: "NONE" }];
        item.needsTargets = false;
        return;
      }
    }
    item.targets = chosen;
    item.needsTargets = false;
    d.passesInRow = 0;
    d.priorityPlayer = item.controller;
    d.log.unshift(`${pid} chose targets for: ${item.label}`);
  };

  const engineConfirmMulligan = (d: GameState, pid: PlayerId, recycleIds: string[]) => {
    if (d.step !== "MULLIGAN") return;
    const p = d.players[pid];
    if (p.mulliganDone) return;
    const ids = new Set(recycleIds.slice(0, 2));
    const selected = p.hand.filter((c) => ids.has(c.instanceId));
    // Remove selected from hand
    p.hand = p.hand.filter((c) => !ids.has(c.instanceId));
    // Recycle selected cards to bottom of main deck (random order).
    const recycled = shuffle(selected, d.turnNumber + (pid === "P1" ? 7 : 11));
    p.mainDeck.push(...recycled);
    // Draw replacements
    drawCards(d, pid, recycled.length);
    p.mulliganDone = true;
    p.mulliganSelectedIds = [];
    d.log.unshift(`${pid} mulligan confirmed (${recycled.length} recycled, ${recycled.length} drawn).`);

    if (d.players.P1.mulliganDone && d.players.P2.mulliganDone) {
      d.players.P1.scoredBattlefieldsThisTurn = [];
      d.players.P2.scoredBattlefieldsThisTurn = [];
      d.players.P1.mainDeckCardsPlayedThisTurn = 0;
      d.players.P2.mainDeckCardsPlayedThisTurn = 0;
      d.step = "AWAKEN";
      d.priorityPlayer = d.turnPlayer;
      d.state = "OPEN";
      d.passesInRow = 0;
      d.log.unshift(`Turn ${d.turnNumber} begins for ${d.turnPlayer}.`);
    }
  };

  const engineHideCard = (d: GameState, pid: PlayerId, cardInstanceId: string, battlefieldIndex: number, opts?: { autoPay?: boolean }) => {
    if (d.step !== "ACTION") return;
    if (d.turnPlayer !== pid) return;
    if (d.windowKind !== "NONE" || d.chain.length > 0 || d.state !== "OPEN") return;

    const p = d.players[pid];
    const cardIdx = p.hand.findIndex((c) => c.instanceId === cardInstanceId);
    if (cardIdx < 0) return;
    const card = p.hand[cardIdx];
    if (!isHiddenCard(card)) return;

    const bf = d.battlefields[battlefieldIndex];
    if (bf.facedown) return;
    if (bf.controller !== pid) return;

    // Pay Hide cost: [A] (1 power of any domain).
    const anyDomains = ALL_POWER_DOMAINS;
    const swiftScoutActive = p.legend?.name === "Swift Scout";
    let canPayPower = choosePowerPaymentDomains(p.runePool, 1, anyDomains) !== null;
    let canPayEnergy = swiftScoutActive && p.runePool.energy >= 1;
    let canPay = canPayPower || canPayEnergy;
    if (!canPayPower && !canPayEnergy && opts?.autoPay) {
      const plan = buildAutoPayPlan(p.runePool, p.runesInPlay, {
        energyNeed: 0,
        basePowerNeed: 0,
        powerDomainsAllowed: anyDomains,
        additionalPowerByDomain: {},
        additionalPowerAny: 1,
      });
      if (plan && Object.keys(plan.runeUses).length > 0) {
        applyAutoPayPlan(d, pid, plan);
        d.log.unshift(`${pid} auto-paid the Hide cost.`);
      }
      canPayPower = choosePowerPaymentDomains(p.runePool, 1, anyDomains) !== null;
      canPay = canPayPower || canPayEnergy;
    }
    if (!canPay) return;

    if (canPayPower) {
      const pay = choosePowerPaymentDomains(p.runePool, 1, anyDomains)!;
      for (const dom of Object.keys(pay.payment) as Domain[]) p.runePool.power[dom] -= pay.payment[dom];
    } else if (canPayEnergy) {
      p.runePool.energy -= 1;
      d.log.unshift(`${pid} paid 1 energy to hide a card (Swift Scout).`);
    }

    p.hand.splice(cardIdx, 1);
    bf.facedown = { card, owner: pid, hiddenOnTurn: d.turnNumber, markedForRemoval: false };
    d.log.unshift(`${pid} hid a card at Battlefield ${battlefieldIndex + 1}.`);
  };

  const engineStandardMove = (
      d: GameState,
      pid: PlayerId,
      from: { kind: "BASE" } | { kind: "BF"; index: number },
      unitIds: string[],
      to: { kind: "BASE" } | { kind: "BF"; index: number }
  ) => {
    if (d.step !== "ACTION") return;
    if (d.turnPlayer !== pid) return;
    if (d.windowKind !== "NONE" || d.chain.length > 0 || d.state !== "OPEN") return;
    if (unitIds.length === 0) return;

    const p = d.players[pid];
    const pullFrom = (src: typeof from): CardInstance[] => {
      if (src.kind === "BASE") return p.base.units;
      return d.battlefields[src.index].units[pid];
    };
    const pushTo = (dst: typeof to): CardInstance[] => {
      if (dst.kind === "BASE") return p.base.units;
      return d.battlefields[dst.index].units[pid];
    };

    const srcArr = pullFrom(from);
    const moving: CardInstance[] = [];
    for (const id of unitIds) {
      const idx = srcArr.findIndex((u) => u.instanceId === id);
      if (idx < 0) continue;
      const u = srcArr[idx];
      if (!u.isReady) return;
      moving.push(u);
    }
    if (moving.length === 0) return;

    if (from.kind !== "BASE" && to.kind !== "BASE" && from.index !== to.index) {
      const allGanking = moving.every((u) => hasKeyword(u, "Ganking"));
      if (!allGanking) return;
    }

    const ids = new Set(unitIds);
    const remaining = srcArr.filter((u) => !ids.has(u.instanceId));
    if (from.kind === "BASE") p.base.units = remaining;
    else d.battlefields[from.index].units[pid] = remaining;

    for (const u of moving) {
      u.isReady = false;
      u.moveCountThisTurn += 1;
    }
    const dstArr = pushTo(to);
    dstArr.push(...moving);

    d.log.unshift(
        `${pid} moved ${moving.length} unit(s) from ${from.kind === "BASE" ? "Base" : `Battlefield ${from.index + 1}`} to ${
            to.kind === "BASE" ? "Base" : `Battlefield ${to.index + 1}`
        }.`
    );

    if (to.kind === "BF") {
      const bf = d.battlefields[to.index];
      if (bf.controller !== pid) bf.contestedBy = pid;
    }

    checkMoveFromLocationTriggers(d, pid, moving, from, to);
    checkMoveTriggers(d, pid, moving, to.kind === "BF" ? to.index : "BASE");
  };

  const enginePlayCard = (
      d: GameState,
      pid: PlayerId,
      params: {
        source: "HAND" | "CHAMPION" | "FACEDOWN";
        cardInstanceId: string;
        fromBattlefieldIndex?: number;
        destination?: { kind: "BASE" } | { kind: "BF"; index: number } | null;
        accelerate?: { pay: boolean; domain: Domain };
        targets?: Target[];
      },
      opts?: { autoPay?: boolean }
  ): { ok: boolean; reason?: string } => {
    if (d.step === "GAME_OVER") return { ok: false, reason: "Game over" };
    const p = d.players[pid];

    // Timing gates (match commitPendingPlay).
    if (params.source !== "FACEDOWN" && d.step !== "MULLIGAN" && d.step !== "ACTION" && d.step !== "DRAW" && d.step !== "CHANNEL" && d.step !== "SCORING" && d.step !== "AWAKEN") {
      // Keep permissive; engine enforces via canPlayNonspellOutsideShowdown/canSpellTimingNow below.
    }

    let card: CardInstance | null = null;
    let fromLabel = "";
    let hiddenCtxBf: number | null = null;
    let isHiddenPlay = false;

    if (params.source === "HAND") {
      const idx = p.hand.findIndex((c) => c.instanceId === params.cardInstanceId);
      if (idx < 0) return { ok: false, reason: "Card not in hand" };
      card = p.hand[idx];
      fromLabel = "hand";
    } else if (params.source === "CHAMPION") {
      if (!p.championZone || p.championZone.instanceId !== params.cardInstanceId) return { ok: false, reason: "Champion not available" };
      card = p.championZone;
      fromLabel = "champion";
    } else {
      const bfIdx = params.fromBattlefieldIndex ?? null;
      if (bfIdx == null) return { ok: false, reason: "Missing battlefield index" };
      const bf = d.battlefields[bfIdx];
      if (!bf.facedown || bf.facedown.owner !== pid) return { ok: false, reason: "No facedown card" };
      if (bf.facedown.hiddenOnTurn === d.turnNumber) return { ok: false, reason: "Cannot play hidden same turn" };
      card = bf.facedown.card;
      fromLabel = `facedown @ BF${bfIdx + 1}`;
      hiddenCtxBf = bfIdx;
      isHiddenPlay = true;
    }
    if (!card) return { ok: false, reason: "No card" };

    // Spell timing check
    if (!canSpellTimingNow(d, pid, card, params.source)) return { ok: false, reason: "Spell timing" };

    // Non-spell timing check
    if (card.type !== "Spell") {
      if (!canPlayNonspellOutsideShowdown(card, d, pid, params.source)) return { ok: false, reason: "Non-spell timing" };
    }

    // Legion is a conditional effect: it turns "on" if you've played another main-deck card earlier this turn.
    // (It should not prevent playing the card.)
    const playedAnotherCardThisTurn = p.mainDeckCardsPlayedThisTurn > 0;
    const legionActiveThisPlay = hasKeyword(card, "Legion") && playedAnotherCardThisTurn;

    // Determine target requirement for spells
    let inferredReq: TargetRequirement = { kind: "NONE" };
    if (card.type === "Spell") inferredReq = inferTargetRequirement(card.ability?.effect_text || "", { here: false });

    const chosenTargets: Target[] = params.targets && params.targets.length > 0 ? params.targets : [{ kind: "NONE" }];
    if (card.type === "Spell" && inferredReq.kind !== "NONE" && (!chosenTargets[0] || chosenTargets[0].kind === "NONE")) {
      return { ok: false, reason: "Missing target" };
    }

    // Hidden targeting restriction: must target same battlefield if applicable
    const restrictBf = isHiddenPlay ? hiddenCtxBf : null;
    if (restrictBf != null && chosenTargets[0]) {
      if (chosenTargets[0].kind === "UNIT") {
        const loc = locateUnit(d, chosenTargets[0].owner, chosenTargets[0].instanceId);
        if (!loc || loc.zone !== "BF" || loc.battlefieldIndex !== restrictBf) {
          return { ok: false, reason: "Hidden restriction target" };
        }
      }
      if (chosenTargets[0].kind === "BATTLEFIELD" && chosenTargets[0].index !== restrictBf) {
        return { ok: false, reason: "Hidden restriction battlefield" };
      }
    }

    // Determine destination rules for permanents
    let dest = params.destination ?? null;
    if (card.type === "Unit") {
      if (!dest || dest.kind === undefined) dest = { kind: "BASE" };
      if (dest.kind === "BF") {
        const bf = d.battlefields[dest.index];
        if (!isHiddenPlay && bf.controller !== pid) return { ok: false, reason: "Must control battlefield to deploy" };
        const opponent = otherPlayer(pid);
        const opponentWarden = d.battlefields.some((field) =>
            field.units[opponent].some((u) => {
              const raw = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`.toLowerCase();
              return raw.includes("while i'm at a battlefield") && raw.includes("opponents can only play units to their base");
            })
        );
        if (opponentWarden) return { ok: false, reason: "Unit deployment restricted (Mageseeker Warden)" };
      }
      if (isHiddenPlay) dest = { kind: "BF", index: hiddenCtxBf! };
    }
    if (card.type === "Gear") {
      if (isHiddenPlay) dest = { kind: "BF", index: hiddenCtxBf! };
      else dest = { kind: "BASE" };
    }

    // Accelerate add-on
    const wantsAccelerate = !!params.accelerate?.pay && card.type === "Unit" && hasKeyword(card, "Accelerate");
    const accelDom: Domain | null = wantsAccelerate ? params.accelerate?.domain || null : null;

    // Power domains allowed (card domain identity; Colorless falls back to player's domains)
    const doms = parseDomains(card.domain).map(clampDomain).filter((x) => x !== "Colorless");
    const powerDomainsAllowed = doms.length > 0 ? doms : p.domains;

    // Compute deflect tax (extra any-domain power)
    const taxTarget = chosenTargets[0]?.kind === "UNIT" ? locateUnit(d, chosenTargets[0].owner, chosenTargets[0].instanceId)?.unit || null : null;
    const deflectTax = card.type === "Spell" ? computeDeflectTax(taxTarget) : 0;

    const legionDiscountE = legionActiveThisPlay ? extractLegionEnergyDiscount(card) : 0;
    let overrideEnergyCost = isHiddenPlay ? 0 : legionDiscountE > 0 ? Math.max(0, (card.cost ?? 0) - legionDiscountE) : undefined;
    let overridePowerCost = isHiddenPlay ? 0 : undefined;

    const effectTextRaw = card.ability?.effect_text || "";
    const effectLower = effectTextRaw.toLowerCase();
    const battlefieldSpellDiscount =
        card.type === "Spell"
            ? d.battlefields.some((bf) =>
                bf.units[pid].some((u) => {
                  const raw = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`.toLowerCase();
                  return raw.includes("while i'm at a battlefield") && raw.includes("energy costs for spells you play is reduced by 1 energy");
                })
            )
                ? 1
                : 0
            : 0;
    if (/this costs \d+ energy less/i.test(effectTextRaw)) {
      const m = effectLower.match(/this costs (\d+) energy less/i);
      const reduce = m ? parseInt(m[1], 10) : 0;
      const opponent = otherPlayer(pid);
      const withinVictory = effectLower.includes("within 3 points of the victory score")
          ? d.players[opponent].points >= d.victoryScore - 3
          : true;
      const enemyUnitDied = effectLower.includes("if an enemy unit has died this turn")
          ? d.players[pid].enemyUnitsDiedThisTurn > 0
          : true;
      if (withinVictory && enemyUnitDied && reduce > 0) {
        const base = overrideEnergyCost ?? card.cost ?? 0;
        overrideEnergyCost = Math.max(0, base - reduce);
      }
    }

    if (battlefieldSpellDiscount > 0) {
      const base = overrideEnergyCost ?? card.cost ?? 0;
      overrideEnergyCost = Math.max(1, base - battlefieldSpellDiscount);
    }

    const baseEnergyCost = overrideEnergyCost ?? (card.cost ?? 0);
    const basePowerCost = overridePowerCost ?? (card.stats.power ?? 0);
    const additionalCost = resolveAdditionalCostsForPlay(d, pid, card, effectTextRaw, baseEnergyCost, basePowerCost);
    if (additionalCost.error) return { ok: false, reason: additionalCost.error };
    const playEffectText = additionalCost.effectText;
    const additionalCostPaid = additionalCost.additionalCostPaid;
    if (typeof additionalCost.overrideEnergyCost === "number") overrideEnergyCost = additionalCost.overrideEnergyCost;
    if (typeof additionalCost.overridePowerCost === "number") overridePowerCost = additionalCost.overridePowerCost;

    const extraPowerByDomain = {
      ...(wantsAccelerate && accelDom ? ({ [accelDom]: 1 } as Partial<Record<Domain, number>>) : {}),
      ...(additionalCost.additionalPowerByDomain || {}),
    };

    const costOpts = {
      powerDomainsAllowed,
      overrideEnergyCost,
      overridePowerCost,
      additionalEnergy: wantsAccelerate ? 1 : 0,
      additionalPowerByDomain: extraPowerByDomain,
      additionalPowerAny: deflectTax,
    };

    let affordable = canAffordCardWithChoices(d, pid, card, costOpts);
    if (!affordable && opts?.autoPay) {
      // Attempt to auto-pay with runes in play.
      const plan = buildAutoPayPlan(p.runePool, p.runesInPlay, {
        energyNeed: (overrideEnergyCost ?? card.cost) + (wantsAccelerate ? 1 : 0),
        basePowerNeed: overridePowerCost ?? (card.stats.power ?? 0),
        powerDomainsAllowed,
        additionalPowerByDomain: extraPowerByDomain,
        additionalPowerAny: deflectTax,
      });
      if (plan && Object.keys(plan.runeUses).length > 0) {
        applyAutoPayPlan(d, pid, plan);
        d.log.unshift(`${pid} auto-paid runes for ${card.name}.`);
      }
      affordable = canAffordCardWithChoices(d, pid, card, costOpts);
    }
    if (!affordable) return { ok: false, reason: "Cannot afford" };

    // Actually pay costs
    payCost(d, pid, card, costOpts);

    // Deflect tax goes to the target unit's controller's rune pool (per rules)
    if (deflectTax > 0 && taxTarget) {
      const targetController = taxTarget.controller;
      if (targetController !== pid) {
        // Add the deflect tax to the target's controller's rune pool as Colorless power
        d.players[targetController].runePool.power.Colorless += deflectTax;
        d.log.unshift(`${targetController} received ${deflectTax} Colorless power from Deflect tax.`);
      }
    }

    // Remove from zone
    if (params.source === "HAND") {
      const idx = p.hand.findIndex((c) => c.instanceId === params.cardInstanceId);
      if (idx >= 0) p.hand.splice(idx, 1);
      p.mainDeckCardsPlayedThisTurn += 1;
    } else if (params.source === "CHAMPION") {
      p.championZone = null;
      p.mainDeckCardsPlayedThisTurn += 1;
    } else {
      const bfIdx = params.fromBattlefieldIndex ?? hiddenCtxBf;
      if (bfIdx != null) {
        const bf = d.battlefields[bfIdx];
        if (bf.facedown && bf.facedown.owner === pid) bf.facedown = null;
      }
      p.mainDeckCardsPlayedThisTurn += 1;
    }

    // Put on chain
    const chainWasEmpty = d.chain.length === 0;
    const itemId = makeId("chain");
    const playDest = card.type === "Unit" || card.type === "Gear" ? (dest as any) : null;

    const chainItem: ChainItem = {
      id: itemId,
      controller: pid,
      kind: "PLAY_CARD",
      label: `Play ${card.name}`,
      sourceCard: card,
      sourceZone: params.source,
      playDestination: playDest,
      effectText: playEffectText || "",
      contextBattlefieldIndex: params.source === "FACEDOWN" ? hiddenCtxBf : d.windowBattlefieldIndex,
      targets: chosenTargets,
      restrictTargetsToBattlefieldIndex: restrictBf,
      legionActive: legionActiveThisPlay,
      additionalCostPaid,
    };

    // Adjust readiness for Accelerate (units) / default ready (gear)
    if (card.type === "Unit") {
      card.isReady = wantsAccelerate;
      const raw = `${card.ability?.effect_text || ""} ${card.ability?.raw_text || ""}`.toLowerCase();
      if (raw.includes("if an opponent controls a battlefield") && raw.includes("i enter ready")) {
        const opponent = otherPlayer(pid);
        const opponentControls = d.battlefields.some((bf) => bf.controller === opponent);
        if (opponentControls) card.isReady = true;
      }
      if (raw.includes("if an opponent's score is within 3 points of the victory score") && raw.includes("i enter ready")) {
        const opponent = otherPlayer(pid);
        if (d.players[opponent].points >= d.victoryScore - 3) card.isReady = true;
      }
    }
    if (card.type === "Gear") card.isReady = true;

    d.chain.push(chainItem);
    d.state = "CLOSED";
    d.priorityPlayer = pid;
    d.passesInRow = 0;
    d.log.unshift(`${pid} played ${card.name} from ${fromLabel}.`);

    // Immediately resolve permanents if they started the chain.
    if (chainWasEmpty && card.type !== "Spell") {
      resolveTopOfChain(d);
    }

    checkGlobalTriggers(d, "PLAY_CARD", { player: pid, card });
    if (isHiddenPlay) {
      queueTriggersForEvent(
          d,
          pid,
          (trig, source) => {
            if (!trig.includes("when you play a card from")) return false;
            const raw = `${source.ability?.effect_text || ""} ${source.ability?.raw_text || ""}`.toLowerCase();
            return raw.includes("[hidden]");
          },
          (source) => source.ability?.effect_text
      );
    }

    cleanupStateBased(d);
    maybeOpenNextWindow(d);
    return { ok: true };
  };

  const applyAiIntent = (pid: PlayerId, intent: AiIntent) => {
    switch (intent.type) {
      case "PASS":
        dispatchEngineAction({ type: "PASS_PRIORITY", player: pid });
        return;
      case "NEXT_STEP":
        dispatchEngineAction({ type: "NEXT_STEP", player: pid });
        return;
      case "MULLIGAN":
        dispatchEngineAction({ type: "MULLIGAN_CONFIRM", player: pid, recycleIds: intent.recycleIds });
        return;
      case "SET_CHAIN_TARGETS":
        dispatchEngineAction({ type: "SET_CHAIN_TARGETS", player: pid, chainItemId: intent.chainItemId, targets: intent.targets });
        return;
      case "HIDE":
        dispatchEngineAction({ type: "HIDE_CARD", player: pid, cardInstanceId: intent.cardInstanceId, battlefieldIndex: intent.battlefieldIndex, autoPay: true });
        return;
      case "MOVE":
        dispatchEngineAction({ type: "STANDARD_MOVE", player: pid, from: intent.from, unitIds: intent.unitIds, to: intent.to });
        return;
      case "PLAY":
        dispatchEngineAction({
          type: "PLAY_CARD",
          player: pid,
          source: intent.source,
          cardInstanceId: intent.cardInstanceId,
          fromBattlefieldIndex: intent.fromBattlefieldIndex,
          destination: intent.destination ?? null,
          accelerate: intent.accelerate,
          targets: intent.targets,
          autoPay: true,
        });
        return;
      default:
        return;
    }
  };

  const aiCardNumericValue = (c: CardInstance): number => {
    if (c.type === "Unit") return (c.stats.might || 0) * 3 - (c.cost || 0) + (hasKeyword(c, "Ganking") ? 1 : 0) + (hasKeyword(c, "Deflect") ? 1 : 0);
    if (c.type === "Gear") return 1 - (c.cost || 0);
    if (c.type === "Spell") {
      const raw = (c.ability?.effect_text || "").toLowerCase();
      const dmg = extractDamageAmount(raw);
      if (dmg) return dmg * 2 - (c.cost || 0);
      if (raw.includes("kill")) return 6;
      if (raw.includes("banish")) return 5;
      if (raw.includes("stun")) return 3;
      return 0;
    }
    return 0;
  };

  const aiBoardScore = (d: GameState, pid: PlayerId): number => {
    const opp = otherPlayer(pid);
    const my = d.players[pid];
    const en = d.players[opp];

    // Terminal
    if (d.step === "GAME_OVER") {
      const myWin = my.points >= d.victoryScore && en.points < d.victoryScore;
      const enWin = en.points >= d.victoryScore && my.points < d.victoryScore;
      if (myWin) return 999999;
      if (enWin) return -999999;
      return (my.points - en.points) * 10000;
    }

    const myControlled = d.battlefields.filter((bf) => bf.controller === pid).length;
    const enControlled = d.battlefields.filter((bf) => bf.controller === opp).length;
    const myContesting = d.battlefields.filter((bf) => bf.contestedBy === pid).length;
    const enContesting = d.battlefields.filter((bf) => bf.contestedBy === opp).length;

    const bfMight = (p: PlayerId) =>
        d.battlefields.reduce(
            (sum, bf) => sum + bf.units[p].reduce((a, u) => a + effectiveMight(u, { role: "NONE", game: d, battlefieldIndex: bf.index }), 0),
            0
        );
    const baseMight = (p: PlayerId) => d.players[p].base.units.reduce((a, u) => a + effectiveMight(u, { role: "NONE", game: d }), 0);

    const unitsOnBoard = (p: PlayerId) =>
        d.players[p].base.units.length + d.battlefields.reduce((sum, bf) => sum + bf.units[p].length, 0);

    const gearOnBoard = (p: PlayerId) =>
        d.players[p].base.gear.length + d.battlefields.reduce((sum, bf) => sum + bf.gear[p].length, 0);

    const myRunesReady = my.runesInPlay.filter((r) => r.isReady).length;
    const enRunesReady = en.runesInPlay.filter((r) => r.isReady).length;

    let score = 0;

    // Points / objective control
    score += (my.points - en.points) * 1200;
    score += (myControlled - enControlled) * 260;
    score += (myContesting - enContesting) * 70;

    // Board presence (make sure playing units is valuable vs "sandbagging" cards forever)
    score += (bfMight(pid) - bfMight(opp)) * 9;
    score += (baseMight(pid) - baseMight(opp)) * 5;
    score += (unitsOnBoard(pid) - unitsOnBoard(opp)) * 16;
    score += (gearOnBoard(pid) - gearOnBoard(opp)) * 3;

    // Hand/zone resources (important, but not worth skipping turns)
    score += (my.hand.length - en.hand.length) * 1.5;
    score += ((my.championZone ? 1 : 0) - (en.championZone ? 1 : 0)) * 2;

    // Runes (keep this low; spending runes is how you play the game)
    score += (myRunesReady - enRunesReady) * 0.35;

    // If we are one point from winning, heavily prefer simply maintaining a control lead.
    if (my.points === d.victoryScore - 1) score += myControlled * 120;
    if (en.points === d.victoryScore - 1) score -= enControlled * 120;

    return score;
  };

  const aiCanProbablyResolveEffectText = (c: CardInstance): boolean => {
    if (c.type !== "Spell") return true;
    const raw = (c.ability?.effect_text || "").toLowerCase();
    if (raw.includes("deal")) return true;
    if (raw.includes("stun")) return true;
    if (raw.includes("ready")) return true;
    if (raw.includes("kill")) return true;
    if (raw.includes("banish")) return true;
    if (raw.includes("buff")) return true;
    if (raw.includes("return") || raw.includes("recall")) return true;
    if (raw.includes("draw")) return true;
    if (raw.includes("channel")) return true;
    if (raw.includes("add") && raw.includes("rune")) return true;
    return false;
  };

  const aiInferReqForSpell = (spell: CardInstance): TargetRequirement => inferTargetRequirement(spell.ability?.effect_text || "", { here: false });

  const aiEnumerateIntents = (d: GameState, pid: PlayerId, difficulty: AiDifficulty): AiIntent[] => {
    const intents: AiIntent[] = [];

    // 1) Mulligan
    if (d.step === "MULLIGAN") {
      const p = d.players[pid];
      if (!p.mulliganDone) {
        // Decide which cards to recycle (max 2)
        if (difficulty === "EASY") {
          intents.push({ type: "MULLIGAN", recycleIds: [] });
        } else {
          const hand = [...p.hand];
          hand.sort((a, b) => (b.cost || 0) - (a.cost || 0));
          const expensive = hand.filter((c) => (c.cost || 0) >= 6).slice(0, 2);
          const pick = difficulty === "MEDIUM" ? expensive : hand.slice(0, 2);
          intents.push({ type: "MULLIGAN", recycleIds: pick.map((c) => c.instanceId) });
        }
      }
      return intents;
    }

    // 2) Chain items needing targets controlled by this AI
    const top = d.chain[d.chain.length - 1];
    if (top && top.needsTargets && top.controller === pid) {
      const diff = difficulty;
      const chosen = pickTargetForAi(d, pid, top.targetRequirement || { kind: "NONE" }, top.contextBattlefieldIndex ?? null, top.restrictTargetsToBattlefieldIndex ?? null, diff);
      intents.push({ type: "SET_CHAIN_TARGETS", chainItemId: top.id, targets: chosen });
      return intents;
    }

    // 3) Non-action steps: if it's our turn and we can advance, do so.
    const canAdvance = d.chain.length === 0 && d.windowKind === "NONE" && d.state === "OPEN";
    if (d.step !== "ACTION") {
      if (d.turnPlayer === pid && canAdvance && d.step !== "GAME_OVER") {
        intents.push({ type: "NEXT_STEP" });
      } else if (d.priorityPlayer === pid && (d.chain.length > 0 || d.state === "CLOSED" || d.windowKind !== "NONE")) {
        intents.push({ type: "PASS" });
      }
      return intents;
    }

    // 4) ACTION step
    const isMainActionState = d.step === "ACTION" && d.turnPlayer === pid && canAdvance;
    const isPriorityState = d.priorityPlayer === pid;

    if (isMainActionState) {
      // --- Hide candidates
      if (difficulty === "HARD" || difficulty === "VERY_HARD") {
        const hiddenCards = d.players[pid].hand.filter((c) => isHiddenCard(c));
        if (hiddenCards.length > 0) {
          const controlled = d.battlefields.filter((bf) => bf.controller === pid && !bf.facedown).map((bf) => bf.index);
          for (const bfIdx of controlled) {
            for (const hc of hiddenCards.slice(0, 2)) {
              intents.push({ type: "HIDE", cardInstanceId: hc.instanceId, battlefieldIndex: bfIdx });
            }
          }
        }
      }

      // --- Play champion (early board presence)
      const champ = d.players[pid].championZone;
      if (champ) {
        const doms = parseDomains(champ.domain).map(clampDomain).filter((x) => x !== "Colorless");
        const accelDom = doms.length > 0 ? doms[0] : d.players[pid].domains[0] || "Fury";
        intents.push({ type: "PLAY", source: "CHAMPION", cardInstanceId: champ.instanceId, destination: { kind: "BASE" }, accelerate: { pay: false, domain: accelDom }, targets: [{ kind: "NONE" }] });
      }

      // --- Play from hand (limit candidates)
      const hand = [...d.players[pid].hand];
      // Prefer units first, then spells/gear
      hand.sort((a, b) => aiCardNumericValue(b) - aiCardNumericValue(a));
      const consider = hand.slice(0, difficulty === "EASY" ? 2 : difficulty === "MEDIUM" ? 4 : 6);
      const controlledBfs = d.battlefields.filter((bf) => bf.controller === pid).map((bf) => bf.index);

      for (const c of consider) {
        if (c.type === "Spell") {
          if (!aiCanProbablyResolveEffectText(c)) continue;
          if (!canSpellTimingNow(d, pid, c)) continue;
          const req = aiInferReqForSpell(c);
          const t = pickTargetForAi(d, pid, req, d.windowBattlefieldIndex, null, difficulty);
          intents.push({ type: "PLAY", source: "HAND", cardInstanceId: c.instanceId, destination: null, targets: t });
        } else if (c.type === "Gear") {
          if (!canPlayNonspellOutsideShowdown(c, d, pid)) continue;
          intents.push({ type: "PLAY", source: "HAND", cardInstanceId: c.instanceId, destination: { kind: "BASE" }, targets: [{ kind: "NONE" }] });
        } else if (c.type === "Unit") {
          if (!canPlayNonspellOutsideShowdown(c, d, pid)) continue;
          // Try a controlled battlefield if we have one, else base.
          const dests: ({ kind: "BASE" } | { kind: "BF"; index: number })[] = [
            { kind: "BASE" } as const,
            ...controlledBfs.map((i) => ({ kind: "BF", index: i } as const)),
          ];
          const doms = parseDomains(c.domain).map(clampDomain).filter((x) => x !== "Colorless");
          const accelDom = doms.length > 0 ? doms[0] : d.players[pid].domains[0] || "Fury";
          for (const dest of dests.slice(0, difficulty === "EASY" ? 1 : 2)) {
            intents.push({ type: "PLAY", source: "HAND", cardInstanceId: c.instanceId, destination: dest, accelerate: { pay: false, domain: accelDom }, targets: [{ kind: "NONE" }] });
            if ((difficulty === "HARD" || difficulty === "VERY_HARD") && hasKeyword(c, "Accelerate")) {
              intents.push({ type: "PLAY", source: "HAND", cardInstanceId: c.instanceId, destination: dest, accelerate: { pay: true, domain: accelDom }, targets: [{ kind: "NONE" }] });
            }
          }
        }
      }

      // --- Standard move candidates (move ready units from base to battlefields)
      const readyBase = d.players[pid].base.units.filter((u) => u.isReady);
      readyBase.sort((a, b) => effectiveMight(b, { role: "NONE", game: d }) - effectiveMight(a, { role: "NONE", game: d }));

      const allBfs = d.battlefields.map((bf) => bf.index);

      // Singles
      const moveSingles = readyBase.slice(0, difficulty === "EASY" ? 1 : difficulty === "MEDIUM" ? 2 : 3);
      for (const u of moveSingles) {
        for (const bfIdx of allBfs) {
          intents.push({ type: "MOVE", from: { kind: "BASE" }, to: { kind: "BF", index: bfIdx }, unitIds: [u.instanceId] });
        }
      }

      // Pairs (helps the AI build real contesting pressure)
      if (difficulty !== "EASY" && readyBase.length >= 2) {
        const pair = readyBase.slice(0, 2).map((u) => u.instanceId);
        for (const bfIdx of allBfs) {
          intents.push({ type: "MOVE", from: { kind: "BASE" }, to: { kind: "BF", index: bfIdx }, unitIds: pair });
        }
      }

      // Triples (VERY_HARD only)
      if (difficulty === "VERY_HARD" && readyBase.length >= 3) {
        const trio = readyBase.slice(0, 3).map((u) => u.instanceId);
        for (const bfIdx of allBfs) {
          intents.push({ type: "MOVE", from: { kind: "BASE" }, to: { kind: "BF", index: bfIdx }, unitIds: trio });
        }
      }

      // --- Facedown play candidates (Hard+ only)
      if (difficulty === "HARD" || difficulty === "VERY_HARD") {
        d.battlefields.forEach((bf, idx) => {
          if (!bf.facedown || bf.facedown.owner !== pid) return;
          if (bf.facedown.hiddenOnTurn === d.turnNumber) return;
          const c = bf.facedown.card;
          if (c.type === "Spell") {
            if (!aiCanProbablyResolveEffectText(c)) return;
            if (!canSpellTimingNow(d, pid, c)) return;
            const req = aiInferReqForSpell(c);
            const t = pickTargetForAi(d, pid, req, idx, idx, difficulty);
            intents.push({ type: "PLAY", source: "FACEDOWN", cardInstanceId: c.instanceId, fromBattlefieldIndex: idx, destination: null, targets: t });
          } else {
            intents.push({ type: "PLAY", source: "FACEDOWN", cardInstanceId: c.instanceId, fromBattlefieldIndex: idx, destination: { kind: "BF", index: idx }, targets: [{ kind: "NONE" }] });
          }
        });
      }

      // Always allow ending the turn
      intents.push({ type: "NEXT_STEP" });
      return intents;
    }

    // Priority within a window/chain: respond with Action/Reaction spells if possible, else pass.
    if (isPriorityState) {
      const hand = [...d.players[pid].hand];
      hand.sort((a, b) => aiCardNumericValue(b) - aiCardNumericValue(a));
      const consider = hand.slice(0, difficulty === "EASY" ? 1 : difficulty === "MEDIUM" ? 2 : 4);
      for (const c of consider) {
        if (c.type !== "Spell") continue;
        if (!aiCanProbablyResolveEffectText(c)) continue;
        if (!canSpellTimingNow(d, pid, c)) continue;
        const req = aiInferReqForSpell(c);
        const t = pickTargetForAi(d, pid, req, d.windowBattlefieldIndex, null, difficulty);
        intents.push({ type: "PLAY", source: "HAND", cardInstanceId: c.instanceId, destination: null, targets: t });
      }
      intents.push({ type: "PASS" });
    }
    return intents;
  };


  const aiFastForwardForScore = (sim: GameState, maxIters = 60) => {
    let guard = 0;
    while (guard++ < maxIters) {
      if (sim.step === "GAME_OVER") return;

      if (sim.chain.length > 0) {
        // For scoring, assume both players will pass and let the chain resolve.
        resolveTopOfChain(sim);
        continue;
      }

      // End regular showdowns deterministically.
      if (sim.windowKind === "SHOWDOWN") {
        const idx = sim.windowBattlefieldIndex!;
        const bf = sim.battlefields[idx];

        // Close showdown
        sim.windowKind = "NONE";
        sim.windowBattlefieldIndex = null;
        sim.focusPlayer = null;
        sim.passesInRow = 0;
        sim.state = "OPEN";
        sim.priorityPlayer = sim.turnPlayer;

        const p1 = bf.units.P1.length;
        const p2 = bf.units.P2.length;

        if (p1 > 0 && p2 > 0) {
          const attacker = bf.contestedBy!;
          const defender = otherPlayer(attacker);
          sim.windowKind = "COMBAT";
          sim.windowBattlefieldIndex = idx;
          sim.combat = { battlefieldIndex: idx, attacker, defender, step: "SHOWDOWN" };
          sim.focusPlayer = attacker;
          sim.priorityPlayer = attacker;
          sim.passesInRow = 0;
          continue;
        }

        const winner: PlayerId | null = p1 > 0 ? "P1" : p2 > 0 ? "P2" : null;
        const prev = bf.controller;

        if (winner) {
          bf.controller = winner;
          bf.contestedBy = null;
          if (prev !== winner) attemptScore(sim, winner, idx, "Conquer");
        } else {
          bf.controller = null;
          bf.contestedBy = null;
        }

        cleanupStateBased(sim);
        maybeOpenNextWindow(sim);
        continue;
      }

      // End combat showdowns deterministically (auto-assign damage).
      if (sim.windowKind === "COMBAT" && sim.combat && sim.combat.step === "SHOWDOWN") {
        const bfi = sim.combat.battlefieldIndex;
        const attacker = sim.combat.attacker;
        const defender = sim.combat.defender;
        assignCombatDamageAuto(sim, bfi, attacker, defender);
        sim.combat.step = "DAMAGE";
        resolveCombatResolution(sim);
        continue;
      }

      // If a combat damage step is hanging around, resolveCombatResolution already clears it, but guard anyway.
      if (sim.windowKind === "COMBAT" && sim.combat && sim.combat.step === "DAMAGE") {
        resolveCombatResolution(sim);
        continue;
      }

      break;
    }
  };

  const aiChooseIntent = (d: GameState, pid: PlayerId, difficulty: AiDifficulty): AiIntent | null => {
    const candidates = aiEnumerateIntents(d, pid, difficulty);
    if (candidates.length === 0) return null;

    const scoreIntent = (intent: AiIntent): number => {
      const sim = deepClone(d);

      switch (intent.type) {
        case "PASS":
          enginePassPriority(sim, pid);
          break;
        case "NEXT_STEP":
          engineNextStep(sim, pid);
          break;
        case "MULLIGAN":
          engineConfirmMulligan(sim, pid, intent.recycleIds);
          break;
        case "SET_CHAIN_TARGETS":
          engineSetChainTargets(sim, pid, intent.chainItemId, intent.targets);
          cleanupStateBased(sim);
          maybeOpenNextWindow(sim);
          break;
        case "HIDE":
          engineHideCard(sim, pid, intent.cardInstanceId, intent.battlefieldIndex, { autoPay: true });
          cleanupStateBased(sim);
          maybeOpenNextWindow(sim);
          break;
        case "MOVE":
          engineStandardMove(sim, pid, intent.from, intent.unitIds, intent.to);
          cleanupStateBased(sim);
          maybeOpenNextWindow(sim);
          break;
        case "PLAY": {
          const r = enginePlayCard(
              sim,
              pid,
              {
                source: intent.source,
                cardInstanceId: intent.cardInstanceId,
                fromBattlefieldIndex: intent.fromBattlefieldIndex,
                destination: intent.destination ?? null,
                accelerate: intent.accelerate,
                targets: intent.targets,
              },
              { autoPay: true }
          );
          if (!r.ok) return -999999;
          break;
        }
        default:
          break;
      }

      // Key improvement: for evaluation, deterministically fast-forward through chain/showdowns/combat resolution
      // so the AI can actually "see" the outcome of a showdown or combat.
      aiFastForwardForScore(sim);

      let sc = aiBoardScore(sim, pid);

      // Light tie-breakers. Real value should come from aiBoardScore().
      // We slightly discourage PASS / ending the turn, and slightly encourage taking meaningful actions.
      const isMainAction = d.step === "ACTION" && d.turnPlayer === pid && d.chain.length === 0 && d.windowKind === "NONE" && d.state === "OPEN";
      if (intent.type === "PASS") sc -= 0.08;
      if (intent.type === "NEXT_STEP") sc -= isMainAction ? 0.35 : 0.10;
      if (intent.type === "PLAY") sc += 0.10;
      if (intent.type === "MOVE") sc += 0.05;
      if (intent.type === "HIDE") sc += 0.03;

      return sc;
    };

    const scored = candidates
        .map((intent) => ({ intent, score: scoreIntent(intent) }))
        .sort((a, b) => b.score - a.score);

    if (difficulty === "EASY") {
      // Pick randomly among the top few.
      const topN = Math.min(4, scored.length);
      const pick = scored[Math.floor(Math.random() * topN)];
      return pick.intent;
    }

    if (difficulty === "MEDIUM") {
      // Mostly pick the best, sometimes the runner-up.
      if (scored.length >= 2 && Math.random() < 0.25) return scored[1].intent;
      return scored[0].intent;
    }

    // HARD / VERY_HARD: pick the best. (VERY_HARD mainly differs by having more legal intents available.)
    return scored[0].intent;
  };

  const aiTimerRef = useRef<number | null>(null);
  const gameRef = useRef<GameState | null>(null);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    if (!game) return;
    if (aiPaused) return;

    // If no AI enabled, do nothing.
    const aiPlayers = (['P1', 'P2'] as PlayerId[]).filter((pid) => aiByPlayer[pid]?.enabled);
    if (aiPlayers.length === 0) return;

    // Avoid scheduling multiple overlapping decisions.
    if (aiTimerRef.current) {
      window.clearTimeout(aiTimerRef.current);
      aiTimerRef.current = null;
    }

    // Find a single AI player that should act now.
    const snap = game;
    let actor: PlayerId | null = null;
    for (const pid of aiPlayers) {
      const diff = aiByPlayer[pid]?.difficulty || "MEDIUM";
      const intent = aiChooseIntent(snap, pid, diff);
      // Only act if the intent is actually legal right now.
      if (!intent) continue;
      // Gate: mulligan, or controlled chain target, or priority, or turn-player advance.
      const top = snap.chain[snap.chain.length - 1];
      const canAdvance = snap.chain.length === 0 && snap.windowKind === "NONE" && snap.state === "OPEN";
      const isMyMulligan = snap.step === "MULLIGAN" && !snap.players[pid].mulliganDone;
      const isMyChainChoice = !!top && top.needsTargets && top.controller === pid;
      const isMyPriority = snap.priorityPlayer === pid;
      const isMyTurnAdvance = snap.turnPlayer === pid && canAdvance && snap.step !== "GAME_OVER";
      if (isMyMulligan || isMyChainChoice || isMyPriority || isMyTurnAdvance) {
        actor = pid;
        break;
      }
    }

    if (!actor) return;

    const delay = Math.max(50, Math.min(2500, aiByPlayer[actor]?.thinkMs || 650));
    aiTimerRef.current = window.setTimeout(() => {
      aiTimerRef.current = null;
      const latest = gameRef.current;
      if (!latest) return;
      if (!aiByPlayer[actor]?.enabled) return;
      if (aiPaused) return;
      const diff = aiByPlayer[actor]?.difficulty || "MEDIUM";
      const intent = aiChooseIntent(latest, actor, diff);
      if (!intent) return;
      applyAiIntent(actor, intent);
    }, delay);

    return () => {
      if (aiTimerRef.current) {
        window.clearTimeout(aiTimerRef.current);
        aiTimerRef.current = null;
      }
    };
  }, [game, aiByPlayer, aiPaused]);

  const toggleRevealHands = () => setRevealAllHands((v) => !v);
  const toggleRevealFacedown = () => setRevealAllFacedown((v) => !v);
  const toggleRevealDecks = () => setRevealAllDecks((v) => !v);

  const clearTransientUI = () => {
    setSelectedHandCardId(null);
    setPendingPlay(null);
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
    setHideChoice({ cardId: null, battlefieldIndex: null });
    setMoveSelection({ from: null, unitIds: [], to: null });
    setArenaMove(null);
    setArenaHideCardId(null);
    setHoverPayPlan(null);
  };

  const resetGame = () => {
    undoRef.current = [];
    clearTransientUI();
    setHoverCard(null);
    setGame(null);
    setPreGameView("SETUP");
  };

  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    clearTransientUI();
    setHoverCard(null);
    setGame(prev);
  };

  const nextStep = (pidOrEvent?: any) => {
    if (!g) return;
    const actor: PlayerId = isPlayerId(pidOrEvent) ? pidOrEvent : g.turnPlayer;
    dispatchEngineAction({ type: "NEXT_STEP", player: actor });
  };

  // ----------------------------- Runes / Seals (Add) -----------------------------

  const exhaustRuneForEnergy = (pid: PlayerId, runeId: string) => {
    if (!g) return;
    dispatchEngineAction({ type: "RUNE_EXHAUST", player: pid, runeInstanceId: runeId });
  };


  const recycleRuneForPower = (pid: PlayerId, runeId: string) => {
    if (!g) return;
    dispatchEngineAction({ type: "RUNE_RECYCLE", player: pid, runeInstanceId: runeId });
  };


  const exhaustGearForSealPower = (pid: PlayerId, gearId: string) => {
    if (!g) return;
    dispatchEngineAction({ type: "SEAL_EXHAUST", player: pid, gearInstanceId: gearId });
  };

  // ----------------------------- Mulligan -----------------------------

  const toggleMulliganSelect = (pid: PlayerId, cardInstanceId: string) => {
    if (!g) return;
    updateGame((d) => {
      if (d.step !== "MULLIGAN") return;
      const p = d.players[pid];
      if (p.mulliganDone) return;
      const inHand = p.hand.some((c) => c.instanceId === cardInstanceId);
      if (!inHand) return;
      const sel = new Set(p.mulliganSelectedIds);
      if (sel.has(cardInstanceId)) sel.delete(cardInstanceId);
      else {
        if (sel.size >= 2) {
          d.log.unshift(`${pid} can mulligan at most 2 cards.`);
          return;
        }
        sel.add(cardInstanceId);
      }
      p.mulliganSelectedIds = Array.from(sel);
    });
  };

  const confirmMulligan = (pid: PlayerId) => {
    if (!g) return;
    const ids = g.players[pid].mulliganSelectedIds || [];
    dispatchEngineAction({ type: "MULLIGAN_CONFIRM", player: pid, recycleIds: ids });
  };


  // ----------------------------- Play / Hide / Move -----------------------------

  const beginPlayFromHand = (pid: PlayerId, cardInstanceId: string) => {
    if (!g) return;
    if (!canActAs(pid)) return;
    const p = g.players[pid];
    const card = p.hand.find((c) => c.instanceId === cardInstanceId);
    if (!card) return;

    const doms = parseDomains(card.domain).map(clampDomain).filter((d) => d !== "Colorless");
    const allowed = doms.length > 0 ? doms : g.players[pid].domains;
    setPendingAccelerateDomain(allowed[0] || "Fury");

    setPendingPlay({ player: pid, cardId: cardInstanceId, from: "HAND" });
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
  };

  const beginPlayChampion = (pid: PlayerId) => {
    if (!g) return;
    if (!canActAs(pid)) return;
    const champ = g.players[pid].championZone;
    if (!champ) return;
    const doms = parseDomains(champ.domain).map(clampDomain).filter((d) => d !== "Colorless");
    const allowed = doms.length > 0 ? doms : g.players[pid].domains;
    setPendingAccelerateDomain(allowed[0] || "Fury");
    setPendingPlay({ player: pid, cardId: champ.instanceId, from: "CHAMPION" });
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
  };

  const beginPlayFacedown = (pid: PlayerId, battlefieldIndex: number) => {
    if (!g) return;
    if (!canActAs(pid)) return;
    const bf = g.battlefields[battlefieldIndex];
    if (!bf.facedown || bf.facedown.owner !== pid) return;
    const fc = bf.facedown.card;
    const doms = parseDomains(fc.domain).map(clampDomain).filter((d) => d !== "Colorless");
    const allowed = doms.length > 0 ? doms : g.players[pid].domains;
    setPendingAccelerateDomain(allowed[0] || "Fury");


    // Hidden can be played beginning on the next player's turn (i.e., not the same turn it was hidden).
    if (bf.facedown.hiddenOnTurn === g.turnNumber) {
      updateGame((d) => d.log.unshift("You can't play a Hidden card the same turn you hid it."));
      return;
    }

    setPendingPlay({ player: pid, cardId: bf.facedown.card.instanceId, from: "FACEDOWN", fromBattlefieldIndex: battlefieldIndex });
    setPendingDestination({ kind: "BF", index: battlefieldIndex });
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
  };

  const commitHide = () => {
    if (!g) return;
    const pid = g.turnPlayer; // hide only on your turn (simplified)
    if (!canHideNow(g)) return;
    if (!hideChoice.cardId || hideChoice.battlefieldIndex === null) return;
    if (!canActAs(pid)) return;

    dispatchEngineAction({
      type: "HIDE_CARD",
      player: pid,
      cardInstanceId: hideChoice.cardId,
      battlefieldIndex: hideChoice.battlefieldIndex,
      autoPay: autoPayEnabled,
    });

    setHideChoice({ cardId: null, battlefieldIndex: null });
  };



  // ----------------------------- Chain resolution helpers -----------------------------

  const normalizeTriggeredText = (txt: string): string => {
    const t = (txt || "").trim();
    return t.replace(/^[—-]\s*/, "").trim();
  };

  const buildTriggeredAbilityItem = (
      d: GameState,
      controller: PlayerId,
      sourceName: string,
      effectText: string,
      ctxBf: number | null,
      restrictBf: number | null,
      sourceInstanceId?: string,
      legionActive: boolean = false
  ): ChainItem | null => {
    const cleaned = normalizeTriggeredText(effectText);
    if (!cleaned) return null;
    const req = inferTargetRequirement(cleaned, { here: restrictBf != null });
    return {
      id: makeId("chain"),
      controller,
      kind: "TRIGGERED_ABILITY",
      label: `${sourceName} — Trigger`,
      effectText: cleaned,
      contextBattlefieldIndex: ctxBf,
      restrictTargetsToBattlefieldIndex: restrictBf,
      legionActive,
      needsTargets: req.kind !== "NONE",
      targetRequirement: req,
      targets: [{ kind: "NONE" }],
      sourceInstanceId,
    };
  };

  const queuePlayTriggersForCard = (d: GameState, item: ChainItem) => {
    if (item.kind !== "PLAY_CARD" || !item.sourceCard) return;
    const card = item.sourceCard;
    if (card.type !== "Unit" && card.type !== "Gear") return;

    const trigger = (card.ability?.trigger || "").trim();
    const hasPlayMe =
        /^When you play (me|this)$/i.test(trigger) ||
        /^When this is played$/i.test(trigger) ||
        /^When I'm played$/i.test(trigger) ||
        /^When I'm played and when I conquer$/i.test(trigger);
    const hasPlayToBattlefield = /^When you play me to a battlefield$/i.test(trigger);

    const ctxBf = item.playDestination?.kind === "BF" ? item.playDestination.index : null;
    const restrictBf = item.sourceZone === "FACEDOWN" ? item.contextBattlefieldIndex ?? null : null;

    // 1) Explicit "When you play me" trigger
    if (hasPlayMe && !hasKeyword(card, "Legion")) {
      const t = buildTriggeredAbilityItem(d, item.controller, card.name, card.ability?.effect_text || "", ctxBf, restrictBf, card.instanceId);
      if (t) {
        d.chain.push(t);
        d.log.unshift(`Triggered ability queued: ${card.name} (When you play me).`);
      }
    }

    if (hasPlayToBattlefield && item.playDestination?.kind === "BF") {
      const t = buildTriggeredAbilityItem(d, item.controller, card.name, card.ability?.effect_text || "", ctxBf, restrictBf, card.instanceId);
      if (t) {
        d.chain.push(t);
        d.log.unshift(`Triggered ability queued: ${card.name} (Played to battlefield).`);
      }
    }

    // 2) Vision keyword is a built-in "When you play me" trigger.
    // Some card JSON stores this in reminder_text; if missing, we fall back to raw_text.
    if (hasKeyword(card, "Vision")) {
      const reminder = (card.ability?.reminder_text || []).join(" ").trim();
      const raw = (card.ability?.raw_text || "").trim();
      const txt = reminder || raw;
      if (txt && /When you play me/i.test(txt)) {
        const cleaned = txt.replace(/^[\s\S]*?When you play me,?\s*/i, "");
        const t = buildTriggeredAbilityItem(d, item.controller, card.name, cleaned, ctxBf, restrictBf, card.instanceId);
        if (t) {
          d.chain.push(t);
          d.log.unshift(`Triggered ability queued: ${card.name} (Vision).`);
        }
      }
    }
    // 2b) "When I defend or I'm played from [Hidden]" triggers on facedown play.
    if (/^When I defend or I'm played from/i.test(trigger) && item.sourceZone === "FACEDOWN") {
      const eff = card.ability?.effect_text || "";
      const t = buildTriggeredAbilityItem(d, item.controller, card.name, eff, ctxBf, restrictBf, card.instanceId);
      if (t) {
        d.chain.push(t);
        d.log.unshift(`Triggered ability queued: ${card.name} (Played from Hidden).`);
      }
    }
    // 3) Legion keyword: conditional clause becomes active if captured at play time (played another card earlier this turn).
    // Treat the Legion clause as an on-play triggered ability (so it can be responded to and can require targets).
    if (hasKeyword(card, "Legion") && item.legionActive) {
      const clause = extractLegionClauseText(card);
      if (clause) {
        const clauseLower = clause.toLowerCase();
        const looksLikeOnlyCost =
            /\bcost\s+\d+\s+(?:energy\s+)?less\b/.test(clauseLower) ||
            /\breduce\s+my\s+cost\b/.test(clauseLower);

        if (!looksLikeOnlyCost) {
          let eff = clause;
          const m = clause.match(/^when\s+you\s+play\s+(me|this),?\s*(.*)$/i);
          if (m) eff = (m[2] || "").trim();
          const t = buildTriggeredAbilityItem(d, item.controller, card.name, eff, ctxBf, restrictBf, card.instanceId, !!item.legionActive);
          if (t) {
            d.chain.push(t);
            d.log.unshift(`Triggered ability queued: ${card.name} (Legion).`);
          }
        }
      }
    }

    // 4) Data fallback: some cards encode play-triggers in text but have a missing/empty trigger field.
    if (!card.ability?.trigger && !hasKeyword(card, "Legion") && !hasKeyword(card, "Vision")) {
      const tt = normalizeTriggeredText(card.ability?.effect_text || card.ability?.raw_text || "");
      const mm = tt.match(/^When\s+you\s+play\s+(me|this),?\s*(.*)$/i);
      const eff = (mm?.[2] || "").trim();
      if (eff) {
        const t = buildTriggeredAbilityItem(d, item.controller, card.name, eff, ctxBf, restrictBf, card.instanceId, !!item.legionActive);
        if (t) {
          d.chain.push(t);
          d.log.unshift(`Triggered ability queued: ${card.name} (text fallback).`);
        }
      }
    }


  };

  const resolveTopOfChain = (d: GameState) => {
    if (d.chain.length === 0) return;
    const item = d.chain.pop()!;
    d.log.unshift(`Resolving: ${item.label}`);

    if (item.kind === "PLAY_CARD" && item.sourceCard) {
      const card = item.sourceCard;
      const controller = item.controller;
      const p = d.players[controller];

      if (card.type === "Spell") {
        // Hidden plays add a "here" targeting restriction. If the target is no longer "here" at resolution, the spell fizzles.
        const rbf = item.restrictTargetsToBattlefieldIndex ?? null;
        const first = item.targets?.[0];

        let didResolve = true;
        if (rbf != null && first && first.kind !== "NONE") {
          let legalHere = true;
          if (first.kind === "UNIT") {
            const loc = locateUnit(d, first.owner, first.instanceId);
            legalHere = !!loc && loc.zone === "BF" && loc.battlefieldIndex === rbf;
          } else if (first.kind === "BATTLEFIELD") {
            legalHere = first.index === rbf;
          }
          if (!legalHere) {
            didResolve = false;
            d.log.unshift(`Target is no longer "here"; ${card.name} fizzles.`);
          } else {
            resolveEffectText(d, controller, item.effectText || "", item.targets, {
              battlefieldIndex: item.contextBattlefieldIndex ?? null,
              sourceInstanceId: card.instanceId,
              sourceCardName: card.name,
              sourceCardType: card.type,
            });
          }
        } else {
          resolveEffectText(d, controller, item.effectText || "", item.targets, {
            battlefieldIndex: item.contextBattlefieldIndex ?? null,
            sourceInstanceId: card.instanceId,
            sourceCardName: card.name,
            sourceCardType: card.type,
          });
        }

        p.trash.push(card);
        d.log.unshift(didResolve ? `${card.name} resolved and went to Trash.` : `${card.name} fizzled and went to Trash.`);
      } else if (card.type === "Unit") {
        if (!item.playDestination) d.log.unshift("Unit had no destination (bug).");
        else {
          addUnitToZone(d, controller, card, item.playDestination);
          d.log.unshift(`${card.name} entered play ${item.playDestination.kind === "BASE" ? "at Base" : `at Battlefield ${item.playDestination.index + 1}`}.`);
        }
      } else if (card.type === "Gear") {
        if (item.playDestination && item.playDestination.kind === "BF") {
          const bf = d.battlefields[item.playDestination.index];
          bf.gear[controller].push(card);
          d.log.unshift(`${card.name} entered play (Gear) at Battlefield ${item.playDestination.index + 1} (will be recalled during Cleanup).`);
        } else {
          p.base.gear.push(card);
          d.log.unshift(`${card.name} entered play (Gear) at Base.`);
        }
      } else {
        d.log.unshift(`Unsupported card type on chain: ${card.type}`);
      }

      // Triggered abilities that trigger when a card is played trigger now.
      queuePlayTriggersForCard(d, item);
    } else if (item.kind === "TRIGGERED_ABILITY" || item.kind === "ACTIVATED_ABILITY") {
      resolveEffectText(d, item.controller, item.effectText || "", item.targets, {
        battlefieldIndex: item.contextBattlefieldIndex ?? null,
        sourceInstanceId: item.sourceInstanceId,
        sourceCardName: item.label,
      });
    }

    cleanupStateBased(d);

    // After resolution: if chain is empty, we return to OPEN state.
    if (d.chain.length === 0) {
      d.state = "OPEN";
      d.passesInRow = 0;

      // If the last item resolved during a Showdown, Focus passes.
      const inShowdown = d.windowKind === "SHOWDOWN" || (d.windowKind === "COMBAT" && d.combat?.step === "SHOWDOWN");
      if (inShowdown && d.focusPlayer) {
        d.focusPlayer = otherPlayer(d.focusPlayer);
        d.priorityPlayer = d.focusPlayer;
        d.log.unshift(`Focus passes to ${d.focusPlayer}.`);
      } else {
        d.priorityPlayer = d.turnPlayer;
      }
    } else {
      d.state = "CLOSED";
      d.passesInRow = 0;
      // The player who controls the most recent item becomes the Active Player.
      d.priorityPlayer = d.chain[d.chain.length - 1].controller;
    }

    // If we are not currently in a window, we may need to open a new one.
    maybeOpenNextWindow(d);
  };

  const commitPendingPlay = () => {
    if (!g || !pendingPlay) return;
    const pid = pendingPlay.player;
    if (!canActAs(pid)) return;

    const dest =
        pendingDestination == null
            ? null
            : pendingDestination.kind === "BASE"
                ? ({ kind: "BASE" } as const)
                : ({ kind: "BF", index: pendingDestination.index } as const);

    dispatchEngineAction({
      type: "PLAY_CARD",
      player: pid,
      source: pendingPlay.from as any,
      cardInstanceId: pendingPlay.cardId,
      fromBattlefieldIndex: pendingPlay.fromBattlefieldIndex,
      destination: dest,
      accelerate: { pay: !!pendingAccelerate, domain: pendingAccelerateDomain },
      targets: pendingTargets,
      autoPay: autoPayEnabled,
    });

    // Clear UI pending state regardless of success; failures are logged by the engine.
    setPendingPlay(null);
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
  };


  const cancelPendingPlay = () => {
    setPendingPlay(null);
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
  };

  const passPriority = (pid: PlayerId) => {
    if (!g) return;
    if (pendingChainChoice) {
      updateGame((d) => d.log.unshift("Choose targets before passing."));
      return;
    }
    if (g.priorityPlayer !== pid) return;
    dispatchEngineAction({ type: "PASS_PRIORITY", player: pid });
  };


  const doStandardMove = () => {
    if (!g) return;
    const pid = g.turnPlayer;
    if (!canStandardMoveNow(g)) return;
    if (!moveSelection.from || !moveSelection.to || moveSelection.unitIds.length === 0) return;
    if (!canActAs(pid)) return;

    dispatchEngineAction({ type: "STANDARD_MOVE", player: pid, from: moveSelection.from, unitIds: moveSelection.unitIds, to: moveSelection.to });

    setMoveSelection({ from: null, unitIds: [], to: null });
  };


  // ----------------------------- Target picker helpers -----------------------------

  const listAllUnits = (d: GameState): { label: string; t: Target }[] => {
    const res: { label: string; t: Target }[] = [];
    for (const pid of ["P1", "P2"] as PlayerId[]) {
      for (const u of d.players[pid].base.units) res.push({ label: `${u.name} (${pid}) [Base]`, t: { kind: "UNIT", owner: pid, instanceId: u.instanceId, zone: "BASE" } });
      for (const bf of d.battlefields) {
        for (const u of bf.units[pid]) res.push({ label: `${u.name} (${pid}) [BF${bf.index + 1}]`, t: { kind: "UNIT", owner: pid, instanceId: u.instanceId, battlefieldIndex: bf.index, zone: "BF" } });
      }
    }
    return res;
  };

  // ----------------------------- Rendering -----------------------------

  const renderRunePool = (pool: RunePool, domains: Domain[]) => {
    const ALL: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];
    const parts = ALL.map((d) => `${d}:${pool.power[d] || 0}`);
    return (
        <div style={{ fontSize: 12 }}>
          <div><b>Energy:</b> {pool.energy}</div>
          <div><b>Power:</b> {parts.join(" | ")}</div>
        </div>
    );
  };

  const renderCardPill = (c: CardInstance, extra?: React.ReactNode) => (
      <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8, marginBottom: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div>
            <div style={{ fontWeight: 700 }}>{c.name}</div>
            <div style={{ fontSize: 12, color: "#444" }}>
              {c.type} • {c.domain} • Cost {c.cost}E{c.stats.power ? ` + ${c.stats.power}P` : ""}
              {c.type === "Unit" ? ` • Might ${effectiveMight(c, { role: "NONE" })}` : ""}
            </div>
            {c.ability?.keywords?.length ? (
                <div style={{ fontSize: 12, marginTop: 4 }}>KW: {c.ability.keywords.join(", ")}</div>
            ) : null}
            {c.ability?.effect_text ? (
                <div style={{ fontSize: 12, marginTop: 4, color: "#222" }}>{c.ability.effect_text}</div>
            ) : null}
          </div>
          <div style={{ textAlign: "right", fontSize: 12 }}>
            {c.type === "Unit" ? (
                <>
                  <div><b>{c.isReady ? "Ready" : "Exhausted"}</b>{c.stunned ? " • Stunned" : ""}</div>
                  <div>Damage: {c.damage}</div>
                  <div>Buffs: {c.buffs} | Temp: {c.tempMightBonus}</div>
                </>
            ) : (
                <div><b>{c.isReady ? "Ready" : "Exhausted"}</b></div>
            )}
            {extra}
          </div>
        </div>
      </div>
  );

  const renderPlayerPanel = (pid: PlayerId) => {
    if (!g) return null;
    const p = g.players[pid];
    const canSeeHand = revealAllHands || viewerId === pid;

    return (
        <div style={{ flex: 1, border: "1px solid #ccc", borderRadius: 10, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{pid}{g.turnPlayer === pid ? " (Turn)" : ""}{g.priorityPlayer === pid ? " • Priority" : ""}</div>
            <div style={{ fontSize: 14 }}><b>Points:</b> {p.points}/{g.victoryScore}</div>
          </div>

          <div style={{ fontSize: 12, color: "#444" }}>
            <div><b>Legend:</b> {p.legend ? p.legend.name : "—"}</div>
            <div><b>Domains:</b> {p.domains.join(", ")}</div>
            <div><b>Main Deck:</b> {p.mainDeck.length} • <b>Trash:</b> {p.trash.length} • <b>Banish:</b> {p.banishment.length}</div>
            <div><b>Rune Deck:</b> {p.runeDeck.length} • <b>Runes in Play:</b> {p.runesInPlay.length}</div>
          </div>

          <div style={{ marginTop: 8 }}>{renderRunePool(p.runePool, p.domains)}</div>

          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 700 }}>Champion Zone</div>
            {p.championZone ? (
                <div>
                  {renderCardPill(p.championZone)}
                  <button
                      disabled={!canActAs(pid)}
                      onClick={() => beginPlayChampion(pid)}
                  >
                    Play Champion
                  </button>
                </div>
            ) : (
                <div style={{ fontSize: 12, color: "#666" }}>—</div>
            )}
          </div>

          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 700 }}>Runes in Play</div>
            {p.runesInPlay.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
            {p.runesInPlay.map((r) => (
                <div key={r.instanceId} style={{ border: "1px solid #eee", borderRadius: 6, padding: 8, marginTop: 6, fontSize: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <div><b>{r.domain} Rune</b> • {r.isReady ? "Ready" : "Exhausted"}</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button disabled={!canActAs(pid) || !r.isReady} onClick={() => exhaustRuneForEnergy(pid, r.instanceId)}>Exhaust → +1E</button>
                      <button disabled={!canActAs(pid)} onClick={() => recycleRuneForPower(pid, r.instanceId)}>Recycle → +1 {r.domain}P</button>
                    </div>
                  </div>
                </div>
            ))}
          </div>

          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 700 }}>Base – Units</div>
            {p.base.units.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
            {p.base.units.map((u) => renderCardPill(u))}
          </div>

          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 700 }}>Base – Gear</div>
            {p.base.gear.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
            {p.base.gear.map((gear) =>
                renderCardPill(gear, (
                    <div style={{ marginTop: 6 }}>
                      <button disabled={!canActAs(pid) || !gear.isReady} onClick={() => exhaustGearForSealPower(pid, gear.instanceId)}>Exhaust (Seal) → +Power</button>
                    </div>
                ))
            )}
          </div>

          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 700 }}>Hand ({p.hand.length})</div>
            {!canSeeHand ? <div style={{ fontSize: 12, color: "#666" }}>Hidden</div> : null}
            {canSeeHand && p.hand.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
            {canSeeHand &&
                p.hand.map((c) => (
                    <div key={c.instanceId} style={{ display: "flex", gap: 8, alignItems: "center", borderBottom: "1px dotted #eee", padding: "6px 0" }}>
                      <input
                          type="radio"
                          name={`hand_${pid}`}
                          checked={selectedHandCardId === c.instanceId}
                          onChange={() => setSelectedHandCardId(c.instanceId)}
                      />
                      <div style={{ flex: 1, fontSize: 12 }}>
                        <b>{c.name}</b> • {c.type} • {c.domain} • {c.cost}E{c.stats.power ? `+${c.stats.power}P` : ""}{" "}
                        {c.ability?.keywords?.length ? ` • ${c.ability.keywords.join(", ")}` : ""}
                      </div>
                      <button disabled={!canActAs(pid)} onClick={() => beginPlayFromHand(pid, c.instanceId)}>Play</button>
                      {g.step === "MULLIGAN" ? (
                          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                            <input
                                type="checkbox"
                                checked={p.mulliganSelectedIds.includes(c.instanceId)}
                                disabled={p.mulliganDone}
                                onChange={() => toggleMulliganSelect(pid, c.instanceId)}
                            />
                            Mulligan
                          </label>
                      ) : null}
                    </div>
                ))}

            {g.step === "MULLIGAN" ? (
                <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
                  <button disabled={p.mulliganDone} onClick={() => confirmMulligan(pid)}>
                    {p.mulliganDone ? "Mulligan Confirmed" : `Confirm Mulligan (${p.mulliganSelectedIds.length}/2)`}
                  </button>
                  <div style={{ fontSize: 12, color: "#666" }}>
                    Recycle up to 2 cards, then draw that many. Confirm with 0 selected to keep.
                  </div>
                </div>
            ) : null}
          </div>
        </div>
    );
  };

  const renderBattlefields = () => {
    if (!g) return null;
    return (
        <div style={{ border: "1px solid #bbb", borderRadius: 10, padding: 12, marginTop: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Battlefields</div>
          <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
            {g.battlefields.map((bf) => (
                <div key={bf.index} style={{ flex: 1, border: "1px solid #ddd", borderRadius: 10, padding: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{bf.card.name}</div>
                      <div style={{ fontSize: 12, color: "#444" }}>
                        BF {bf.index + 1} • Owner {bf.owner} • Controller {bf.controller ?? "None"}{bf.contestedBy ? ` • Contested by ${bf.contestedBy}` : ""}
                      </div>
                      {bf.card.ability?.trigger || bf.card.ability?.effect_text ? (
                          <div style={{ fontSize: 12, marginTop: 4 }}>
                            <b>{bf.card.ability?.trigger}</b> {bf.card.ability?.effect_text ? `— ${bf.card.ability.effect_text}` : ""}
                          </div>
                      ) : null}
                    </div>
                    <div style={{ textAlign: "right", fontSize: 12 }}>
                      {g.windowBattlefieldIndex === bf.index ? (
                          <div style={{ fontWeight: 800 }}>
                            {g.windowKind === "SHOWDOWN" ? "SHOWDOWN" : g.windowKind === "COMBAT" ? `COMBAT: ${g.combat?.step}` : ""}
                          </div>
                      ) : null}
                      {bf.facedown ? (
                          <div style={{ marginTop: 6 }}>
                            <div><b>Facedown:</b> {revealAllFacedown || viewerId === bf.facedown.owner ? bf.facedown.card.name : "Hidden"} ({bf.facedown.owner})</div>
                            <button disabled={!canActAs(bf.facedown.owner)} onClick={() => beginPlayFacedown(bf.facedown!.owner, bf.index)}>Play Hidden</button>
                          </div>
                      ) : (
                          <div style={{ marginTop: 6, color: "#666" }}>Facedown: —</div>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700 }}>P1 Units</div>
                      {bf.units.P1.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
                      {bf.units.P1.map((u) => renderCardPill(u))}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700 }}>P2 Units</div>
                      {bf.units.P2.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
                      {bf.units.P2.map((u) => renderCardPill(u))}
                    </div>
                  </div>
                </div>
            ))}
          </div>
        </div>
    );
  };

  const renderMovePanel = () => {
    if (!g) return null;
    const pid = g.turnPlayer;
    const p = g.players[pid];
    const from = moveSelection.from;
    const availableUnits: CardInstance[] = (() => {
      if (!from) return [];
      if (from.kind === "BASE") return p.base.units.filter((u) => u.isReady);
      return g.battlefields[from.index].units[pid].filter((u) => u.isReady);
    })();

    const destinations: ({ kind: "BASE" } | { kind: "BF"; index: number })[] = [
      { kind: "BASE" },
      { kind: "BF", index: 0 },
      { kind: "BF", index: 1 },
    ];

    return (
        <div style={{ border: "1px solid #bbb", borderRadius: 10, padding: 12, marginTop: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Standard Move (Turn player: {pid})</div>
          <div style={{ fontSize: 12, color: "#444", marginTop: 4 }}>
            Standard Move uses ready units and exhausts them; it does not use the chain.
          </div>

          <div style={{ display: "flex", gap: 12, marginTop: 10, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>From</div>
              <select
                  value={!from ? "" : from.kind === "BASE" ? "BASE" : `BF_${from.index}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) setMoveSelection((s) => ({ ...s, from: null, unitIds: [] }));
                    else if (v === "BASE") setMoveSelection((s) => ({ ...s, from: { kind: "BASE" }, unitIds: [] }));
                    else {
                      const idx = parseInt(v.split("_")[1], 10);
                      setMoveSelection((s) => ({ ...s, from: { kind: "BF", index: idx }, unitIds: [] }));
                    }
                  }}
                  style={{ width: "100%", padding: 6 }}
              >
                <option value="">—</option>
                <option value="BASE">Base</option>
                <option value="BF_0">Battlefield 1</option>
                <option value="BF_1">Battlefield 2</option>
              </select>

              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 700 }}>Units to move (ready only)</div>
                {availableUnits.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
                {availableUnits.map((u) => (
                    <label key={u.instanceId} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                      <input
                          type="checkbox"
                          checked={moveSelection.unitIds.includes(u.instanceId)}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setMoveSelection((s) => ({
                              ...s,
                              unitIds: checked ? [...s.unitIds, u.instanceId] : s.unitIds.filter((id) => id !== u.instanceId),
                            }));
                          }}
                      />
                      {u.name} (Might {effectiveMight(u, { role: "NONE" })}) {hasKeyword(u, "Ganking") ? "• Ganking" : ""}
                    </label>
                ))}
              </div>
            </div>

            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>To</div>
              <select
                  value={!moveSelection.to ? "" : moveSelection.to.kind === "BASE" ? "BASE" : `BF_${moveSelection.to.index}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) setMoveSelection((s) => ({ ...s, to: null }));
                    else if (v === "BASE") setMoveSelection((s) => ({ ...s, to: { kind: "BASE" } }));
                    else {
                      const idx = parseInt(v.split("_")[1], 10);
                      setMoveSelection((s) => ({ ...s, to: { kind: "BF", index: idx } }));
                    }
                  }}
                  style={{ width: "100%", padding: 6 }}
              >
                <option value="">—</option>
                {destinations.map((dst) => (
                    <option key={dst.kind === "BASE" ? "BASE" : `BF_${dst.index}`} value={dst.kind === "BASE" ? "BASE" : `BF_${dst.index}`}>
                      {dst.kind === "BASE" ? "Base" : `Battlefield ${dst.index + 1}`}
                    </option>
                ))}
              </select>

              <div style={{ marginTop: 12 }}>
                <button disabled={!canActAs(pid) || !canStandardMoveNow(g)} onClick={doStandardMove}>
                  Execute Standard Move
                </button>
              </div>
            </div>
          </div>
        </div>
    );
  };

  const renderHidePanel = () => {
    if (!g) return null;
    const pid = g.turnPlayer;
    const p = g.players[pid];
    const hiddenCards = p.hand.filter((c) => hasKeyword(c, "Hidden"));
    const controlledBfs = g.battlefields.filter((bf) => bf.controller === pid && !bf.facedown);

    return (
        <div style={{ border: "1px solid #bbb", borderRadius: 10, padding: 12, marginTop: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Hide (Hidden keyword)</div>
          <div style={{ fontSize: 12, color: "#444", marginTop: 4 }}>
            Hide: pay 1 power (any domain) and place the card facedown at a battlefield you control (one facedown per battlefield). You can play it later from that battlefield ignoring base cost.
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>Hidden card</div>
              <select
                  value={hideChoice.cardId ?? ""}
                  onChange={(e) => setHideChoice((s) => ({ ...s, cardId: e.target.value || null }))}
                  style={{ width: "100%", padding: 6 }}
                  disabled={!canActAs(pid) || !canHideNow(g)}
              >
                <option value="">—</option>
                {hiddenCards.map((c) => (
                    <option key={c.instanceId} value={c.instanceId}>
                      {c.name} ({c.type})
                    </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>Battlefield</div>
              <select
                  value={hideChoice.battlefieldIndex ?? ""}
                  onChange={(e) => setHideChoice((s) => ({ ...s, battlefieldIndex: e.target.value === "" ? null : parseInt(e.target.value, 10) }))}
                  style={{ width: "100%", padding: 6 }}
                  disabled={!canActAs(pid) || !canHideNow(g)}
              >
                <option value="">—</option>
                {controlledBfs.map((bf) => (
                    <option key={bf.index} value={bf.index}>
                      Battlefield {bf.index + 1} ({bf.card.name})
                    </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button disabled={!canActAs(pid) || !canHideNow(g)} onClick={commitHide}>
                Hide
              </button>
            </div>
          </div>
        </div>
    );
  };


  const renderChainChoiceModal = () => {
    if (!g || !pendingChainChoice) return null;
    const item = g.chain.find((x) => x.id === pendingChainChoice.chainItemId) || g.chain[g.chain.length - 1];
    if (!item) return null;

    const req: TargetRequirement = item.targetRequirement || { kind: "NONE" };
    const ctxBf = item.contextBattlefieldIndex ?? null;
    const restrictBf = item.restrictTargetsToBattlefieldIndex ?? null;

    const unitOptions = getUnitTargetOptions(g, item.controller, req, ctxBf, restrictBf);
    const battlefieldOptions = getBattlefieldTargetOptions(g, restrictBf);

    const pickerDisabled = viewerId !== item.controller;
    const canConfirm =
        viewerId === item.controller &&
        canActAs(item.controller) &&
        req.kind !== "NONE" &&
        pendingTargets[0]?.kind !== "NONE";

    return (
        <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              zIndex: 60,
            }}
        >
          <div
              style={{
                width: 720,
                maxWidth: "95vw",
                background: "#111827",
                border: "1px solid #374151",
                borderRadius: 12,
                padding: 16,
              }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>Choose Targets</div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Controller: {item.controller}</div>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
              <div style={{ fontWeight: 700 }}>{item.label}</div>
              {item.effectText ? <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{item.effectText}</div> : null}
            </div>

            {req.kind !== "NONE" ? (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>Targets</div>
                  <select
                      disabled={pickerDisabled}
                      style={{ width: "100%", padding: 6, marginTop: 6 }}
                      value={pendingTargets[0]?.kind === "NONE" ? "" : JSON.stringify(pendingTargets[0])}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) setPendingTargets([{ kind: "NONE" }]);
                        else setPendingTargets([JSON.parse(v)]);
                      }}
                  >
                    <option value="">—</option>
                    {(req.kind === "BATTLEFIELD" ? battlefieldOptions : unitOptions).map((u) => (
                        <option key={u.label} value={JSON.stringify(u.t)}>
                          {u.label}
                        </option>
                    ))}
                  </select>
                  {pickerDisabled ? (
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>Waiting for {item.controller}…</div>
                  ) : null}
                </div>
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                  onClick={confirmChainChoice}
                  disabled={!canConfirm}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid #374151",
                    background: canConfirm ? "#10b981" : "#374151",
                    color: "white",
                    cursor: canConfirm ? "pointer" : "not-allowed",
                  }}
              >
                Confirm Targets
              </button>
            </div>
          </div>
        </div>
    );
  };

  const renderPlayModal = () => {
    if (!g || !pendingPlay) return null;
    const pid = pendingPlay.player;
    const p = g.players[pid];

    // Find card
    let card: CardInstance | null =
        pendingPlay.from === "HAND"
            ? p.hand.find((c) => c.instanceId === pendingPlay.cardId) || null
            : pendingPlay.from === "CHAMPION"
                ? p.championZone && p.championZone.instanceId === pendingPlay.cardId
                    ? p.championZone
                    : null
                : (() => {
                  const bf = g.battlefields[pendingPlay.fromBattlefieldIndex ?? -1];
                  if (!bf?.facedown || bf.facedown.owner !== pid) return null;
                  return bf.facedown.card.instanceId === pendingPlay.cardId ? bf.facedown.card : null;
                })();

    if (!card) return null;

    const effect = card.ability?.effect_text || "";
    const targetReq: TargetRequirement =
        card.type === "Spell" ? inferTargetRequirement(effect, { here: pendingPlay.from === "FACEDOWN" }) : { kind: "NONE" };

    const restrictBf = pendingPlay.from === "FACEDOWN" ? pendingPlay.fromBattlefieldIndex ?? null : null;
    const ctxBf = g.windowBattlefieldIndex ?? null;

    const unitOptions = card.type === "Spell" ? getUnitTargetOptions(g, pid, targetReq, ctxBf, restrictBf) : [];
    const battlefieldOptions = card.type === "Spell" ? getBattlefieldTargetOptions(g, restrictBf) : [];

    const controlledBfs = g.battlefields.filter((bf) => bf.controller === pid);

    const powerDomainsAllowed = (() => {
      const doms = parseDomains(card.domain).map(clampDomain).filter((d) => d !== "Colorless");
      return doms.length > 0 ? doms : p.domains;
    })();

    const costPreview = (() => {
      const isHiddenPlay = pendingPlay.from === "FACEDOWN";
      const baseE = isHiddenPlay ? 0 : card.cost;
      const baseP = isHiddenPlay ? 0 : (card.stats.power ?? 0);
      const accel = card.type === "Unit" && hasKeyword(card, "Accelerate") && pendingAccelerate;
      const accelE = accel ? 1 : 0;
      const accelP = accel ? 1 : 0;
      const accelDom = pendingAccelerateDomain;
      let deflectTax = 0;
      const t = pendingTargets[0];
      if (t?.kind === "UNIT") {
        const loc = locateUnit(g, t.owner, t.instanceId);
        deflectTax = computeDeflectTax(loc?.unit || null);
      }
      return { baseE, baseP, accelE, accelP, accelDom, deflectTax, allowed: powerDomainsAllowed };
    })();

    return (
        <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.45)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
              zIndex: 1000,
            }}
        >
          <div style={{ width: 760, maxWidth: "100%", background: "white", borderRadius: 12, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 18, fontWeight: 900 }}>Play: {card.name}</div>
              <button onClick={cancelPendingPlay}>Close</button>
            </div>

            <div style={{ marginTop: 6, fontSize: 12, color: "#333" }}>
              {summarizeCard(card)}
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>Destination</div>

                {card.type === "Unit" ? (
                    <>
                      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                        <input
                            type="radio"
                            name="dest"
                            checked={pendingDestination?.kind === "BASE"}
                            onChange={() => setPendingDestination({ kind: "BASE" })}
                        />
                        Base
                      </label>
                      {controlledBfs.map((bf) => (
                          <label key={bf.index} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                            <input
                                type="radio"
                                name="dest"
                                checked={pendingDestination?.kind === "BF" && pendingDestination.index === bf.index}
                                onChange={() => setPendingDestination({ kind: "BF", index: bf.index })}
                            />
                            Battlefield {bf.index + 1} ({bf.card.name})
                          </label>
                      ))}
                    </>
                ) : card.type === "Gear" ? (
                    <div style={{ fontSize: 12, color: "#444" }}>
                      {pendingPlay.from === "FACEDOWN" ? `Hidden Gear will be played “here” at Battlefield ${pendingPlay.fromBattlefieldIndex! + 1} (simplified).` : "Gear is played to Base."}
                    </div>
                ) : (
                    <div style={{ fontSize: 12, color: "#444" }}>Spells resolve and go to Trash.</div>
                )}

                {card.type === "Unit" && hasKeyword(card, "Accelerate") ? (
                    <div style={{ marginTop: 10 }}>
                      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                        <input type="checkbox" checked={pendingAccelerate} onChange={(e) => setPendingAccelerate(e.target.checked)} />
                        Pay Accelerate (+1E +1 power of a card domain) to enter ready
                      </label>
                      {pendingAccelerate ? (
                          <div style={{ marginTop: 6, fontSize: 12 }}>
                            <span style={{ marginRight: 6 }}><b>Accelerate domain:</b></span>
                            <select
                                value={pendingAccelerateDomain}
                                onChange={(e) => setPendingAccelerateDomain(e.target.value as Domain)}
                            >
                              {powerDomainsAllowed.map((d) => (
                                  <option key={d} value={d}>{d}</option>
                              ))}
                            </select>
                          </div>
                      ) : null}
                    </div>
                ) : null}

                <div style={{ marginTop: 12, fontSize: 12 }}>
                  <div><b>Cost preview</b></div>
                  <div>Base: {costPreview.baseE}E + {costPreview.baseP}P (allowed: {costPreview.allowed.join(", ")})</div>
                  <div>Accelerate: +{costPreview.accelE}E +{costPreview.accelP} {costPreview.accelP ? costPreview.accelDom : ""}P</div>
                  <div>Deflect tax (any power): +{costPreview.deflectTax}P</div>
                </div>
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>Targets</div>
                {targetReq.kind === "NONE" ? (
                    <div style={{ fontSize: 12, color: "#666" }}>No target required (auto/inferred).</div>
                ) : (
                    <div style={{ fontSize: 12, color: "#444" }}>
                      Needs: {targetReq.kind}
                    </div>
                )}

                {targetReq.kind !== "NONE" ? (
                    <div style={{ marginTop: 8 }}>
                      <select
                          style={{ width: "100%", padding: 6 }}
                          value={pendingTargets[0]?.kind === "NONE" ? "" : JSON.stringify(pendingTargets[0])}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (!v) setPendingTargets([{ kind: "NONE" }]);
                            else setPendingTargets([JSON.parse(v)]);
                          }}
                      >
                        <option value="">—</option>
                        {(targetReq.kind === "BATTLEFIELD" ? battlefieldOptions : unitOptions).map((u) => (
                            <option key={u.label} value={JSON.stringify(u.t)}>
                              {u.label}
                            </option>
                        ))}
                      </select>
                      <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
                        Note: Hidden-play target legality “here” is not fully enforced; use manual discipline if needed.
                      </div>
                    </div>
                ) : null}
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14 }}>
              <button onClick={cancelPendingPlay}>Cancel</button>
              <button onClick={commitPendingPlay} disabled={!canActAs(pid)}>
                Put on Chain (Pay Costs)
              </button>
            </div>
          </div>
        </div>
    );
  };

  const renderChainPanel = () => {
    if (!g) return null;
    return (
        <div style={{ border: "1px solid #bbb", borderRadius: 10, padding: 12, marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>
              Chain / Priority — State: {g.state} {g.windowKind !== "NONE" ? `• ${g.windowKind} @ BF${(g.windowBattlefieldIndex ?? -1) + 1}` : ""}
            </div>
            <div style={{ fontSize: 12 }}>
              Priority: <b>{g.priorityPlayer}</b> • Passes in row: {g.passesInRow}
            </div>
          </div>

          {g.chain.length === 0 ? <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Chain is empty.</div> : null}
          {g.chain.length > 0 ? (
              <ol style={{ marginTop: 10, paddingLeft: 20, fontSize: 12 }}>
                {g.chain.map((it, i) => (
                    <li key={it.id}>
                      <b>{it.label}</b> — controller {it.controller}
                    </li>
                ))}
              </ol>
          ) : null}

          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <button disabled={!canActAs("P1") || g.priorityPlayer !== "P1"} onClick={() => passPriority("P1")}>
              P1 Pass
            </button>
            <button disabled={!canActAs("P2") || g.priorityPlayer !== "P2"} onClick={() => passPriority("P2")}>
              P2 Pass
            </button>
          </div>

          <div style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
            Two consecutive passes resolves the top of the chain; if the chain is empty, it ends the current showdown step.
          </div>
        </div>
    );
  };

  const renderLog = () => {
    if (!g) return null;
    return (
        <div style={{ border: "1px solid #bbb", borderRadius: 10, padding: 12, marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Log</div>
            <button onClick={() => updateGame((d) => (d.log = []))}>Clear</button>
          </div>
          <div style={{ marginTop: 10, maxHeight: 220, overflow: "auto", fontSize: 12, background: "#fafafa", padding: 10, borderRadius: 8 }}>
            {g.log.length === 0 ? <div style={{ color: "#666" }}>—</div> : null}
            {g.log.map((l, i) => (
                <div key={i} style={{ padding: "2px 0" }}>
                  {l}
                </div>
            ))}
          </div>
        </div>
    );
  };


  // ----------------------------- Arena UI helpers -----------------------------

  const arenaCss = `
    .rb-root {
      height: 100vh;
      width: 100%;
      color: #eef1f5;
      background:
        radial-gradient(1200px 700px at 50% 0%, rgba(80, 120, 255, 0.18), rgba(0, 0, 0, 0) 60%),
        radial-gradient(900px 600px at 15% 100%, rgba(255, 120, 80, 0.14), rgba(0, 0, 0, 0) 60%),
        radial-gradient(1000px 700px at 90% 70%, rgba(120, 255, 200, 0.10), rgba(0, 0, 0, 0) 55%),
        linear-gradient(180deg, #0b0f17 0%, #06070b 100%);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      overflow: hidden;
    }

    .rb-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.35);
      border-bottom: 1px solid rgba(255,255,255,0.12);
      backdrop-filter: blur(8px);
    }

    .rb-title {
      font-weight: 900;
      letter-spacing: 0.3px;
    }

    .rb-topbarControls {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .rb-topbarControls button, .rb-topbarControls select {
      background: rgba(255,255,255,0.08);
      color: #eef1f5;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 10px;
      padding: 7px 10px;
      font-size: 12px;
    }

    .rb-topbarControls button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .rb-content {
      height: calc(100vh - 54px);
      padding: 12px;
      box-sizing: border-box;
    }

    .rb-grid {
      height: 100%;
      width: 100%;
      display: grid;
      grid-template-columns: 300px 1fr 360px;
      grid-template-rows: 1fr;
      gap: 12px;
    }

    .rb-panel {
      background: rgba(0, 0, 0, 0.33);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 16px;
      padding: 12px;
      box-sizing: border-box;
      backdrop-filter: blur(10px);
      overflow: hidden;
    }

    .rb-panelTitle {
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      opacity: 0.9;
      margin-bottom: 10px;
    }

    .rb-board {
      position: relative;
      overflow: hidden;
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,0.12);
      background:
        radial-gradient(700px 380px at 50% 55%, rgba(255,255,255,0.06), rgba(0,0,0,0) 70%),
        linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.20));
    }

    .rb-boardInner {
      height: 100%;
      padding: 14px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 10px;
    }

    .rb-hudRow {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      justify-content: space-between;
    }

    .rb-hud {
      display: flex;
      gap: 10px;
      align-items: center;
      min-width: 0;
    }

    .rb-avatar {
      width: 46px;
      height: 46px;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.08);
      flex: 0 0 auto;
    }

    .rb-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .rb-hudText {
      min-width: 0;
    }

    .rb-hudName {
      font-weight: 900;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .rb-hudSub {
      font-size: 12px;
      opacity: 0.85;
    }

    .rb-matRow {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      align-items: stretch;
    }

    .rb-bf {
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(0,0,0,0.22);
      overflow: hidden;
      position: relative;
      min-height: 250px;
      padding: 10px;
      box-sizing: border-box;
    }

    .rb-bfHeader {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: flex-start;
      margin-bottom: 8px;
    }

    .rb-bfName {
      font-weight: 900;
      font-size: 13px;
      line-height: 1.15;
    }

    .rb-bfMeta {
      font-size: 11px;
      opacity: 0.85;
      margin-top: 2px;
    }

    .rb-bfControllerBadge {
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.08);
      white-space: nowrap;
    }

    .rb-bfBody {
      display: grid;
      grid-template-columns: 92px 1fr;
      gap: 10px;
      align-items: start;
    }

    .rb-bfSide {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
    }

    .rb-zoneLabel {
      font-size: 11px;
      opacity: 0.85;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .rb-card {
      width: 86px;
      height: 120px;
      border-radius: 12px;
      overflow: hidden;
      position: relative;
      box-shadow: 0 10px 24px rgba(0,0,0,0.55);
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06);
      transition: transform 120ms ease, box-shadow 120ms ease;
      cursor: default;
      user-select: none;
    }

    .rb-card img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .rb-card:hover {
      transform: translateY(-10px) scale(1.05);
      z-index: 60;
      box-shadow: 0 18px 40px rgba(0,0,0,0.65);
    }

    .rb-card--sm { width: 66px; height: 92px; border-radius: 11px; }
    .rb-card--xs { width: 54px; height: 76px; border-radius: 10px; }

    .rb-cardSelected {
      outline: 3px solid rgba(130, 210, 255, 0.9);
      box-shadow: 0 0 0 2px rgba(130, 210, 255, 0.30), 0 18px 40px rgba(0,0,0,0.65);
    }

    .rb-cardFaceDown {
      background:
        radial-gradient(120px 90px at 30% 20%, rgba(255,255,255,0.10), rgba(0,0,0,0) 70%),
        linear-gradient(135deg, rgba(20,20,30,0.85), rgba(0,0,0,0.85));
    }

    .rb-cardFaceDown::after {
      content: "RIFTBOUND";
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      letter-spacing: 1px;
      font-size: 10px;
      opacity: 0.75;
    }

    /* Runes (tap/recycle) */
    .rb-rune {
      width: 56px;
      height: 78px;
      border-radius: 11px;
      overflow: hidden;
      position: relative;
      box-shadow: 0 10px 22px rgba(0,0,0,0.55);
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06);
      transition: transform 120ms ease, box-shadow 120ms ease;
      cursor: pointer;
      user-select: none;
    }

    .rb-rune img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .rb-rune:hover {
      transform: translateY(-8px) scale(1.03);
      z-index: 60;
      box-shadow: 0 18px 40px rgba(0,0,0,0.65);
    }

    .rb-runeExhausted {
      opacity: 0.58;
      filter: grayscale(0.25) brightness(0.9);
    }

    .rb-runeGlowExhaust {
      box-shadow: 0 0 0 2px rgba(130, 210, 255, 0.85), 0 0 20px rgba(130, 210, 255, 0.35), 0 10px 22px rgba(0,0,0,0.55);
    }

    .rb-runeGlowRecycle {
      box-shadow: 0 0 0 2px rgba(255, 190, 120, 0.85), 0 0 20px rgba(255, 190, 120, 0.35), 0 10px 22px rgba(0,0,0,0.55);
    }

    .rb-runeGlowBoth {
      box-shadow: 0 0 0 2px rgba(200, 130, 255, 0.88), 0 0 20px rgba(200, 130, 255, 0.35), 0 10px 22px rgba(0,0,0,0.55);
    }

    .rb-runeHint {
      position: absolute;
      left: 6px;
      bottom: 6px;
      padding: 2px 6px;
      border-radius: 999px;
      background: rgba(0,0,0,0.65);
      border: 1px solid rgba(255,255,255,0.12);
      font-size: 10px;
      opacity: 0.9;
    }

    .rb-cardBadge {
      position: absolute;
      top: 6px;
      left: 6px;
      padding: 2px 6px;
      border-radius: 999px;
      background: rgba(0,0,0,0.65);
      border: 1px solid rgba(255,255,255,0.12);
      font-size: 11px;
    }

    .rb-cardStat {
      position: absolute;
      bottom: 6px;
      right: 6px;
      padding: 2px 6px;
      border-radius: 999px;
      background: rgba(0,0,0,0.65);
      border: 1px solid rgba(255,255,255,0.12);
      font-size: 11px;
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .rb-readyDot {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 1px solid rgba(0,0,0,0.3);
      background: rgba(90, 255, 145, 0.95);
    }
    .rb-exhaustedDot { background: rgba(255, 200, 60, 0.95); }

    .rb-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .rb-rowTight { gap: 6px; }

    .rb-rowCenter { justify-content: center; }

    .rb-hand {
      display: flex;
      justify-content: center;
      gap: 10px;
      padding: 6px 0 2px 0;
      flex-wrap: nowrap;
      overflow: auto;
    }

    .rb-hand::-webkit-scrollbar { height: 10px; }
    .rb-hand::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 999px; }

    .rb-actionHint {
      font-size: 12px;
      opacity: 0.85;
      margin-top: 6px;
      line-height: 1.3;
    }

    .rb-bigButton {
      width: 100%;
      padding: 12px 10px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(60, 150, 255, 0.22);
      color: #eef1f5;
      font-weight: 900;
      letter-spacing: 0.4px;
    }

    .rb-bigButton:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .rb-miniButton {
      padding: 6px 8px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.08);
      color: #eef1f5;
      font-size: 12px;
      font-weight: 700;
    }

    .rb-miniButton:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .rb-log {
      margin-top: 10px;
      max-height: calc(100% - 230px);
      overflow: auto;
      font-size: 12px;
      line-height: 1.25;
      background: rgba(0,0,0,0.25);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 14px;
      padding: 10px;
      box-sizing: border-box;
    }

    .rb-preview {
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(0,0,0,0.25);
    }

    .rb-preview img {
      width: 100%;
      display: block;
    }

    .rb-previewText {
      padding: 10px;
      font-size: 12px;
      line-height: 1.3;
    }

    .rb-softText { opacity: 0.8; }

    .rb-modalOverlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.68);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      padding: 18px;
    }

    .rb-modal {
      width: min(1080px, 96vw);
      max-height: min(84vh, 920px);
      overflow: hidden;
      border-radius: 18px;
      background: rgba(18, 20, 26, 0.98);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55);
      display: flex;
      flex-direction: column;
    }

    .rb-modalHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.10);
      background: rgba(0, 0, 0, 0.20);
    }

    .rb-modalBody {
      padding: 12px 14px;
      overflow: auto;
    }

    .rb-pileGrid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: flex-start;
    }
  `;

  const cardImageUrl = (c: any): string | null => {
    return (c?.image_url as string) || (c?.image as string) || null;
  };

  const sumPower = (pool: RunePool): number => {
    return (
        (pool.power.Body || 0) +
        (pool.power.Calm || 0) +
        (pool.power.Chaos || 0) +
        (pool.power.Fury || 0) +
        (pool.power.Mind || 0) +
        (pool.power.Order || 0) +
        (pool.power.Colorless || 0)
    );
  };

  const formatPowerBreakdown = (pool: RunePool): string => {
    const parts: string[] = [];
    const doms: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];
    for (const d of doms) parts.push(`${d[0]}:${pool.power[d] || 0}`);
    return parts.join(" ");
  };

  const commitHideAt = (pid: PlayerId, cardId: string, battlefieldIndex: number) => {
    if (!g) return;
    if (!canActAs(pid) || !canHideNow(g)) return;

    dispatchEngineAction({ type: "HIDE_CARD", player: pid, cardInstanceId: cardId, battlefieldIndex, autoPay: autoPayEnabled });

    setArenaHideCardId(null);
    setHideChoice({ cardId: null, battlefieldIndex: null });
  };


  const executeStandardMoveWith = (
      pid: PlayerId,
      from: { kind: "BASE" } | { kind: "BF"; index: number },
      unitIds: string[],
      to: { kind: "BASE" } | { kind: "BF"; index: number }
  ) => {
    if (!g) return;
    if (!canActAs(pid) || !canStandardMoveNow(g)) return;
    if (unitIds.length === 0) return;

    dispatchEngineAction({ type: "STANDARD_MOVE", player: pid, from, unitIds, to });

    setArenaMove(null);
    setMoveSelection({ from: null, unitIds: [], to: null });
  };


  type ArenaCardSize = "md" | "sm" | "xs";

  const ArenaCard = ({
                       card,
                       facedown,
                       size = "md",
                       selected,
                       dimmed,
                       showReadyDot,
                       onClick,
                       onDoubleClick,
                     }: {
    key?: string;
    card: CardInstance;
    facedown?: boolean;
    size?: ArenaCardSize;
    selected?: boolean;
    dimmed?: boolean;
    showReadyDot?: boolean;
    onClick?: () => void;
    onDoubleClick?: () => void;
  }) => {
    const img = !facedown ? cardImageUrl(card) : null;
    const sizeClass = size === "md" ? "" : size === "sm" ? " rb-card--sm" : " rb-card--xs";
    const cls = [
      "rb-card",
      sizeClass,
      facedown ? " rb-cardFaceDown" : "",
      selected ? " rb-cardSelected" : "",
    ].join("");

    const badge = card.type === "Unit" ? `${effectiveMight(card, { role: "NONE" })}` : card.type === "Spell" ? "Spell" : card.type === "Gear" ? "Gear" : card.type;

    return (
        <div
            className={cls}
            style={{ opacity: dimmed ? 0.55 : 1, cursor: onClick ? "pointer" : "default" }}
            onMouseEnter={() => (!facedown ? setHoverCard(card) : null)}
            onMouseLeave={() => setHoverCard((h) => (h && (h as any).instanceId === card.instanceId ? null : h))}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
        >
          {img ? <img src={img} alt={card.name} /> : null}
          {!facedown ? <div className="rb-cardBadge">{badge}</div> : null}
          {showReadyDot ? <div className={`rb-readyDot ${card.isReady ? "" : "rb-exhaustedDot"}`} /> : null}
          {!facedown && card.type === "Unit" ? (
              <div className="rb-cardStat">
                <span>M{effectiveMight(card, { role: "NONE" })}</span>
                <span>D{card.damage}</span>
              </div>
          ) : null}
        </div>
    );
  };

  const renderArenaGame = () => {
    if (!g) return null;
    const me: PlayerId = viewerId;
    const opp: PlayerId = otherPlayer(me);
    const meState = g.players[me];
    const oppState = g.players[opp];

    const selectedHandCard = meState.hand.find((c) => c.instanceId === selectedHandCardId) || null;
    const isMyTurn = g.turnPlayer === me;
    const canAdvanceStep = canActAs(me) && g.turnPlayer === me && g.chain.length === 0 && g.windowKind === "NONE" && g.state === "OPEN" && g.step !== "GAME_OVER";
    const canPass = g.priorityPlayer === me && (g.state === "CLOSED" || g.windowKind !== "NONE" || g.chain.length > 0);

    const showMulliganUI = g.step === "MULLIGAN";
    const mulliganSelected = new Set(meState.mulliganSelectedIds);

    const canSelectMoveUnits = isMyTurn && canStandardMoveNow(g) && canActAs(me);
    const canHide = isMyTurn && canHideNow(g) && canActAs(me);

    const BattlefieldMat = ({ idx }: { idx: number }) => {
      const bf = g.battlefields[idx];

      const canHideHere = !!arenaHideCardId && canHide && bf.controller === me && !bf.facedown;
      const canMoveHere =
          !!arenaMove && canSelectMoveUnits && !(arenaMove!.from.kind === "BF" && arenaMove!.from.index === idx);

      const controllerText = bf.controller ? `Controlled by ${bf.controller}` : "Uncontrolled";
      const contestedText = bf.contestedBy ? `• Contested by ${bf.contestedBy}` : "";

      return (
          <div
              className="rb-bf"
              style={{
                boxShadow: canHideHere
                    ? "0 0 0 2px rgba(120, 255, 200, 0.35), 0 20px 60px rgba(0,0,0,0.35)"
                    : canMoveHere
                        ? "0 0 0 2px rgba(130, 210, 255, 0.30), 0 20px 60px rgba(0,0,0,0.35)"
                        : undefined,
              }}
              onClick={() => {
                if (canHideHere) commitHideAt(me, arenaHideCardId!, idx);
                else if (canMoveHere) executeStandardMoveWith(me, arenaMove!.from, arenaMove!.unitIds, { kind: "BF", index: idx });
              }}
          >
            <div className="rb-bfHeader">
              <div style={{ minWidth: 0 }}>
                <div className="rb-bfName">{bf.card.name}</div>
                <div className="rb-bfMeta">
                  BF {idx + 1} • {controllerText} {contestedText}
                </div>
              </div>
              <div className="rb-bfControllerBadge">{bf.controller ?? "—"}</div>
            </div>

            <div className="rb-bfBody">
              <div className="rb-bfSide">
                <div className="rb-zoneLabel">Battlefield</div>
                <ArenaCard
                    card={{
                      ...(bf.card as any),
                      owner: bf.owner,
                      createdTurn: 0,
                      instanceId: `bf_${idx}`,
                      controller: bf.owner,
                      isReady: true,
                      damage: 0,
                      buffs: 0,
                      tempMightBonus: 0,
                      stunned: false,
                    }}
                    size="sm"
                    showReadyDot={false}
                    onClick={() => setHoverCard(bf.card as any)}
                />
                <div className="rb-zoneLabel">Facedown</div>
                {bf.facedown ? (
                    <ArenaCard
                        card={bf.facedown.card}
                        facedown={!(revealAllFacedown || viewerId === bf.facedown.owner)}
                        size="sm"
                        showReadyDot={false}
                        onDoubleClick={() => beginPlayFacedown(bf.facedown!.owner, idx)}
                        onClick={() => beginPlayFacedown(bf.facedown!.owner, idx)}
                    />
                ) : (
                    <div className="rb-softText" style={{ fontSize: 12 }}>
                      —
                    </div>
                )}
              </div>

              <div>
                <div className="rb-zoneLabel">{opp} units</div>
                <div className="rb-row rb-rowTight">
                  {bf.units[opp].length === 0 ? <span className="rb-softText">—</span> : null}
                  {bf.units[opp].map((u) => (
                      <ArenaCard
                          key={u.instanceId}
                          card={u}
                          size="xs"
                          showReadyDot={true}
                          onClick={() => setHoverCard(u)}
                      />
                  ))}
                </div>

                <div className="rb-zoneLabel">{opp} gear</div>
                <div className="rb-row rb-rowTight">
                  {bf.gear[opp].length === 0 ? <span className="rb-softText">—</span> : null}
                  {bf.gear[opp].map((g0) => (
                      <ArenaCard
                          key={g0.instanceId}
                          card={g0}
                          size="xs"
                          showReadyDot={true}
                          onClick={() => setHoverCard(g0)}
                      />
                  ))}
                </div>

                <div style={{ height: 10 }} />

                <div className="rb-zoneLabel">{me} units</div>
                <div className="rb-row rb-rowTight">
                  {bf.units[me].length === 0 ? <span className="rb-softText">—</span> : null}
                  {bf.units[me].map((u) => {
                    const selected = arenaMove?.unitIds.includes(u.instanceId) ?? false;
                    const clickable = canSelectMoveUnits && u.isReady;
                    return (
                        <ArenaCard
                            key={u.instanceId}
                            card={u}
                            size="xs"
                            selected={selected}
                            showReadyDot={true}
                            onClick={() => {
                              if (!clickable) return;
                              setArenaMove((s) => {
                                const from = { kind: "BF" as const, index: idx };
                                if (!s || s.from.kind !== "BF" || s.from.index !== idx) return { from, unitIds: [u.instanceId] };
                                const set = new Set(s.unitIds);
                                if (set.has(u.instanceId)) set.delete(u.instanceId);
                                else set.add(u.instanceId);
                                const nextIds = Array.from(set);
                                return nextIds.length === 0 ? null : { ...s, unitIds: nextIds };
                              });
                            }}
                            onDoubleClick={() => setHoverCard(u)}
                        />
                    );
                  })}
                </div>

                <div style={{ height: 10 }} />

                <div className="rb-zoneLabel">{me} gear</div>
                <div className="rb-row rb-rowTight">
                  {bf.gear[me].length === 0 ? <span className="rb-softText">—</span> : null}
                  {bf.gear[me].map((g1) => (
                      <ArenaCard
                          key={g1.instanceId}
                          card={g1}
                          size="xs"
                          showReadyDot={true}
                          onClick={() => setHoverCard(g1)}
                      />
                  ))}
                </div>
              </div>
            </div>
          </div>
      );
    };

    const BaseRow = ({ pid }: { pid: PlayerId }) => {
      const ps = g.players[pid];
      return (
          <div>
            <div className="rb-zoneLabel">{pid} base</div>
            <div className="rb-row rb-rowTight">
              {ps.base.units.map((u) => (
                  <ArenaCard
                      key={u.instanceId}
                      card={u}
                      size="xs"
                      selected={pid === me ? arenaMove?.unitIds.includes(u.instanceId) : false}
                      showReadyDot={true}
                      onClick={() => {
                        if (pid !== me) return;
                        const clickable = canSelectMoveUnits && u.isReady;
                        if (!clickable) return;
                        setArenaMove((s) => {
                          const from = { kind: "BASE" as const };
                          if (!s || s.from.kind !== "BASE") return { from, unitIds: [u.instanceId] };
                          const set = new Set(s.unitIds);
                          if (set.has(u.instanceId)) set.delete(u.instanceId);
                          else set.add(u.instanceId);
                          const nextIds = Array.from(set);
                          return nextIds.length === 0 ? null : { ...s, unitIds: nextIds };
                        });
                      }}
                  />
              ))}
              {ps.base.gear.map((gear) => (
                  <ArenaCard key={gear.instanceId} card={gear} size="xs" showReadyDot={true} onClick={() => setHoverCard(gear)} />
              ))}
              {ps.base.units.length === 0 && ps.base.gear.length === 0 ? <span className="rb-softText">—</span> : null}
            </div>
          </div>
      );
    };

    const renderHand = () => {
      const p = meState;
      const isHideArming = !!arenaHideCardId;

      return (
          <div>
            <div className="rb-zoneLabel">
              Hand ({p.hand.length}) {showMulliganUI ? "• Mulligan: click up to 2 cards" : ""}
            </div>

            <div className="rb-hand">
              {p.hand.length === 0 ? <span className="rb-softText">—</span> : null}
              {p.hand.map((c) => {
                const isMull = showMulliganUI && mulliganSelected.has(c.instanceId);
                const isSelected = selectedHandCardId === c.instanceId;
                const showSel = showMulliganUI ? isMull : isSelected;
                return (
                    <div
                        key={c.instanceId}
                        onMouseEnter={() => {
                          if (!autoPayEnabled) return;
                          if (!g) return;
                          if (!canActAs(me)) return;
                          if (showMulliganUI) return;

                          const reason = canPlayNonspellOutsideShowdown(c, g, me);
                          if (reason) {
                            setHoverPayPlan(null);
                            return;
                          }

                          const domainsAllowed = (() => {
                            const doms = parseDomains(c.domain).map(clampDomain);
                            if (doms.length === 0 || doms.includes("Colorless")) return meState.domains;
                            return doms;
                          })();

                          const plan = buildAutoPayPlan(meState.runePool, meState.runesInPlay, {
                            energyNeed: c.cost,
                            basePowerNeed: c.stats.power || 0,
                            powerDomainsAllowed: domainsAllowed,
                            additionalPowerByDomain: {},
                            additionalPowerAny: 0,
                          });

                          if (plan) setHoverPayPlan({ cardInstanceId: c.instanceId, plan });
                          else setHoverPayPlan(null);
                        }}
                        onMouseLeave={() => {
                          setHoverPayPlan((prev) => (prev?.cardInstanceId === c.instanceId ? null : prev));
                        }}
                    >
                      <ArenaCard
                          card={c}
                          size="md"
                          selected={showSel}
                          showReadyDot={false}
                          onClick={() => {
                            if (showMulliganUI) {
                              toggleMulliganSelect(me, c.instanceId);
                              return;
                            }
                            setSelectedHandCardId(c.instanceId);
                            setArenaHideCardId(null);
                          }}
                          onDoubleClick={() => {
                            if (showMulliganUI) return;
                            beginPlayFromHand(me, c.instanceId);
                          }}
                      />
                    </div>
                );
              })}
            </div>

            <div className="rb-actionHint">
              {showMulliganUI ? (
                  <>
                    <button className="rb-miniButton" disabled={meState.mulliganDone} onClick={() => confirmMulligan(me)}>
                      {meState.mulliganDone ? "Mulligan Confirmed" : `Confirm Mulligan (${meState.mulliganSelectedIds.length}/2)`}
                    </button>
                    <div className="rb-softText" style={{ marginTop: 6 }}>
                      Switch “playing as” to confirm the other player.
                    </div>
                  </>
              ) : selectedHandCard ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span>
                  Selected: <b>{selectedHandCard.name}</b>
                </span>
                    <button className="rb-miniButton" disabled={!canActAs(me)} onClick={() => beginPlayFromHand(me, selectedHandCard.instanceId)}>
                      Play
                    </button>
                    {hasKeyword(selectedHandCard, "Hidden") ? (
                        <button
                            className="rb-miniButton"
                            disabled={!canHide}
                            onClick={() => setArenaHideCardId((s) => (s === selectedHandCard.instanceId ? null : selectedHandCard.instanceId))}
                        >
                          {isHideArming ? "Cancel Hide" : "Hide → Battlefield"}
                        </button>
                    ) : null}
                    {isHideArming ? <span className="rb-softText">Click a battlefield you control to place it facedown.</span> : null}
                  </div>
              ) : (
                  <span className="rb-softText">Tip: double-click a card to play it.</span>
              )}
            </div>
          </div>
      );
    };

    const renderPreview = () => {
      if (!hoverCard) return <div className="rb-softText">Hover a card to preview it here.</div>;
      const c: any = hoverCard;
      const img = cardImageUrl(c);
      return (
          <div>
            <div className="rb-preview">
              {img ? <img src={img} alt={c.name} /> : null}
              <div className="rb-previewText">
                <div style={{ fontWeight: 900, marginBottom: 4 }}>{c.name}</div>
                <div className="rb-softText" style={{ marginBottom: 6 }}>
                  {c.type} • {c.domain} • Cost {c.cost}E{c.stats?.power ? ` + ${c.stats.power}P` : ""}
                </div>
                {c.ability?.keywords?.length ? <div style={{ marginBottom: 6 }}>KW: {c.ability.keywords.join(", ")}</div> : null}
                {c.ability?.effect_text ? <div>{c.ability.effect_text}</div> : null}
              </div>
            </div>
          </div>
      );
    };

    return (
        <div className="rb-grid">
          <div className="rb-panel">
            <div className="rb-panelTitle">Preview</div>
            {renderPreview()}
            <div className="rb-panelTitle" style={{ marginTop: 12 }}>
              Log
            </div>
            <div className="rb-log">
              {g.log.length === 0 ? <div className="rb-softText">—</div> : null}
              {g.log.slice(0, 30).map((l, i) => (
                  <div key={i} style={{ padding: "2px 0" }}>
                    {l}
                  </div>
              ))}
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 8, justifyContent: "space-between" }}>
              <button className="rb-miniButton" onClick={() => updateGame((d) => (d.log = []))}>
                Clear log
              </button>
              <button className="rb-miniButton" onClick={() => setHoverCard(null)}>
                Clear preview
              </button>
            </div>
          </div>

          <div className="rb-board">
            <div className="rb-boardInner">
              <div className="rb-hudRow">
                <div className="rb-hud">
                  <div className="rb-avatar">
                    {oppState.legend && cardImageUrl(oppState.legend) ? <img src={cardImageUrl(oppState.legend)!} alt={oppState.legend.name} /> : null}
                  </div>
                  <div className="rb-hudText">
                    <div className="rb-hudName">{opp} — {oppState.legend ? oppState.legend.name : "Legend"}</div>
                    <div className="rb-hudSub">
                      Points {oppState.points}/{g.victoryScore} • Hand {oppState.hand.length} • Deck {oppState.mainDeck.length} • <button className="rb-miniButton" onClick={() => setPileViewer({ player: opp, zone: "TRASH" })}>Trash {oppState.trash.length}</button>
                    </div>
                  </div>
                </div>

                <div style={{ textAlign: "right", fontSize: 12, opacity: 0.9 }}>
                  <div>
                    Turn {g.turnNumber} • <b>{g.step}</b>
                  </div>
                  <div>
                    Turn player: <b>{g.turnPlayer}</b> • Priority: <b>{g.priorityPlayer}</b>
                  </div>
                  <div>
                    Chain: {g.chain.length} • State: {g.state} {g.windowKind !== "NONE" ? `• ${g.windowKind} @ BF${(g.windowBattlefieldIndex ?? -1) + 1}` : ""}
                  </div>
                </div>
              </div>

              <BaseRow pid={opp} />

              <div className="rb-matRow">
                <BattlefieldMat idx={0} />
                <BattlefieldMat idx={1} />
              </div>

              <div
                  style={{
                    border: arenaMove && canSelectMoveUnits ? "1px dashed rgba(130, 210, 255, 0.45)" : "1px solid rgba(255,255,255,0.10)",
                    borderRadius: 16,
                    padding: 10,
                    background: "rgba(0,0,0,0.18)",
                  }}
                  onClick={() => {
                    if (arenaMove && canSelectMoveUnits && arenaMove.from.kind !== "BASE") {
                      executeStandardMoveWith(me, arenaMove.from, arenaMove.unitIds, { kind: "BASE" });
                    }
                  }}
              >
                <BaseRow pid={me} />
                {arenaMove && canSelectMoveUnits ? (
                    <div className="rb-actionHint">
                      Move armed: click a battlefield (or this base panel) to move selected ready units.{" "}
                      <button className="rb-miniButton" onClick={() => setArenaMove(null)}>
                        Cancel move
                      </button>
                    </div>
                ) : null}
              </div>

              {renderHand()}
            </div>
          </div>

          <div className="rb-panel">
            <div className="rb-panelTitle">Actions</div>

            <button className="rb-bigButton" disabled={!canAdvanceStep} onClick={() => nextStep()}>
              {g.step === "ACTION" ? "End Turn" : "Next Step"}
            </button>

            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button className="rb-miniButton" disabled={!canPass || !canActAs(me)} onClick={() => passPriority(me)}>
                Pass
              </button>
              <button className="rb-miniButton" disabled={undoRef.current.length === 0} onClick={undo}>
                Undo
              </button>
              <button className="rb-miniButton" onClick={() => setArenaMove(null)}>
                Clear move
              </button>
              <button className="rb-miniButton" onClick={() => setArenaHideCardId(null)}>
                Clear hide
              </button>
            </div>

            <div className="rb-actionHint" style={{ marginTop: 10 }}>
              <div>
                <b>{me}</b> Pool: {meState.runePool.energy}E • {sumPower(meState.runePool)}P ({formatPowerBreakdown(meState.runePool)})
              </div>
              <div className="rb-softText" style={{ marginTop: 4 }}>
                Opponent pool hidden in this view (switch “playing as” to see it).
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input
                    type="checkbox"
                    checked={autoPayEnabled}
                    onChange={(e) => setAutoPayEnabled(e.target.checked)}
                />
                Auto-pay runes on Play
              </label>
              <div className="rb-softText" style={{ marginTop: 4 }}>
                Hover a hand card to preview payment: <span style={{ opacity: 0.95 }}>blue = Exhaust</span>, <span style={{ opacity: 0.95 }}>orange = Recycle</span>, <span style={{ opacity: 0.95 }}>purple = Both</span>.
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="rb-panelTitle">Legend</div>
              {meState.legend ? (
                  <div className="rb-row rb-rowCenter" style={{ flexDirection: "column", gap: 8 }}>
                    <ArenaCard
                        card={{
                          ...(meState.legend as any),
                          instanceId: `legend_${me}`,
                          owner: me,
                          controller: me,
                          isReady: meState.legendReady,
                          damage: 0,
                          buffs: 0,
                          tempMightBonus: 0,
                          stunned: false,
                          createdTurn: 0,
                        }}
                        size="sm"
                        showReadyDot={true}
                        onClick={() => setHoverCard(meState.legend as any)}
                    />
                    <button
                        className="rb-miniButton"
                        disabled={!canActAs(me) || g.priorityPlayer !== me || !meState.legendReady || !legendActivatedEffect(meState.legend)}
                        onClick={() => dispatchEngineAction({ type: "LEGEND_ACTIVATE", player: me, autoPay: autoPayEnabled })}
                        title={
                          !legendActivatedEffect(meState.legend)
                              ? "Legend activated Exhaust ability not supported yet"
                              : g.priorityPlayer !== me
                                  ? "You must have priority"
                                  : !meState.legendReady
                                      ? "Legend is exhausted"
                                      : "Activate Legend"
                        }
                    >
                      Activate Legend
                    </button>
                  </div>
              ) : (
                  <div className="rb-softText">—</div>
              )}
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="rb-panelTitle">Champion</div>
              {meState.championZone ? (
                  <div className="rb-row rb-rowCenter">
                    <ArenaCard
                        card={meState.championZone}
                        size="sm"
                        showReadyDot={false}
                        onDoubleClick={() => beginPlayChampion(me)}
                        onClick={() => beginPlayChampion(me)}
                    />
                  </div>
              ) : (
                  <div className="rb-softText">—</div>
              )}
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="rb-panelTitle">Runes in play</div>
              {meState.runesInPlay.length === 0 ? <div className="rb-softText">—</div> : null}
              <div className="rb-row rb-rowTight">
                {meState.runesInPlay.map((r) => {
                  const h = hoverPayPlan?.plan.runeUses[r.instanceId];
                  const img = cardImageUrl(r);
                  const cls = [
                    "rb-rune",
                    !r.isReady ? "rb-runeExhausted" : "",
                    h === "EXHAUST" ? "rb-runeGlowExhaust" : "",
                    h === "RECYCLE" ? "rb-runeGlowRecycle" : "",
                    h === "BOTH" ? "rb-runeGlowBoth" : "",
                  ]
                      .filter(Boolean)
                      .join(" ");
                  const hint = h === "EXHAUST" ? "E" : h === "RECYCLE" ? "P" : h === "BOTH" ? "E+P" : (r.domain?.[0] || "R");

                  return (
                      <div
                          key={r.instanceId}
                          className={cls}
                          title={`${r.name || "Rune"} (${r.domain}) • Left-click: Exhaust (+1 Energy) • Right-click: Recycle (+1 Power)`}
                          onClick={() => exhaustRuneForEnergy(me, r.instanceId)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            recycleRuneForPower(me, r.instanceId);
                          }}
                      >
                        {img ? (
                            <img src={img} alt={r.name || r.domain} />
                        ) : (
                            <div
                                style={{
                                  width: "100%",
                                  height: "100%",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  fontWeight: 900,
                                  letterSpacing: 0.6,
                                  opacity: 0.9,
                                }}
                            >
                              {r.domain}
                            </div>
                        )}
                        <div className={`rb-readyDot ${r.isReady ? "" : "rb-exhaustedDot"}`} />
                        <div className="rb-runeHint">{hint}</div>
                      </div>
                  );
                })}
              </div>
              <div className="rb-actionHint" style={{ marginTop: 8 }}>
                Tip: left-click a rune to <b>Exhaust</b> (+1E). Right-click to <b>Recycle</b> (+1P). Hover a hand card to preview auto-pay.
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="rb-panelTitle">Gear (Seals)</div>
              {meState.base.gear.length === 0 ? <div className="rb-softText">—</div> : null}
              <div className="rb-row rb-rowTight" style={{ flexWrap: "wrap" }}>
                {meState.base.gear.map((gear) => (
                    <div key={gear.instanceId} style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
                      <ArenaCard card={gear} size="xs" showReadyDot={true} onClick={() => setHoverCard(gear)} />
                      <button className="rb-miniButton" disabled={!canActAs(me) || !gear.isReady} onClick={() => exhaustGearForSealPower(me, gear.instanceId)}>
                        Exhaust (Seal)
                      </button>
                    </div>
                ))}
              </div>

            </div>


            <div style={{ marginTop: 14 }}>
              <div className="rb-panelTitle">Piles</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="rb-miniButton" onClick={() => setPileViewer({ player: me, zone: "TRASH" })}>
                  Your Trash ({meState.trash.length})
                </button>
                <button className="rb-miniButton" onClick={() => setPileViewer({ player: opp, zone: "TRASH" })}>
                  Opponent Trash ({oppState.trash.length})
                </button>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="rb-panelTitle">UI</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="rb-miniButton" onClick={() => setUiMode("Arena")} disabled={uiMode === "Arena"}>
                  Arena
                </button>
                <button className="rb-miniButton" onClick={() => setUiMode("Classic")} disabled={uiMode === "Classic"}>
                  Classic
                </button>
              </div>
              <div className="rb-actionHint">Arena is board-focused; Classic is the old debug panel layout.</div>
            </div>
          </div>
        </div>
    );
  };

  const renderSetupScreen = () => {
    return (
        <div style={{ maxWidth: 720, margin: "28px auto" }} className="rb-panel">
          <div className="rb-panelTitle">Setup</div>
          <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 8 }}>Load card data and start a duel</div>
          <div className="rb-softText" style={{ marginBottom: 12 }}>
            Load the provided JSON card database, then auto-setup a hot-seat Duel.
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  loadCardData(file).catch((err) => alert(String(err)));
                }}
            />
            <div className="rb-softText">Loaded cards: <b>{allCards.length}</b></div>
          </div>

          <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className="rb-bigButton" style={{ maxWidth: 320 }} disabled={allCards.length === 0} onClick={startAutoDuel}>
              Auto-setup Duel (Hot-seat)
            </button>

            <button className="rb-bigButton" style={{ maxWidth: 260 }} disabled={allCards.length === 0} onClick={() => setPreGameView("DECK_BUILDER")}>
              Deck Builder
            </button>

            <div className="rb-softText">
              Tip: once started, switch “playing as” to take actions for each player.
            </div>
          </div>
        </div>
    );
  };


  const renderDeckBuilder = () => {
    const pid = builderActivePlayer;
    const spec = builderDecks[pid] || emptyDeckSpec();

    const legends = allCards
        .filter((c) => c.type === "Legend")
        .slice()
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    const runeCards = allCards
        .filter((c) => c.type === "Rune")
        .slice()
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    const battlefieldCards = allCards
        .filter((c) => c.type === "Battlefield")
        .slice()
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    const mainPoolAll = allCards
        .filter((c) => isMainDeckType(c.type))
        .slice()
        .sort((a, b) => {
          const ca = Number(a.cost || 0);
          const cb = Number(b.cost || 0);
          if (ca !== cb) return ca - cb;
          return (a.name || "").localeCompare(b.name || "");
        });

    const legend = spec.legendId ? getCardById(allCards, spec.legendId) : null;
    const identity = legend ? domainIdentityFromLegend(legend) : (["Body", "Calm", "Chaos", "Fury", "Mind", "Order"] as Domain[]);
    const champTag = legend ? ((legend.tags || [])[0] || null) : null;

    const eligibleBattlefields = legend ? battlefieldCards.filter((b) => cardWithinIdentity(b, identity)) : battlefieldCards;

    const eligibleRunes = legend
        ? runeCards.filter((r) => {
          const domRaw = (parseDomains(r.domain)[0] || r.domain || "Colorless").trim();
          const dom = clampDomain(domRaw);
          return dom === "Colorless" || identity.includes(dom);
        })
        : runeCards;

    const eligibleMainPool = legend ? mainPoolAll.filter((c) => cardWithinIdentity(c, identity)) : mainPoolAll;

    const eligibleChampions = legend ? eligibleMainPool.filter((c) => isLikelyChampionUnit(c, champTag)) : [];

    const mainTotal = countTotal(spec.main);
    const runeTotal = countTotal(spec.runes);

    const toPreview = (cd: CardData, labelSalt = ""): CardInstance => ({
      ...cd,
      instanceId: `preview_${pid}_${labelSalt}_${cd.id}`,
      owner: pid,
      controller: pid,
      isReady: true,
      damage: 0,
      buffs: 0,
      tempMightBonus: 0,
      stunned: false,
      stunnedUntilTurn: 0,
      moveCountThisTurn: 0,
      createdTurn: 0,
    });

    const validateDeck = (p: PlayerId, s: DeckSpec): string[] => {
      const errs: string[] = [];

      const lg = s.legendId ? getCardById(allCards, s.legendId) : null;
      if (!lg || lg.type !== "Legend") errs.push("Select a Legend.");

      const champ = s.championId ? getCardById(allCards, s.championId) : null;
      if (!champ || champ.type !== "Unit") errs.push("Select a chosen Champion (Unit).");

      const bfs = s.battlefields || [];
      if (bfs.length !== 3) errs.push(`Choose exactly 3 battlefields (currently ${bfs.length}).`);

      const rTotal = countTotal(s.runes || {});
      if (rTotal !== 12) errs.push(`Rune deck must have exactly 12 cards (currently ${rTotal}).`);

      const mTotal = countTotal(s.main || {});
      if (mTotal < 40) errs.push(`Main deck must have at least 40 cards (currently ${mTotal}).`);

      if (champ && champ.type === "Unit") {
        const champCopies = Math.floor((s.main || {})[champ.id] || 0);
        if (champCopies < 1) errs.push("Main deck must include at least 1 copy of the chosen Champion.");
      }

      // Best-effort deep validation using the builder->engine conversion (gives more precise domain/tag errors).
      try {
        buildPlayerFromDeckSpec(allCards, p, s, 1);
      } catch (e: any) {
        const msg = String(e?.message || e);
        // avoid duplicates
        if (!errs.includes(msg)) errs.push(msg);
      }

      return errs;
    };

    const errorsP1 = validateDeck("P1", builderDecks.P1);
    const errorsP2 = validateDeck("P2", builderDecks.P2);
    const activeErrors = pid === "P1" ? errorsP1 : errorsP2;
    const canStart = allCards.length > 0 && errorsP1.length === 0 && errorsP2.length === 0;


    const bfsP1 = deckBattlefieldsFor("P1");
    const bfsP2 = deckBattlefieldsFor("P2");
    const usedBattlefieldIds =
        matchState?.format === "BO3" && matchState?.usedBattlefieldIds
            ? matchState.usedBattlefieldIds
            : { P1: [], P2: [] };
    const remainingBfP1 = bfsP1.filter((b) => !usedBattlefieldIds.P1.includes(b.id));
    const remainingBfP2 = bfsP2.filter((b) => !usedBattlefieldIds.P2.includes(b.id));

    const nextOptionsP1 = remainingBfP1.length > 0 ? remainingBfP1 : bfsP1;
    const nextOptionsP2 = remainingBfP2.length > 0 ? remainingBfP2 : bfsP2;



    // Card browser filters (main-deck only)
    let browser = eligibleMainPool;
    if (builderTypeFilter !== "All") browser = browser.filter((c) => c.type === builderTypeFilter);
    const q = builderSearch.trim().toLowerCase();
    if (q) browser = browser.filter((c) => (c.name || "").toLowerCase().includes(q) || (c.id || "").toLowerCase().includes(q));
    browser = browser.slice(0, 96);

    const deckRows = Object.entries(spec.main)
        .map(([id, n]) => ({ id, n: n as number, card: getCardById(allCards, id) }))
        .filter((x): x is { id: string; n: number; card: CardData } => x.card !== null && (x.n || 0) > 0)
        .sort((a, b) => {
          const ta = (a.card as any).type || "";
          const tb = (b.card as any).type || "";
          if (ta !== tb) return ta.localeCompare(tb);
          const ca = Number((a.card as any).cost || 0);
          const cb = Number((b.card as any).cost || 0);
          if (ca !== cb) return ca - cb;
          return ((a.card as any).name || "").localeCompare((b.card as any).name || "");
        });

    const activeLegendName = legend?.name || "—";
    const activeIdentityText = legend ? identity.join(", ") : "—";

    const toggleBattlefield = (bfId: string) => {
      updateDeck(pid, (d) => {
        const cur = d.battlefields || [];
        if (cur.includes(bfId)) return { ...d, battlefields: cur.filter((x) => x !== bfId) };
        if (cur.length >= 3) return d; // hard cap
        return { ...d, battlefields: [...cur, bfId] };
      });
    };

    const autoFillActive = () => {
      if (allCards.length === 0) return;

      updateDeck(pid, (d) => {
        // Legend
        const lg = d.legendId ? getCardById(allCards, d.legendId) : null;
        const legendCard = lg && lg.type === "Legend" ? lg : legends[0] || null;
        if (!legendCard) return d;
        const id = domainIdentityFromLegend(legendCard);
        const tag = (legendCard.tags || [])[0] || null;

        // Champion (heuristic: champion-tag + comma-name)
        const champCandidates = allCards
            .filter((c) => isLikelyChampionUnit(c, tag))
            .filter((c) => cardWithinIdentity(c, id));
        const champ = champCandidates[0] || allCards.find((c) => c.type === "Unit") || null;

        // Battlefields (3)
        const bfPool = battlefieldCards.filter((b) => cardWithinIdentity(b, id));
        const bf3 = (shuffle(bfPool, 777) as CardData[]).slice(0, 3).map((b) => b.id);

        // Runes (12): distribute across identity domains
        const runeByDomain: Partial<Record<Domain, CardData>> = {};
        for (const rc of runeCards) {
          const domRaw = (parseDomains(rc.domain)[0] || rc.domain || "Colorless").trim();
          const dom = clampDomain(domRaw);
          if (!runeByDomain[dom]) runeByDomain[dom] = rc;
        }
        const runeCounts: Record<string, number> = {};
        const doms = id.length > 0 ? id : (["Body", "Calm", "Chaos", "Fury", "Mind", "Order"] as Domain[]);
        const per = Math.floor(12 / doms.length);
        const rem = 12 % doms.length;
        for (let i = 0; i < doms.length; i++) {
          const dom = doms[i];
          const cnt = per + (i < rem ? 1 : 0);
          const runeCard = runeByDomain[dom] || runeCards[0];
          if (!runeCard) continue;
          runeCounts[runeCard.id] = (runeCounts[runeCard.id] || 0) + cnt;
        }

        // Main deck (>=40) with max 3 copies
        const pool = eligibleMainPool.length > 0 ? eligibleMainPool : mainPoolAll;
        const counts: Record<string, number> = {};
        if (champ && champ.id) counts[champ.id] = 1;

        const maxCopies = 3;
        const picks = shuffle(pool, 888) as CardData[];
        let i = 0;
        while (countTotal(counts) < 40 && picks.length > 0) {
          const c = picks[i % picks.length];
          i++;
          if (!c) break;
          if (counts[c.id] >= maxCopies) continue;
          counts[c.id] = (counts[c.id] || 0) + 1;
        }

        return {
          legendId: legendCard.id,
          championId: champ ? champ.id : null,
          battlefields: bf3,
          runes: runeCounts,
          main: counts,
        };
      });
    };

    const exportDecks = async () => {
      const payload = JSON.stringify(builderDecks, null, 2);
      try {
        await navigator.clipboard.writeText(payload);
        alert("Decks JSON copied to clipboard.");
      } catch {
        window.prompt("Copy decks JSON:", payload);
      }
    };

    const importDecks = () => {
      const raw = window.prompt("Paste decks JSON here:");
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed?.P1 || !parsed?.P2) throw new Error("Expected object with {P1, P2}.");
        setBuilderDecks({ P1: parsed.P1, P2: parsed.P2 });
        alert("Imported.");
      } catch (e: any) {
        alert(`Import failed: ${String(e?.message || e)}`);
      }
    };

    // ----------------------------- Saved Deck Library helpers -----------------------------

    const isDeckSpec = (x: any): x is DeckSpec => {
      return !!x && typeof x === "object" && "legendId" in x && "main" in x && "runes" in x && "battlefields" in x;
    };

    const selectedLibDeck = selectedLibraryDeckId ? deckLibrary.find((d) => d.id === selectedLibraryDeckId) || null : null;

    const libSearch = librarySearch.trim().toLowerCase();
    const libTag = libraryTagFilter.trim().toLowerCase();

    const filteredLibrary = deckLibrary.filter((d) => {
      const name = (d.name || "").toLowerCase();
      const tags = (d.tags || []).map((t) => String(t).toLowerCase());
      if (libSearch && !name.includes(libSearch) && !tags.some((t) => t.includes(libSearch))) return false;
      if (libTag && !tags.some((t) => t.includes(libTag))) return false;
      return true;
    });

    const loadLibraryDeckIntoBuilder = (deck: DeckLibraryEntry, pid: PlayerId) => {
      setBuilderDecks((prev) => ({ ...prev, [pid]: deepClone(deck.spec) }));
      setSaveAsName(deck.name || "");
      setSaveAsTags((deck.tags || []).join(", "));
      setSelectedLibraryDeckId(deck.id);
    };

    const defaultDeckName = (s: DeckSpec): string => {
      const lg = s.legendId ? getCardById(allCards, s.legendId) : null;
      const ch = s.championId ? getCardById(allCards, s.championId) : null;
      const a = lg?.name || "Legend";
      const b = ch?.name || "Champion";
      return `${a} — ${b}`;
    };

    const parseTagCsv = (csv: string): string[] => {
      return String(csv || "")
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .slice(0, 16);
    };

    const saveActiveToLibraryAsNew = () => {
      const name = (saveAsName && saveAsName.trim().length > 0 ? saveAsName.trim() : defaultDeckName(spec)).trim();
      if (!name) return;

      const entry: DeckLibraryEntry = {
        id: makeDeckLibraryId(),
        name,
        tags: parseTagCsv(saveAsTags),
        spec: deepClone(spec),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setDeckLibrary((prev) => [entry, ...prev]);
      setSelectedLibraryDeckId(entry.id);
    };


    const updateSelectedLibraryDeck = () => {
      if (!selectedLibraryDeckId) {
        alert("Select a saved deck first.");
        return;
      }
      setDeckLibrary((prev) =>
          prev.map((d) => (d.id === selectedLibraryDeckId ? { ...d, spec: deepClone(spec), updatedAt: Date.now() } : d))
      );
      alert("Updated saved deck.");
    };

    const loadSelectedLibraryDeckIntoActive = () => {
      if (!selectedLibDeck) {
        alert("Select a saved deck first.");
        return;
      }
      updateDeck(pid, () => deepClone(selectedLibDeck.spec));
      alert(`Loaded \"${selectedLibDeck.name}\" into ${pid}.`);
    };

    const renameSelectedLibraryDeck = () => {
      if (!selectedLibDeck) return;
      const name = window.prompt("New name:", selectedLibDeck.name);
      if (!name) return;
      setDeckLibrary((prev) => prev.map((d) => (d.id === selectedLibDeck.id ? { ...d, name, updatedAt: Date.now() } : d)));
    };

    const setSelectedLibraryDeckTags = (csv: string) => {
      if (!selectedLibDeck) return;
      const tags = parseTagCsv(csv);
      setDeckLibrary((prev) =>
          prev.map((d) => (d.id === selectedLibDeck.id ? { ...d, tags, updatedAt: Date.now() } : d))
      );
    };

    const duplicateSelectedLibraryDeck = () => {
      if (!selectedLibDeck) return;
      const name = window.prompt("Name for duplicate:", `${selectedLibDeck.name} (copy)`);
      if (!name) return;
      const entry: DeckLibraryEntry = {
        id: makeDeckLibraryId(),
        name,
        tags: deepClone(selectedLibDeck.tags || []),
        spec: deepClone(selectedLibDeck.spec),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setDeckLibrary((prev) => [entry, ...prev]);
      setSelectedLibraryDeckId(entry.id);
    };

    const deleteSelectedLibraryDeck = () => {
      if (!selectedLibDeck) return;
      if (!confirm(`Delete \"${selectedLibDeck.name}\" from library?`)) return;
      setDeckLibrary((prev) => prev.filter((d) => d.id !== selectedLibDeck.id));
      if (selectedLibraryDeckId === selectedLibDeck.id) setSelectedLibraryDeckId(null);
    };

    const exportSelectedLibraryDeck = async () => {
      if (!selectedLibDeck) {
        alert("Select a saved deck first.");
        return;
      }
      const payload = JSON.stringify(selectedLibDeck.spec, null, 2);
      try {
        await navigator.clipboard.writeText(payload);
        alert("Deck JSON copied to clipboard.");
      } catch {
        window.prompt("Copy deck JSON:", payload);
      }
    };

    const importDeckIntoLibrary = () => {
      const raw = window.prompt("Paste a single DeckSpec JSON here:");
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (!isDeckSpec(parsed)) throw new Error("Not a DeckSpec.");
        const name = window.prompt("Deck name:", defaultDeckName(parsed));
        if (!name) return;
        const entry: DeckLibraryEntry = {
          id: makeDeckLibraryId(),
          name,
          tags: [],
          spec: parsed,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        setDeckLibrary((prev) => [entry, ...prev]);
        setSelectedLibraryDeckId(entry.id);
        alert("Imported deck into library.");
      } catch (e: any) {
        alert(`Import failed: ${String(e?.message || e)}`);
      }
    };

    const exportDeckLibrary = async () => {
      const payload = JSON.stringify(deckLibrary, null, 2);
      try {
        await navigator.clipboard.writeText(payload);
        alert("Deck library JSON copied to clipboard.");
      } catch {
        window.prompt("Copy deck library JSON:", payload);
      }
    };

    const importDeckLibrary = () => {
      const raw = window.prompt("Paste Deck Library JSON (array of entries) here:");
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("Expected an array.");
        const mapped: DeckLibraryEntry[] = parsed
            .filter((x: any) => x && typeof x === "object")
            .map((x: any) => {
              if (!isDeckSpec(x.spec)) throw new Error("Entry missing spec DeckSpec.");
              return {
                id: String(x.id || makeDeckLibraryId()),
                name: String(x.name || "Imported Deck"),
                tags: Array.isArray(x.tags) ? x.tags.map((t: any) => String(t)).filter(Boolean) : [],
                spec: x.spec,
                createdAt: Number(x.createdAt || Date.now()),
                updatedAt: Number(x.updatedAt || Date.now()),
              } as DeckLibraryEntry;
            });

        const replace = confirm("Replace your existing deck library? (Cancel = merge)");
        if (replace) setDeckLibrary(mapped);
        else {
          setDeckLibrary((prev) => {
            // Merge by id (import wins). If id collides, remap.
            const existingIds = new Set(prev.map((d) => d.id));
            const incoming = mapped.map((d) => (existingIds.has(d.id) ? { ...d, id: makeDeckLibraryId() } : d));
            return [...incoming, ...prev];
          });
        }
        alert("Imported deck library.");
      } catch (e: any) {
        alert(`Import failed: ${String(e?.message || e)}`);
      }
    };

    return (
        <div style={{ maxWidth: 1240, margin: "18px auto", padding: "0 12px" }}>
          <div className="rb-panel">
            <div className="rb-panelTitle">Deck Builder</div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
              <button className="rb-miniButton" onClick={() => setPreGameView("SETUP")}>
                ← Back
              </button>

              <button className="rb-miniButton" disabled={allCards.length === 0} onClick={exportDecks}>
                Export decks
              </button>
              <button className="rb-miniButton" disabled={allCards.length === 0} onClick={importDecks}>
                Import decks
              </button>

              <button
                  className="rb-miniButton"
                  onClick={() => {
                    if (!confirm("Clear BOTH decks?")) return;
                    setBuilderDecks({ P1: emptyDeckSpec(), P2: emptyDeckSpec() });
                  }}
              >
                Clear all
              </button>

              <div style={{ flex: 1 }} />


              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", marginRight: 8 }}>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="rb-softText" style={{ fontWeight: 900 }}>Match</span>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }} className="rb-softText">
                    <input
                        type="radio"
                        name="matchfmt"
                        checked={matchFormat === "BO1"}
                        onChange={() => {
                          setMatchFormat("BO1");
                          setMatchState(null);
                          setMatchNextBattlefieldPick({ P1: null, P2: null });
                        }}
                    />
                    Best of 1 (random battlefields)
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }} className="rb-softText">
                    <input
                        type="radio"
                        name="matchfmt"
                        checked={matchFormat === "BO3"}
                        onChange={() => {
                          setMatchFormat("BO3");
                          // We'll initialize the match when starting the duel.
                          setMatchState(null);
                          setMatchNextBattlefieldPick({ P1: nextOptionsP1[0]?.id ?? null, P2: nextOptionsP2[0]?.id ?? null });
                        }}
                    />
                    Best of 3 (pick each game; no repeats)
                  </label>
                </div>

                {matchFormat === "BO3" && canStart ? (
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <span className="rb-softText">Game 1 battlefields:</span>
                      <span className="rb-softText">P1</span>
                      <select
                          value={matchNextBattlefieldPick.P1 ?? ""}
                          onChange={(e) => setMatchNextBattlefieldPick((prev) => ({ ...prev, P1: e.target.value || null }))}
                      >
                        {nextOptionsP1.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                        ))}
                      </select>
                      <span className="rb-softText">P2</span>
                      <select
                          value={matchNextBattlefieldPick.P2 ?? ""}
                          onChange={(e) => setMatchNextBattlefieldPick((prev) => ({ ...prev, P2: e.target.value || null }))}
                      >
                        {nextOptionsP2.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                        ))}
                      </select>
                    </div>
                ) : null}
              </div>

              <button className="rb-bigButton" style={{ maxWidth: 280 }} disabled={!canStart} onClick={() => startDeckBuilderDuel()}>
                Start Duel from Decks
              </button>
            </div>

            {/* Saved Deck Library */}
            <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: "1px solid rgba(255,255,255,0.10)",
                }}
            >
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <input
                      className="rb-input"
                      placeholder="Search library (name or tag)…"
                      value={librarySearch}
                      onChange={(e) => setLibrarySearch(e.target.value)}
                      style={{ width: 260 }}
                  />
                  <input
                      className="rb-input"
                      placeholder="Filter by tag…"
                      value={libraryTagFilter}
                      onChange={(e) => setLibraryTagFilter(e.target.value)}
                      style={{ width: 260 }}
                  />
                </div>

                <div style={{ flex: 1 }} />

                <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 320 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <input
                        className="rb-input"
                        placeholder="Save current as…"
                        value={saveAsName}
                        onChange={(e) => setSaveAsName(e.target.value)}
                        style={{ flex: 1, minWidth: 200 }}
                    />
                    <button className="rb-miniButton" onClick={saveActiveToLibraryAsNew} title="Save the current builder deck as a new library entry">
                      Save as new
                    </button>
                  </div>
                  <input
                      className="rb-input"
                      placeholder="Tags (comma separated)…"
                      value={saveAsTags}
                      onChange={(e) => setSaveAsTags(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                <div style={{ minWidth: 320, flex: 1 }}>
                  <div className="rb-softText" style={{ marginBottom: 6 }}>
                    Library ({filteredLibrary.length}/{deckLibrary.length}) — drag to reorder
                  </div>

                  <div
                      style={{
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 12,
                        overflow: "hidden",
                        background: "rgba(0,0,0,0.18)",
                        maxHeight: 220,
                        overflowY: "auto",
                      }}
                  >
                    {filteredLibrary.length === 0 ? (
                        <div className="rb-softText" style={{ padding: 10 }}>
                          No decks match your filters.
                        </div>
                    ) : (
                        filteredLibrary.map((d, idx) => {
                          const selected = d.id === selectedLibraryDeckId;
                          const tags = (d.tags || []).join(", ");
                          return (
                              <div
                                  key={d.id}
                                  draggable
                                  onDragStart={() => setLibraryDragId(d.id)}
                                  onDragEnd={() => setLibraryDragId(null)}
                                  onDragOver={(e) => e.preventDefault()}
                                  onDrop={() => {
                                    if (libraryDragId && libraryDragId !== d.id) moveDeckInLibrary(libraryDragId, d.id);
                                  }}
                                  onClick={() => setSelectedLibraryDeckId(d.id)}
                                  style={{
                                    padding: "10px 12px",
                                    cursor: "pointer",
                                    borderTop: idx === 0 ? "none" : "1px solid rgba(255,255,255,0.08)",
                                    background: selected ? "rgba(255,255,255,0.10)" : "transparent",
                                    userSelect: "none",
                                  }}
                                  title="Click to select • Drag to reorder"
                              >
                                <div style={{ fontWeight: 800 }}>{d.name}</div>
                                <div className="rb-softText" style={{ marginTop: 2 }}>
                                  {tags || "—"}
                                </div>
                              </div>
                          );
                        })
                    )}
                  </div>
                </div>

                <div style={{ minWidth: 320, flex: 1 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <select
                        className="rb-input"
                        value={selectedLibraryDeckId || ""}
                        onChange={(e) => setSelectedLibraryDeckId(e.target.value || null)}
                        style={{ flex: 1, minWidth: 200 }}
                    >
                      <option value="">— Select saved deck —</option>
                      {filteredLibrary.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                      ))}
                    </select>

                    <button
                        className="rb-miniButton"
                        disabled={!selectedLibDeck}
                        onClick={() => selectedLibDeck && loadLibraryDeckIntoBuilder(selectedLibDeck, builderActivePlayer)}
                        title={`Load selected deck into ${builderActivePlayer}`}
                    >
                      Load → {builderActivePlayer}
                    </button>
                  </div>

                  {selectedLibDeck ? (
                      <div style={{ marginTop: 8 }}>
                        <div className="rb-softText" style={{ marginBottom: 4 }}>
                          Tags for selected deck
                        </div>
                        <input
                            className="rb-input"
                            value={(selectedLibDeck.tags || []).join(", ")}
                            onChange={(e) => setSelectedLibraryDeckTags(e.target.value)}
                            placeholder="tags…"
                        />
                        <div className="rb-softText" style={{ marginTop: 6 }}>
                          Selected: <b>{selectedLibDeck.name}</b> • Updated {new Date(selectedLibDeck.updatedAt).toLocaleString()}
                        </div>
                      </div>
                  ) : (
                      <div className="rb-softText" style={{ marginTop: 8 }}>
                        Save multiple decks here, then load them into either P1 or P2.
                      </div>
                  )}

                  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                    <button className="rb-miniButton" disabled={!selectedLibDeck} onClick={updateSelectedLibraryDeck} title="Overwrite the selected library deck with the current builder deck">
                      Update
                    </button>
                    <button className="rb-miniButton" disabled={!selectedLibDeck} onClick={renameSelectedLibraryDeck}>
                      Rename
                    </button>
                    <button className="rb-miniButton" disabled={!selectedLibDeck} onClick={duplicateSelectedLibraryDeck}>
                      Duplicate
                    </button>
                    <button className="rb-miniButton" disabled={!selectedLibDeck} onClick={deleteSelectedLibraryDeck}>
                      Delete
                    </button>

                    <div style={{ flex: 1 }} />

                    <button className="rb-miniButton" disabled={!selectedLibDeck} onClick={exportSelectedLibraryDeck}>
                      Export Deck
                    </button>
                    <button className="rb-miniButton" onClick={importDeckIntoLibrary}>
                      Import Deck
                    </button>
                    <button className="rb-miniButton" onClick={exportDeckLibrary}>
                      Export Library
                    </button>
                    <button className="rb-miniButton" onClick={importDeckLibrary}>
                      Import Library
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button className="rb-miniButton" disabled={builderActivePlayer === "P1"} onClick={() => setBuilderActivePlayer("P1")}>
                Edit P1
              </button>
              <button className="rb-miniButton" disabled={builderActivePlayer === "P2"} onClick={() => setBuilderActivePlayer("P2")}>
                Edit P2
              </button>
              <button
                  className="rb-miniButton"
                  onClick={() => {
                    setBuilderDecks((prev) => ({ ...prev, P2: JSON.parse(JSON.stringify(prev.P1)) }));
                  }}
              >
                Copy P1 → P2
              </button>
              <button className="rb-miniButton" onClick={() => updateDeck(pid, () => emptyDeckSpec())}>
                Clear {pid}
              </button>
              <button className="rb-miniButton" disabled={allCards.length === 0} onClick={autoFillActive}>
                Auto-fill {pid}
              </button>
            </div>

            <div style={{ marginTop: 10 }} className="rb-softText">
              Editing <b>{pid}</b> • Legend: <b>{activeLegendName}</b> • Identity: <b>{activeIdentityText}</b>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "340px 1fr 340px", gap: 12, marginTop: 12, alignItems: "start" }}>
              {/* Config */}
              <div className="rb-panel">
                <div className="rb-panelTitle">Deck configuration</div>

                <div className="rb-zoneLabel">Legend</div>
                <select
                    value={spec.legendId || ""}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      updateDeck(pid, (d) => ({ ...d, legendId: id, championId: null, battlefields: [], runes: {}, main: {} }));
                    }}
                    style={{ width: "100%", padding: 8, borderRadius: 10, background: "rgba(0,0,0,0.25)", color: "white", border: "1px solid rgba(255,255,255,0.12)" }}
                >
                  <option value="">— Select Legend —</option>
                  {legends.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.domain})
                      </option>
                  ))}
                </select>

                <div style={{ height: 12 }} />

                <div className="rb-zoneLabel">Chosen Champion</div>
                <select
                    value={spec.championId || ""}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      updateDeck(pid, (d) => {
                        const main = { ...(d.main || {}) };
                        if (id && (main[id] || 0) < 1) main[id] = 1;
                        return { ...d, championId: id, main };
                      });
                    }}
                    disabled={!legend}
                    style={{ width: "100%", padding: 8, borderRadius: 10, background: "rgba(0,0,0,0.25)", color: "white", border: "1px solid rgba(255,255,255,0.12)" }}
                >
                  <option value="">— Select Champion —</option>
                  {eligibleChampions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} (cost {c.cost})
                      </option>
                  ))}
                </select>
                {!legend ? <div className="rb-softText" style={{ marginTop: 6 }}>Pick a Legend first (to filter legal Champions).</div> : null}

                <div style={{ height: 12 }} />

                <div className="rb-zoneLabel">Battlefields (pick 3)</div>
                <div style={{ maxHeight: 240, overflow: "auto", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 8 }}>
                  {eligibleBattlefields.map((bf) => {
                    const checked = (spec.battlefields || []).includes(bf.id);
                    return (
                        <div key={bf.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 4px", borderRadius: 10 }}>
                          <input type="checkbox" checked={checked} onChange={() => toggleBattlefield(bf.id)} />
                          <div style={{ fontSize: 12, fontWeight: 800, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {bf.name}
                          </div>
                          <div style={{ fontSize: 11, opacity: 0.85 }}>{bf.domain}</div>
                        </div>
                    );
                  })}
                  {eligibleBattlefields.length === 0 ? <div className="rb-softText">—</div> : null}
                </div>

                <div style={{ height: 12 }} />

                <div className="rb-zoneLabel">Rune deck (exactly 12)</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {eligibleRunes.map((r) => {
                    const cnt = Math.floor((spec.runes || {})[r.id] || 0);
                    return (
                        <div key={r.id} style={{ width: 150, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 900 }}>{r.name}</div>
                          <div style={{ fontSize: 11, opacity: 0.8 }}>{r.domain}</div>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
                            <button className="rb-miniButton" onClick={() => updateDeck(pid, (d) => ({ ...d, runes: bumpCount(d.runes || {}, r.id, -1, 0, null) }))}>
                              −
                            </button>
                            <div style={{ minWidth: 24, textAlign: "center", fontWeight: 900 }}>{cnt}</div>
                            <button className="rb-miniButton" onClick={() => updateDeck(pid, (d) => ({ ...d, runes: bumpCount(d.runes || {}, r.id, +1, 0, null) }))}>
                              +
                            </button>
                          </div>
                        </div>
                    );
                  })}
                  {eligibleRunes.length === 0 ? <div className="rb-softText">—</div> : null}
                </div>

                <div style={{ height: 10 }} />

                <div className="rb-softText">
                  Main deck: <b>{mainTotal}</b> cards • Rune deck: <b>{runeTotal}</b>/12
                </div>
              </div>

              {/* Card browser */}
              <div className="rb-panel">
                <div className="rb-panelTitle">Card browser</div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                      value={builderSearch}
                      onChange={(e) => setBuilderSearch(e.target.value)}
                      placeholder="Search cards (name or id)…"
                      style={{
                        flex: 1,
                        minWidth: 220,
                        padding: "9px 10px",
                        borderRadius: 12,
                        background: "rgba(0,0,0,0.25)",
                        color: "white",
                        border: "1px solid rgba(255,255,255,0.12)",
                      }}
                  />

                  <select
                      value={builderTypeFilter}
                      onChange={(e) => setBuilderTypeFilter(e.target.value as any)}
                      style={{
                        padding: "9px 10px",
                        borderRadius: 12,
                        background: "rgba(0,0,0,0.25)",
                        color: "white",
                        border: "1px solid rgba(255,255,255,0.12)",
                      }}
                  >
                    <option value="All">All</option>
                    <option value="Unit">Units</option>
                    <option value="Spell">Spells</option>
                    <option value="Gear">Gear</option>
                  </select>
                </div>

                <div className="rb-softText" style={{ marginTop: 8 }}>
                  Showing <b>{browser.length}</b> cards (filtered to identity where possible).
                </div>

                <div className="rb-row" style={{ marginTop: 10, flexWrap: "wrap" }}>
                  {browser.map((c) => {
                    const cur = Math.floor((spec.main || {})[c.id] || 0);
                    const preview = toPreview(c, "browse");
                    return (
                        <div key={c.id} style={{ width: 118, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                          <ArenaCard
                              card={preview}
                              size="xs"
                              showReadyDot={false}
                              onClick={() => updateDeck(pid, (d) => ({ ...d, main: bumpCount(d.main || {}, c.id, +1, 0, 3) }))}
                              onDoubleClick={() => setHoverCard(preview)}
                          />
                          <div style={{ fontSize: 11, fontWeight: 800, textAlign: "center", maxWidth: 116, lineHeight: 1.1 }}>
                            {c.name}
                          </div>
                          <div style={{ fontSize: 11, opacity: 0.8 }}>x{cur}</div>
                        </div>
                    );
                  })}
                  {browser.length === 0 ? <div className="rb-softText">No results.</div> : null}
                </div>
              </div>

              {/* Deck list */}
              <div className="rb-panel">
                <div className="rb-panelTitle">Main deck list</div>

                <div className="rb-softText">
                  Click + / − to adjust (max 3 copies per card). Your chosen Champion must be included at least once.
                </div>

                <div style={{ marginTop: 10, maxHeight: 560, overflow: "auto", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 8 }}>
                  {deckRows.length === 0 ? <div className="rb-softText">—</div> : null}
                  {deckRows.map((row) => {
                    const cd = row.card!;
                    const cnt = Math.floor(row.n || 0);
                    const preview = toPreview(cd, "deck");
                    return (
                        <div key={row.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 4px", borderRadius: 10 }}>
                          <div style={{ width: 36 }}>
                            <ArenaCard card={preview} size="xs" showReadyDot={false} onClick={() => setHoverCard(preview)} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cd.name}</div>
                            <div style={{ fontSize: 11, opacity: 0.8 }}>
                              {cd.type} • cost {cd.cost} • {cd.domain}
                            </div>
                          </div>
                          <button className="rb-miniButton" onClick={() => updateDeck(pid, (d) => ({ ...d, main: bumpCount(d.main || {}, cd.id, -1, 0, 3) }))}>
                            −
                          </button>
                          <div style={{ width: 26, textAlign: "center", fontWeight: 900 }}>{cnt}</div>
                          <button className="rb-miniButton" onClick={() => updateDeck(pid, (d) => ({ ...d, main: bumpCount(d.main || {}, cd.id, +1, 0, 3) }))}>
                            +
                          </button>
                        </div>
                    );
                  })}
                </div>

                {hoverCard ? (
                    <div style={{ marginTop: 12 }}>
                      <div className="rb-panelTitle">Preview</div>
                      {"instanceId" in (hoverCard as any) ? (
                          <div className="rb-row rb-rowCenter">
                            <ArenaCard card={hoverCard as any} size="sm" showReadyDot={false} />
                          </div>
                      ) : null}
                      <div className="rb-softText" style={{ marginTop: 8 }}>
                        {(hoverCard as any).name}
                      </div>
                    </div>
                ) : null}
              </div>
            </div>

            {activeErrors.length > 0 ? (
                <div style={{ marginTop: 14 }}>
                  <div className="rb-panelTitle">Issues for {pid}</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {activeErrors.map((e, i) => (
                        <li key={i} style={{ color: "#ffb4b4" }}>
                          {e}
                        </li>
                    ))}
                  </ul>
                </div>
            ) : null}

            {(errorsP1.length > 0 || errorsP2.length > 0) && canStart === false ? (
                <div className="rb-softText" style={{ marginTop: 10 }}>
                  Fix both decks before starting. (You can use “Auto-fill” as a starting point.)
                </div>
            ) : null}
          </div>
        </div>
    );
  };


  const renderPileViewerModal = () => {
    if (!g || !pileViewer) return null;

    const pid = pileViewer.player;
    const zone = pileViewer.zone;
    const ps = g.players[pid];
    const cards = zone === "TRASH" ? ps.trash : ps.banishment;
    const title = zone === "TRASH" ? "Trash (discard pile)" : "Banishment";

    return (
        <div className="rb-modalOverlay" onClick={() => setPileViewer(null)}>
          <div className="rb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="rb-modalHeader">
              <div style={{ fontWeight: 900 }}>
                {pid} — {title} ({cards.length})
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button className="rb-miniButton" onClick={() => setPileViewer({ player: "P1", zone })}>
                  View P1
                </button>
                <button className="rb-miniButton" onClick={() => setPileViewer({ player: "P2", zone })}>
                  View P2
                </button>
                <button className="rb-miniButton" onClick={() => setPileViewer(null)}>
                  Close
                </button>
              </div>
            </div>
            <div className="rb-modalBody">
              {cards.length === 0 ? <div className="rb-softText">—</div> : null}
              <div className="rb-pileGrid">
                {[...cards]
                    .slice()
                    .reverse()
                    .map((c) => (
                        <div key={c.instanceId} style={{ width: 120, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                          <ArenaCard card={c} size="xs" showReadyDot={false} onClick={() => setHoverCard(c)} />
                          <div style={{ fontSize: 11, fontWeight: 800, textAlign: "center", maxWidth: 118, lineHeight: 1.1, opacity: 0.95 }}>
                            {c.name}
                          </div>
                        </div>
                    ))}
              </div>
            </div>
          </div>
        </div>
    );
  };


  const normalizeEffectForDiag = (s: string) =>
      (s || "")
          .replace(/_/g, " ")
          .replace(/\[\s*add\s*\]\s*/gi, "add ")
          .replace(/\s+/g, " ")
          .trim();

  const effectSupportTags = (effectText: string): string[] => {
    const t = normalizeEffectForDiag(effectText);
    if (!t) return [];
    const lower = t.toLowerCase();
    const tags: string[] = [];

    if (extractDiscardAmount(t)) tags.push("DISCARD");
    if (extractDrawAmount(t)) tags.push("DRAW");
    if (extractChannelAmount(t)) tags.push("CHANNEL");
    if (/\badd\s+\d+\s+energy\b/i.test(t)) tags.push("ADD_ENERGY");
    if (/\badd\s+\d+\s+[a-z]+\s+rune\b/i.test(t)) tags.push("ADD_RUNE");
    if (/\badd\s+\d+\s+rune\s+of\s+any\s+type\b/i.test(t)) tags.push("ADD_ANY_RUNE");
    if (/\bplay\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:an?\s+)?\d+\s+might\s+[a-z]+\s+unit\s+token/i.test(t))
      tags.push("TOKENS");
    if (/\bgive\b/i.test(t) && /\[[^\]]+\]/.test(t)) tags.push("KEYWORD_GRANT");
    if (effectMentionsStun(t)) tags.push("STUN");
    if (effectMentionsReady(t)) tags.push("READY");
    if (effectMentionsBuff(t)) tags.push("BUFF");
    if (effectMentionsKill(t)) tags.push("KILL");
    if (effectMentionsBanish(t)) tags.push("BANISH");
    if (effectMentionsReturn(t)) tags.push("RETURN");
    if (/\bgive\s+(?:a\s+)?(?:friendly\s+|enemy\s+|your\s+|opposing\s+)?(unit|units|me|it|this)\s+[+-]\s*\d+\s+might\s+this\s+turn\b/i.test(t))
      tags.push("MIGHT_THIS_TURN");
    if (extractDamageAmount(t) != null || /\bdeal\s+its\s+energy\s+cost\s+as\s+damage\b/i.test(t)) tags.push("DAMAGE");

    return tags;
  };

  type AuditStatus = "FULL" | "PARTIAL" | "UNSUPPORTED" | "NO_TEXT";

  interface EffectAuditRow {
    id: string;
    name: string;
    type: CardType;
    domain: string;
    cost: number;
    trigger: string;
    keywords: string[];
    text: string;
    raw: string;
    primitives: string[];
    primitivesSupported: string[];
    primitivesMissing: string[];
    flags: string[];
    targetProfile: {
      needsTargets: boolean;
      count: number;
      restriction: "ANY" | "FRIENDLY" | "ENEMY";
      location: "ANY" | "HERE" | "BATTLEFIELD";
      notes: string[];
    };
    status: AuditStatus;
  }

  const keywordBase = (kw: string): string => {
    const s = String(kw || "").trim();
    if (!s) return "";
    const parts = s.split(/\s+/);
    return parts[0] || s;
  };

  const wordToNum = (w: string): number | null => {
    const m: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
    };
    if (!w) return null;
    if (/^\d+$/.test(w)) {
      const n = parseInt(w, 10);
      return Number.isFinite(n) ? n : null;
    }
    return m[w.toLowerCase()] ?? null;
  };

  const uniq = (xs: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const x of xs) {
      const k = String(x || "").trim();
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  };

  const auditInferTargetProfile = (textRaw: string): EffectAuditRow["targetProfile"] => {
    const t = (textRaw || "").toLowerCase();
    const notes: string[] = [];
    if (!t.trim()) return { needsTargets: false, count: 0, restriction: "ANY", location: "ANY", notes };

    // If the text clearly indicates a global effect, assume no explicit targets.
    if (/\b(all|each)\s+(friendly|enemy|opposing|your)?\s*units\b/.test(t)) {
      const restriction: "ANY" | "FRIENDLY" | "ENEMY" = /\benemy\b|\bopposing\b/.test(t) ? "ENEMY" : /\bfriendly\b|\byour\b/.test(t) ? "FRIENDLY" : "ANY";
      const location: "ANY" | "HERE" | "BATTLEFIELD" = /\bhere\b/.test(t) ? "HERE" : /\bbattlefield\b/.test(t) ? "BATTLEFIELD" : "ANY";
      notes.push("global-units");
      return { needsTargets: false, count: 0, restriction, location, notes };
    }

    // Detect explicit selection counts.
    const chooseN = t.match(/\bchoose\s+(?:up\s+to\s+)?(\d+|one|two|three|four|five)\s+units\b/);
    const count = chooseN ? wordToNum(chooseN[1]) ?? 1 : 1;

    const hasUnit = /\bunit\b/.test(t) || /\bunits\b/.test(t);
    const hasBattlefield = /\bbattlefield\b/.test(t);
    const hasChoose = /\bchoose\b/.test(t);

    // Many “at a battlefield” effects still need a unit target.
    const needsUnitTarget =
        hasUnit && /\b(stun|kill|banish|ready|buff|deal|give|move|return|recall|heal)\b/.test(t) && !/\b(all|each)\b/.test(t);

    // Battlefield selection is rare; keep conservative.
    const needsBattlefieldTarget = hasBattlefield && hasChoose && /\b(battlefield)\b/.test(t);

    const restriction: "ANY" | "FRIENDLY" | "ENEMY" =
        /\benemy\b|\bopposing\b/.test(t) ? "ENEMY" : /\bfriendly\b|\byour\b/.test(t) ? "FRIENDLY" : "ANY";
    const location: "ANY" | "HERE" | "BATTLEFIELD" = /\bhere\b/.test(t) ? "HERE" : /\bat\s+a\s+battlefield\b/.test(t) ? "BATTLEFIELD" : "ANY";

    if (count > 1) notes.push(`multi-${count}`);
    if (restriction !== "ANY") notes.push(restriction === "ENEMY" ? "enemy-only" : "friendly-only");
    if (location !== "ANY") notes.push(location === "HERE" ? "here" : "at-battlefield");
    if (/\b(choose|target)\b/.test(t)) notes.push("explicit-select");

    if (needsBattlefieldTarget) {
      return { needsTargets: true, count: 1, restriction: "ANY", location: "BATTLEFIELD", notes: [...notes, "battlefield-target"] };
    }
    if (needsUnitTarget) {
      return { needsTargets: true, count, restriction, location, notes };
    }
    return { needsTargets: false, count: 0, restriction, location, notes };
  };

  const auditAnalyzeEffectText = (textRaw: string, triggerRaw: string, keywords: string[]) => {
    const text = normalizeEffectForDiag(textRaw);
    const lower = text.toLowerCase();
    const trigger = String(triggerRaw || "").trim();

    const primitives: string[] = [];
    const flags: string[] = [];

    // --- Trigger coverage ---
    if (trigger) {
      const supportedTrigger =
          /^When you play (me|this)$/i.test(trigger) ||
          /^When this is played$/i.test(trigger) ||
          /^When I'm played$/i.test(trigger) ||
          /^When I attack$/i.test(trigger) ||
          /^When I defend$/i.test(trigger) ||
          /^When I attack or defend$/i.test(trigger) ||
          /^When I defend or I'm played from$/i.test(trigger) ||
          /^When I move$/i.test(trigger) ||
          /^When I move to a battlefield$/i.test(trigger) ||
          /^When you play a spell$/i.test(trigger) ||
          /^When you play a spell that costs 5 energy or more$/i.test(trigger) ||
          /^When you play a gear$/i.test(trigger) ||
          /^When you play a unit$/i.test(trigger) ||
          /^When you play another unit$/i.test(trigger) ||
          /^When you play a \[Mighty\] unit$/i.test(trigger) ||
          /^When you play your second card in a turn$/i.test(trigger) ||
          /^When you play a card on an opponent's turn$/i.test(trigger) ||
          /^When you play me to a battlefield$/i.test(trigger) ||
          /^When you discard me$/i.test(trigger) ||
          /^When you discard a card$/i.test(trigger) ||
          /^When you discard one or more cards$/i.test(trigger) ||
          /^When you stun an enemy unit$/i.test(trigger) ||
          /^When you stun one or more enemy units$/i.test(trigger) ||
          /^When a friendly unit attacks or defends alone$/i.test(trigger) ||
          /^When you ready a friendly unit$/i.test(trigger) ||
          /^When you buff a friendly unit$/i.test(trigger) ||
          /^When a buffed friendly unit dies$/i.test(trigger) ||
          /^When another non-Recruit unit you control dies$/i.test(trigger) ||
          /^When a unit moves from here$/i.test(trigger) ||
          /^When a friendly unit moves from my location$/i.test(trigger) ||
          /^When you defend here$/i.test(trigger) ||
          /^When you conquer$/i.test(trigger) ||
          /^When you conquer here$/i.test(trigger) ||
          /^When you hold here$/i.test(trigger) ||
          /^When you kill a unit with a spell$/i.test(trigger) ||
          /^When you kill a stunned enemy unit$/i.test(trigger) ||
          /^If you've discarded a card this turn$/i.test(trigger) ||
          /^If I have moved twice this turn$/i.test(trigger) ||
          /^While I'm buffed$/i.test(trigger) ||
          /^While I'm attacking or defending alone$/i.test(trigger) ||
          /^While I'm \[Mighty\]$/i.test(trigger) ||
          /^While I'm at a battlefield$/i.test(trigger) ||
          /^While you have 8\+ runes$/i.test(trigger) ||
          /^If an opponent's score is within 3 points of the Victory Score$/i.test(trigger) ||
          /^If an enemy unit has died this turn$/i.test(trigger) ||
          /^When you play a card from/i.test(trigger) ||
          /^When you kill$/i.test(trigger) ||
          /^When I conquer$/i.test(trigger) ||
          /^When I hold$/i.test(trigger) ||
          /^At the end of your turn$/i.test(trigger) ||
          /^At the start of your Beginning Phase$/i.test(trigger) ||
          /^At start of your Beginning Phase$/i.test(trigger);
      if (!supportedTrigger) flags.push(`TRIGGER_UNSUPPORTED: ${trigger}`);
    }

    // --- Conditional / branching ---
    const ifKillDraw = /\bif\s+this\s+kills\s+it,\s*draw\s+\d+\b/i.test(text);
    const supportedIf =
        /if you do/i.test(lower) ||
        /if you control a poro/i.test(lower) ||
        /if you control a facedown card at a battlefield/i.test(lower) ||
        /if you have one or fewer cards in your hand/i.test(lower) ||
        /if you have 4\+ units at that battlefield/i.test(lower) ||
        /if you have 7\+ units here/i.test(lower) ||
        /if there is a ready enemy unit here/i.test(lower) ||
        /only unit you control there/i.test(lower) ||
        /if you can't/i.test(lower) ||
        /if you couldn't channel/i.test(lower) ||
        /if you've discarded a card this turn/i.test(lower) ||
        /if i have moved twice this turn/i.test(lower) ||
        /if an opponent's score is within 3 points of the victory score/i.test(lower) ||
        /if an enemy unit has died this turn/i.test(lower);
    if (/\bif\b/.test(lower) && !ifKillDraw && !supportedIf) flags.push("CONDITIONAL_GENERAL");
    if (/\bif\s+you\s+do\b/.test(lower)) flags.push("IF_YOU_DO_BRANCH");
    const supportedReplacement =
        /next time it dies this turn/i.test(lower) ||
        /kill it the next time it takes damage this turn/i.test(lower) ||
        /kill this instead/i.test(lower);
    if (/\binstead\b/.test(lower) && !supportedReplacement) flags.push("REPLACEMENT_EFFECT");
    const supportedScaling =
        /draw 1 for each of your mighty units/i.test(lower) ||
        /for each buff spent, channel/i.test(lower) ||
        /for each friendly unit, you may spend its buff/i.test(lower);
    if ((/\bfor\s+each\b|\bfor\s+every\b/.test(lower)) && !supportedScaling) flags.push("SCALING_EFFECT");

    // --- Turn-scoped hooks (often missing in simple resolvers) ---
    if (/\bthis\s+turn\b/.test(lower) && /\b(when|whenever|each\s+time|the\s+next\s+time)\b/.test(lower)) {
      if (/\btakes\s+damage\b/.test(lower) || /\bis\s+dealt\s+damage\b/.test(lower)) flags.push("TURN_SCOPED_DAMAGE_HOOK");
      else flags.push("TURN_SCOPED_TRIGGER");
    }

    // --- Continuous effects ---
    if (/\b(other|all)\s+friendly\s+units\s+enter\s+ready\b/i.test(text)) flags.push("CONTINUOUS_ENTER_READY");
    if (/\b(other|all)\s+friendly\s+units\b/i.test(text) && /\benter\s+ready\b/i.test(text)) flags.push("CONTINUOUS_ENTER_READY");

    // --- Additional costs / cost mods ---
    if (/\bas\s+(?:an\s+)?additional\s+cost\b/.test(lower) || /\bas\s+you\s+play\s+(?:me|this)\b/.test(lower)) flags.push("ADDITIONAL_COST");
    if (/\bcost\s+\d+\s+(?:energy\s+)?less\b/.test(lower) || /\breduce\s+my\s+cost\s+by\s+\d+\s+energy\b/.test(lower)) flags.push("COST_MODIFIER");

    // --- Detect primitive operations present in the text ---
    if (extractDiscardAmount(text) != null) primitives.push("DISCARD_HAND_N");
    if (extractDrawAmount(text) != null) primitives.push("DRAW_N");
    if (extractChannelAmount(text) != null) primitives.push("CHANNEL_N");
    if (/\badd\s+\d+\s+energy\b/.test(lower)) primitives.push("ADD_ENERGY_N");
    if (/\badd\s+\d+\s+[a-z]+\s+rune\b/.test(lower)) primitives.push("ADD_POWER_DOMAIN_N");
    if (/\badd\s+\d+\s+rune\s+of\s+any\s+type\b/.test(lower)) primitives.push("ADD_POWER_ANY_N");
    if (/\bplay\b/.test(lower) && /\bunit\s+token\b/.test(lower)) primitives.push("PLAY_TOKENS");

    // Keyword grant: only supported as a single-target or self, so audit “units” separately.
    if (/\bgive\b/.test(lower) && /\[[^\]]+\]/.test(text)) {
      if (/\bunits\b/.test(lower)) primitives.push("GRANT_KEYWORD_MULTI");
      else primitives.push("GRANT_KEYWORD_SINGLE");
    }

    if (effectMentionsStun(text)) primitives.push("STUN_UNIT_SINGLE");
    if (effectMentionsReady(text)) primitives.push("READY_UNIT_SINGLE");
    if (effectMentionsBuff(text)) primitives.push("BUFF_PLUS1_PERM");
    if (effectMentionsReturn(text)) primitives.push("RETURN_TO_BASE_SINGLE");
    if (effectMentionsKill(text)) primitives.push("KILL_UNIT_SINGLE");
    if (effectMentionsBanish(text)) primitives.push("BANISH_UNIT_SINGLE");

    const mightMatch = lower.match(
        /\bgive\s+(?:a\s+)?(?:friendly\s+|enemy\s+|your\s+|opposing\s+)?(unit|units|me|it|this)\s+([+-])\s*(\d+)\s+might\s+this\s+turn\b/
    );
    if (mightMatch) {
      const who = mightMatch[1];
      if (who === "units") {
        if (/\benemy\b|\bopposing\b/.test(lower)) primitives.push("MIGHT_THIS_TURN_UNITS_ENEMY");
        else if (/\bfriendly\b|\byour\b/.test(lower)) primitives.push("MIGHT_THIS_TURN_UNITS_FRIENDLY");
        else primitives.push("MIGHT_THIS_TURN_UNITS_UNSPEC");
      } else {
        primitives.push("MIGHT_THIS_TURN_SINGLE");
      }
    }

    const dmgFromDiscard = /\bdeal\s+its\s+energy\s+cost\s+as\s+damage\b/i.test(text);
    const dmg = extractDamageAmount(text);
    if (dmgFromDiscard || (dmg != null && dmg > 0)) {
      if (/\ball\s+units\s+at\s+battlefields\b/i.test(text)) primitives.push("DAMAGE_AOE_ALL_BATTLEFIELDS");
      else if (/\ball\s+units\s+here\b/i.test(text)) primitives.push("DAMAGE_AOE_HERE");
      else if (/\ball\s+enemy\s+units\b/i.test(text) || /\beach\s+enemy\s+unit\b/i.test(text)) primitives.push("DAMAGE_AOE_ENEMY");
      else if (dmgFromDiscard) primitives.push("DAMAGE_FROM_DISCARD_ENERGY_COST");
      else primitives.push("DAMAGE_SINGLE");

      if (/\bif\s+this\s+kills\s+it,\s*draw\s+\d+\b/i.test(text)) primitives.push("DRAW_ON_KILL");
    }

    // Search is not currently parsed; keep as explicit missing flags.
    if (/\bsearch\b/.test(lower)) flags.push("SEARCH_NOT_SUPPORTED");

    // --- Keyword coverage ---
    const supportedKeywordBases = new Set<string>([
      "Action",
      "Reaction",
      "Accelerate",
      "Hidden",
      "Legion",
      "Vision",
      "Assault",
      "Shield",
      "Tank",
      "Deflect",
      "Ganking",
      "Add",
      "Deathknell",
      "Temporary",
      "Mighty",
      "Burn",
      "Burnout",
      "Burn",
    ]);
    const missingKeywords = uniq(
        (keywords || [])
            .map((k) => keywordBase(k))
            .filter(Boolean)
            .filter((k) => !supportedKeywordBases.has(k))
    );
    for (const mk of missingKeywords) flags.push(`KEYWORD_UNSUPPORTED: ${mk}`);

    // Multi-target selection (not implemented yet)
    if (/\bchoose\s+(?:up\s+to\s+)?(\d+|one|two|three|four|five)\s+units\b/.test(lower)) flags.push("MULTI_TARGET_UNITS");

    // Enemy-only mass effects are now supported for "give ... might this turn".

    // Normalize + dedupe
    return {
      text,
      primitives: uniq(primitives),
      flags: uniq(flags),
    };
  };

  const effectAudit = useMemo(() => {
    const rows: EffectAuditRow[] = [];

    const supportedPrimitives = new Set<string>([
      "DISCARD_HAND_N",
      "DRAW_N",
      "CHANNEL_N",
      "ADD_ENERGY_N",
      "ADD_POWER_DOMAIN_N",
      "ADD_POWER_ANY_N",
      "PLAY_TOKENS",
      "GRANT_KEYWORD_SINGLE",
      "STUN_UNIT_SINGLE",
      "READY_UNIT_SINGLE",
      "BUFF_PLUS1_PERM",
      "RETURN_TO_BASE_SINGLE",
      "KILL_UNIT_SINGLE",
      "BANISH_UNIT_SINGLE",
      "MIGHT_THIS_TURN_SINGLE",
      "MIGHT_THIS_TURN_UNITS_FRIENDLY",
      "MIGHT_THIS_TURN_UNITS_ENEMY",
      "DAMAGE_SINGLE",
      "DAMAGE_AOE_ENEMY",
      "DAMAGE_AOE_ALL_BATTLEFIELDS",
      "DAMAGE_AOE_HERE",
      "DAMAGE_FROM_DISCARD_ENERGY_COST",
      "DRAW_ON_KILL",
    ]);

    // Flags that we treat as “missing engine capability” (vs. informational).
    const missingFlagPrefixes = [
      "TRIGGER_UNSUPPORTED",
      "CONDITIONAL_GENERAL",
      "IF_YOU_DO_BRANCH",
      "REPLACEMENT_EFFECT",
      "SCALING_EFFECT",
      "TURN_SCOPED_TRIGGER",
      "TURN_SCOPED_DAMAGE_HOOK",
      "CONTINUOUS_ENTER_READY",
      "SEARCH_NOT_SUPPORTED",
      "KEYWORD_UNSUPPORTED",
      "MULTI_TARGET_UNITS",
    ];

    const isMissingFlag = (f: string): boolean => {
      const s = String(f || "");
      return missingFlagPrefixes.some((p) => s.startsWith(p));
    };

    for (const c of allCards) {
      const eff = (c.ability?.effect_text || "").trim();
      const raw = (c.ability?.raw_text || "").trim();
      const trigger = (c.ability?.trigger || "").trim();
      const keywords = (c.ability?.keywords || []).slice();
      const text = normalizeEffectForDiag(eff || raw);
      const analyzed = auditAnalyzeEffectText(text, trigger, keywords);
      const primitives = analyzed.primitives;
      const flags = analyzed.flags;

      const primitivesSupported = primitives.filter((p) => supportedPrimitives.has(p));
      const primitivesMissing = primitives.filter((p) => !supportedPrimitives.has(p));

      const targetProfile = auditInferTargetProfile(text);

      const missingFlags = flags.filter(isMissingFlag);
      const supportedCount = primitivesSupported.length;
      const missingCount = primitivesMissing.length + missingFlags.length;

      let status: AuditStatus = "NO_TEXT";
      if (text) {
        if (missingCount === 0) status = "FULL";
        else if (supportedCount > 0) status = "PARTIAL";
        else status = "UNSUPPORTED";
      } else {
        // No text: we still might have missing keywords or triggers.
        if (missingCount === 0) status = "NO_TEXT";
        else status = supportedCount > 0 ? "PARTIAL" : "UNSUPPORTED";
      }

      rows.push({
        id: c.id,
        name: c.name,
        type: c.type,
        domain: c.domain,
        cost: Number(c.cost || 0),
        trigger,
        keywords,
        text,
        raw,
        primitives,
        primitivesSupported,
        primitivesMissing,
        flags,
        targetProfile,
        status,
      });
    }

    const total = rows.length;
    const withText = rows.filter((r) => !!r.text).length;
    const full = rows.filter((r) => r.status === "FULL").length;
    const partial = rows.filter((r) => r.status === "PARTIAL").length;
    const unsupported = rows.filter((r) => r.status === "UNSUPPORTED").length;
    const noText = rows.filter((r) => r.status === "NO_TEXT").length;

    const missingPrimitiveCounts: Record<string, number> = {};
    const missingFlagCounts: Record<string, number> = {};

    for (const r of rows) {
      for (const p of r.primitivesMissing) missingPrimitiveCounts[p] = (missingPrimitiveCounts[p] || 0) + 1;
      for (const f of r.flags.filter((x) => x && isMissingFlag(x))) {
        const key = String(f);
        missingFlagCounts[key] = (missingFlagCounts[key] || 0) + 1;
      }
    }

    const topMissingPrimitives = Object.entries(missingPrimitiveCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([k, v]) => ({ k, v }));

    const topMissingFlags = Object.entries(missingFlagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([k, v]) => ({ k, v }));

    return {
      total,
      withText,
      full,
      partial,
      unsupported,
      noText,
      rows,
      topMissingPrimitives,
      topMissingFlags,
    };
  }, [allCards]);

  const effectCoverage = useMemo(() => {
    const rows: Array<{
      id: string;
      name: string;
      text: string;
      keywords: string[];
      supported: boolean;
      tags: string[];
    }> = [];

    for (const c of allCards) {
      const et = (c.ability?.effect_text || "").trim();
      const rt = (c.ability?.raw_text || "").trim();
      const kw = (c.ability?.keywords || []).slice();

      const base = normalizeEffectForDiag(et || rt);
      if (!base) continue;

      const tags = effectSupportTags(base);
      const supported = tags.length > 0;

      rows.push({ id: c.id, name: c.name, text: base, keywords: kw, supported, tags });
    }

    const supportedCount = rows.filter((r) => r.supported).length;
    const unsupported = rows.filter((r) => !r.supported);

    return {
      totalWithText: rows.length,
      supportedCount,
      unsupportedCount: unsupported.length,
      unsupportedRows: unsupported,
    };
  }, [allCards]);

  const renderDiagnosticsModal = () => {
    if (!showDiagnostics) return null;

    const q = (diagSearch || "").toLowerCase().trim();

    const tabButtonStyle = (active: boolean): React.CSSProperties => ({
      padding: "6px 10px",
      borderRadius: 999,
      border: "1px solid rgba(255,255,255,0.18)",
      background: active ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.22)",
      color: "#eef1f5",
      fontWeight: active ? 900 : 700,
      cursor: "pointer",
    });

    const statusPill = (s: AuditStatus): React.CSSProperties => {
      const base: React.CSSProperties = {
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 900,
        border: "1px solid rgba(255,255,255,0.14)",
      };
      if (s === "FULL") return { ...base, background: "rgba(64, 220, 140, 0.18)", color: "#bff7da" };
      if (s === "PARTIAL") return { ...base, background: "rgba(250, 200, 70, 0.18)", color: "#ffe7b8" };
      if (s === "UNSUPPORTED") return { ...base, background: "rgba(250, 90, 90, 0.18)", color: "#ffd1d1" };
      return { ...base, background: "rgba(160, 160, 160, 0.16)", color: "#d7dde7" };
    };

    const rowsUnsupported = effectCoverage.unsupportedRows
        .filter((r) => (!q ? true : r.name.toLowerCase().includes(q) || r.text.toLowerCase().includes(q)))
        .slice(0, 250);

    const auditRowsFiltered = (() => {
      let rows = effectAudit.rows;
      if (auditStatusFilter !== "ALL") {
        if (auditStatusFilter === "PROBLEMS") rows = rows.filter((r) => r.status === "PARTIAL" || r.status === "UNSUPPORTED");
        else rows = rows.filter((r) => r.status === auditStatusFilter);
      }
      if (q) {
        rows = rows.filter((r) => {
          const name = (r.name || "").toLowerCase();
          const txt = (r.text || "").toLowerCase();
          const trig = (r.trigger || "").toLowerCase();
          const prim = r.primitives.join(" ").toLowerCase();
          const flags = r.flags.join(" ").toLowerCase();
          return name.includes(q) || txt.includes(q) || trig.includes(q) || prim.includes(q) || flags.includes(q);
        });
      }
      // Keep the modal snappy.
      return rows.slice(0, 350);
    })();

    const copyAuditJson = async () => {
      const payload = JSON.stringify(effectAudit, null, 2);
      try {
        await navigator.clipboard.writeText(payload);
        alert("Audit JSON copied to clipboard.");
      } catch {
        window.prompt("Copy audit JSON:", payload);
      }
    };

    const copyFilteredAuditJson = async () => {
      const payload = JSON.stringify(
          {
            meta: {
              filter: auditStatusFilter,
              search: diagSearch,
              generatedAt: new Date().toISOString(),
            },
            rows: auditRowsFiltered,
          },
          null,
          2
      );
      try {
        await navigator.clipboard.writeText(payload);
        alert("Filtered audit JSON copied to clipboard.");
      } catch {
        window.prompt("Copy filtered audit JSON:", payload);
      }
    };

    return (
        <div className="rb-modalOverlay" onClick={() => setShowDiagnostics(false)}>
          <div className="rb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="rb-modalHeader">
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ fontWeight: 900 }}>Effect Diagnostics</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button style={tabButtonStyle(diagTab === "UNSUPPORTED")} onClick={() => setDiagTab("UNSUPPORTED")}>
                    Unsupported List
                  </button>
                  <button style={tabButtonStyle(diagTab === "AUDIT")} onClick={() => setDiagTab("AUDIT")}>
                    Full Audit
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {diagTab === "AUDIT" ? (
                    <>
                      <button className="rb-miniButton" onClick={copyFilteredAuditJson}>
                        Copy filtered JSON
                      </button>
                      <button className="rb-miniButton" onClick={copyAuditJson}>
                        Copy full JSON
                      </button>
                    </>
                ) : null}
                <button className="rb-miniButton" onClick={() => setShowDiagnostics(false)}>
                  Close
                </button>
              </div>
            </div>
            <div className="rb-modalBody">
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                {diagTab === "UNSUPPORTED" ? (
                    <div className="rb-softTextSmall">
                      Cards with ability text: <b>{effectCoverage.totalWithText}</b> • Supported: <b>{effectCoverage.supportedCount}</b> • Unsupported: <b>{effectCoverage.unsupportedCount}</b>
                    </div>
                ) : (
                    <div className="rb-softTextSmall">
                      Total cards: <b>{effectAudit.total}</b> • With text: <b>{effectAudit.withText}</b> • Full: <b>{effectAudit.full}</b> • Partial: <b>{effectAudit.partial}</b> • Unsupported: <b>{effectAudit.unsupported}</b> • No-text: <b>{effectAudit.noText}</b>
                    </div>
                )}

                <input
                    value={diagSearch}
                    onChange={(e) => setDiagSearch(e.target.value)}
                    placeholder={diagTab === "AUDIT" ? "Search card / primitive / flag..." : "Search card/effect..."}
                    style={{
                      flex: "1 1 280px",
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.16)",
                      background: "rgba(0,0,0,0.25)",
                      color: "#eef1f5",
                    }}
                />

                {diagTab === "AUDIT" ? (
                    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="rb-softTextSmall">Status:</span>
                  <select
                      value={auditStatusFilter}
                      onChange={(e) => setAuditStatusFilter(e.target.value as any)}
                      style={{
                        padding: "6px 8px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.18)",
                        background: "rgba(0,0,0,0.25)",
                        color: "#eef1f5",
                      }}
                  >
                    <option value="PROBLEMS">Problems (Partial + Unsupported)</option>
                    <option value="ALL">All</option>
                    <option value="FULL">Full</option>
                    <option value="PARTIAL">Partial</option>
                    <option value="UNSUPPORTED">Unsupported</option>
                    <option value="NO_TEXT">No text</option>
                  </select>
                </span>
                ) : null}
              </div>

              {diagTab === "UNSUPPORTED" ? (
                  rowsUnsupported.length === 0 ? (
                      <div className="rb-softText">No unsupported effects match the filter.</div>
                  ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {rowsUnsupported.map((r) => (
                            <div
                                key={r.id}
                                style={{
                                  border: "1px solid rgba(255,255,255,0.10)",
                                  borderRadius: 12,
                                  padding: 10,
                                  background: "rgba(0,0,0,0.18)",
                                }}
                            >
                              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                                <div style={{ fontWeight: 900 }}>{r.name}</div>
                                <div className="rb-softTextSmall">{r.keywords && r.keywords.length ? r.keywords.join(" • ") : ""}</div>
                              </div>
                              <div className="rb-softTextSmall" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
                                {r.text}
                              </div>
                            </div>
                        ))}
                      </div>
                  )
              ) : (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                      <div style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 10, background: "rgba(0,0,0,0.16)" }}>
                        <div style={{ fontWeight: 900, marginBottom: 6 }}>Top missing primitives</div>
                        {effectAudit.topMissingPrimitives.length === 0 ? (
                            <div className="rb-softTextSmall">(none)</div>
                        ) : (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                              {effectAudit.topMissingPrimitives.map((x) => (
                                  <span key={x.k} style={{ padding: "3px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.14)", fontSize: 11, background: "rgba(0,0,0,0.22)" }}>
                            {x.k} • {x.v}
                          </span>
                              ))}
                            </div>
                        )}
                      </div>

                      <div style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 10, background: "rgba(0,0,0,0.16)" }}>
                        <div style={{ fontWeight: 900, marginBottom: 6 }}>Top missing structural flags</div>
                        {effectAudit.topMissingFlags.length === 0 ? (
                            <div className="rb-softTextSmall">(none)</div>
                        ) : (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                              {effectAudit.topMissingFlags.map((x) => (
                                  <span key={x.k} style={{ padding: "3px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.14)", fontSize: 11, background: "rgba(0,0,0,0.22)" }}>
                            {x.k} • {x.v}
                          </span>
                              ))}
                            </div>
                        )}
                      </div>
                    </div>

                    {auditRowsFiltered.length === 0 ? (
                        <div className="rb-softText">No cards match the current audit filter.</div>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {auditRowsFiltered.map((r) => {
                            const expanded = auditExpandedId === r.id;
                            const missing = [...r.primitivesMissing, ...r.flags.filter((f) => /^TRIGGER_UNSUPPORTED|^CONDITIONAL_GENERAL|^IF_YOU_DO_BRANCH|^REPLACEMENT_EFFECT|^SCALING_EFFECT|^TURN_SCOPED_TRIGGER|^TURN_SCOPED_DAMAGE_HOOK|^CONTINUOUS_ENTER_READY|^ADDITIONAL_COST|^COST_MODIFIER|^SEARCH_NOT_SUPPORTED|^REVEAL_NOT_SUPPORTED|^MOVE_EFFECT_NOT_SUPPORTED|^KEYWORD_UNSUPPORTED|^MULTI_TARGET_UNITS/.test(f))];

                            return (
                                <div
                                    key={r.id}
                                    style={{
                                      border: "1px solid rgba(255,255,255,0.10)",
                                      borderRadius: 12,
                                      padding: 10,
                                      background: "rgba(0,0,0,0.18)",
                                    }}
                                >
                                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                                    <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                                      <button
                                          className="rb-miniButton"
                                          onClick={() => setAuditExpandedId((prev) => (prev === r.id ? null : r.id))}
                                          style={{ padding: "6px 10px" }}
                                      >
                                        {expanded ? "Hide" : "Details"}
                                      </button>
                                      <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                                        <div className="rb-softTextSmall">
                                          {r.type} • {r.domain} • Cost {r.cost}
                                          {r.targetProfile.needsTargets ? ` • Targets: ${r.targetProfile.count} (${r.targetProfile.restriction}, ${r.targetProfile.location})` : ""}
                                        </div>
                                      </div>
                                    </div>

                                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                                      <span style={statusPill(r.status)}>{r.status}</span>
                                    </div>
                                  </div>

                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                                    {missing.slice(0, 10).map((m) => (
                                        <span
                                            key={m}
                                            style={{
                                              padding: "3px 8px",
                                              borderRadius: 999,
                                              border: "1px solid rgba(255,255,255,0.12)",
                                              fontSize: 11,
                                              background: "rgba(255, 120, 120, 0.10)",
                                            }}
                                        >
                                {m}
                              </span>
                                    ))}
                                    {missing.length > 10 ? (
                                        <span style={{ padding: "3px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.12)", fontSize: 11, background: "rgba(0,0,0,0.22)" }}>
                                +{missing.length - 10} more
                              </span>
                                    ) : null}
                                  </div>

                                  {expanded ? (
                                      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
                                        {r.trigger ? (
                                            <div className="rb-softTextSmall">
                                              <b>Trigger:</b> {r.trigger}
                                            </div>
                                        ) : null}

                                        {r.keywords && r.keywords.length ? (
                                            <div className="rb-softTextSmall">
                                              <b>Keywords:</b> {r.keywords.join(" • ")}
                                            </div>
                                        ) : null}

                                        {r.text ? (
                                            <div className="rb-softTextSmall" style={{ whiteSpace: "pre-wrap" }}>
                                              <b>Text:</b> {r.text}
                                            </div>
                                        ) : (
                                            <div className="rb-softTextSmall">(No effect text)</div>
                                        )}

                                        <div className="rb-softTextSmall">
                                          <b>Primitives:</b> {r.primitives.length ? r.primitives.join(", ") : "(none)"}
                                        </div>
                                        <div className="rb-softTextSmall">
                                          <b>Supported primitives:</b> {r.primitivesSupported.length ? r.primitivesSupported.join(", ") : "(none)"}
                                        </div>
                                        <div className="rb-softTextSmall">
                                          <b>Missing primitives:</b> {r.primitivesMissing.length ? r.primitivesMissing.join(", ") : "(none)"}
                                        </div>
                                        <div className="rb-softTextSmall">
                                          <b>Flags:</b> {r.flags.length ? r.flags.join(" • ") : "(none)"}
                                        </div>

                                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                          <button
                                              className="rb-miniButton"
                                              onClick={async () => {
                                                const payload = JSON.stringify(r, null, 2);
                                                try {
                                                  await navigator.clipboard.writeText(payload);
                                                  alert("Card audit JSON copied.");
                                                } catch {
                                                  window.prompt("Copy card audit JSON:", payload);
                                                }
                                              }}
                                          >
                                            Copy card JSON
                                          </button>
                                        </div>
                                      </div>
                                  ) : null}
                                </div>
                            );
                          })}
                        </div>
                    )}

                    <div className="rb-softTextSmall" style={{ marginTop: 12 }}>
                      Notes:
                      <ul style={{ margin: "6px 0 0 18px" }}>
                        <li>
                          “Primitives” are the small effect operations the emulator can (or can’t) execute today. A single card may need multiple primitives.
                        </li>
                        <li>
                          “Flags” are structural capabilities that typically require new engine hooks (e.g., continuous effects, turn-scoped triggers, multi-target selection).
                        </li>
                        <li>
                          This audit is heuristic and may produce false positives; it’s designed to guide implementation work quickly, not to be an oracle.
                        </li>
                      </ul>
                    </div>
                  </>
              )}

              {diagTab === "UNSUPPORTED" ? (
                  <div className="rb-softTextSmall" style={{ marginTop: 12 }}>
                    Note: “Supported” here means the emulator has a parser/handler for at least one operation in the text. Many cards still have static / continuous effects that are not yet fully modeled.
                  </div>
              ) : null}
            </div>
          </div>
        </div>
    );
  };

  const renderClassicGame = () => {
    if (!g) return null;
    return (
        <div style={{ padding: 16 }}>
          <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
            <button onClick={resetGame}>Reset Game</button>
            <button onClick={toggleRevealHands}>{revealAllHands ? "Hide Hands (hotseat)" : "Reveal Hands (hotseat)"}</button>
            <button onClick={toggleRevealFacedown}>{revealAllFacedown ? "Hide Facedown (hotseat)" : "Reveal Facedown (hotseat)"}</button>
            <button onClick={toggleRevealDecks}>{revealAllDecks ? "Hide Decks (hotseat)" : "Reveal Decks (hotseat)"}</button>
            <span style={{ fontSize: 12, color: "#ddd" }}>
            You are “playing as”:
            <select value={viewerId} onChange={(e) => setViewerId(e.target.value as PlayerId)} style={{ marginLeft: 6 }}>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
            </select>
          </span>
            <button disabled={!canActAs(viewerId) || g.turnPlayer !== viewerId || g.chain.length > 0 || g.windowKind !== "NONE" || g.state !== "OPEN"} onClick={() => nextStep()}>
              Next Step
            </button>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 12 }}>
            {renderPlayerPanel("P1")}
            {renderPlayerPanel("P2")}
          </div>

          {renderBattlefields()}
          {renderChainPanel()}
          {renderMovePanel()}
          {renderHidePanel()}
          {renderLog()}
        </div>
    );
  };


  const renderMatchOverlay = () => {
    if (!g || !matchState || matchState.format !== "BO3") return null;

    const matchOver = matchState.wins.P1 >= 2 || matchState.wins.P2 >= 2;
    const currentGameNumber = matchState.gamesCompleted + 1;

    const p1Bfs = deckBattlefieldsFor("P1");
    const p2Bfs = deckBattlefieldsFor("P2");

    const remainingP1 = p1Bfs.filter((b) => !matchState.usedBattlefieldIds.P1.includes(b.id));
    const remainingP2 = p2Bfs.filter((b) => !matchState.usedBattlefieldIds.P2.includes(b.id));

    const nextOptionsP1 = remainingP1.length > 0 ? remainingP1 : p1Bfs;
    const nextOptionsP2 = remainingP2.length > 0 ? remainingP2 : p2Bfs;

    const gameWinner = g.step === "GAME_OVER" ? getGameWinner(g) : null;

    const potentialWins = { ...matchState.wins };
    if (g.step === "GAME_OVER" && gameWinner && !matchOver) potentialWins[gameWinner] = (potentialWins[gameWinner] || 0) + 1;
    const wouldEndAfterCommit = potentialWins.P1 >= 2 || potentialWins.P2 >= 2;

    const matchWinner: PlayerId | null =
        matchState.wins.P1 >= 2 ? "P1" : matchState.wins.P2 >= 2 ? "P2" : null;

    return (
        <div style={{ maxWidth: 1150, margin: "10px auto 0" }} className="rb-panel">
          <div style={{ display: "flex", gap: 14, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <div style={{ minWidth: 240 }}>
              <div style={{ fontWeight: 900, fontSize: 14 }}>Best of 3 Match</div>
              <div className="rb-softText">
                Game {currentGameNumber} • Score P1 {matchState.wins.P1}-{matchState.wins.P2} P2
              </div>
              {g.step === "GAME_OVER" ? (
                  <div className="rb-softText" style={{ marginTop: 4 }}>
                    Game winner: <b>{gameWinner ?? "Unknown"}</b>
                  </div>
              ) : null}
              {matchWinner ? (
                  <div className="rb-softText" style={{ marginTop: 4 }}>
                    Match winner: <b>{matchWinner}</b>
                  </div>
              ) : null}
            </div>

            {g.step === "GAME_OVER" && !matchOver ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="rb-softText">Next game battlefields:</span>

                  <span className="rb-softText">P1</span>
                  <select
                      value={matchNextBattlefieldPick.P1 ?? (nextOptionsP1[0]?.id ?? "")}
                      onChange={(e) => setMatchNextBattlefieldPick((prev) => ({ ...prev, P1: e.target.value || null }))}
                      disabled={nextOptionsP1.length === 0}
                  >
                    {nextOptionsP1.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                    ))}
                  </select>

                  <span className="rb-softText">P2</span>
                  <select
                      value={matchNextBattlefieldPick.P2 ?? (nextOptionsP2[0]?.id ?? "")}
                      onChange={(e) => setMatchNextBattlefieldPick((prev) => ({ ...prev, P2: e.target.value || null }))}
                      disabled={nextOptionsP2.length === 0}
                  >
                    {nextOptionsP2.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                    ))}
                  </select>

                  <button className="rb-miniButton" onClick={startNextBo3Game}>
                    {wouldEndAfterCommit ? "Commit result" : "Commit result & start next game"}
                  </button>

                  {remainingP1.length === 0 || remainingP2.length === 0 ? (
                      <span className="rb-softText" style={{ opacity: 0.8 }}>
                (No unused battlefields left for at least one player; reusing is allowed as a fallback.)
              </span>
                  ) : null}
                </div>
            ) : null}

            {g.step === "GAME_OVER" && matchWinner ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                      className="rb-miniButton"
                      onClick={() => {
                        // Start a fresh BO3 match using the current decks.
                        setMatchFormat("BO3");
                        setMatchState(null);
                        const p1 = deckBattlefieldsFor("P1");
                        const p2 = deckBattlefieldsFor("P2");
                        setMatchNextBattlefieldPick({ P1: p1[0]?.id ?? null, P2: p2[0]?.id ?? null });
                        startDeckBuilderDuel("BO3");
                      }}
                  >
                    Start new BO3 match
                  </button>
                </div>
            ) : null}
          </div>
        </div>
    );
  };


  return (
      <div className="rb-root">
        <style>{arenaCss}</style>

        <div className="rb-topbar">
          <div style={{ display: "flex", gap: 12, alignItems: "baseline", minWidth: 0 }}>
            <div className="rb-title">Riftbound Duel Emulator</div>
            <div style={{ fontSize: 12, opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {g ? `Turn ${g.turnNumber} • Step: ${g.step} • Turn player: ${g.turnPlayer}` : "Load card data to begin"}
            </div>
          </div>

          <div className="rb-topbarControls">
          <span style={{ fontSize: 12, opacity: 0.9 }}>
            UI:
            <select value={uiMode} onChange={(e) => setUiMode(e.target.value as any)} style={{ marginLeft: 6 }}>
              <option value="Arena">Arena</option>
              <option value="Classic">Classic</option>
            </select>
          </span>

            <button onClick={resetGame} disabled={!g}>
              Reset
            </button>

            <button onClick={toggleRevealHands} disabled={!g}>
              {revealAllHands ? "Hide Hands (hotseat)" : "Reveal Hands (hotseat)"}
            </button>
            <button onClick={toggleRevealFacedown} disabled={!g}>
              {revealAllFacedown ? "Hide Facedown (hotseat)" : "Reveal Facedown (hotseat)"}
            </button>
            <button onClick={toggleRevealDecks} disabled={!g}>
              {revealAllDecks ? "Hide Decks (hotseat)" : "Reveal Decks (hotseat)"}
            </button>

            <button onClick={() => setShowDiagnostics(true)} disabled={allCards.length === 0}>
              Diagnostics
            </button>

            <span style={{ fontSize: 12, opacity: 0.9 }}>
            Playing as:
            <select value={viewerId} onChange={(e) => setViewerId(e.target.value as PlayerId)} style={{ marginLeft: 6 }}>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
            </select>
          </span>

            <span style={{ fontSize: 12, opacity: 0.9 }}>
            AI P1:
            <select
                value={aiByPlayer.P1.enabled ? aiByPlayer.P1.difficulty : "HUMAN"}
                onChange={(e) => {
                  const v = e.target.value as any;
                  setAiByPlayer((prev) => ({
                    ...prev,
                    P1: v === "HUMAN" ? { ...prev.P1, enabled: false } : { ...prev.P1, enabled: true, difficulty: v },
                  }));
                }}
                style={{ marginLeft: 6 }}
            >
              <option value="HUMAN">Human</option>
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
              <option value="VERY_HARD">Very Hard</option>
            </select>
          </span>

            <span style={{ fontSize: 12, opacity: 0.9 }}>
            AI P2:
            <select
                value={aiByPlayer.P2.enabled ? aiByPlayer.P2.difficulty : "HUMAN"}
                onChange={(e) => {
                  const v = e.target.value as any;
                  setAiByPlayer((prev) => ({
                    ...prev,
                    P2: v === "HUMAN" ? { ...prev.P2, enabled: false } : { ...prev.P2, enabled: true, difficulty: v },
                  }));
                }}
                style={{ marginLeft: 6 }}
            >
              <option value="HUMAN">Human</option>
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
              <option value="VERY_HARD">Very Hard</option>
            </select>
          </span>

            <span style={{ fontSize: 12, opacity: 0.9 }}>
            AI delay:
            <input
                type="number"
                min={0}
                max={2500}
                step={50}
                value={aiByPlayer.P2.thinkMs}
                onChange={(e) => {
                  const v = Math.max(0, Math.min(2500, Number(e.target.value) || 0));
                  setAiByPlayer((prev) => ({
                    P1: { ...prev.P1, thinkMs: v },
                    P2: { ...prev.P2, thinkMs: v },
                  }));
                }}
                style={{ width: 72, marginLeft: 6 }}
            />
            ms
          </span>

            <button onClick={() => setAiPaused((x) => !x)} disabled={!g}>
              {aiPaused ? "Resume AI" : "Pause AI"}
            </button>
          </div>
        </div>

        {renderMatchOverlay()}

        <div className="rb-content">{!g ? (preGameView === "SETUP" ? renderSetupScreen() : renderDeckBuilder()) : uiMode === "Arena" ? renderArenaGame() : renderClassicGame()}</div>

        {renderPileViewerModal()}
        {renderDiagnosticsModal()}

        {renderChainChoiceModal()}
        {renderPlayModal()}
      </div>
  );
}
