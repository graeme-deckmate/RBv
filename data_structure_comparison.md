# Data Structure Comparison: riftbound_card_data.json vs riftbound_data_expert.json

## Key Differences

### ID Format
- **Old**: `"id": "ogn-001"` (lowercase, simple format)
- **New**: `"id": "OGN-001/298"` (uppercase, includes card number out of total)

### Type Information
- **Old**: `"type": "Unit"` (separate field, capitalized)
- **New**: `"type_line": "unit - dragon"` (combined with tags/subtypes, lowercase)

### Domain Information
- **Old**: `"domain": "Fury"` (explicit domain field)
- **New**: No explicit domain field - must be extracted from type_line or inferred

### Stats Structure
- **Old**: 
```json
"cost": 5.0,
"stats": { "might": 5.0, "power": null }
```
- **New**:
```json
"stats": { "energy": 5.0, "might": 5.0, "power": NaN }
```
Note: `cost` renamed to `energy` and moved inside `stats`. `power` can be `NaN`, `"C"` (class power), or a number.

### Ability/Rules Text Structure
- **Old**:
```json
"ability": {
  "raw_text": "...",
  "type": "Passive",
  "keywords": [...],
  "trigger": "...",
  "effect_text": "...",
  "reminder_text": [...]
}
```
- **New**:
```json
"rules_text": {
  "raw": "...",
  "keywords": [...]
}
```
Note: New format is simpler, with `game_logic` containing structured effect data.

### Game Logic (New Only)
```json
"game_logic": {
  "capabilities": {
    "play_speed": "Action (Slow)" | "Action (Showdown/Open State)",
    "setup_option": null,
    "modes": [{ "mode_name": "ACCELERATE", "effect": "Enter Ready", "cost": "See Text" }]
  },
  "chain": [
    {
      "type": "PASSIVE_OR_IMMEDIATE" | "TRIGGERED_ABILITY",
      "condition": "...",
      "effects": [{ "action": "DAMAGE", "amount": "3" }]
    }
  ]
}
```

### Tags
- **Old**: `"tags": ["Dragon", "Noxus"]` (explicit array)
- **New**: Tags embedded in `type_line` (e.g., "unit - dragon")

### Image URL
- **Old**: `"image_url": "https://..."` (present)
- **New**: No image_url field

## Conversion Requirements for RBEXP.tsx

1. **Extract domain from type_line or card name patterns**
2. **Map `stats.energy` to `cost`**
3. **Handle `NaN` values in stats (treat as null)**
4. **Parse `type_line` to get card type and tags**
5. **Map `rules_text.raw` to `ability.raw_text`**
6. **Map `rules_text.keywords` to `ability.keywords`**
7. **Handle power values: `NaN` → null, `"C"` → 1 (class power)**
8. **Extract trigger/effect from `game_logic.chain` if available**

