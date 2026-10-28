import type { Deck } from '../api/types';

export interface DeckTreeRow {
  name: string;
  label: string;
  depth: number;
  deck?: Deck;
  children: Map<string, DeckTreeRow>;
}

// Missing parents in older imports are display-only groups, with no database writes.
export function visibleDeckRows(decks: Deck[], collapsed: ReadonlySet<string>): DeckTreeRow[] {
  const roots = new Map<string, DeckTreeRow>();
  for (const deck of decks) {
    let siblings = roots;
    const parts = deck.name.split('::');
    parts.forEach((label, depth) => {
      const name = parts.slice(0, depth + 1).join('::');
      let node = siblings.get(name);
      if (!node) {
        node = { name, label, depth, children: new Map() };
        siblings.set(name, node);
      }
      if (depth === parts.length - 1) node.deck = deck;
      siblings = node.children;
    });
  }
  const rows: DeckTreeRow[] = [];
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function visit(siblings: Map<string, DeckTreeRow>) {
    for (const node of [...siblings.values()].sort((a, b) => collator.compare(a.label, b.label) || a.name.localeCompare(b.name))) {
      rows.push(node);
      if (!collapsed.has(node.name)) visit(node.children);
    }
  }
  visit(roots);
  return rows;
}
