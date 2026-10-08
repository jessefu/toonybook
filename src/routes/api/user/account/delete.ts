import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { deleteAccount } from '@/modules/account/service';
import { respData, respErr } from '@/lib/resp';

/**
 * Delete the signed-in user's account.
 *
 * The failure reasons are returned as short machine-readable strings rather
 * than sentences: the dialog has to answer with localized copy, and the
 * "you still have a subscription" case needs a link to Billing next to it,
 * neither of which fits through `respErr`'s message field.
 */
async function POST({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized');

    const body = await request.json().catch(() => ({}));
    const email = typeof body?.email === 'string' ? body.email : '';

    const result = await deleteAccount({
      userId: session.user.id,
      confirmEmail: email,
    });

    if (!result.ok) return respErr(result.reason);

    return respData({ booksDeleted: result.booksDeleted });
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

export const Route = createFileRoute('/api/user/account/delete')({
  server: {
    handlers: { POST },
  },
});
