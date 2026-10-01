/**
 * The story dimensions a book is created with: which narrative style the text
 * is written in, and how long the book is.
 *
 * **Client-safe by construction** — no `@/core/*`, no `@/core/db`, nothing
 * server-only. The storybook form and the reader both import this file to
 * render the style picker and to price a book, the same way
 * `modules/config/settings.ts` is imported by the admin settings page. The
 * prompt text those styles expand to lives in `./style-prompts`, which is
 * deliberately *not* reachable from the client bundle.
 */

export const STORYBOOK_STYLES = [
  'heartwarming',
  'whimsical',
  'humorous',
  'wordless',
  'educational',
  'philosophical',
] as const;

export type StorybookStyle = (typeof STORYBOOK_STYLES)[number];

export const DEFAULT_STORYBOOK_STYLE: StorybookStyle = 'heartwarming';

/**
 * Page counts are bounded by what can be illustrated in one run: every page is
 * an extra provider call, and 15 pages means 16 illustrations to queue, poll,
 * download and typeset.
 */
export const STORYBOOK_MIN_PAGES = 4;
export const STORYBOOK_MAX_PAGES = 15;
export const STORYBOOK_DEFAULT_PAGES = 8;

/**
 * Shared with the API schemas so the request validation and the service's own
 * truncation cannot drift apart — a book that passes validation but is silently
 * trimmed would look like the model ignored the brief.
 */
export const MAX_STORY_PAGE_TEXT = 2000;
export const MAX_STORY_SCENE_TEXT = 600;

/**
 * What a book costs: one credit per page. The cover is not charged.
 *
 * It was a flat 10 while every book was 8 pages, then `pageCount + 1` once the
 * length became the user's choice. The pricing page now sells credits as pages
 * ("15 credits — 15 illustrated pages"), and 15 credits has to buy a 15-page
 * book for that to be true, so the cover illustration is on us. It is one
 * provider call on the shortest book the form allows, which the credit packs
 * absorb comfortably.
 */
export function storybookCostCredits(pageCount: number): number {
  return clampStorybookPages(pageCount);
}

/** Clamp a client-supplied page count into the range we can actually draw. */
export function clampStorybookPages(pageCount?: number): number {
  return Math.max(
    STORYBOOK_MIN_PAGES,
    Math.min(pageCount ?? STORYBOOK_DEFAULT_PAGES, STORYBOOK_MAX_PAGES)
  );
}

/**
 * Styles whose book carries no narration at all.
 *
 * Kept here rather than as a flag on the prompt preset in `./style-prompts`
 * because the form needs the same answer — it warns the user before they spend
 * credits on a text-free book — and that file is server-only. One list, so the
 * warning cannot disagree with what the text model was actually told.
 */
export const WORDLESS_STORYBOOK_STYLES: readonly StorybookStyle[] = [
  'wordless',
];

export function isWordlessStyle(style: StorybookStyle): boolean {
  return WORDLESS_STORYBOOK_STYLES.includes(style);
}

/**
 * The illustration styles a book can be drawn in.
 *
 * A second, independent axis from the narrative style above: the same story can
 * be a woodcut or a collage. Only the ids live here — the prose they expand to
 * is in `./art-style-prompts`, for the same reason as the narrative prompts.
 */
export const ART_STYLES = [
  'watercolor',
  'collage',
  'pencil',
  'woodcut',
  'inkwash',
  'flat',
] as const;

export type ArtStyle = (typeof ART_STYLES)[number];

/**
 * Watercolour, because it is what `DEFAULT_ART_STYLE` already describes — a book
 * created without touching the picker should look like the books this app has
 * been making all along, not like a new default someone has to discover.
 */
export const DEFAULT_ART_STYLE_ID: ArtStyle = 'watercolor';
