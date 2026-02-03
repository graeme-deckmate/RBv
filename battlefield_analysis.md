# Battlefield Trigger Analysis

## Trigger Types and Timing

| Trigger | When it fires |
|---------|---------------|
| **When you conquer here** | When you capture the battlefield (go from 0 to 1+ units while enemy has 0) |
| **When you hold here** | At the end of your turn if you control the battlefield |
| **When you defend here** | When combat starts and you are the defender |
| **When you attack here** | When combat starts and you are the attacker |
| **When a unit moves from here** | When any unit leaves this battlefield |
| **At the start of each player's first Beginning Phase** | Beginning of game for each player |
| **While you control this battlefield** | Continuous effect while controlled |

## All Battlefields and Their Effects

### Conquer Triggers (fire when capturing)
1. **Monastery of Hirana** - you may spend a buff to draw 1
2. **Sigil of the Storm** - recycle one of your runes
3. **Targon's Peak** - ready 2 runes at the end of this turn
4. **The Candlelit Sanctum** - look at top 2 cards, may recycle one or both
5. **Zaun Warrens** - discard 1, then draw 1
6. **Emperor's Dais** - may pay [1] and return a unit to hand, play 2S Sand Soldier
7. **Hall of Legends** - may pay [1] to ready your legend
8. **Minefield** - put top 2 cards of Main Deck into trash
9. **Seat of Power** - draw 1 for each other battlefield you or allies control
10. **Sunken Temple** - if you have Mighty units, may pay [1] to draw 1
11. **Treasure Hoard** - may pay [1] to play a Gold gear token exhausted
12. **Veiled Temple** - may ready a friendly gear, may detach if Equipment

### Hold Triggers (fire at end of your turn if you control)
1. **Altar to Unity** - play a 1S Recruit unit token in your base
2. **Grove of the God-Willow** - draw 1
3. **Hallowed Tomb** - may return Chosen Champion from trash to Champion Zone
4. **Navori Fighting Pit** - buff a unit here
5. **Reckoner's Arena** - activate conquer effects of units here
6. **Startipped Peak** - may channel 1 rune exhausted
7. **The Grand Plaza** - if you have 7+ units here, you win the game
8. **Power Nexus** - may pay [A][A][A][A] to score 1 point
9. **The Papertree** - each player channels 1 rune exhausted

### Defend Triggers (fire when combat starts as defender)
1. **Fortified Position** - choose a unit, it gains Shield 2 this combat
2. **Reaver's Row** - may move a friendly unit here to base
3. **Ravenbloom Conservatory** - reveal top card, if spell put in hand, else recycle

### Movement Triggers
1. **Back-Alley Bar** - When a unit moves from here, give it +1S this turn

### Continuous Effects (while you control)
1. **Trifarian War Camp** - Units here have +1S (including attackers)
2. **Vilemaw's Lair** - Units can't move from here to base
3. **Windswept Hillock** - Units here have Ganking
4. **Forge of the Fluft** - friendly legends have "[T]: Attach Equipment to unit"
5. **Marai Spire** - friendly Repeat costs cost [1] less
6. **Ornn's Forge** - first friendly non-token gear each turn costs [1] less
7. **Rockfall Path** - Units can't be played here

### Static Effects (always active)
1. **Aspirant's Climb** - Increase victory points needed by 1
2. **Bandle Tree** - You may hide an additional card here
3. **Void Gate** - Spells/abilities affecting units here deal 1 Bonus Damage
4. **Forgotten Monument** - Players can't score here until their third turn

### Beginning Phase Triggers
1. **Obelisk of Power** - At start of each player's first Beginning Phase, channel 1 rune
2. **The Arena's Greatest** - At start of each player's first Beginning Phase, gain 1 point

### Other Triggers
1. **The Dreaming Tree** - First time you choose a friendly unit with a spell here each turn, draw 1

## Trifarian War Camp - Special Note

**Effect:** "Units here have +1 [S]. (This includes attackers.)"

This is a **continuous effect** that should:
- Apply to ALL units at this battlefield (both players)
- Apply during combat (attackers AND defenders)
- Be factored into effectiveMight calculation

**Current Implementation Status:** Need to verify this is working correctly.
