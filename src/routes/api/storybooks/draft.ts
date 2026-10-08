import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { getAuth } from '@/core/auth';
import { moderateAll, ModerationError } from '@/modules/moderation/service';
import { draftStory } from '@/modules/storybook/service';
import {
  DEFAULT_STORYBOOK_STYLE,
  STORYBOOK_MAX_PAGES,
  STORYBOOK_MIN_PAGES,
  STORYBOOK_STYLES,
} from '@/modules/storybook/styles';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

import { moderationMessage } from './-moderation';

/**
 * Step 1 of the two-step flow: write the story text only.
 *
 * Free and non-committal — it creates no task and spends no credits, so the
 * user can regenerate the story as often as they like before paying for the
 * illustrations. The illustrations are step 2 (`POST /api/storybooks`).
 */
const draftSchema = z.object({
  idea: z.string().trim().min(3).max(500),
  childName: z.string().trim().max(50).optional(),
  characterNames: z.array(z.string().trim().max(30)).max(6).optional(),
  ageGroup: z.enum(['2-4', '5-7', '8-10']).default('5-7'),
  language: z.enum(['en', 'zh']).default('en'),
  style: z.enum(STORYBOOK_STYLES).default(DEFAULT_STORYBOOK_STYLE),
  pageCount: z
    .number()
    .int()
    .min(STORYBOOK_MIN_PAGES)
    .max(STORYBOOK_MAX_PAGES)
    .optional(),
});

async function POST({ request }: { request: Request }) {
  // This one costs an LLM call per request but no credits, so it needs the
  // tighter cap of the two endpoints.
  const limited = enforceMinIntervalRateLimit(request, {
    intervalMs: 3000,
    keyPrefix: 'storybook-draft',
  });
  if (limited) return limited;

  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized');

    const body = await request.json().catch(() => null);
    const parsed = draftSchema.safeParse(body);
    if (!parsed.success) {
      return respErr(parsed.error.issues[0]?.message || 'Invalid input');
    }

    // Content moderation, before anything else happens. The idea is the field
    // the user actually writes, but the names travel into the printed book too,
    // so they are checked with it.
    const verdict = moderateAll([
      parsed.data.idea,
      parsed.data.childName,
      ...(parsed.data.characterNames ?? []),
    ]);
    if (!verdict.allowed) {
      console.warn('storybook draft rejected by moderation:', verdict.matches);
      return respErr(moderationMessage(verdict.category, request));
    }

    const story = await draftStory(parsed.data);
    return respData(story);
  } catch (error: any) {
    // The model wrote something the filter refuses. The draft is free and
    // nothing has been stored, so there is nothing to roll back — just say why.
    if (error instanceof ModerationError) {
      console.warn('storybook draft refused by moderation:', error.category);
      return respErr(moderationMessage(error.category, request));
    }
    console.error('story draft failed:', error);
    return respErr(error?.message || 'Failed to write the story');
  }
}

export const Route = createFileRoute('/api/storybooks/draft')({
  server: {
    handlers: { POST },
  },
});
