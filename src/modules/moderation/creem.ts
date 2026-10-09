/**
 * Creem's Moderation API, assembled from the admin settings.
 *
 * Creem is the merchant of record for this product and requires every AI
 * image/video generator on its platform to screen user-supplied text *before*
 * generation — "no prompt reaches your model without a decision from the
 * Moderation API first". This is that screen.
 *
 * Deliberately a separate file from `./service.ts`. That module's whole value is
 * that it is a pure function over a word list — no provider, no key, no network
 * — which is what makes it impossible to be offline. This one needs all three,
 * so it lives beside it rather than inside it.
 *
 * @docs https://docs.creem.io/features/moderation
 */

import {
  createCreemProvider,
  CreemModerationDisabledError,
  CreemModerationError,
} from '@/core/payment/creem';
import { getAllConfigs } from '@/modules/config/service';

export type CreemScreenOutcome =
  /**
   * Proceed, un-screened by Creem. Either no API key is configured, or the store
   * has moderation switched off (`reason: 'disabled'`) — see the catch below for
   * why the latter is not treated as an outage.
   */
  | { kind: 'skipped'; reason?: 'disabled' }
  | { kind: 'allow' }
  /** Block. `flagged` is not a soft pass: Creem advises blocking it too. */
  | { kind: 'blocked'; decision: 'deny' | 'flag' }
  /** Block. No decision was reached, and the requirement is to fail closed. */
  | { kind: 'unavailable'; reason: 'network' | 'http' };

/**
 * Ask Creem whether `prompt` may go to a generation model.
 *
 * Returns an outcome rather than throwing. Every branch below is a decision the
 * caller has to make anyway, and a union makes the fail-closed policy visible at
 * the call site instead of buried in a `catch`.
 *
 * Fail-closed means: `blocked` and `unavailable` both stop the request. Only
 * `skipped` — no key at all — lets it through, because Creem is optional in this
 * template and a self-hosted deployment without it must still generate books.
 * That trade is real: with no key, the always-on word list in `./service.ts` is
 * the only screening there is.
 */
export async function screenTextWithCreem({
  prompt,
  externalId,
  timeoutMs,
}: {
  prompt: string;
  externalId?: string;
  timeoutMs?: number;
}): Promise<CreemScreenOutcome> {
  if (!prompt.trim()) return { kind: 'allow' };

  const configs = await getAllConfigs();
  const apiKey = configs['creem_api_key'];
  if (!apiKey) return { kind: 'skipped' };

  const provider = createCreemProvider({
    apiKey,
    // Same mapping as modules/payment/service.ts. Key presence alone enables
    // moderation: `creem_enabled` gates checkout, not this — a store can take
    // payment elsewhere and still owe Creem a screened prompt.
    environment:
      configs['creem_environment'] === 'production' ? 'production' : 'sandbox',
  });

  try {
    const result = await provider.moderatePrompt({
      prompt,
      externalId,
      timeoutMs,
    });
    if (result.decision === 'allow') return { kind: 'allow' };
    // `flag` is not a soft pass. Creem's own guidance is to block it too, and
    // the content is one they are already watching.
    return { kind: 'blocked', decision: result.decision };
  } catch (error) {
    if (error instanceof CreemModerationDisabledError) {
      // The key works and the store simply has moderation switched off in the
      // Creem dashboard. Not a failure to reach a decision, so not fail-closed:
      // blocking every user on a dashboard setting they cannot change would be
      // a permanent outage whose error message told them to retry. The operator
      // is out of compliance either way — this only avoids punishing customers
      // for it. Logged loudly because it must be fixed before the next review.
      console.error(
        'creem moderation is disabled for this store — enable it in the Creem dashboard',
        { externalId }
      );
      return { kind: 'skipped', reason: 'disabled' };
    }

    const status = error instanceof CreemModerationError ? error.status : 0;
    console.error('creem moderation unavailable:', {
      externalId,
      reason: status === 0 ? 'network' : 'http',
      message: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'unavailable', reason: status === 0 ? 'network' : 'http' };
  }
}
