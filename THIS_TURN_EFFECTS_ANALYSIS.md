# Riftbound "This Turn" Effects Analysis

## Summary
Total cards with "this turn" effects: **73 cards**

## Categories and Implementation Status

### 1. GIVE_MIGHT_THIS_TURN (28 cards) - ✅ MOSTLY IMPLEMENTED
Cards that give +N [S] this turn to units.

| Card | Type | Effect | Status |
|------|------|--------|--------|
| Back-Alley Bar | battlefield | When a unit moves from here, give it +1 [S] this turn | ⚠️ NEEDS CHECK |
| Heart of Dark Ice | gear | [T]: Give a unit +3 [S] this turn | ⚠️ NEEDS CHECK |
| Pirate's Haven | gear | When you ready a friendly unit, give it +1 [S] this turn | ⚠️ NEEDS CHECK |
| Against the Odds | spell | Give a friendly unit +2 [S] this turn for each enemy unit there | ⚠️ NEEDS CHECK |
| Back to Back | spell | Give two friendly units each +2 [S] this turn | ✅ IMPLEMENTED |
| Bonds of Strength | spell | Give two friendly units each +1 [S] this turn | ✅ IMPLEMENTED |
| Call to Glory | spell | Give a unit +3 [S] this turn | ✅ IMPLEMENTED |
| Danger Zone | spell | Give your Mechs +1 [S] this turn | ⚠️ NEEDS CHECK |
| Decisive Strike | spell | Give friendly units +2 [S] this turn | ✅ IMPLEMENTED |
| Defiant Dance | spell | Give a unit +2 [S] this turn and another unit -2 [S] this turn | ⚠️ NEEDS CHECK |
| Discipline | spell | Give a unit +2 [S] this turn. Draw 1 | ✅ IMPLEMENTED |
| En Garde | spell | Give a friendly unit +1 [S] this turn, then additional +1 if alone | ⚠️ NEEDS CHECK |
| Feral Strength | spell | Give a unit +2 [S] this turn | ✅ IMPLEMENTED |
| Gentlemen's Duel | spell | Give a friendly unit +3 [S] this turn | ✅ IMPLEMENTED |
| Grand Strategem | spell | Give friendly units +5 [S] this turn | ✅ IMPLEMENTED |
| Primal Strength | spell | Give a unit +7 [S] this turn | ✅ IMPLEMENTED |
| Punch First | spell | Give a unit +5 [S] this turn | ✅ IMPLEMENTED |
| Siphon Power | spell | Give friendly units +1 [S] and enemy units -1 [S] this turn | ⚠️ NEEDS CHECK |
| Blastcone Fae | unit | When you play me, give a unit -2 [S] this turn | ✅ IMPLEMENTED |
| Dangerous Duo | unit | [Legion] — give a unit +2 [S] this turn | ✅ IMPLEMENTED |
| Darius, Trifarian | unit | When you play second card, give me +2 [S] this turn | ⚠️ NEEDS CHECK |
| Draven, Vanquisher | unit | When I attack/defend, pay [C] to give me +2 [S] this turn | ⚠️ NEEDS CHECK |
| Eclipse Herald | unit | When you stun enemy, ready me and give me +1 [S] this turn | ⚠️ NEEDS CHECK |
| Ember Monk | unit | When you play from [Hidden], give me +2 [S] this turn | ⚠️ NEEDS CHECK |
| Frostcoat Cub | unit | If you paid additional cost, give a unit -2 [S] this turn | ⚠️ NEEDS CHECK |
| Irelia, Fervent | unit | When you choose or ready me, give me +1 [S] this turn | ⚠️ NEEDS CHECK |
| Jinx, Rebel | unit | When you discard, ready me and give me +1 [S] this turn | ⚠️ NEEDS CHECK |
| Kato the Arm | unit | When I move to battlefield, give unit my keywords and +[S] equal to my Might this turn | ⚠️ NEEDS CHECK |
| Lux, Illuminated | unit | When you play spell costing [5]+, give me +3 [S] this turn | ⚠️ NEEDS CHECK |
| Prize of Progress | unit | When you use gear ability, give me +1 [S] this turn | ⚠️ NEEDS CHECK |
| Ravenbloom Student | unit | When you play a spell, give me +1 [S] this turn | ⚠️ NEEDS CHECK |
| Ribbon Dancer | unit | When I move to battlefield, give another unit +1 [S] this turn | ⚠️ NEEDS CHECK |
| Teemo, Scout | unit | When you play me, give me +3 [S] this turn | ✅ IMPLEMENTED |
| Thousand-Tailed Watcher | unit | When you play me, give enemy units -3 [S] this turn | ⚠️ NEEDS CHECK |
| Undertitan | unit | When you play me, give your other units +2 [S] this turn | ⚠️ NEEDS CHECK |
| Vi, Destructive | unit | Recycle 1: Give me +1 [S] this turn | ⚠️ NEEDS CHECK |
| Whiteflame Protector | unit | When you play me, give a unit +8 [S] this turn | ✅ IMPLEMENTED |

### 2. GIVE_MINUS_MIGHT_THIS_TURN (6 cards) - ✅ MOSTLY IMPLEMENTED
Cards that give -N [S] this turn.

| Card | Type | Effect | Status |
|------|------|--------|--------|
| Orb of Regret | gear | [T]: Give a unit -1 [S] this turn, min 1 | ⚠️ NEEDS CHECK |
| Ahri, Nine-Tailed Fox | legend | When enemy attacks, give it -1 [S] this turn | ⚠️ NEEDS CHECK |
| Frigid Touch | spell | Give a unit -2 [S] this turn | ✅ IMPLEMENTED |
| Smoke Screen | spell | Give a unit -4 [S] this turn, min 1 | ✅ IMPLEMENTED |
| Stupefy | spell | Give a unit -1 [S] this turn, min 1. Draw 1 | ✅ IMPLEMENTED |

### 3. DELAYED_TRIGGER (3 cards) - ✅ IMPLEMENTED
Cards that create delayed triggers for this turn.

| Card | Type | Effect | Status |
|------|------|--------|--------|
| Mask of Foresight | gear | When friendly unit attacks/defends alone, give +1 [S] this turn | ✅ IMPLEMENTED |
| Rally the Troops | spell | When a friendly unit is played this turn, buff it. Draw 1 | ✅ IMPLEMENTED |
| Sun Disc | gear | [Legion] — Next unit you play this turn enters ready | ⚠️ NEEDS CHECK |

### 4. ENTER_READY_THIS_TURN (2 cards) - ⚠️ NEEDS IMPLEMENTATION
Cards that make units enter ready this turn.

| Card | Type | Effect | Status |
|------|------|--------|--------|
| Bushwhack | spell | Friendly units enter ready this turn. Play Gold token | ❌ NOT IMPLEMENTED |
| Confront | spell | Units you play this turn enter ready. Draw 1 | ❌ NOT IMPLEMENTED |

### 5. STUN (7 cards) - ✅ IMPLEMENTED
Cards that stun units (doesn't deal combat damage this turn).

| Card | Type | Effect | Status |
|------|------|--------|--------|
| Miss Fortune, Bounty Hunter | legend | [T]: Give a unit [Ganking] this turn | ✅ IMPLEMENTED |
| Facebreaker | spell | Stun a friendly and enemy unit | ✅ IMPLEMENTED |
| Rune Prison | spell | Stun a unit | ✅ IMPLEMENTED |
| Thwonk! | spell | Stun an attacking unit | ✅ IMPLEMENTED |
| Zenith Blade | spell | Stun an enemy unit | ✅ IMPLEMENTED |
| Leona, Determined | unit | When I attack, stun an enemy unit here | ✅ IMPLEMENTED |
| Solari Chief | unit | When you play me, stun or kill if stunned | ✅ IMPLEMENTED |
| Solari Shieldbearer | unit | When you play me, stun a unit | ✅ IMPLEMENTED |

### 6. KEYWORD_THIS_TURN (4 cards) - ⚠️ PARTIAL
Cards that give keywords this turn.

| Card | Type | Effect | Status |
|------|------|--------|--------|
| Miss Fortune, Bounty Hunter | legend | Give a unit [Ganking] this turn | ⚠️ NEEDS CHECK |
| Block | spell | Give [Shield 3] and [Tank] this turn | ⚠️ NEEDS CHECK |
| Cleave | spell | Give [Assault 3] this turn | ⚠️ NEEDS CHECK |
| Gem Jammer | unit | Give a unit [Ganking] this turn | ⚠️ NEEDS CHECK |
| Udyr, Wildman | unit | Give me [Ganking] this turn | ⚠️ NEEDS CHECK |

### 7. PREVENT_THIS_TURN (2 cards) - ⚠️ NEEDS IMPLEMENTATION
Cards that prevent damage this turn.

| Card | Type | Effect | Status |
|------|------|--------|--------|
| Counter Strike | spell | Prevent next damage to unit this turn. Draw 1 | ❌ NOT IMPLEMENTED |
| Unyielding Spirit | spell | Prevent all spell and ability damage this turn | ❌ NOT IMPLEMENTED |

### 8. RECALL_ON_DEATH (2 cards) - ⚠️ NEEDS IMPLEMENTATION
Cards that recall units instead of dying this turn.

| Card | Type | Effect | Status |
|------|------|--------|--------|
| Unlicensed Armory | gear | Next time unit dies this turn, may pay [C] to recall | ❌ NOT IMPLEMENTED |
| Highlander | spell | Next time unit dies this turn, recall instead | ❌ NOT IMPLEMENTED |

### 9. KILL_ON_DAMAGE (2 cards) - ✅ IMPLEMENTED
Cards that kill units when they take damage this turn.

| Card | Type | Effect | Status |
|------|------|--------|--------|
| Imperial Decree | spell | When any unit takes damage this turn, kill it | ✅ IMPLEMENTED |
| Noxian Guillotine | spell | Kill unit next time it takes damage this turn | ✅ IMPLEMENTED |

### 10. CONDITIONAL_THIS_TURN (8 cards) - ⚠️ PARTIAL
Cards with conditional effects based on this turn's actions.

| Card | Type | Effect | Status |
|------|------|--------|--------|
| Azir, Emperor of the Sands | legend | Use only if you've played Equipment this turn | ⚠️ NEEDS CHECK |
| Ezreal, Prodigal Explorer | legend | Use only if chosen enemy twice this turn | ⚠️ NEEDS CHECK |
| Darius, Hand of Noxus | legend | [Legion] — if played card this turn | ✅ IMPLEMENTED |
| Spoils of War | spell | Costs [2] less if enemy unit died this turn | ⚠️ NEEDS CHECK |
| Noxus Hopeful | unit | [Legion] — costs [2] less | ✅ IMPLEMENTED |
| Raging Soul | unit | If discarded this turn, has [Assault] and [Ganking] | ⚠️ NEEDS CHECK |
| Sivir, Mercenary | unit | If spent [A][A] this turn, has +2 [S] and [Ganking] | ⚠️ NEEDS CHECK |

### 11. OTHER (15 cards) - ⚠️ NEEDS REVIEW
Complex or unique effects.

| Card | Type | Effect | Status |
|------|------|--------|--------|
| Targon's Peak | battlefield | When conquer, ready 2 runes at end of this turn | ⚠️ NEEDS CHECK |
| Temporal Portal | gear | Give next spell [Repeat] equal to cost this turn | ❌ NOT IMPLEMENTED |
| Guerilla Warfare | spell | Hide cards ignoring costs this turn | ❌ NOT IMPLEMENTED |
| Riposte | spell | Counter spell, give +[S] equal to spell's cost this turn | ⚠️ NEEDS CHECK |
| Convergent Mutation | spell | Unit's Might becomes another unit's Might this turn | ❌ NOT IMPLEMENTED |
| Deathgrip | spell | Kill friendly unit, give +[S] equal to its Might this turn | ⚠️ NEEDS CHECK |
| Last Stand | spell | Double unit's Might this turn, give [Temporary] | ⚠️ NEEDS CHECK |
| Relentless Pursuit | spell | This turn, unit has "When I conquer, may move to base" | ❌ NOT IMPLEMENTED |
| Stand United | spell | Buffs give additional +1 [S] this turn | ❌ NOT IMPLEMENTED |
| Switcheroo | spell | Swap Might of two units this turn | ❌ NOT IMPLEMENTED |
| Aphelios, Exalted | unit | Choose one not chosen this turn | ⚠️ NEEDS CHECK |
| Brynhir Thundersong | unit | Opponents can't play cards this turn | ❌ NOT IMPLEMENTED |
| Jayce, Man of Progress | unit | Play gear ignoring Energy cost this turn | ⚠️ NEEDS CHECK |
| Kayn, Unleashed | unit | If moved twice this turn, don't take damage | ✅ IMPLEMENTED |
| Perched Grimwyrm | unit | Play only to battlefield conquered this turn | ⚠️ NEEDS CHECK |

---

## Priority Implementation List

### HIGH PRIORITY (Core Gameplay)
1. **Bushwhack/Confront** - "Units enter ready this turn" delayed effect
2. **Counter Strike/Unyielding Spirit** - Damage prevention this turn
3. **Highlander/Unlicensed Armory** - Recall on death this turn
4. **Brynhir Thundersong** - Opponents can't play cards this turn

### MEDIUM PRIORITY (Common Effects)
5. **Switcheroo** - Swap Might this turn
6. **Convergent Mutation** - Copy Might this turn
7. **Stand United** - Buffs give additional +1 [S] this turn
8. **Temporal Portal** - Give spell [Repeat] this turn

### LOW PRIORITY (Edge Cases)
9. **Relentless Pursuit** - Grant temporary ability this turn
10. **Guerilla Warfare** - Hide ignoring costs this turn
11. **Aphelios modal** - Track choices this turn
