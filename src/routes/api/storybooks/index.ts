import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { getAuth } from '@/core/auth';
import { screenTextWithCreem } from '@/modules/moderation/creem';
import { moderateAll, ModerationError } from '@/modules/moderation/service';
import {
  listStorybooks,
  startStorybook,
  STORYBOOK_UPLOAD_KEY_PATTERN,
} from '@/modules/storybook/service';
import {
  ART_STYLES,
  DEFAULT_STORYBOOK_STYLE,
  MAX_STORY_PAGE_TEXT,
  MAX_STORY_SCENE_TEXT,
  STORYBOOK_MAX_PAGES,
  STORYBOOK_MIN_PAGES,
  STORYBOOK_STYLES,
} from '@/modules/storybook/styles';
import { getSnowId } from '@/lib/hash';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

import { creemMessage, moderationMessage } from './-moderation';

/** The story the user confirmed in `POST /api/storybooks/draft`. */
const storySchema = z.object({
  title: z.string().trim().max(120),
  pages: z
    .array(
      z.object({
        text: z.string().max(MAX_STORY_PAGE_TEXT),
        scene: z.string().max(MAX_STORY_SCENE_TEXT),
      })
    )
    .min(1)
    .max(STORYBOOK_MAX_PAGES),
});

const createSchema = z.object({
  idea: z.string().trim().min(3).max(500),
  story: storySchema.optional(),
  childName: z.string().trim().max(50).optional(),
  ageGroup: z.enum(['2-4', '5-7', '8-10']).default('5-7'),
  language: z.enum(['en', 'zh']).default('en'),
  style: z.enum(STORYBOOK_STYLES).default(DEFAULT_STORYBOOK_STYLE),
  // Optional with no default, unlike `style`: omitting it means "no illustration
  // style chosen", which falls through to the admin's `ai_image_style`. A
  // default here would quietly override the admin setting for every caller that
  // never knew about the picker.
  artStyle: z.enum(ART_STYLES).optional(),
  pageCount: z
    .number()
    .int()
    .min(STORYBOOK_MIN_PAGES)
    .max(STORYBOOK_MAX_PAGES)
    .optional(),
  // Keys, not URLs — the server resolves them against its own storage, so a
  // caller cannot aim the fetch at an arbitrary host. See modules/storybook.
  characters: z
    .array(
      z.object({
        key: z
          .string()
          .regex(STORYBOOK_UPLOAD_KEY_PATTERN, 'Invalid photo key'),
        name: z.string().trim().max(30).optional(),
      })
    )
    .max(6)
    .optional(),
});

async function GET({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized');

    const url = new URL(request.url);
    const page = Number(url.searchParams.get('page') || '1');
    const limit = Number(url.searchParams.get('limit') || '20');

    const items = await listStorybooks({
      userId: session.user.id,
      page,
      limit,
    });
    return respData({ items });
  } catch (error: any) {
    return respErr(error.message || 'Failed to list storybooks');
  }
}

async function POST({ request }: { request: Request }) {
  const limited = enforceMinIntervalRateLimit(request, {
    intervalMs: 5000,
    keyPrefix: 'storybook-create',
  });
  if (limited) return limited;

  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized');

    const body = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return respErr(parsed.error.issues[0]?.message || 'Invalid input');
    }

    // Content moderation runs in two passes, both before a single credit is
    // spent on illustrations — Creem asks for moderate, then debit, then
    // generate, and `startStorybook` below is the debit.
    //
    // The fields are gathered once so the two checks cannot drift apart. The
    // idea and the names come from the form; the story is the one the user just
    // read and could have edited by hand in the review step. The *illustration*
    // prompts are not screened: `startStorybook` composes them from this same
    // text. A story the model writes is caught by `assertStoryAllowed` in there,
    // which is the only other way text enters a book.
    const fields = [
      parsed.data.idea,
      parsed.data.childName,
      ...(parsed.data.characters ?? []).map((character) => character.name),
      parsed.data.story?.title,
      ...(parsed.data.story?.pages ?? []).flatMap((page) => [
        page.text,
        page.scene,
      ]),
    ];

    // Pass 1: the local word list. Free, instant and network-free, so it settles
    // the obvious cases without spending a Creem unit on a call whose verdict
    // could not change the outcome.
    const verdict = moderateAll(fields);
    if (!verdict.allowed) {
      console.warn('storybook rejected by moderation:', verdict.matches);
      return respErr(moderationMessage(verdict.category, request));
    }

    // Pass 2: Creem's Moderation API, which the merchant of record requires
    // before user text reaches a generation model. One call for the whole
    // payload rather than one per field — it is a single verdict either way.
    const externalId = `storybook-create:${session.user.id}:${getSnowId()}`;
    const screened = await screenTextWithCreem({
      prompt: fields.filter((field): field is string => !!field).join('\n\n'),
      externalId,
    });
    if (screened.kind === 'blocked') {
      console.warn('storybook rejected by creem moderation:', {
        externalId,
        decision: screened.decision,
      });
      return respErr(creemMessage('blocked', request));
    }
    if (screened.kind === 'unavailable') {
      // Fail closed: no decision out of Creem means no generation. Nothing has
      // been charged at this point, so the attempt is all the user loses.
      console.warn('storybook refused: creem moderation unavailable', {
        externalId,
        reason: screened.reason,
      });
      return respErr(creemMessage('unavailable', request));
    }

    // Returns as soon as the illustrations are queued — the book is finished
    // by the client's polling (see advanceStorybook).
    const task = await startStorybook({
      userId: session.user.id,
      ...parsed.data,
    });
    return respData(task);
  } catch (error: any) {
    // Thrown when the story the model wrote — rather than the one the user
    // typed — is what the filter refuses.
    if (error instanceof ModerationError) {
      console.warn('storybook refused by moderation:', error.category);
      return respErr(moderationMessage(error.category, request));
    }
    const message = error?.message || 'Failed to create storybook';
    if (message.toLowerCase().includes('insufficient')) {
      return respErr('Insufficient credits');
    }
    console.error('storybook generation failed:', error);
    return respErr(message);
  }
}

export const Route = createFileRoute('/api/storybooks/')({
  server: {
    handlers: { GET, POST },
  },
});
