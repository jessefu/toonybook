import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  account,
  aiTask,
  apikey,
  chat,
  chatMessage,
  credit,
  inviteCode,
  post,
  session,
  subscription,
  taxonomy,
  ticket,
  ticketMessage,
  user,
  userInvite,
  userRole,
  verification,
} from '@/config/db/schema';
import { deleteUserStorybooks } from '@/modules/storybook/service';
import { getUuid } from '@/lib/hash';

/**
 * Account deletion.
 *
 * A feature module orchestrating the shared services it is built on: it asks
 * `storybook/` to release the user's books and their stored objects, then clears
 * the user's own rows. Same shape as `storybook/service.ts` — see the module
 * dependency notes in AGENTS.md.
 *
 * ## Why the user row survives
 *
 * Deleting it would cascade straight through `order` and `subscription`, and
 * those are billing records we have to keep: tax and accounting rules require
 * them, and every dispute or refund a payment provider raises is settled by
 * looking one up. So the account is **anonymized** instead — every trace of the
 * person is removed or overwritten, the row that orders point at stays:
 *
 * - the email is replaced with one that cannot be reached or re-registered over,
 *   which frees the original address for a fresh sign-up;
 * - the name, avatar, IP and UTM source are cleared;
 * - the credentials (`account`), sessions, roles, credits, books, support
 *   threads and API keys are deleted outright.
 *
 * The result is indistinguishable from a deleted account in every way that
 * matters to the user, and honest in the privacy policy: see the "How long we
 * keep it" section there.
 */

/** Everything the address of a deleted account ends with. */
const DELETED_EMAIL_DOMAIN = 'deleted.invalid';

/** What a deleted account's name is replaced with. */
export const DELETED_USER_NAME = 'Deleted user';

export function isDeletedAccountEmail(email?: string | null): boolean {
  return Boolean(email?.toLowerCase().endsWith(`@${DELETED_EMAIL_DOMAIN}`));
}

/**
 * Subscription states that still renew on their own.
 *
 * Matches what the Billing page offers a Cancel button for (`isCancellable`),
 * because "can still be cancelled" and "is still going to charge you" are the
 * same set. `pending_cancel` is deliberately not here: that subscription is
 * already on its way out, and blocking deletion on it would trap a user who has
 * done everything right.
 */
const RENEWING_SUBSCRIPTION_STATUSES = ['active', 'trialing'];

export type DeleteAccountFailure =
  | 'not_found'
  | 'already_deleted'
  | 'email_mismatch'
  /** Still renewing — must be cancelled from Billing first. */
  | 'active_subscription';

export type DeleteAccountResult =
  | { ok: true; booksDeleted: number }
  | { ok: false; reason: DeleteAccountFailure };

/**
 * Delete a user's account and everything personal in it.
 *
 * `confirmEmail` must match the account's own address: the UI asks the user to
 * type it, and re-checking it here means a stray or replayed request cannot
 * destroy an account on the strength of a session cookie alone.
 */
export async function deleteAccount(params: {
  userId: string;
  confirmEmail: string;
}): Promise<DeleteAccountResult> {
  const [existing] = await db()
    .select({
      id: user.id,
      email: user.email,
    })
    .from(user)
    .where(eq(user.id, params.userId));

  if (!existing) return { ok: false, reason: 'not_found' };
  if (isDeletedAccountEmail(existing.email)) {
    return { ok: false, reason: 'already_deleted' };
  }

  const typed = params.confirmEmail.trim().toLowerCase();
  if (!typed || typed !== existing.email.trim().toLowerCase()) {
    return { ok: false, reason: 'email_mismatch' };
  }

  // Refuse while a subscription can still renew. Cancelling is a click in
  // Billing and keeps the access they already paid for; deleting first would
  // take their money and their account in the same breath.
  const renewing = await db()
    .select({ id: subscription.id })
    .from(subscription)
    .where(
      and(
        eq(subscription.userId, params.userId),
        inArray(subscription.status, [...RENEWING_SUBSCRIPTION_STATUSES])
      )
    );

  if (renewing.length > 0) {
    return { ok: false, reason: 'active_subscription' };
  }

  // 1. Books first: this is the only step that has to reach into storage, and
  //    it needs the rows to still exist to know which objects to release.
  const booksDeleted = await deleteUserStorybooks(params.userId);

  // 2. The user's own rows. Ordered so nothing references a row that is gone
  //    (ticket messages before tickets), and scoped by userId at every point —
  //    a wrong id here deletes someone else's data.
  await db()
    .delete(ticketMessage)
    .where(eq(ticketMessage.userId, params.userId));
  await db().delete(ticket).where(eq(ticket.userId, params.userId));
  await db().delete(chatMessage).where(eq(chatMessage.userId, params.userId));
  await db().delete(chat).where(eq(chat.userId, params.userId));
  await db().delete(apikey).where(eq(apikey.userId, params.userId));
  await db().delete(credit).where(eq(credit.userId, params.userId));
  await db().delete(userInvite).where(eq(userInvite.userId, params.userId));
  await db().delete(userRole).where(eq(userRole.userId, params.userId));
  await db().delete(post).where(eq(post.userId, params.userId));
  await db().delete(taxonomy).where(eq(taxonomy.userId, params.userId));
  // Anything else attached to the account, including non-storybook AI tasks
  // (their objects are not persisted anywhere we can reach, so the rows are all
  // there is to delete).
  await db().delete(aiTask).where(eq(aiTask.userId, params.userId));

  // 3. Sign-in. Deleting the credentials is what makes the account unusable
  //    even though the row stays.
  await db().delete(session).where(eq(session.userId, params.userId));
  await db().delete(account).where(eq(account.userId, params.userId));
  await db()
    .delete(verification)
    .where(eq(verification.identifier, existing.email));

  // 4. Anonymize what is left. Invite codes this user created are kept (other
  //    people may still be using them) with the author detached.
  await db()
    .update(inviteCode)
    .set({ createdBy: null })
    .where(eq(inviteCode.createdBy, params.userId));

  await db()
    .update(user)
    .set({
      email: `deleted+${getUuid()}@${DELETED_EMAIL_DOMAIN}`,
      name: DELETED_USER_NAME,
      image: null,
      emailVerified: false,
      ip: '',
      utmSource: '',
    })
    .where(eq(user.id, params.userId));

  return { ok: true, booksDeleted };
}
