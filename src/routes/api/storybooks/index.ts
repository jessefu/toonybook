import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { getAuth } from '@/core/auth';
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
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

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

    // Returns as soon as the illustrations are queued — the book is finished
    // by the client's polling (see advanceStorybook).
    const task = await startStorybook({
      userId: session.user.id,
      ...parsed.data,
    });
    return respData(task);
  } catch (error: any) {
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
