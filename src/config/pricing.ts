/**
 * Authoritative pricing catalog.
 *
 * The checkout API uses this as the SOURCE OF TRUTH for price/credits/duration.
 * Any price, credits, or plan info sent by the client is IGNORED — only the
 * product_id is honored, and everything else is looked up here.
 *
 * To change pricing, edit this file and redeploy. Admin UI cannot alter prices.
 */

import { PaymentInterval, PaymentType } from '@/core/payment/types';

export type PricingPlanInfo = {
  name: string;
  interval: PaymentInterval;
  intervalCount: number;
};

export type PricingProduct = {
  productId: string;
  productName: string;
  planName: string;
  description: string;
  type: PaymentType;
  priceInCents: number;
  currency: string;
  credits: number;
  creditsValidDays?: number;
  plan?: PricingPlanInfo;
};

/**
 * The product catalog. Keys MUST match what the pricing UI sends as `product_id`.
 *
 * One credit = one illustrated page, so `credits` reads directly as pages.
 *
 * The shape is deliberate, and it is what makes either kind of product worth
 * buying:
 *
 * - **Subscriptions are the cheap way to buy pages.** The per-page rate falls
 *   from $0.25 (monthly) to $0.17 (yearly), so anyone making three or more
 *   books a month is better off subscribing than topping up.
 * - **Credit packs are the flexible way**, and are priced *above* every
 *   subscription rate ($0.333 / $0.30 per page) on purpose. A pack is for
 *   someone who does not want a recurring charge, or who ran out mid-month —
 *   not a competing offer. Making a pack match the subscription rate would
 *   cannibalise it, which is exactly what the previous $29.99-for-100 pack did
 *   to the $29.99-a-month subscription. That also bounds how generous a pack
 *   can get: at $14.99 the large pack could not go past ~54 credits before
 *   reaching the $0.25/monthly rate and undercutting the plan it is meant to
 *   feed (permanent credits at the same rate always win).
 *
 * `creditsValidDays` is what separates the two in behaviour:
 * `calculateCreditExpirationTime` returns null for a missing/zero value, so a
 * pack's credits never expire, while a subscription's lapse with the period
 * they were granted for and cannot be stockpiled. `credits/service.ts` spends
 * the expiring ones first, so a subscriber's permanent top-ups are never
 * touched while monthly credits are about to go stale.
 */
export const pricingCatalog: Record<string, PricingProduct> = {
  storyteller_monthly: {
    productId: 'storyteller_monthly',
    productName: 'Storyteller',
    planName: 'Storyteller Monthly',
    description: 'Storyteller Monthly — 40 credits every month',
    type: PaymentType.SUBSCRIPTION,
    priceInCents: 999,
    currency: 'usd',
    credits: 40,
    creditsValidDays: 30,
    plan: {
      name: 'Storyteller',
      interval: PaymentInterval.MONTH,
      intervalCount: 1,
    },
  },
  storyteller_yearly: {
    productId: 'storyteller_yearly',
    productName: 'Storyteller',
    planName: 'Storyteller Yearly',
    description: 'Storyteller Yearly — 480 credits a year',
    type: PaymentType.SUBSCRIPTION,
    priceInCents: 9900,
    currency: 'usd',
    // A year's allowance is granted up front; there is no monthly re-grant for
    // annual plans, so the whole 480 lands in one transaction and lapses with
    // the year it was bought for.
    credits: 480,
    creditsValidDays: 365,
    plan: {
      name: 'Storyteller',
      interval: PaymentInterval.YEAR,
      intervalCount: 1,
    },
  },
  classroom_monthly: {
    productId: 'classroom_monthly',
    productName: 'Classroom',
    planName: 'Classroom Monthly',
    description: 'Classroom Monthly — 150 credits every month',
    type: PaymentType.SUBSCRIPTION,
    priceInCents: 2999,
    currency: 'usd',
    credits: 150,
    creditsValidDays: 30,
    plan: {
      name: 'Classroom',
      interval: PaymentInterval.MONTH,
      intervalCount: 1,
    },
  },
  classroom_yearly: {
    productId: 'classroom_yearly',
    productName: 'Classroom',
    planName: 'Classroom Yearly',
    description: 'Classroom Yearly — 1,800 credits a year',
    type: PaymentType.SUBSCRIPTION,
    priceInCents: 29900,
    currency: 'usd',
    credits: 1800,
    creditsValidDays: 365,
    plan: {
      name: 'Classroom',
      interval: PaymentInterval.YEAR,
      intervalCount: 1,
    },
  },
  credits_15: {
    productId: 'credits_15',
    productName: 'Starter Pack',
    planName: 'Starter Pack',
    description: '15 credits — 15 illustrated pages',
    type: PaymentType.ONE_TIME,
    priceInCents: 499,
    currency: 'usd',
    // 15 is the longest book the form allows, so the cheapest pack can buy a
    // whole book of any length.
    credits: 15,
  },
  credits_50: {
    productId: 'credits_50',
    productName: 'Value Pack',
    planName: 'Value Pack',
    description: '50 credits — 50 illustrated pages',
    type: PaymentType.ONE_TIME,
    priceInCents: 1499,
    currency: 'usd',
    credits: 50,
  },
};

export function getPricingProduct(productId: string): PricingProduct | null {
  if (!productId) return null;
  return pricingCatalog[productId] ?? null;
}

export function listPricingProducts(): PricingProduct[] {
  return Object.values(pricingCatalog);
}
