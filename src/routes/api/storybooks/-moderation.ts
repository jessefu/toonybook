import type { ModerationCategory } from '@/modules/moderation/service';
import {
  getCookieFromHeader,
  guessLocaleFromAcceptLanguage,
} from '@/lib/cookie';
import { m } from '@/paraglide/messages.js';
import { baseLocale, getLocale, locales } from '@/paraglide/runtime.js';

/**
 * The sentence a user sees when content moderation refuses their story.
 *
 * Static references (not `tDynamic`) so the messages stay tree-shakeable, and
 * resolved on the server so the client shows whatever `respErr` carried — the
 * storybook page toasts `error.message` as it comes.
 */
const MESSAGES = {
  sexual: m['moderation.sexual'],
  violence: m['moderation.violence'],
  self_harm: m['moderation.self_harm'],
  hate: m['moderation.hate'],
  substances: m['moderation.substances'],
  profanity: m['moderation.profanity'],
  other: m['moderation.other'],
} as const;

type Locale = (typeof locales)[number];

/** What `setLocale()` writes when the user picks a language. */
const LOCALE_COOKIE = 'PARAGLIDE_LOCALE';

function asLocale(value: string | undefined | null): Locale | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return (locales as readonly string[]).includes(normalized)
    ? (normalized as Locale)
    : null;
}

/**
 * Which language to answer in.
 *
 * Not plain `getLocale()`. API paths are never locale-prefixed (see the
 * `urlPatterns` in vite.config.ts), and server-side the middleware resolves a
 * path without a prefix to the base locale — so inside a route handler
 * `getLocale()` is always English, whatever the reader's language. For `/zh/…`
 * pages that never shows, because the URL carries the locale; for `/api/…` it
 * always would.
 *
 * So the language is taken from the two things a request actually carries: the
 * cookie `setLocale()` writes, and `Accept-Language`, which every browser sends
 * on its own. Falling back to the middleware's answer keeps this correct if an
 * API endpoint is ever reached through a localized URL.
 */
function requestLocale(request: Request): Locale {
  return (
    asLocale(
      getCookieFromHeader(request.headers.get('cookie'), LOCALE_COOKIE)
    ) ??
    asLocale(
      guessLocaleFromAcceptLanguage(
        request.headers.get('accept-language') ?? undefined
      )
    ) ??
    asLocale(getLocale()) ??
    (baseLocale as Locale)
  );
}

export function moderationMessage(
  category: ModerationCategory,
  request: Request
): string {
  const message = MESSAGES[category] ?? m['moderation.blocked'];
  return message({}, { locale: requestLocale(request) });
}
