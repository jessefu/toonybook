import type { ArtStyle, StorybookStyle } from '@/modules/storybook/styles';
import { m } from '@/paraglide/messages.js';

/**
 * Localised names and one-line descriptions for the six narrative styles.
 *
 * Static `m[...]` references rather than keys built from the id at runtime, so
 * the message compiler can still see (and tree-shake) every key. Colocated with
 * the two routes that need it — the create form and the reader — under the `-`
 * prefix convention for non-route files.
 *
 * Kept client-side on purpose: importing these from `@/modules/storybook/styles`
 * would be fine, but the prompt text lives next door in `style-prompts.ts` and
 * must never reach the browser.
 */
export const STORY_STYLE_LABELS: Record<StorybookStyle, () => string> = {
  heartwarming: m['settings.storybooks.style_heartwarming'],
  whimsical: m['settings.storybooks.style_whimsical'],
  humorous: m['settings.storybooks.style_humorous'],
  wordless: m['settings.storybooks.style_wordless'],
  educational: m['settings.storybooks.style_educational'],
  philosophical: m['settings.storybooks.style_philosophical'],
};

export const STORY_STYLE_DESCRIPTIONS: Record<StorybookStyle, () => string> = {
  heartwarming: m['settings.storybooks.style_heartwarming_desc'],
  whimsical: m['settings.storybooks.style_whimsical_desc'],
  humorous: m['settings.storybooks.style_humorous_desc'],
  wordless: m['settings.storybooks.style_wordless_desc'],
  educational: m['settings.storybooks.style_educational_desc'],
  philosophical: m['settings.storybooks.style_philosophical_desc'],
};

/**
 * Name for a style id that arrived from the API, which may be absent (books
 * created before styles existed) or, in principle, unrecognised. Returns null
 * rather than a placeholder so callers can drop the whole line.
 */
export function storybookStyleLabel(style?: string | null): string | null {
  const label = STORY_STYLE_LABELS[style as StorybookStyle];
  return label ? label() : null;
}

/**
 * The same, for the illustration styles — a separate axis, so a separate map.
 *
 * The labels are the medium's name in the reader's language; the prompt the
 * model sees is English regardless (see `modules/storybook/art-style-prompts`).
 */
export const ART_STYLE_LABELS: Record<ArtStyle, () => string> = {
  watercolor: m['settings.storybooks.art_watercolor'],
  collage: m['settings.storybooks.art_collage'],
  pencil: m['settings.storybooks.art_pencil'],
  woodcut: m['settings.storybooks.art_woodcut'],
  inkwash: m['settings.storybooks.art_inkwash'],
  flat: m['settings.storybooks.art_flat'],
};

export const ART_STYLE_DESCRIPTIONS: Record<ArtStyle, () => string> = {
  watercolor: m['settings.storybooks.art_watercolor_desc'],
  collage: m['settings.storybooks.art_collage_desc'],
  pencil: m['settings.storybooks.art_pencil_desc'],
  woodcut: m['settings.storybooks.art_woodcut_desc'],
  inkwash: m['settings.storybooks.art_inkwash_desc'],
  flat: m['settings.storybooks.art_flat_desc'],
};

/**
 * Null for books drawn before the picker existed — they carry no art style,
 * because the style they used was whatever the admin setting said at the time
 * and is not recoverable from the book.
 */
export function artStyleLabel(style?: string | null): string | null {
  const label = ART_STYLE_LABELS[style as ArtStyle];
  return label ? label() : null;
}
