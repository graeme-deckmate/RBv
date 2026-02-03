# Riftbound Core Rules Notes

## Golden and Silver Rules (000)
- **Golden Rule (001-002)**: Card text supersedes rules text. Card's indication is what is true.
- **Silver Rule (050-053)**: Card text uses different terminology than rules. "Card" = Main Deck card. Runes, legends, battlefields are NOT cards. Cards refer to themselves in first person (Units/legends say "I"/"me", Gear/spells say "this", Battlefields say "here").

## Game Concepts (100)

### Deck Construction (101-103)
- Player needs: 2 Decks, 1 Champion Legend, Battlefields (number by Mode of Play)
- **Champion Legend**: Placed in Legend Zone at start, dictates Domain Identity
- **Main Deck**: At least 40 cards (1 Chosen Champion Unit, Units, Gear, Spells)
- **Chosen Champion**: Placed in Champion Zone at start, must have champion tag matching Champion Legend
- Up to 3 copies of same named card in Main Deck
- Only 3 total Signature cards (with same Champion tag as Champion Legend)
- Signature cards are NOT Champion units, cannot be in Champion Zone
- **Rune Deck**: 12 Rune Cards, must be Domain Identity of Chosen Champion

### Battlefields (103.4)
- Number dictated by Mode of Play
- Subject to Domain Identity

## Setup (104-113)

### Spaces/Zones (105-107)
- **The Board**: Play Area with Game Objects
  - **The Base**: One per player, is a Location, houses Runes
  - **Battlefield Zone**: Where Battlefields are located, each is a Location
  - **Facedown Zones**: Sub-zone of each Battlefield, max 1 card, controlled by Battlefield controller
  - **Legend Zone**: Space for Champion Legend (NOT a location)
  
- **Non-Board Zones**:
  - **The Trash**: Where killed/discarded cards go, unordered, Public Information
  - **The Champion Zone**: Where Chosen Champion is placed at start
  - **The Main Deck Zone**: Face-down deck, Secret Information
  - **The Rune Deck Zone**: Face-down runes, Secret Information
  - **Banishment**: Cards removed from play by spell/effect, temporary space for processing effects
  - **The Hand**: Cards player may Play from, Private Information (count is public)

## Game Objects (108-109)
- All Game Objects in Play Area are Public Information
- State of Game Objects (Buffed, Exhausted, etc.) is Public Information
- When Game Object changes to/from Non-Board Zone, all Temporary Modifications cease

## Setup Process (110-113)
1. Each player separates Champion Legend → Legend Zone
2. Each player separates Chosen Champion → Champion Zone
3. Each player sets aside Battlefields


## Setup Process Continued (113-118)
- Mode of Play dictates Battlefield placement
- Players shuffle decks, place Main Deck in Main Deck Zone, Rune Deck in Rune Deck Zone
- Determine Turn Order (First Player becomes Turn Player first)
- Players draw 4 cards
- Mulligan: Choose up to 2 cards, set aside, draw replacements, Recycle set-aside cards

## Game Objects (119-123)
- Game Object: Any game piece that can produce Game Effects or grant prerequisites for Game Actions
- Game Objects include: Main Deck cards, Runes, Legends, Battlefields, Tokens, Abilities, Buffs/status markers

## Cards (124-136)
- **Ownership (126)**: Owner is player who brought card into game
- **Privacy (127)**: Secret (neither player sees), Private (only controller sees), Public (all see)
- **Facedown**: Back side presented, front is Private Information
- **Cost (130)**: Upper left corner - Energy Cost (numeral) + Power Cost (symbols)
- **Name (131)**: Identifies card uniquely, middle of card
- **Category (132)**: Dictates behaviors during play
  - **Permanents**: Unit and Gear - remain on board after played
  - **Spells**: Do not remain on board after played
  - **Runes**: Channeled (not played), remain on board, NOT Main Deck cards
  - **Non-Deck Cards**: Battlefields and Legends - start in zones, not decks

## Domains (133)
- Six Domains: **Fury** (red), **Calm** (green), **Mind** (blue), **Body** (orange), **Chaos** (purple), **Order** (yellow)
- Identified by symbols in lower right corner

## Rules Text (134)
- Contains: Abilities, Instructions, Keywords, Reminder Text
- **Keywords**: Short words/phrases representing abilities/instructions
- **Reminder Text**: Italics in parentheses, no game function

## Units (137-138)
- Game Objects while on the Board


## Units Detailed (137-141)
- **Location**: On Board at Battlefield or Base
- **Killed**: When damage >= Might, unit is Killed
- **Might**: Combat statistic, determines Combat contribution and kill threshold (min 0)
- **Damage**: Marked on units, removed at end of turn and after Combat
- **Enter Board Exhausted**: Can be altered by Accelerate
- **Standard Move**: Inherent ability, costs Exhausting the unit
  - Can move from Base to Battlefield (max 2 other player's units)
  - Can move from Battlefield to Base
  - **Ganking**: Allows Battlefield-to-Battlefield movement
- **Activated Abilities**: Written as "Cost: Effect", can be used during Action Phase in Open State (not during Showdown)

## Unit Intrinsic Properties (139)
- **Tag**: Zero or more Tags (champions, regions, factions, species)
- **Might**: Combat stat
- **Damage**: Tracked on unit

## Gear (142-145)
- Game Object while on Board
- **Enters Play Ready** (not exhausted)
- **Can only be played to Base**
- If Gear is at Battlefield, immediately recalled to Base
- May have Activated Abilities

## Spells (146-152)
- Card type, played during Open State Outside of Showdowns
- Controlled by player who played it
- Creates game effect, then goes to Trash
- **Resolving**: Execute rules text top to bottom
- **Spell Keywords**:
  - **Action**: Can also be played during Open States during Showdowns
  - **Reaction**: Grants Action rules + can be played during all Closed States, resolves before spells/abilities on chain

## Runes (153-159)
- Card Type, NOT Main Deck card
- Kept in Rune Deck (12 cards)
- **Channeled** (not played), remain on board but NOT permanents
- When Recycled, return to Rune Deck (not Main Deck)
- Produce **Energy** (no Domain, pays numeric costs) and **Power** (has Domain, pays Domain costs)
- **Basic Runes**: Fury, Calm, Mind, Body, Chaos, Order
  - Abilities: [T]: Add [1], Recycle this: Add [C] (C = Domain color)
- **Rune Pool**: Conceptual collection of available Energy and Power


## Turn Structure (514-517)

### Start of Turn (515)
1. **Awaken Phase**: Turn Player readies all Game Objects they control
2. **Beginning Phase**: Beginning Step (game effects), Scoring Step (Holding occurs)
3. **Channel Phase**: Turn Player channels 2 runes from Rune Deck
4. **Draw Phase**: Turn Player draws 1 card (Burn Out if no cards), Rune Pool empties

### Action Phase (516)
- No defined structure, Neutral Open State
- Only Turn Player can play spells/activate abilities
- **Combat**: Occurs when opposing Units at same Battlefield
- **Showdowns**: Occur during Combat or when Units move to empty Battlefield

### End of Turn (517)
1. **Ending Step**: End of turn Game Effects
2. **Expiration Step**: Clear damage from Units, "this turn" effects expire, Rune Pools empty
3. **Cleanup Step**: Perform Cleanup

## Cleanups (518-526)
Cleanup occurs after: Chain resolves, Move completes, Showdown completes, Combat completes
- Kill Units with damage >= Might
- Remove Attacker/Defender status from Units not at Combat Battlefield
- Execute state-based Game Effects ("While", "As long as")
- Remove Hidden cards from Battlefields without same-controller Unit → Trash
- Mark Combat as Pending at Battlefields with Units from two opposing players
- **Contested Battlefield**: No Current Controller, Turn Player chooses → Showdown
- **Pending Combat**: Turn Player chooses Battlefield → Combat begins

## Chains and Showdowns (527-537)

### Relevant Players (528-531)
- Players in Combat, or Invited players
- Active Player may invite non-Relevant player

### Chains (532-537)
- Non-Board Zone that exists when card played or ability activated
- Only one Chain at a time
- **Closed State**: Chain exists, cards/abilities cannot be played by default
- **Open State**: No Chain exists


## Game Actions/Keywords (595-604)

### Play (595)
- Paying costs associated with a card
- Discretionary Action (can be done when player has resources)

### Move (596)
- Moving Game Object between Locations on The Board
- Limited Action
- Standard Move inherent to Units is a Discretionary Action
- Cost: Exhausting the Unit, Effect: Moving the Unit

### Hide (597)
- Placing a card facedown at a Battlefield you control
- Discretionary Action
- Hidden cards have gameplay properties defined by the effect

### Discard (598)
- Moving card from hand to Trash without activating/executing rules text
- Limited Action
- "When I am discarded" abilities trigger after discarding

### Stun (599)
- Selecting Units on Board and rendering them Stunned
- Stunned is binary state
- Stunned Units lose status at beginning of next Ending Step
- Stunned Units don't contribute Might to combat but can still be killed
- Limited Action (only when directed by Game Effects)

### Reveal (600)
- Presenting a card to all players from a zone they don't have access to
- Revealed is temporary state, not a zone
- Limited Action

### Counter (601)
- Negating execution/activation/playing of a card
- Countered card does nothing, goes to Trash
- No cost refund
- Limited Action

### Buff (602)
- Placing a Buff counter on a Unit
- Unit can only have one Buff counter
- Limited Action

### Banish (603)
- Placing a card from any zone to Banishment
- Cards can reference banished cards by same object
- Limited Action

### Kill (604)
- Permanent going to Trash from Board
- Active Kill: Instructed by game effect/ability
- Passive Kill: Result of Lethal Damage or state consequence
- Limited Action


## Keywords Glossary (712-717+)

### Buffs (701-705)
- Objects placed on Units
- Each Buff contributes +1 Might
- Only one Buff per Unit at a time
- If Unit leaves play, remove all Buffs
- Champions don't retain Buffs in Champion Zone

### Mighty (706-711)
- Unit "is Mighty" if Might >= 5
- Unit "becomes Mighty" when Might changes from <5 to >=5
- Units on board evaluated by current Might
- Units in Non-Board Zones evaluated by inherent/printed Might

### Accelerate (717)
- Unit ability
- "As you play me, you may pay 1[C] as additional cost. If you do, I enter ready."
- [C] matches the domain of the unit
- Optional Additional Cost when playing
- No function while on board
- Multiple instances redundant

### Action (718)
- Permissive keyword for spells
- Allows spell to be played during Open States during Showdowns
- Without Action, spells can only be played during Neutral Open State

### Reaction (719)
- Permissive keyword for spells
- Grants Action rules + can be played during Closed States
- Resolves before other items on the Chain

### Hidden (723)
- Cards placed facedown at Battlefields
- Have gameplay properties defined by the effect that placed them
- Can be played for [0] on subsequent turns

### Ganking (724)
- Unit ability
- Allows Battlefield-to-Battlefield movement via Standard Move
- Without Ganking, Standard Move only allows Base↔Battlefield

### Deathknell (725)
- Triggered ability
- "[Deathknell] — Effect" means "When I die, Effect"
- Triggers when unit is killed

### Arrival (726)
- Triggered ability  
- "[Arrival] — Effect" means "When I enter the board, Effect"

### Recall (727)
- Moving a permanent from Battlefield to Base
- Limited Action


## FAQ Clarifications

### Symbol Shorthand
- [E] = Exhaust (previously [T])
- [M] = Might (previously [S])
- [A] = One power of any domain/color
- [C] = One power of this card's domain/color

### Scoring
- **Conquer**: Take control of battlefield you didn't control + haven't scored this turn = 1 point
- **Hold**: Control battlefield at start of your turn = 1 point
- Last point (8th in 1v1, 11th in 2v2): Must conquer ALL battlefields that turn to win

### Movement
- Standard Move: Exhaust unit to move Base↔Battlefield (or Battlefield↔Battlefield with Ganking)
- Can move multiple units together as a group to same legal destination
- Ganking allows Battlefield-to-Battlefield movement, not extra moves

### Combat
- Equal total Might: Both sides deal damage equal to total Might, killing all units, no one scores
- Units heal from damage at end of combat AND end of turn
- Stunned units don't deal damage but can still be killed

### Resources
- Runes have two abilities: Exhaust for 1 Energy, Recycle for 1 Power of that domain
- Can use both abilities same turn (exhaust then recycle)
- Rune abilities have Reaction keyword (usable anytime)
- 12 runes total per deck
- Seals: Can't generate energy, only exhausted for power, don't recycle

### Accelerate Cost
- 1 Energy + 1 Power of unit's domain
- Example: 3-cost Fury unit with Accelerate = [4][R] total

