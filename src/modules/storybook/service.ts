import { and, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import { aiTask } from '@/config/db/schema';
import {
  AITaskStatus,
  createTask,
  findTask,
  getTasks,
  updateTask,
  updateTaskInfo,
} from '@/modules/ai-tasks/service';
import {
  generateText,
  getImageEditModel,
  getImageModel,
  getTextModel,
  NO_IMAGE_EDIT_MODEL,
  NO_IMAGE_PROVIDER,
  pollImageJob,
  resolveImageProvider,
  resolveTextProvider,
  startImageJob,
  type ImageJobStatus,
  type ImageProviderKind,
} from '@/modules/ai/service';
import { getAllConfigs } from '@/modules/config/service';
import { moderateAll, ModerationError } from '@/modules/moderation/service';
import {
  copyStoredObject,
  deleteStoredObjects,
  deleteUploadedObjects,
  persistFileBytes,
} from '@/modules/storage/service';

import { ART_STYLE_CONTRACT, ART_STYLE_PRESETS } from './art-style-prompts';
import { buildStorybookPdf } from './pdf';
import {
  STORY_SAFETY_CONTRACT,
  STORYBOOK_STYLE_PRESETS,
} from './style-prompts';
import {
  clampStorybookPages,
  DEFAULT_STORYBOOK_STYLE,
  isWordlessStyle,
  MAX_STORY_PAGE_TEXT,
  MAX_STORY_SCENE_TEXT,
  storybookCostCredits,
  type ArtStyle,
  type StorybookStyle,
} from './styles';

export const STORYBOOK_MEDIA_TYPE = 'storybook';

/** A book whose images never finish is treated as failed so its credits come back. */
const STORYBOOK_TIMEOUT_MS = 15 * 60 * 1000;
/** Minimum gap between two polls of the same book — the list view polls every 5s. */
const POLL_THROTTLE_MS = 3_000;
/**
 * How many polls a single illustration may spend failing to be copied into our
 * storage. The provider's own copy stays available for days, and each poll
 * re-runs the download, so a run of bad luck costs patience rather than the
 * whole book. `STORYBOOK_TIMEOUT_MS` remains the hard backstop.
 */
const MAX_PERSIST_ATTEMPTS = 5;
/**
 * How many times the PDF may fail to assemble before the book is given up on.
 * Each attempt re-downloads every illustration from the provider — whose copy
 * stays up for days — so a couple of retries covers a flaky network without
 * leaving the user watching "generating" forever.
 */
const MAX_PDF_ATTEMPTS = 3;

export type StorybookAgeGroup = '2-4' | '5-7' | '8-10';
export type StorybookLanguage = 'en' | 'zh';

export interface StorybookPage {
  text: string;
  imageUrl: string;
}

export interface StorybookResult {
  title: string;
  childName?: string;
  ageGroup: StorybookAgeGroup;
  language: StorybookLanguage;
  pages: StorybookPage[];
  coverImageUrl: string;
  /**
   * The printable book, assembled once the last illustration lands and stored
   * as the book's durable artifact.
   *
   * Absent on books finished before the PDF became the export of record; the
   * download route rebuilds those on demand.
   */
  pdfUrl?: string;
  /** Storage key behind `pdfUrl` — kept so deleting the book can free it. */
  pdfKey?: string;
  /** Storage key of the retained cover image, for the same reason. */
  coverKey?: string;
  /** Which text provider actually wrote the story, so a silent fall back to
   * the built-in template is visible instead of being taken for a real story. */
  textProvider?: string;
  textModel?: string;
  /** The narrative style the text was written in. Absent on books created
   * before styles existed. */
  storyStyle?: StorybookStyle;
  /**
   * The illustration style the pages were drawn in.
   *
   * Optional rather than defaulted: books created before the picker existed
   * were drawn with whatever `ai_image_style` said at the time, and claiming
   * they are watercolours would be a guess.
   */
  artStyle?: ArtStyle;
  /** How many character photos the illustrations were based on. The photos
   * themselves are deleted once the book settles, so only the count survives. */
  characterCount?: number;
  createdAt: string;
}

interface LocalizedStoryPage {
  text: string;
  scene: string;
}

/**
 * A character photo, copied out of the shared uploads namespace into this
 * book's own prefix so it can be deleted with the book.
 */
export interface StorybookReference {
  /** `storybook/<taskId>/ref/<i>.<ext>` */
  key: string;
  /** Public URL handed to the image provider. */
  url: string;
  name?: string;
}

/**
 * One illustration. Slot 0 is the cover, 1..n map to `plan.pages[n-1]`.
 *
 * Only the cover is copied into our storage (`persist`); the rest are read
 * straight from the provider while the PDF is assembled and then left to
 * expire, so their URLs are the vendor's and their keys are absent.
 */
interface ImageSlot {
  slot: number;
  prompt: string;
  taskId: string;
  status: ImageJobStatus;
  url?: string;
  /** Storage key, once the illustration has been copied into our storage. */
  key?: string;
  error?: string;
  /** Polls spent failing to copy a finished illustration into storage. */
  persistAttempts?: number;
}

/** The subset of an `ImageJob` the poll loop actually consumes. */
interface ImageJobResult {
  status: ImageJobStatus;
  url?: string;
  key?: string;
  error?: string;
  /** Set when the illustration exists but could not be copied — see `ImageJob`. */
  retryable?: boolean;
}

/** Everything the poll loop needs to resume a book, persisted in `aiTask.taskInfo`. */
interface StorybookPlan {
  title: string;
  childName?: string;
  ageGroup: StorybookAgeGroup;
  language: StorybookLanguage;
  pages: LocalizedStoryPage[];
  imageProvider: ImageProviderKind;
  imageModel: string;
  /** Text provider/model that wrote `pages`, recorded at start time so the
   * finished book can report how its story was actually written. */
  textProvider?: string;
  textModel?: string;
  /** Narrative style the story was written in. */
  storyStyle?: StorybookStyle;
  /** Illustration style the pages are being drawn in. */
  artStyle?: ArtStyle;
  /** Character photos, kept so they can be deleted once the book settles.
   * Optional: plans written before character support have none. */
  references?: StorybookReference[];
  /**
   * The shared `uploads/` keys the character photos came from — the originals,
   * as uploaded, before this book got its own copies.
   *
   * Kept so a finished book can release them: uploads are content-addressed and
   * de-duplicated, so they were never deleted on the way in. Deleted once the
   * book settles (see `settleStorybook`) and if the book is deleted while it is
   * still generating — not on a failed start, where the user's next retry sends
   * the same keys again.
   */
  uploadKeys?: string[];
  slots: ImageSlot[];
  startedAt: number;
  /** Epoch ms before which another poll should be skipped. */
  nextPollAt: number;
  /** PDF assembly is a second, retryable step after the last illustration. */
  pdfStatus?: 'pending' | 'ready';
  pdfAttempts?: number;
  pdfError?: string;
  /** Set once the assembly has been uploaded, so a retry after a failed
   * `updateTask` reuses the stored file instead of rebuilding it. */
  pdfUrl?: string;
  pdfKey?: string;
}

/**
 * Last-resort illustration style, used only when a book was created without an
 * art style *and* admin → Settings → AI (`ai_image_style`) is blank.
 *
 * Books created through the form always carry one of `ART_STYLE_PRESETS`, so
 * this is the path for older books and for API callers that omit the field.
 * The admin setting still overrides it, as before.
 *
 * Deliberately says "semi-realistic proportions": the earlier wording
 * ("children picture book", "gentle", "soft pastel") pushed the image models
 * into chibi/Q-version figures with oversized heads, which reads as a cartoon
 * rather than an illustrated book.
 */
export const DEFAULT_ART_STYLE =
  'delicate watercolor storybook illustration, semi-realistic proportions, fine brush detail, soft natural light, muted elegant palette, no text, safe for children';

/**
 * Instructions that hold a character's likeness across pages.
 *
 * Reference images are positional, so the brief has to say which image is which
 * character by index — otherwise a two-child book swaps their faces between
 * pages.
 */
function characterBrief(references: StorybookReference[]): string {
  if (!references.length) return '';
  const roster = references
    .map((ref, i) => `image ${i + 1}${ref.name ? ` (${ref.name})` : ''}`)
    .join(', ');
  return (
    `The reference images are the real characters of this story: ${roster}. ` +
    'Redraw them in the illustration style, but keep each character’s face, hair, ' +
    'fur, colouring and body shape exactly as in their reference image, identically ' +
    'on every page. Do not invent or add characters.'
  );
}

/**
 * The prompt for one illustration: the page's scene, then how to draw it, then
 * the house rules, then the character brief.
 *
 * Order matters to the models — subject first keeps them from treating the style
 * words as the subject, and the character brief last keeps the likeness
 * instruction the most recent thing they read.
 */
function buildImagePrompt(
  scene: string,
  references: StorybookReference[],
  style: string = DEFAULT_ART_STYLE
): string {
  const brief = characterBrief(references);
  return `${scene}, ${style}, ${ART_STYLE_CONTRACT}${brief ? `. ${brief}` : ''}`;
}

const WORD_TARGETS: Record<StorybookAgeGroup, string> = {
  '2-4': 'one short simple sentence per page',
  '5-7': 'two or three easy sentences per page',
  '8-10': 'a short paragraph per page',
};

function parseJson<T>(raw: unknown): T | null {
  if (!raw) return null;
  try {
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
  } catch {
    return null;
  }
}

function extractJsonObject(raw: string): any {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('story text response is not JSON');
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

/** Write the story text with whichever LLM is configured; null when none is. */
async function writeStoryWithAI(params: {
  idea: string;
  childName?: string;
  characterNames: string[];
  ageGroup: StorybookAgeGroup;
  language: StorybookLanguage;
  style: StorybookStyle;
  pageCount: number;
}): Promise<{
  title: string;
  pages: LocalizedStoryPage[];
  textProvider: string;
  textModel: string;
} | null> {
  const {
    idea,
    childName,
    characterNames,
    ageGroup,
    language,
    style,
    pageCount,
  } = params;

  const langName = language === 'zh' ? 'Simplified Chinese' : 'English';
  const wordless = isWordlessStyle(style);

  // The style directive comes first and the house contract after it, so the
  // craft rules set the register before the format rules narrow it. The one
  // place they can collide is length — "a short paragraph per page" for 8-10
  // would flatten the philosophical and wordless styles — so the style is
  // stated to win.
  const system = [
    STORYBOOK_STYLE_PRESETS[style],
    // Safety comes immediately after the style, before the format rules: a
    // style says how the book reads, this says who it is for, and neither is
    // negotiable by the other.
    STORY_SAFETY_CONTRACT,
    `Write in ${langName}.`,
    wordless
      ? 'This is a wordless book: every page\'s "text" must be the empty string, and all of the storytelling moves into "scene".'
      : `Reading level: ages ${ageGroup} — ${WORD_TARGETS[ageGroup]}. Where the style above asks for something sparer, the style wins.`,
    'Return ONLY valid JSON: {"title": string, "pages": [{"text": string, "scene": string}]}.',
    '"scene" is a visual brief for an illustrator, written in English: who is in frame, the setting, the action, and the mood — specific enough to draw, and different on every page.',
    'Never describe what a character looks like — the illustrations are drawn from photographs, and a written description of them would fight the reference.',
  ].join(' ');

  const user = [
    `Story idea: ${idea}`,
    childName ? `The hero is a child named ${childName}.` : '',
    characterNames.length
      ? `The cast is: ${characterNames.join(', ')}. Use these names in the text and in every "scene", so the illustrator knows who appears on each page.`
      : '',
    `Write exactly ${pageCount} pages.`,
  ]
    .filter(Boolean)
    .join('\n');

  const generated = await generateText({
    system,
    user,
    jsonMode: true,
    maxTokens: 4096,
  });
  if (!generated) return null;

  const parsed = extractJsonObject(generated.text);
  if (!parsed.title || !Array.isArray(parsed.pages) || !parsed.pages.length) {
    throw new Error('story text JSON missing title/pages');
  }
  return {
    title: String(parsed.title).slice(0, 120),
    pages: parsed.pages.slice(0, pageCount).map((p: any) => ({
      // A caption on a wordless page is the model ignoring the brief rather
      // than adding value — it would print under an illustration that was
      // generated to carry the page on its own, so it is dropped.
      text: wordless ? '' : String(p.text ?? '').slice(0, MAX_STORY_PAGE_TEXT),
      scene: String(p.scene ?? parsed.title).slice(0, MAX_STORY_SCENE_TEXT),
    })),
    textProvider: generated.provider,
    textModel: generated.model,
  };
}

/**
 * Deterministic built-in story used when no LLM key is configured — keeps the
 * whole flow playable out of the box.
 *
 * Deliberately ignores the chosen style: these are fixed beats, not generated
 * prose, and the reader is already told the built-in template was used. It
 * carries one beat per supported page (15), so asking for the longest book
 * without an LLM configured still produces a whole book rather than a short one.
 */
function writeStoryOffline(params: {
  idea: string;
  childName?: string;
  characterNames?: string[];
  language: StorybookLanguage;
  pageCount: number;
}): { title: string; pages: LocalizedStoryPage[] } {
  const { idea, childName, characterNames, language, pageCount } = params;
  const hero =
    childName?.trim() ||
    characterNames?.find((n) => n?.trim())?.trim() ||
    (language === 'zh' ? '小主人公' : 'our little hero');
  const title =
    language === 'zh' ? `${hero}的奇妙冒险` : `${hero}'s Wonderful Adventure`;

  const beatsEn = [
    `One quiet evening, ${hero} had a big idea: ${idea}.`,
    `"Tomorrow," ${hero} whispered, "I will make it real."`,
    `So ${hero} packed a tiny bag with a snack, a flashlight, and a whole lot of courage.`,
    `The path began right outside the door, soft and quiet in the moonlight.`,
    `The first step felt wobbly. "What if I can't do it?" whispered a small worried voice.`,
    `Just then a friendly face appeared between the trees.`,
    `"I know that voice," said the friend. "I have one too."`,
    `So they walked on together — slowly, gently, one little step at a time.`,
    `They tripped. They laughed. They tried again.`,
    `The wind grew chilly, and the path grew steep.`,
    `"Hold my hand," said the friend. "We are almost there."`,
    `And just when the stars began to twinkle, the idea came true!`,
    `"We did it!" ${hero} cheered, feeling warm and proud inside.`,
    `They sat side by side and watched the sky turn slowly silver.`,
    `That night, ${hero} fell asleep smiling, dreaming of tomorrow's adventure. The end.`,
  ];
  const beatsZh = [
    `一个安静的夜晚，${hero}有了一个了不起的想法：${idea}。`,
    `"明天，"${hero}小声说，"我要把它变成真的。"`,
    `于是，${hero}收拾了一个小背包，装上点心、小手电，还有满满的勇气。`,
    `小路就从家门口开始，在月光下安安静静的。`,
    `第一步有点摇摇晃晃。"万一我做不到呢？"一个小小的声音担心地说。`,
    `就在这时，树影里出现了一张友好的面孔。`,
    `"这个声音我认得，"伙伴说，"我也有一个。"`,
    `于是他们一起往前走——慢慢地、轻轻地，一小步一小步地来。`,
    `他们绊了一跤。他们笑了。他们又试了一次。`,
    `风渐渐凉了，路也渐渐陡了。`,
    `"握住我的手，"伙伴说，"我们快到了。"`,
    `就在星星开始眨眼的时候，愿望实现啦！`,
    `"我们成功了！"${hero}欢呼着，心里暖暖的、甜甜的。`,
    `他们并排坐着，看天空一点一点变成银色。`,
    `那天晚上，${hero}带着微笑睡着了，梦里都是明天的冒险。完。`,
  ];
  const scenes = [
    'a child having a big idea under a starry evening sky, cozy bedroom window',
    'a child whispering to the moon from a bedroom window, warm lamp light',
    'a child packing a tiny backpack with a flashlight and a snack, warm bedroom',
    'an open cottage door with a moonlit path leading into a quiet meadow',
    'a child taking a first wobbly step on a forest path, soft moonlight',
    'a friendly small animal peeking out from between the trees, gentle forest',
    'a child and the small animal face to face, curious and friendly, forest clearing',
    'a child and the animal friend walking together along a winding path',
    'a child and the animal tumbling over a tree root, laughing, fireflies around',
    'wind bending tall grass on a steep hillside path, a child leaning into it',
    "the animal friend holding the child's hand on a steep path, warm glow",
    'a child and the animal celebrating under twinkling stars, wide night sky',
    'a child cheering with raised arms, proud and happy, night meadow',
    'a child and the animal sitting side by side under a silver night sky',
    'a child sleeping peacefully with a smile, teddy bear, moonlight through window',
  ];

  const beats = language === 'zh' ? beatsZh : beatsEn;
  const count = Math.max(1, Math.min(pageCount, beats.length));
  return {
    title,
    pages: beats.slice(0, count).map((text, i) => ({ text, scene: scenes[i] })),
  };
}

/** The story text, before any illustration exists. */
export interface StoryDraft {
  title: string;
  pages: { text: string; scene: string }[];
  /** How the text was written. `builtin` means no LLM is configured and the
   * fixed template was used — worth surfacing, because the two are otherwise
   * indistinguishable to a reader and a misconfigured model looks like a
   * working one. */
  textProvider?: string;
  textModel?: string;
  /** The style the text was written in, so the reader can say which one it was. */
  storyStyle?: StorybookStyle;
}

async function resolveStory(params: {
  idea: string;
  childName?: string;
  characterNames: string[];
  ageGroup: StorybookAgeGroup;
  language: StorybookLanguage;
  style: StorybookStyle;
  pageCount: number;
}): Promise<StoryDraft> {
  const generated = await writeStoryWithAI(params);
  if (generated) return { ...generated, storyStyle: params.style };
  return {
    ...writeStoryOffline(params),
    storyStyle: params.style,
    textProvider: 'builtin',
    textModel: '',
  };
}

/**
 * Refuse a story whose own words trip content moderation.
 *
 * Runs on text we did not write as well as text we did: the story a user
 * confirms has been through the review step, where every page's text and scene
 * can be edited by hand, and a model can also produce something its prompt did
 * not intend. Both end up printed in a child's book.
 */
function assertStoryAllowed(story: {
  title: string;
  pages: { text: string; scene: string }[];
}): void {
  // A wordless book has empty `text` on every page, so most of what there is to
  // read here is the scenes — which are also what the image model is told to
  // draw.
  const verdict = moderateAll([
    story.title,
    ...story.pages.flatMap((page) => [page.text, page.scene]),
  ]);
  if (!verdict.allowed) {
    console.warn('storybook text refused by moderation:', verdict.matches);
    throw new ModerationError(verdict.category);
  }
}

/**
 * Phase 1 of the two-step flow: write the text, and only the text.
 *
 * Deliberately free — no task row, no credits, no image provider call. The user
 * reviews the story before committing to the illustrations, which are the
 * expensive half and cannot be edited once drawn.
 */
export async function draftStory(params: {
  idea: string;
  childName?: string;
  characterNames?: string[];
  ageGroup: StorybookAgeGroup;
  language: StorybookLanguage;
  style?: StorybookStyle;
  pageCount?: number;
}): Promise<StoryDraft> {
  const story = await resolveStory({
    idea: params.idea,
    childName: params.childName,
    characterNames: params.characterNames ?? [],
    ageGroup: params.ageGroup,
    language: params.language,
    style: params.style ?? DEFAULT_STORYBOOK_STYLE,
    pageCount: clampStorybookPages(params.pageCount),
  });
  // The idea was checked before we got here; this catches the story the model
  // wrote from it, so the user hears about it at the free step rather than
  // after paying for illustrations.
  assertStoryAllowed(story);
  return story;
}

/** Clamp a client-supplied story to something we can actually illustrate. */
function normalizeStory(
  story: { title?: string; pages?: { text?: string; scene?: string }[] },
  pageCount: number
): StoryDraft {
  const pages = (story.pages ?? []).slice(0, pageCount).map((p) => ({
    text: String(p.text ?? '').slice(0, MAX_STORY_PAGE_TEXT),
    scene: String(p.scene ?? '').slice(0, MAX_STORY_SCENE_TEXT),
  }));
  if (!pages.length) throw new Error('story has no pages');
  return {
    title: String(story.title ?? '').slice(0, 120) || 'Story',
    pages,
  };
}

/**
 * A character photo as the API accepts it: a storage **key**, never a URL.
 *
 * The server fetches these itself, so accepting a caller-supplied URL would be
 * an SSRF hole — a key can only ever resolve inside our own bucket.
 */
export interface StorybookCharacterInput {
  key: string;
  name?: string;
}

/**
 * `<32 hex>.<ext>`, optionally under `uploads/`.
 *
 * `/api/storage/upload-image` returns the bare filename (R2Provider prepends
 * its own upload path), but its no-storage dev fallback returns the same name
 * already prefixed — accept both and normalize, so the failure a caller sees is
 * about the missing public domain rather than about the key's shape.
 */
export const STORYBOOK_UPLOAD_KEY_PATTERN =
  /^(?:uploads\/)?[a-f0-9]{32}\.[a-z0-9]{1,8}$/;

/** Canonicalize to the upload-path-relative key storage actually expects. */
function normalizeUploadKey(key: string): string {
  return key.replace(/^uploads\//, '');
}

/**
 * Copy each photo out of the shared `uploads/` namespace into this book's own
 * prefix.
 *
 * `uploads/` objects are content-addressed and deduplicated across users, so
 * they can never be deleted — copying first is what makes "delete the photos
 * when the book is done" safe, and it also means the URL we hand the provider
 * is one we built rather than one the caller sent.
 */
async function copyCharacterPhotos(
  characters: StorybookCharacterInput[],
  scope: string
): Promise<StorybookReference[]> {
  return Promise.all(
    characters.map(async (character, i) => {
      const from = normalizeUploadKey(character.key);
      const ext = from.split('.').pop() as string;
      const key = `${scope}/ref/${i}.${ext}`;
      return {
        key,
        url: await copyStoredObject({ fromKey: from, toKey: key }),
        name: character.name,
      };
    })
  );
}

/**
 * Start a storybook. Kicks off every illustration in parallel and returns as
 * soon as the provider jobs exist — the images are finished later by
 * `advanceStorybook()` as the client polls.
 *
 * The story is normally the one the user confirmed in `draftStory()`; when a
 * caller omits it, it is written here instead (the pre-two-step behaviour).
 */
export async function startStorybook(params: {
  userId: string;
  idea: string;
  story?: { title?: string; pages?: { text?: string; scene?: string }[] };
  childName?: string;
  ageGroup: StorybookAgeGroup;
  language: StorybookLanguage;
  style?: StorybookStyle;
  artStyle?: ArtStyle;
  pageCount?: number;
  characters?: StorybookCharacterInput[];
}) {
  const { userId, idea, childName, ageGroup, language } = params;
  const style = params.style ?? DEFAULT_STORYBOOK_STYLE;

  // Re-checked here, not just in the route schema: this is the value that
  // reaches the network, so it is the last place worth validating.
  const characters = (params.characters ?? []).filter((c) =>
    STORYBOOK_UPLOAD_KEY_PATTERN.test(c.key)
  );
  const pageCount = clampStorybookPages(
    params.pageCount ?? params.story?.pages?.length
  );

  const configs = await getAllConfigs();
  const textProvider = resolveTextProvider(configs);
  const imageProvider = resolveImageProvider(configs);
  const editModel = getImageEditModel(configs);

  // A picture book is nothing without its pictures, so refuse up front rather
  // than consume credits for a run that cannot succeed. Checked before
  // createTask() so nothing is charged.
  if (!imageProvider) {
    throw new Error(NO_IMAGE_PROVIDER);
  }

  // Photos with a text-to-image model would be accepted and then ignored, and
  // the result would look like the photos' fault. Refuse instead.
  if (characters.length && !editModel) {
    throw new Error(NO_IMAGE_EDIT_MODEL);
  }

  const imageModel = characters.length
    ? editModel
    : getImageModel(configs, imageProvider);

  // 1. Create the task + consume credits atomically (throws if insufficient).
  const task = await createTask({
    userId,
    mediaType: STORYBOOK_MEDIA_TYPE,
    provider: textProvider,
    model: getTextModel(configs, textProvider),
    prompt: idea,
    costCredits: storybookCostCredits(pageCount),
    options: {
      childName,
      ageGroup,
      language,
      storyStyle: style,
      // Left out entirely when the caller did not choose one, so the plan shows
      // "no style chosen" rather than an id that was never applied.
      ...(params.artStyle ? { artStyle: params.artStyle } : {}),
      pageCount,
      imageProvider,
      imageModel,
      characterCount: characters.length,
    },
  });

  await updateTask({ taskId: task.id, status: AITaskStatus.PROCESSING });

  const scope = `storybook/${task.id}`;
  let references: StorybookReference[] = [];

  try {
    // 2. Give the book its own copies of the character photos. Needs taskId, so
    //    it can only happen after createTask().
    references = await copyCharacterPhotos(characters, scope);

    // 3. Take the story the user confirmed, or write one if we weren't given it.
    //    A confirmed story was written by the configured model on the draft
    //    call, so it is recorded the same way as one written here.
    const story = params.story?.pages?.length
      ? {
          ...normalizeStory(params.story, pageCount),
          textProvider,
          textModel: getTextModel(configs, textProvider),
          storyStyle: style,
        }
      : await resolveStory({
          idea,
          childName,
          characterNames: characters
            .map((c) => c.name)
            .filter((n): n is string => Boolean(n)),
          ageGroup,
          language,
          style,
          pageCount,
        });

    // 3b. The last gate before the expensive half. `story` is either the text
    //     the user confirmed — which the review step lets them rewrite word by
    //     word — or the one just written here, and both get printed. Throwing
    //     settles the task as failed, which returns the credits.
    assertStoryAllowed(story);

    // 4. Fire off every illustration at once. Replicate/Fal/Kie only accept the
    //    job here; the actual waiting happens in advanceStorybook().
    const referenceImages = references.map((r) => r.url);
    // The chosen preset wins; admin (`ai_image_style`) and then
    // `DEFAULT_ART_STYLE` are the fallback for callers that omit one.
    const artStyle = params.artStyle
      ? ART_STYLE_PRESETS[params.artStyle]
      : (configs.ai_image_style as string | undefined)?.trim() ||
        DEFAULT_ART_STYLE;
    // No title in the cover prompt. It is the one string that is always in the
    // book's own language, so a Chinese title here invites the model to paint
    // Chinese lettering across the cover — the very thing the "no text" rule is
    // there to prevent. The title is set by the PDF from real text instead.
    const prompts = [
      `front cover illustration: ${story.pages[0]?.scene || idea}`,
      ...story.pages.map((p) => p.scene || story.title),
    ].map((scene) => buildImagePrompt(scene, references, artStyle));

    const jobs = await Promise.all(
      prompts.map((prompt, slot) =>
        startImageJob({
          prompt,
          scope,
          slot,
          model: imageModel,
          // The book's durable artifact is the PDF, so only the cover is worth
          // keeping a copy of — the library shows it on the card. Page
          // illustrations stay on the provider and are read once, when the PDF
          // is assembled, instead of being parked in storage forever.
          persist: slot === 0,
          ...(referenceImages.length ? { referenceImages } : {}),
        })
      )
    );

    const slots: ImageSlot[] = jobs.map((job, slot) => ({
      slot,
      prompt: prompts[slot],
      taskId: job.taskId,
      status: job.status,
      url: job.url,
      key: job.key,
      error: job.error,
    }));

    // A synchronous provider (Gemini) can already have failed a slot by now.
    const failed = slots.find((s) => s.status === 'failed');
    if (failed) {
      throw new Error(failed.error || 'illustration failed');
    }

    const plan: StorybookPlan = {
      title: story.title,
      childName,
      ageGroup,
      language,
      pages: story.pages,
      imageProvider,
      imageModel,
      textProvider: story.textProvider,
      textModel: story.textModel,
      storyStyle: story.storyStyle ?? style,
      artStyle: params.artStyle,
      references,
      uploadKeys: characters.map((c) => c.key),
      slots,
      startedAt: Date.now(),
      nextPollAt: 0,
      pdfStatus: 'pending',
      pdfAttempts: 0,
    };

    await updateTaskInfo(task.id, plan as unknown as Record<string, any>);

    return { taskId: task.id, status: AITaskStatus.PROCESSING as string };
  } catch (error: any) {
    // The book never came to exist, so its copies of the photos have no reason
    // to outlive it either.
    await deleteStoredObjects(references.map((r) => r.key));
    // updateTask(FAILED) revokes the consumed credits automatically.
    await updateTask({
      taskId: task.id,
      status: AITaskStatus.FAILED,
      taskResult: { error: error?.message || 'generation failed' },
    });
    throw error;
  }
}

/**
 * Move a book forward: poll the outstanding provider jobs, and once every page
 * has an illustration, assemble the printable PDF that is the book's durable
 * artifact.
 *
 * Safe to call concurrently and repeatedly — polling the same slot twice only
 * re-reads the same provider result, and re-assembling only rewrites the same
 * storage object.
 */
export async function advanceStorybook(taskId: string): Promise<void> {
  const task = await findTask(taskId);
  if (!task || task.status !== AITaskStatus.PROCESSING) return;

  const plan = parseJson<StorybookPlan>(task.taskInfo);
  if (!plan?.slots?.length) {
    // Task is PROCESSING but has no plan — either an older row or a start that
    // died mid-flight. Nothing to advance; the timeout below still settles it.
    if (
      Date.now() - new Date(task.createdAt).getTime() >
      STORYBOOK_TIMEOUT_MS
    ) {
      await failStorybook(taskId, 'generation timed out');
    }
    return;
  }

  const now = Date.now();
  if (now < (plan.nextPollAt || 0)) return;

  // Claim the slot before the (slow) provider round-trips so a concurrent
  // request — the list poll and the detail poll overlap in practice — backs off.
  plan.nextPollAt = now + POLL_THROTTLE_MS;
  await updateTaskInfo(taskId, { nextPollAt: plan.nextPollAt });

  const scope = `storybook/${taskId}`;
  const pending = plan.slots.filter((s) => s.status === 'processing');

  const results = await Promise.all(
    pending.map(async (slot): Promise<ImageJobResult> => {
      try {
        return await pollImageJob({
          provider: plan.imageProvider,
          taskId: slot.taskId,
          scope,
          slot: slot.slot,
          model: plan.imageModel,
          // Must match how the job was started: the cover is copied into our
          // storage, the page illustrations are left on the provider.
          persist: slot.slot === 0,
        });
      } catch (error: any) {
        // A transient provider/network blip shouldn't kill the book — leave the
        // slot pending and let the timeout be the backstop.
        return { status: 'processing', error: error?.message as string };
      }
    })
  );

  pending.forEach((slot, i) => {
    const result = results[i];

    // The illustration is finished and still sitting on the provider's CDN —
    // only our copy of it failed. That is a transient condition, not a dead
    // generation, so leave the slot pending: the next poll re-downloads it.
    // Failing the book here would throw away a paid-for generation, and the
    // user's credits, over a network blip.
    if (result.status === 'failed' && result.retryable) {
      slot.persistAttempts = (slot.persistAttempts ?? 0) + 1;
      slot.error = result.error;
      if (slot.persistAttempts < MAX_PERSIST_ATTEMPTS) return;
    }

    slot.status = result.status;
    if (result.url) slot.url = result.url;
    if (result.key) slot.key = result.key;
    if (result.status === 'failed') {
      slot.error = result.error || 'generation failed';
    }
  });

  const failed = plan.slots.find((s) => s.status === 'failed');
  if (failed) {
    await failStorybook(taskId, failed.error || 'illustration failed', plan);
    return;
  }

  if (plan.slots.every((s) => s.status === 'success')) {
    await finalizeStorybook(taskId, plan);
    return;
  }

  if (now - plan.startedAt > STORYBOOK_TIMEOUT_MS) {
    await failStorybook(taskId, 'generation timed out', plan);
    return;
  }

  // Only persist when a slot actually moved — the claim above already stored
  // nextPollAt, so an uneventful poll costs a single write instead of two.
  if (results.some((r) => r.status !== 'processing')) {
    await updateTaskInfo(taskId, plan as unknown as Record<string, any>);
  }
}

/**
 * Assemble the printable PDF, then settle the book as successful.
 *
 * A separate step from the illustration loop because it is retryable and
 * comparatively slow: it re-reads every illustration from the provider and
 * uploads one file. The book stays PROCESSING until the PDF is actually stored,
 * so an assembly that is cut short — the runtime freezes the isolate once the
 * response that triggered this poll has been sent — is resumed by the next poll
 * rather than leaving a finished book with no export.
 */
async function finalizeStorybook(
  taskId: string,
  plan: StorybookPlan
): Promise<void> {
  const result: StorybookResult = {
    title: plan.title,
    childName: plan.childName,
    ageGroup: plan.ageGroup,
    language: plan.language,
    pages: plan.pages.map((page, i) => ({
      text: page.text,
      imageUrl: plan.slots[i + 1]?.url || '',
    })),
    coverImageUrl: plan.slots[0]?.url || '',
    coverKey: plan.slots[0]?.key,
    textProvider: plan.textProvider,
    textModel: plan.textModel,
    storyStyle: plan.storyStyle,
    artStyle: plan.artStyle,
    // The photos are gone by the time this is readable; only the count survives.
    characterCount: plan.references?.length || undefined,
    createdAt: new Date().toISOString(),
  };

  if (plan.pdfStatus !== 'ready') {
    const key = `storybook/${taskId}/book.pdf`;
    plan.pdfAttempts = (plan.pdfAttempts ?? 0) + 1;
    try {
      const bytes = await buildStorybookPdf(result);
      plan.pdfUrl = await persistFileBytes({
        body: bytes,
        key,
        contentType: 'application/pdf',
      });
      plan.pdfKey = key;
      plan.pdfStatus = 'ready';
      plan.pdfError = undefined;
    } catch (error: any) {
      const message = error?.message || 'failed to assemble the printable pdf';
      plan.pdfError = message;
      if (plan.pdfAttempts < MAX_PDF_ATTEMPTS) {
        // Leave the book PROCESSING; the next poll tries again.
        await updateTaskInfo(taskId, plan as unknown as Record<string, any>);
        return;
      }
      await failStorybook(taskId, message, plan);
      return;
    }
  }

  result.pdfUrl = plan.pdfUrl;
  result.pdfKey = plan.pdfKey;

  await deleteStoredObjects((plan.references ?? []).map((r) => r.key));
  // The book is finished, so the originals it was drawn from have done their
  // job: the illustrations are the artwork now, and the photos were only ever
  // lent to us to make them. Deliberately only on success — a failed book is
  // retried with the same upload keys, so `failStorybook` keeps them and they
  // go when the book is deleted.
  await deleteUploadedObjects(plan.uploadKeys ?? []);
  // Plan before result: if the second write is lost, the next poll reuses the
  // PDF already in storage instead of rebuilding it.
  await updateTaskInfo(taskId, plan as unknown as Record<string, any>);
  await updateTask({
    taskId,
    status: AITaskStatus.SUCCESS,
    taskResult: result,
  });
}

/**
 * Settle a book as failed and drop the character photos.
 *
 * The photos are deleted on this path too: the book does not exist, so there is
 * nothing left that needs them, and a failed run is exactly when the user is
 * most likely to have uploaded something they want gone.
 */
async function failStorybook(
  taskId: string,
  error: string,
  plan?: StorybookPlan | null
): Promise<void> {
  // Whatever this run did manage to put in storage goes with it: the character
  // photos, the retained cover, and a PDF that was uploaded before the final
  // write failed.
  await deleteStoredObjects(
    [
      ...(plan?.references ?? []).map((r) => r.key),
      ...(plan?.slots ?? []).map((s) => s.key),
      plan?.pdfKey,
    ].filter((key): key is string => Boolean(key))
  );
  await updateTask({
    taskId,
    status: AITaskStatus.FAILED,
    taskResult: { error },
  });
}

/**
 * Advance every book currently generating for this user, then list them.
 *
 * The advance is a write triggered by a read — a deliberate trade-off: it is
 * the only way to make progress that behaves identically on Node, Docker, and
 * Cloudflare Workers (no queue, and Workers freeze the isolate once the
 * response is sent). `POLL_THROTTLE_MS` keeps the cost bounded.
 */
export async function listStorybooks(params: {
  userId: string;
  page?: number;
  limit?: number;
}) {
  const tasks = await getTasks({
    userId: params.userId,
    mediaType: STORYBOOK_MEDIA_TYPE,
    page: params.page ?? 1,
    limit: params.limit ?? 20,
  });

  const inFlight = tasks.filter(
    (t: any) => t.status === AITaskStatus.PROCESSING
  );
  if (inFlight.length) {
    await Promise.all(
      inFlight.map((t: any) => advanceStorybook(t.id).catch(() => undefined))
    );
  }

  // Re-read so the rows we return reflect any status change just made.
  const rows = inFlight.length
    ? await getTasks({
        userId: params.userId,
        mediaType: STORYBOOK_MEDIA_TYPE,
        page: params.page ?? 1,
        limit: params.limit ?? 20,
      })
    : tasks;

  return rows.map((t: any) => {
    const result = parseJson<StorybookResult>(t.taskResult);
    const valid = result && result.title ? result : null;
    const plan = parseJson<StorybookPlan>(t.taskInfo);
    return {
      id: t.id,
      status: t.status,
      prompt: t.prompt,
      costCredits: t.costCredits,
      createdAt: t.createdAt,
      title: valid?.title ?? null,
      coverImageUrl: valid?.coverImageUrl ?? null,
      textProvider: plan?.textProvider ?? null,
      textModel: plan?.textModel ?? null,
      storyStyle: plan?.storyStyle ?? null,
      artStyle: plan?.artStyle ?? null,
      pageCount: valid?.pages.length ?? 0,
      language: valid?.language ?? null,
      progressDone:
        plan?.slots?.filter((s) => s.status === 'success').length ?? 0,
      progressTotal: plan?.slots?.length ?? 0,
      error:
        t.status === AITaskStatus.FAILED
          ? parseJson<{ error?: string }>(t.taskResult)?.error ||
            'generation failed'
          : null,
    };
  });
}

export async function getStorybook(taskId: string, userId: string) {
  const task = await findTask(taskId);
  if (
    !task ||
    task.userId !== userId ||
    task.mediaType !== STORYBOOK_MEDIA_TYPE ||
    // Deleting is a soft delete, and `findTask` does not filter — without this
    // a deleted book stays readable by URL, and downloadable as a PDF, long
    // after it left the library.
    task.deletedAt
  ) {
    return null;
  }

  if (task.status === AITaskStatus.PROCESSING) {
    await advanceStorybook(taskId).catch(() => undefined);
  }

  const fresh =
    task.status === AITaskStatus.PROCESSING ? await findTask(taskId) : task;
  if (!fresh) return null;

  const parsed = parseJson<StorybookResult>(fresh.taskResult);
  const result = parsed && parsed.title ? parsed : null;
  const plan = parseJson<StorybookPlan>(fresh.taskInfo);

  return {
    id: fresh.id,
    status: fresh.status,
    prompt: fresh.prompt,
    createdAt: fresh.createdAt,
    result,
    progress: {
      done: plan?.slots?.filter((s) => s.status === 'success').length ?? 0,
      total: plan?.slots?.length ?? 0,
    },
  };
}

/**
 * Release every stored object a book owns: its illustrations, cover, PDF, the
 * copies of the character photos it was drawn from, and — since uploads are
 * content-addressed and never deleted on the way in — those originals too.
 *
 * Shared by the library delete (which keeps the row) and account deletion
 * (which does not), so a book's storage is released the same way either way.
 */
async function releaseStorybookObjects(task: typeof aiTask.$inferSelect) {
  const result = parseJson<StorybookResult>(task.taskResult);
  const plan = parseJson<StorybookPlan>(task.taskInfo);
  await deleteStoredObjects(
    [
      result?.pdfKey,
      result?.coverKey,
      // A book released mid-generation has no result yet; its plan still knows
      // about the cover and any reference photos.
      ...(plan?.slots ?? []).map((s) => s.key),
      plan?.pdfKey,
      ...(plan?.references ?? []).map((r) => r.key),
    ].filter((key): key is string => Boolean(key))
  );
  // A book released before it settled never got to release the uploads it was
  // drawn from — this is the path a failed book's photos leave by.
  await deleteUploadedObjects(plan?.uploadKeys ?? []);
}

/**
 * Remove a book: hidden from the user's library (the row is kept, so the credit
 * ledger stays intact) and its stored objects released.
 *
 * Only the PDF and the cover image are ours to delete — the page illustrations
 * were never persisted. Books finished before that was true have neither key
 * recorded and simply keep the images they stored at the time.
 */
export async function deleteStorybook(taskId: string, userId: string) {
  const task = await findTask(taskId);
  if (
    !task ||
    task.userId !== userId ||
    task.mediaType !== STORYBOOK_MEDIA_TYPE
  ) {
    return false;
  }
  await db()
    .update(aiTask)
    .set({ deletedAt: new Date() })
    .where(eq(aiTask.id, taskId));

  await releaseStorybookObjects(task);
  return true;
}

/**
 * Delete everything a user owns, storage included, and report how many books
 * went.
 *
 * Hard delete rather than the library's soft delete: this runs when the account
 * itself is being deleted, where a row that says "this belonged to a user who
 * no longer exists" is exactly what must not be left behind.
 */
export async function deleteUserStorybooks(userId: string): Promise<number> {
  const tasks = await db()
    .select()
    .from(aiTask)
    .where(
      and(eq(aiTask.userId, userId), eq(aiTask.mediaType, STORYBOOK_MEDIA_TYPE))
    );

  for (const task of tasks) {
    await releaseStorybookObjects(task);
  }

  if (tasks.length) {
    await db()
      .delete(aiTask)
      .where(
        and(
          eq(aiTask.userId, userId),
          eq(aiTask.mediaType, STORYBOOK_MEDIA_TYPE)
        )
      );
  }
  return tasks.length;
}

/**
 * Keep a PDF that had to be assembled on demand, so only the first download of
 * a book finished before exports were stored pays for the rebuild.
 *
 * Best-effort by construction: the caller already holds the bytes it is about
 * to send, so a failed write costs one more rebuild and must never turn a
 * working download into an error.
 */
export async function rememberStorybookPdf(
  taskId: string,
  result: StorybookResult,
  bytes: Uint8Array
): Promise<void> {
  try {
    const key = `storybook/${taskId}/book.pdf`;
    const url = await persistFileBytes({
      body: bytes,
      key,
      contentType: 'application/pdf',
    });
    await updateTask({
      taskId,
      status: AITaskStatus.SUCCESS,
      taskResult: { ...result, pdfUrl: url, pdfKey: key },
    });
  } catch {
    // Ignored on purpose — see above.
  }
}
