# Cards with Multiple Effects (Play Trigger + Activated Ability)

## Units

### Sett, Brawler ✅ (Already Fixed)
- **Play Trigger:** When I'm played and when I conquer, buff me.
- **Activated Ability:** Spend my buff: Give me +4 might this turn.
- **Status:** Implemented

### Udyr, Wildman
- **Activated Ability:** Spend my buff: Choose one you've not chosen this turn —
  - Deal 2 to a unit at a battlefield.
  - Stun a unit at a battlefield.
  - Ready me.
  - Give me [Ganking] this turn.
- **Status:** Needs implementation (complex modal ability)

## Gear

### Zhonya's Hourglass
- **Static Effect:** The next time a friendly unit would die, kill this instead. Recall that unit exhausted.
- **Status:** Needs "kill this instead" replacement effect

### Forge of the Future
- **Play Trigger:** When you play this, play a 1 [S] Recruit unit token at your base.
- **Activated Ability:** Kill this: Recycle up to 4 cards from trashes.
- **Status:** Needs "Kill this:" activated ability

### Poro Snax
- **Play Trigger:** When you play this, draw 1.
- **Activated Ability:** [1][C], [T], Kill this: Draw 1.
- **Status:** Needs "Kill this:" activated ability with cost

### Petricite Monument
- **Static Effect:** [Temporary] + Friendly units have [Deflect].
- **Status:** Needs Temporary keyword implementation

## Legends

### Sett, The Boss / The Boss
- **Triggered Ability:** When a buffed unit you control would die, you may pay [C] and exhaust me to spend its buff and recall it exhausted instead.
- **Second Trigger:** When you conquer, ready me.
- **Status:** Needs replacement effect + conquer trigger

### Irelia, Blade Dancer
- **Triggered Ability:** When you choose a friendly unit, you may exhaust me and pay [A] to ready it.
- **Second Trigger:** When you conquer, you may pay [1] to ready me.
- **Status:** Needs "choose" trigger + conquer trigger

### Sivir, Battle Mistress
- **Triggered Ability:** When you recycle a rune, you may exhaust me to play a Gold gear token exhausted.
- **Second Trigger:** When one or more enemy units die, ready me.
- **Status:** Needs recycle trigger + enemy death trigger

### Renata Glasc, Chem-Baroness
- **Triggered Ability:** When you or an ally hold, you may exhaust me to play a Gold gear token exhausted.
- **Static Effect:** While your score is within 3 points of the Victory Score, your Gold [ADD] an additional [1].
- **Status:** Needs hold trigger + conditional static effect

### Reksai, Void Burrower
- **Triggered Ability:** When you conquer, you may exhaust me to reveal the top 2 cards of your Main Deck. You may play one. Then recycle the rest.
- **Status:** Needs conquer trigger with reveal/play

### Volibear, Relentless Storm / Relentless Storm
- **Triggered Ability:** When you play a [Mighty] unit, you may exhaust me to channel 1 rune exhausted.
- **Status:** Needs "play Mighty unit" trigger

### Fiora, Grand Duelist ✅ (Already Fixed)
- **Triggered Ability:** When one of your units becomes [Mighty], you may exhaust me to channel 1 rune exhausted.
- **Status:** Fixed (was checking wrong property)

## Priority Implementation Order

1. **Kill this:** activated ability for gear (Forge of the Future, Poro Snax) - Similar to existing pattern
2. **Spend my buff:** for Udyr (complex modal)
3. **Legend conquer triggers** (Sett, Irelia)
4. **Legend death/recycle triggers** (Sivir)
5. **Replacement effects** (Zhonya's, Sett legend)
