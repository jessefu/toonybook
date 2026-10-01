import fontkit from '@pdf-lib/fontkit';
import * as jpegNs from 'jpeg-js';
import {
  PDFDocument,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFImage,
} from 'pdf-lib';
import * as upngNs from 'upng-js';

import { getAllConfigs } from '@/modules/config/service';
import { buildPublicUrl, persistFileBytes } from '@/modules/storage/service';

import type { StorybookLanguage, StorybookResult } from './service';

/**
 * Printable export: one A4 portrait page per scene, illustration on top and
 * its text below, so the result prints and binds as a physical picture book.
 *
 * Two font realities shape this module:
 *
 * 1. pdf-lib's built-in fonts are WinAnsi — they cannot encode a single CJK
 *    character (they throw). Chinese books therefore embed a real CJK font,
 *    subsetted so only the glyphs a given book uses are written into the file
 *    (a 10.5 MB font lands as an ~8 KB stream for a typical book).
 * 2. The illustration providers hand back ~1.6 MB PNGs. Embedded as-is, a
 *    12-page book would be a ~23 MB download, so PNGs are transcoded to JPEG
 *    (~480 KB, q82) — roughly 150 DPI across the A4 text block, which is what
 *    a home printer resolves anyway.
 */

// Both ship as UMD/CJS bundles whose types declare named exports only, so the
// interop shape is unwrapped by hand rather than with a default import.
const jpeg =
  (jpegNs as unknown as { default?: typeof jpegNs }).default ?? jpegNs;
const UPNG =
  (upngNs as unknown as { default?: typeof upngNs }).default ?? upngNs;

const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_HEIGHT = PAGE_HEIGHT - MARGIN * 2;

const TEXT_SIZE = 16;
const LINE_HEIGHT = 26;
const TITLE_SIZE = 30;
const TITLE_LINE_HEIGHT = 40;
const SUBTITLE_SIZE = 14;
/** Space between the illustration and the start of its text. */
const IMAGE_TEXT_GAP = 28;

const TEXT_COLOR = rgb(0.13, 0.13, 0.15);
const MUTED_COLOR = rgb(0.45, 0.45, 0.5);

const JPEG_QUALITY = 82;

/**
 * How many illustrations to download and transcode at once. The work is
 * network-bound, so a 12-page book finishes in fewer, larger waves; the
 * ceiling is memory — each in-flight image peaks around 9 MB (compressed
 * source + RGBA + RGB).
 */
const PREPARE_CONCURRENCY = 6;

// --- Font ------------------------------------------------------------------

/**
 * Cached in R2 once, then reused: fetching from the CDN on every export would
 * make each download wait on 10 MB. Falls back to the CDN when storage is not
 * configured (local dev), and the in-process cache covers repeated exports.
 */
const CJK_FONT_CACHE_KEY = 'assets/fonts/notosanssc-regular.ttf';
const GOOGLE_FONTS_CSS =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400';

/**
 * Google serves woff2 to modern clients but a plain TTF to legacy ones, and
 * `@pdf-lib/fontkit` cannot subset woff2. The exact string matters: the full
 * `Mozilla/4.0 (compatible; MSIE 6.0; ...)` UA gets routed to an extensionless
 * binary endpoint instead, so this deliberately stays at the bare token Google
 * maps to "serve the truetype file".
 *
 * Going through the CSS (rather than hardcoding a `fonts.gstatic.com` URL)
 * keeps working when Google bumps the font version.
 */
const LEGACY_UA = 'Mozilla/4.0';

const FETCH_TIMEOUT_MS = 120_000;

function looksLikeFont(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const magic =
    (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  // 0x00010000 TrueType, 'true', 'ttcf' collection, 'OTTO' CFF
  return (
    magic === 0x00010000 ||
    magic === 0x74727565 ||
    magic === 0x74746366 ||
    magic === 0x4f54544f
  );
}

/** Resolve a truetype URL for Noto Sans SC from Google's CSS API. */
async function resolveGoogleFontUrl(): Promise<string> {
  const resp = await fetch(GOOGLE_FONTS_CSS, {
    headers: { 'User-Agent': LEGACY_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`could not reach Google Fonts (${resp.status})`);
  }
  const css = await resp.text();
  // Google may declare several sources (woff2/woff/truetype); fontkit can only
  // subset the uncompressed ones, so pick by declared format first and fall
  // back to the file extension.
  const sources = [
    ...css.matchAll(/url\((https:\/\/[^)]+)\)\s*format\('([^']+)'\)/g),
  ];
  const chosen =
    sources.find(([, , format]) => /^(truetype|opentype)$/i.test(format)) ??
    sources.find(([, url]) => /\.(ttf|otf)$/i.test(url));
  if (!chosen) {
    throw new Error(
      'could not resolve a TTF URL for the CJK font — set "CJK Font URL" under admin → Settings → AI'
    );
  }
  return chosen[1];
}

async function downloadCjkFont(): Promise<Uint8Array> {
  const configs = await getAllConfigs();
  const configured = (configs.pdf_cjk_font_url as string | undefined)?.trim();

  // An explicitly configured URL is authoritative — a cached copy of the
  // default font must not shadow it, or switching fonts would appear to do
  // nothing until the cache entry was cleared by hand.
  if (!configured) {
    try {
      const cached = await buildPublicUrl(CJK_FONT_CACHE_KEY);
      const resp = await fetch(cached, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.ok) {
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (looksLikeFont(bytes)) return bytes;
      }
    } catch {
      // Not cached yet, or storage is not configured — fall through to the CDN.
    }
  }

  const fontUrl = configured || (await resolveGoogleFontUrl());
  const resp = await fetch(fontUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`CJK font download failed: ${resp.status}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (!looksLikeFont(bytes)) {
    throw new Error(
      `the CJK font URL did not return a font file: ${fontUrl.slice(0, 120)}`
    );
  }

  // Only the default source is cached, so a custom font never lands under the
  // default key. Best-effort either way: a failed cache write costs one
  // re-download, which must not fail the export the user is waiting on.
  if (!configured) {
    try {
      await persistFileBytes({
        body: bytes,
        key: CJK_FONT_CACHE_KEY,
        contentType: 'font/ttf',
      });
    } catch {
      // ignore
    }
  }
  return bytes;
}

let cjkFontPromise: Promise<Uint8Array> | null = null;

/**
 * Shared in-process cache. Concurrent exports must not each pull 10 MB, and a
 * failed fetch must not be remembered — hence clearing the promise on error.
 */
function getCjkFont(): Promise<Uint8Array> {
  if (!cjkFontPromise) {
    cjkFontPromise = downloadCjkFont().catch((error) => {
      cjkFontPromise = null;
      throw error;
    });
  }
  return cjkFontPromise;
}

// --- Line wrapping ---------------------------------------------------------

/**
 * Characters that may not begin a line (closing punctuation / trailing marks).
 * When one would land at the head of a line it is allowed to hang past the
 * margin instead, which is the normal convention in Chinese typesetting.
 */
const NO_LINE_START = '。，、！？：；）】」』》〉·…—～!?,.:;)]}%';
/** Characters that may not end a line (opening punctuation). */
const NO_LINE_END = '（【「『《〈([{';

/**
 * Wrap CJK text, which has no spaces to break on: fill a line character by
 * character, then repair the break so punctuation stays legal.
 */
function wrapCjk(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  let chars: string[] = [];
  let width = 0;

  const widthOf = (s: string) => font.widthOfTextAtSize(s, size);
  const flush = () => {
    if (chars.length) lines.push(chars.join('').trimEnd());
    chars = [];
    width = 0;
  };

  for (const ch of text) {
    if (ch === '\n') {
      flush();
      continue;
    }
    if (!chars.length && ch === ' ') continue;

    const w = widthOf(ch);
    if (chars.length && width + w > maxWidth) {
      if (NO_LINE_START.includes(ch)) {
        // Hang the closing mark, then break.
        chars.push(ch);
        flush();
        continue;
      }
      // Never leave an opening bracket stranded at the end of a line.
      const carry: string[] = [];
      while (chars.length && NO_LINE_END.includes(chars[chars.length - 1])) {
        carry.unshift(chars.pop() as string);
      }
      flush();
      chars = [...carry, ch];
      width = widthOf(chars.join(''));
      continue;
    }
    chars.push(ch);
    width += w;
  }
  flush();
  return lines;
}

/** Wrap on spaces, keeping a long unbreakable word on its own line. */
function wrapWords(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    // An empty paragraph must not become a line — a wordless page has no text
    // at all, and a phantom line would reserve 26pt of blank space under the
    // illustration. `wrapCjk` already behaves this way.
    if (line) lines.push(line);
  }
  return lines;
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  language: StorybookLanguage
): string[] {
  return language === 'zh'
    ? wrapCjk(text, font, size, maxWidth)
    : wrapWords(text, font, size, maxWidth);
}

// --- Images ----------------------------------------------------------------

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

/**
 * PNG → JPEG. JPEG has no alpha channel, so transparent pixels are composited
 * onto white — a transparent PNG would otherwise come out with black fringes.
 *
 * The buffer handed to `jpeg-js` must be **RGBA**, not RGB: its encoder indexes
 * every row with `quadWidth = width * 4` regardless of the data it was given
 * (`lib/encoder.js`), so a 3-bytes-per-pixel buffer makes each row start one
 * quarter of a row further along than the last — the illustration comes out
 * sheared, tiled sideways, and leaking memory past its end.
 */
function pngToJpeg(png: Uint8Array): Uint8Array {
  const decoded = UPNG.decode(toArrayBuffer(png));
  const rgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
  const pixels = decoded.width * decoded.height;

  for (let i = 0; i < pixels; i++) {
    const src = i * 4;
    const alpha = rgba[src + 3];
    if (alpha !== 255) {
      const a = alpha / 255;
      rgba[src] = Math.round(rgba[src] * a + 255 * (1 - a));
      rgba[src + 1] = Math.round(rgba[src + 1] * a + 255 * (1 - a));
      rgba[src + 2] = Math.round(rgba[src + 2] * a + 255 * (1 - a));
      rgba[src + 3] = 255;
    }
  }

  return jpeg.encode(
    { data: rgba, width: decoded.width, height: decoded.height },
    JPEG_QUALITY
  ).data;
}

/**
 * Fetch an illustration as JPEG bytes, ready to embed.
 *
 * The format is decided by magic bytes, never by the URL or the stored
 * content-type: the AI providers label every result `image/png` and the
 * storage key follows that label, so a file named `.png` may well be a JPEG.
 *
 * One retry, because a provider CDN connection stalls every so often — measured
 * on Kie's temp host, the same object that hung past two minutes came back in
 * three seconds on the next attempt. Assembly reads every illustration from the
 * provider, so a single stalled page would otherwise cost the whole book.
 */
async function fetchImageBytes(url: string): Promise<Uint8Array> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        throw new Error(`illustration download failed: ${resp.status}`);
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());

      if (isJpeg(bytes)) return bytes;
      if (isPng(bytes)) return pngToJpeg(bytes);
      throw new Error('illustration is neither PNG nor JPEG');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/** Bounded-concurrency map — 13 sequential round trips would crawl. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

// --- Layout ----------------------------------------------------------------

/** Fit a square-ish illustration into a box without distorting it. */
function fitImage(
  image: PDFImage,
  boxWidth: number,
  boxHeight: number
): { width: number; height: number } {
  const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

function drawCentered(
  page: ReturnType<PDFDocument['addPage']>,
  text: string,
  font: PDFFont,
  size: number,
  y: number,
  color = TEXT_COLOR
) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: MARGIN + Math.max(0, (CONTENT_WIDTH - width) / 2),
    y,
    size,
    font,
    color,
  });
}

/**
 * Build the printable book.
 *
 * `book` is the value `getStorybook()` returns, so callers do not need to
 * reshape anything; pages are ordered cover first.
 */
export async function buildStorybookPdf(
  result: StorybookResult
): Promise<Uint8Array<ArrayBuffer>> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const { language } = result;

  // English books read fine in a built-in serif, which keeps the export free
  // of a 10 MB font download. Only CJK needs the embedded font.
  const needsCjk = language === 'zh';
  const cjkFont = needsCjk
    ? await pdf.embedFont(await getCjkFont(), { subset: true })
    : null;
  const latinFont = await pdf.embedFont(StandardFonts.TimesRoman);
  const bodyFont = cjkFont ?? latinFont;

  const orderedUrls = [
    result.coverImageUrl,
    ...result.pages.map((p) => p.imageUrl),
  ];
  const imageBytes = await mapLimit(orderedUrls, PREPARE_CONCURRENCY, (url) =>
    fetchImageBytes(url)
  );
  const images = await Promise.all(
    imageBytes.map((bytes) => pdf.embedJpg(bytes))
  );
  const coverImage = images[0];
  const pageImages = images.slice(1);

  // --- Cover page ---
  const cover = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const titleLines = wrapText(
    result.title,
    bodyFont,
    TITLE_SIZE,
    CONTENT_WIDTH,
    language
  );
  // Keep the whole title block on the page: a pathological title would
  // otherwise push the cover box below the bottom margin and produce a
  // negative image size.
  const MAX_TITLE_LINES = 3;
  const shownTitle =
    titleLines.length > MAX_TITLE_LINES
      ? [
          ...titleLines.slice(0, MAX_TITLE_LINES - 1),
          `${titleLines[MAX_TITLE_LINES - 1]}…`,
        ]
      : titleLines;
  const subtitle = result.childName ?? '';

  let cursor = PAGE_HEIGHT - MARGIN;
  for (const line of shownTitle) {
    cursor -= TITLE_LINE_HEIGHT;
    drawCentered(cover, line, bodyFont, TITLE_SIZE, cursor);
  }
  if (subtitle) {
    cursor -= LINE_HEIGHT;
    drawCentered(cover, subtitle, bodyFont, SUBTITLE_SIZE, cursor, MUTED_COLOR);
  }

  const coverBoxTop = cursor - IMAGE_TEXT_GAP;
  const coverBoxHeight = Math.max(0, coverBoxTop - MARGIN);
  const coverSize = fitImage(coverImage, CONTENT_WIDTH, coverBoxHeight);
  if (coverSize.width > 0 && coverSize.height > 0) {
    cover.drawImage(coverImage, {
      x: MARGIN + (CONTENT_WIDTH - coverSize.width) / 2,
      y: coverBoxTop - coverSize.height,
      width: coverSize.width,
      height: coverSize.height,
    });
  }

  // --- Story pages ---
  result.pages.forEach((storyPage, index) => {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const image = pageImages[index];

    const lines = wrapText(
      storyPage.text,
      bodyFont,
      TEXT_SIZE,
      CONTENT_WIDTH,
      language
    );
    const textHeight = lines.length * LINE_HEIGHT;
    // A wordless page has no text at all, and the gap is only there to separate
    // the illustration from it. Counting it anyway would push the picture 14pt
    // above centre on a page that is otherwise one full-bleed image.
    const gap = textHeight > 0 ? IMAGE_TEXT_GAP : 0;
    // Clamped because a pathologically long page would otherwise hand
    // fitImage() a negative box and produce a negative image size. Pages the
    // story writer produces stay well clear of this.
    const imageBoxHeight = Math.max(0, CONTENT_HEIGHT - textHeight - gap);
    const size = fitImage(image, CONTENT_WIDTH, imageBoxHeight);

    // Centre the whole illustration + text block vertically.
    const blockHeight = size.height + gap + textHeight;
    const blockTop =
      MARGIN + CONTENT_HEIGHT - Math.max(0, (CONTENT_HEIGHT - blockHeight) / 2);

    if (size.width > 0 && size.height > 0) {
      page.drawImage(image, {
        x: MARGIN + (CONTENT_WIDTH - size.width) / 2,
        y: blockTop - size.height,
        width: size.width,
        height: size.height,
      });
    }

    let baseline = blockTop - size.height - gap - TEXT_SIZE;
    for (const line of lines) {
      drawCentered(page, line, bodyFont, TEXT_SIZE, baseline);
      baseline -= LINE_HEIGHT;
    }

    // Page numbers count story pages, not the cover.
    drawCentered(
      page,
      String(index + 1),
      latinFont,
      10,
      MARGIN / 2,
      MUTED_COLOR
    );
  });

  pdf.setTitle(result.title);
  pdf.setCreator('ShipAny');
  pdf.setCreationDate(new Date());

  // pdf-lib types save() as Uint8Array<ArrayBufferLike>; the bytes really do
  // live in a plain ArrayBuffer, which is what Response/Blob accept.
  return (await pdf.save()) as Uint8Array<ArrayBuffer>;
}

/**
 * Filenames for the download: `ascii` for the legacy `filename` parameter and
 * `utf8` for RFC 5987 `filename*`.
 *
 * Titles are AI-generated and may be Chinese, so the legacy parameter — which
 * is not allowed to carry non-ASCII — falls back to the task id rather than
 * emitting a mangled name on clients that ignore `filename*`.
 */
export function buildPdfFilename(
  result: StorybookResult,
  taskId: string
): { ascii: string; utf8: string } {
  const cleaned = result.title
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return {
    ascii: /^[\x20-\x7e]+$/.test(cleaned) ? cleaned : `storybook-${taskId}`,
    utf8: cleaned || `storybook-${taskId}`,
  };
}
