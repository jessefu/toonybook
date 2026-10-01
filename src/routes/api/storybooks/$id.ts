import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { deleteStorybook, getStorybook } from '@/modules/storybook/service';
import { respData, respErr } from '@/lib/resp';

async function GET({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized');

    const book = await getStorybook(params.id, session.user.id);
    if (!book) return respErr('Not found');
    return respData(book);
  } catch (error: any) {
    return respErr(error.message || 'Failed to get storybook');
  }
}

async function DELETE({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized');

    const ok = await deleteStorybook(params.id, session.user.id);
    if (!ok) return respErr('Not found');
    return respData({ deleted: true });
  } catch (error: any) {
    return respErr(error.message || 'Failed to delete storybook');
  }
}

export const Route = createFileRoute('/api/storybooks/$id')({
  server: {
    handlers: { GET, DELETE },
  },
});
