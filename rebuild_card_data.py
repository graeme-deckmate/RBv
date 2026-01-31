#!/usr/bin/env python3
"""
Rebuild riftbound_data_expert.json from the CSV source files.
This ensures all card data is complete with proper domains and image links.
"""

import csv
import json
import re
import sys
from typing import Dict, List, Any, Optional

def parse_csv_row(row: Dict[str, str]) -> Dict[str, Any]:
    """Parse a single CSV row into a card data structure."""
    name = row.get('Name', '').strip()
    if not name:
        return None
    
    # Get collector number as ID
    card_id = row.get('Collector Number', '').strip()
    if not card_id:
        return None
    
    # Get domains
    domain1 = row.get('Domain 1', '').strip().capitalize() if row.get('Domain 1') else ''
    domain2 = row.get('Domain 2', '').strip().capitalize() if row.get('Domain 2') else ''
    
    # Build domain string
    domains = []
    if domain1 and domain1.lower() not in ['', 'nan']:
        domains.append(domain1)
    if domain2 and domain2.lower() not in ['', 'nan']:
        domains.append(domain2)
    domain_str = ', '.join(domains) if domains else 'Colorless'
    
    # Get card type
    card_type = row.get('types', '').strip().lower()
    if not card_type:
        card_type = 'unit'
    
    # Get subtypes
    subtypes = []
    for i in range(1, 6):
        subtype = row.get(f'Subtype {i}', '').strip()
        if subtype and subtype.lower() not in ['', 'nan']:
            subtypes.append(subtype.lower())
    
    # Build type_line
    if subtypes:
        type_line = f"{card_type} - {', '.join(subtypes)}"
    else:
        type_line = card_type
    
    # Get supertypes (like "basic" for runes)
    supertypes = row.get('supertypes', '').strip()
    
    # Get stats
    energy = row.get('Energy', '').strip()
    might = row.get('Might', '').strip()
    power = row.get('Power', '').strip()
    
    # Parse energy
    try:
        energy_val = float(energy) if energy and energy not in ['', '-'] else None
    except ValueError:
        energy_val = None
    
    # Parse might
    try:
        might_val = float(might) if might and might not in ['', '-'] else None
    except ValueError:
        might_val = None
    
    # Parse power (can be "C", "CC", etc. or a number)
    power_val = None
    if power and power not in ['', '-']:
        if power.upper().replace('C', '') == '':
            # It's all C's - count them
            power_val = power.upper()
        else:
            try:
                power_val = float(power)
            except ValueError:
                power_val = power
    
    # Get description (rules text)
    description = row.get('Description', '').strip()
    alt_text = row.get('ALT TEXT', '').strip()
    
    # Extract keywords from description
    keywords = extract_keywords(description)
    
    # Build the card data
    card_data = {
        'id': card_id,
        'name': name,
        'rarity': row.get('Rarity', '').strip().lower(),
        'domain': domain_str,
        'type_line': type_line,
        'stats': {
            'energy': energy_val,
            'might': might_val,
            'power': power_val
        },
        'rules_text': {
            'raw': description,
            'keywords': keywords
        }
    }
    
    # Add supertypes if present
    if supertypes and supertypes.lower() not in ['', 'nan']:
        card_data['supertypes'] = supertypes.lower()
    
    # Add tags if present
    tags = row.get('Tags', '').strip()
    if tags and tags.lower() not in ['', 'nan']:
        card_data['tags'] = [t.strip() for t in tags.split(',') if t.strip()]
    
    return card_data

def extract_keywords(text: str) -> List[str]:
    """Extract keywords from card text."""
    keywords = []
    
    # Common keywords to look for (in brackets or as standalone)
    keyword_patterns = [
        r'\[([A-Za-z]+(?:\s+\d+)?)\]',  # [Keyword] or [Keyword N]
        r'^(Action|Reaction|Hidden)\b',  # Speed keywords at start
    ]
    
    # Known keywords
    known_keywords = [
        'Accelerate', 'Action', 'Reaction', 'Hidden', 'Vision', 'Legion',
        'Assault', 'Defender', 'Elusive', 'Fearsome', 'Mighty', 'Temporary',
        'Quick Attack', 'Overwhelm', 'Lifesteal', 'Barrier', 'Spellshield',
        'Regeneration', 'Tough', 'Challenger', 'Scout', 'Fury', 'Attune',
        'Deep', 'Ephemeral', 'Last Breath', 'Nexus Strike', 'Play', 'Strike',
        'Support', 'Vulnerable', 'Capture', 'Frostbite', 'Immobile', 'Recall',
        'Silence', 'Stun', 'Obliterate', 'Rally', 'Enlightened', 'Reputation',
        'Lurk', 'Predict', 'Invoke', 'Behold', 'Augment', 'Impact', 'Formidable',
        'Equipment', 'Attach', 'Hallowed', 'Evolve', 'Husk', 'Boon', 'Flow'
    ]
    
    # Find bracketed keywords
    bracket_matches = re.findall(r'\[([^\]]+)\]', text)
    for match in bracket_matches:
        # Clean up the match
        kw = match.strip()
        # Remove numbers for keywords like "Assault 2"
        base_kw = re.sub(r'\s+\d+$', '', kw)
        if base_kw and base_kw not in keywords:
            keywords.append(kw)
    
    # Check for known keywords in text
    text_lower = text.lower()
    for kw in known_keywords:
        if kw.lower() in text_lower and kw not in keywords:
            # Check if it's actually a keyword usage (not just mentioned)
            pattern = rf'\[{re.escape(kw)}(?:\s+\d+)?\]|\({re.escape(kw)}'
            if re.search(pattern, text, re.IGNORECASE):
                if kw not in keywords:
                    keywords.append(kw)
    
    return keywords

def load_images(image_csv_path: str) -> Dict[str, str]:
    """Load image URLs from the images CSV."""
    images = {}
    with open(image_csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row.get('Name', '').strip()
            image_url = row.get('Card Image URL', '').strip()
            if name and image_url:
                # Make the URL absolute
                if image_url.startswith('/'):
                    image_url = f"https://riftdecks.com{image_url}"
                images[name] = image_url
    return images

def main():
    csv_path = '/home/ubuntu/RBv/RiftboundCardData  - All Current Card Data.csv'
    images_csv_path = '/home/ubuntu/RBv/RiftboundCardData_Images.csv'
    output_path = '/home/ubuntu/RBv/riftbound_data_expert.json'
    
    # Load images
    print("Loading image URLs...")
    images = load_images(images_csv_path)
    print(f"Loaded {len(images)} image URLs")
    
    # Parse card data
    print("Parsing card data from CSV...")
    cards = []
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            card = parse_csv_row(row)
            if card:
                # Add image URL if available
                if card['name'] in images:
                    card['image_url'] = images[card['name']]
                cards.append(card)
    
    print(f"Parsed {len(cards)} cards")
    
    # Write output
    print(f"Writing to {output_path}...")
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(cards, f, indent=2, ensure_ascii=False)
    
    print("Done!")
    
    # Print some stats
    domains = {}
    types = {}
    for card in cards:
        d = card.get('domain', 'Unknown')
        t = card.get('type_line', '').split(' - ')[0]
        domains[d] = domains.get(d, 0) + 1
        types[t] = types.get(t, 0) + 1
    
    print("\nDomain distribution:")
    for d, count in sorted(domains.items()):
        print(f"  {d}: {count}")
    
    print("\nType distribution:")
    for t, count in sorted(types.items()):
        print(f"  {t}: {count}")

if __name__ == '__main__':
    main()
