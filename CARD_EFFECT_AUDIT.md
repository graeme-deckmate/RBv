# Riftbound Card Effect Audit

## Summary Statistics
- **Total Cards**: 562
- **Problem Cards**: 263 (171 PARTIAL, 92 UNSUPPORTED)
- **Card Types**: Spell (106), Unit (85), Gear (42), Legend (20), Battlefield (10)

## Top Issues by Flag
| Flag | Count | Description |
|------|-------|-------------|
| KEYWORD_UNSUPPORTED | 180 | Keywords not recognized by parser |
| CONDITIONAL_GENERAL | 75 | Conditional effects not fully implemented |
| TRIGGER_UNSUPPORTED | 30 | Trigger patterns not recognized |
| TURN_SCOPED_TRIGGER | 19 | Turn-limited trigger effects |
| SCALING_EFFECT | 17 | Effects that scale with game state |
| ADDITIONAL_COST | 17 | Cards with additional costs |

---

## Effect Categories Requiring Implementation

### 1. ENTRY_READY_CONDITIONAL (3 cards) - HIGH PRIORITY
Cards that enter ready based on conditions:

| Card | Condition | Status |
|------|-----------|--------|
| **Xin Zhao, Vigilant** | "I enter ready if you have two or more other units in your base." | ✅ IMPLEMENTED |
| **Direwing** | "I enter ready if you control another Dragon." | ✅ IMPLEMENTED |
| **Breakneck Mech** | "I enter ready if you control another Mech." | ✅ IMPLEMENTED |

**Implementation Required**: Check condition at play time, set `isReady = true` if condition met.

### 2. ENTRY_READY_CONTINUOUS (1 card)
| Card | Effect | Status |
|------|--------|--------|
| **Magma Wurm** | "Other friendly units enter ready." | PARTIAL - needs continuous effect |

**Implementation Required**: Add aura effect that makes other units enter ready while Magma Wurm is in play.

### 3. COST_REDUCTION (34 cards) - HIGH PRIORITY
Cards with dynamic cost reduction:

| Card | Effect | Status |
|------|--------|--------|
| **Noxus Hopeful** | "[Legion] — I cost [2] less." | PARTIAL |
| **Sky Splitter** | "Energy cost reduced by highest Might among units you control" | ✅ IMPLEMENTED |
| **Rhasa the Sunderer** | "I cost [1] less for each card in your trash." | ✅ IMPLEMENTED |
| **Raging Firebrand** | "Next spell costs [5] less" | ✅ IMPLEMENTED |
| **Eager Apprentice** | "Spells cost [1] less while at battlefield" | ✅ IMPLEMENTED |
| **Herald of Scales** | "Dragons cost [2] less" | ✅ IMPLEMENTED |

### 4. CONDITIONAL_EFFECTS (76 cards)

#### [Legion] Keyword (9 cards)
"Get the effect if you've played another card this turn."

| Card | Effect |
|------|--------|
| Noxus Hopeful | Cost [2] less |
| Dangerous Duo | Give unit +2 [S] |
| Scrapyard Champion | Discard 2, draw 2 |
| Sun Disc | Next unit enters ready |

#### [Alone] Keyword (implied)
"I'm alone if there are no other friendly units at my location."

#### If You Have/Control Conditions
| Card | Condition |
|------|-----------|
| Poro Herder | "if you control a Poro" |
| Garen, Might of Demacia | "if you have 4+ units at battlefield" |
| The Grand Plaza | "if you have 7+ units here" |

### 5. TRIGGERED_ABILITIES (by trigger type)

#### "When you play me" (46 cards)
Most common trigger - needs target selection support.

#### "When I attack/defend" (18 cards)
Combat triggers - need to fire during showdown.

#### "When I die" / [Deathknell] (12 cards)
Death triggers - need to fire when unit is killed.

#### "At the start/end of turn" (12 cards)
Phase triggers - need to fire during Beginning/Ending phases.

#### "When you channel/recycle" (8 cards)
Rune manipulation triggers.

#### "Whenever" (continuous triggers)
Need to monitor game state changes.

### 6. ACTIVATED_ABILITIES

#### [T]: (Tap) Abilities
Most common activated ability format.

#### Cost Patterns Found:
- `[T]:` - Tap only
- `[N], [T]:` - Energy + Tap (e.g., Viktor's `[1], [T]:`)
- `[C], [T]:` - Class rune + Tap
- `Discard N, [T]:` - Discard + Tap

### 7. KEYWORD_EFFECTS

#### Keywords Requiring Implementation:
| Keyword | Effect | Status |
|---------|--------|--------|
| **[Play]** | Timing indicator | Parsed but flagged |
| **[Legion]** | Conditional if played another card | PARTIAL |
| **[Alone]** | Conditional if no other friendly units | PARTIAL |
| **[Deathknell]** | Trigger on death | PARTIAL |
| **[Accelerate]** | Pay extra to enter ready | IMPLEMENTED |
| **[Deflect]** | Opponents pay [A] to target | PARTIAL |
| **[Ganking]** | Can attack from base | IMPLEMENTED |
| **[Tank]** | Must be assigned damage first | IMPLEMENTED |
| **[Assault N]** | +N [S] while attacking | IMPLEMENTED |
| **[Hidden]** | Can be hidden at battlefield | IMPLEMENTED |
| **[Equip]** | Can attach gear | PARTIAL |
| **[Weaponmaster]** | Auto-equip when played | ✅ IMPLEMENTED |
| **[Quick-Draw]** | Reaction + attach | ✅ ADDED TO KEYWORDS |

### 8. SPELL_EFFECTS

#### Damage Spells (40+ cards)
- Single target: "Deal N to a unit"
- Multi target: "Deal N to each/all units"
- Conditional: "If this kills it, draw N"

#### Buff/Debuff Spells (30+ cards)
- "+N [S] this turn"
- "-N [S] this turn"
- "Give [Keyword]"

#### Utility Spells
- Draw cards
- Discard cards
- Return to hand/base
- Move units
- Counter spells

### 9. GEAR_EFFECTS

#### Seals (6 cards) - IMPLEMENTED
Add domain-specific power when exhausted.

#### Equipment (41 cards)
- Attach to units
- Grant stats/keywords
- Triggered effects when attached

### 10. BATTLEFIELD_EFFECTS (10 cards)

| Battlefield | Effect |
|-------------|--------|
| The Grand Plaza | "if you have 7+ units here, you win" |
| Targon's Peak | "ready 2 runes when conquer" |
| Navori Fighting Pit | "buff a unit when hold" |

---

## Priority Implementation List

### HIGH PRIORITY (Game-Breaking)
1. **Conditional Entry Ready** - Xin Zhao, Direwing, Breakneck Mech
2. **[Legion] Keyword** - Cost reduction and triggered effects
3. **Dynamic Cost Reduction** - Sky Splitter, Rhasa, etc.
4. **[Play] Keyword** - Stop flagging as unsupported

### MEDIUM PRIORITY (Gameplay Impact)
5. **[Weaponmaster]** - Auto-equip gear
6. **[Quick-Draw]** - Reaction + attach
7. **Continuous Auras** - Magma Wurm, Eager Apprentice
8. **Death Triggers** - [Deathknell] effects

### LOW PRIORITY (Polish)
9. **Scaling Effects** - Effects based on game state
10. **Complex Conditionals** - Multi-condition effects

---

## Implementation Notes

### For Xin Zhao Entry Ready:
```typescript
// In enginePlayCard, after creating the unit:
if (card.name === "Xin Zhao, Vigilant" || 
    /enter(s)? ready if/i.test(card.ability?.raw_text || "")) {
  const condition = parseEntryReadyCondition(card);
  if (checkCondition(d, pid, condition)) {
    unit.isReady = true;
  }
}
```

### For [Legion] Keyword:
```typescript
// Check if player has played another card this turn
const hasLegion = p.mainDeckCardsPlayedThisTurn > 0;
if (hasLegion && card.ability?.keywords?.includes("Legion")) {
  // Apply Legion effect
}
```

### For Dynamic Cost Reduction:
```typescript
// Calculate effective cost based on game state
function getEffectiveCost(d: GameState, pid: PlayerId, card: CardInstance): number {
  let cost = card.cost;
  
  // Sky Splitter: reduce by highest Might
  if (/cost.*reduced by.*highest might/i.test(card.ability?.raw_text || "")) {
    const maxMight = Math.max(...getUnitsInPlay(d, pid).map(u => u.stats.might || 0));
    cost = Math.max(0, cost - maxMight);
  }
  
  // Rhasa: reduce by cards in trash
  if (/cost.*less for each card in.*trash/i.test(card.ability?.raw_text || "")) {
    cost = Math.max(0, cost - d.players[pid].trash.length);
  }
  
  return cost;
}
```
