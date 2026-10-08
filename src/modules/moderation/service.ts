import {
  ALLOWED_PHRASES,
  BLOCKED_FLAT,
  type ModerationCategory,
} from './words';

export type { ModerationCategory };

export type ModerationResult =
  | { allowed: true }
  | {
      allowed: false;
      category: ModerationCategory;
      /** The terms that matched. For logs — the user is told the category only. */
      matches: string[];
    };

/**
 * Raised when content moderation refuses a story, so a caller can answer with a
 * localized message instead of the raw text here.
 */
export class ModerationError extends Error {
  readonly category: ModerationCategory;

  constructor(category: ModerationCategory) {
    super(`content rejected by moderation: ${category}`);
    this.name = 'ModerationError';
    this.category = category;
  }
}

/** Full-width and leetspeak characters folded back to letters. */
const CHARACTER_FOLDS: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
  '+': 't',
  '|': 'i',
};

/**
 * Fold text down to the shape a term is matched against.
 *
 * Four separate evasions, all of them things a child could type by accident as
 * easily as an adult could on purpose:
 *
 * - **Width and form.** NFKC folds full-width Latin (`ｋｉｌｌ`) to ASCII;
 *   NFD + stripping combining marks folds accents (`séance` → `seance`).
 * - **Zero-width and bidi characters**, which render as nothing and would
 *   otherwise split a word in half.
 * - **Leetspeak** (`k1ll`, `@ss`).
 * - **Letter repetition** (`kiiiill`), which the matcher itself handles by
 *   letting every character repeat — see `buildMatcher`.
 *
 * Deliberately not handled: separators inside a word (`k.i.l.l`, `k i l l`).
 * Collapsing those would have to be undone for ordinary prose — "a boy" is one
 * space away from "aboy" — and the cost of getting it wrong is blocking every
 * sentence with a two-letter word in it. A filter that misses a determined
 * evader but never blocks an honest parent is the right trade here; the story
 * prompts carry their own child-safety contract behind this.
 */
function normalize(input: string): string {
  return (
    input
      .normalize('NFKC')
      // Zero-width, word-joiner and bidi control characters: invisible, and
      // they would otherwise split a word in half.
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[0-9@$!+|]/g, (char) => CHARACTER_FOLDS[char] ?? char)
  );
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex for one term, tolerant of the letter-doubling evasion and of hyphens
 * and spaces inside a multi-word phrase.
 *
 * Anchored at both ends for Latin script, which is what keeps a short term from
 * matching the middle of an innocent word. Chinese is matched as a plain
 * substring instead: it has no word boundaries to anchor to.
 */
function buildMatcher(term: string): RegExp | null {
  if (CJK_RE.test(term)) {
    const literal = escapeRegExp(term);
    return literal ? new RegExp(literal) : null;
  }
  const words = term
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      escapeRegExp(word)
        .split('')
        .map((char) => `${char}+`)
        .join('')
    );
  if (!words.length) return null;
  return new RegExp(`\\b${words.join('[\\s\\-_]*')}\\b`);
}

const MATCHERS: { term: string; category: ModerationCategory; re: RegExp }[] =
  BLOCKED_FLAT.flatMap(({ term, category }) => {
    // Normalized here too, not just the text being searched: a term written
    // with a capital (`傻B`) or with a full-width character would otherwise
    // never match the folded text it is compared against.
    const re = buildMatcher(normalize(term));
    return re ? [{ term, category, re }] : [];
  });

const ALLOWED_MATCHERS: { phrase: string; re: RegExp }[] = ALLOWED_PHRASES.map(
  (phrase) => ({
    phrase,
    // Global, so every occurrence is blanked rather than only the first.
    re: new RegExp(escapeRegExp(normalize(phrase)), 'g'),
  })
);

/**
 * Run one string through the filter.
 *
 * Cheap enough to call on every request — a few hundred precompiled regexes
 * against at most a few hundred characters — and it needs no provider, no key
 * and no network, which is what makes it always on rather than best effort.
 */
export function moderateText(input?: string | null): ModerationResult {
  if (!input) return { allowed: true };

  let text = normalize(input);
  for (const { re } of ALLOWED_MATCHERS) {
    text = text.replace(re, ' ');
  }

  const matches: string[] = [];
  // The longest matching term decides the category. Both because it is the more
  // specific one — `suicide` says more than the `kill` inside it — and because
  // the Chinese single characters ("杀") are inside their own compounds
  // ("自杀"), where the compound's category is the one worth telling the user.
  let best: { term: string; category: ModerationCategory } | null = null;
  for (const matcher of MATCHERS) {
    if (matcher.re.test(text)) {
      matches.push(matcher.term);
      if (!best || matcher.term.length > best.term.length) {
        best = { term: matcher.term, category: matcher.category };
      }
    }
  }

  if (!best) return { allowed: true };
  return { allowed: false, category: best.category, matches };
}

/**
 * Run several fields as one piece of content, reporting the first category that
 * trips.
 *
 * Used for the fields a user types that all end up printed in the book — the
 * idea, the child's name, the character names — and for the story text itself,
 * page by page.
 */
export function moderateAll(
  fields: (string | null | undefined)[]
): ModerationResult {
  const matches: string[] = [];
  for (const field of fields) {
    const verdict = moderateText(field);
    if (!verdict.allowed) {
      matches.push(...verdict.matches);
      return { allowed: false, category: verdict.category, matches };
    }
  }
  return { allowed: true };
}
