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
 * `creditsValidDays` is the whole difference between the two kinds of product
 * here, and it is the reason both exist:
 *
 * - **Credit packs** (`credits_15`, `credits_100`) are one-time purchases and
 *   deliberately omit it. `calculateCreditExpirationTime` returns null for a
 *   missing/zero value, so a top-up never expires — money the user spent stays
 *   theirs until they spend it.
 * - **The subscription** sets it, so each month's credits lapse with the period
 *   they were granted for and cannot be stockpiled.
 */
export const pricingCatalog: Record<string, PricingProduct> = {
  storyteller_monthly: {
    productId: 'storyteller_monthly',
    productName: 'Storyteller',
    planName: 'Storyteller Monthly',
    description: 'Storyteller Monthly — 100 credits every month',
    type: PaymentType.SUBSCRIPTION,
    priceInCents: 2999,
    currency: 'usd',
    credits: 100,
    creditsValidDays: 30,
    plan: {
      name: 'Storyteller',
      interval: PaymentInterval.MONTH,
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
    credits: 15,
  },
  credits_100: {
    productId: 'credits_100',
    productName: 'Value Pack',
    planName: 'Value Pack',
    description: '100 credits — 100 illustrated pages',
    type: PaymentType.ONE_TIME,
    priceInCents: 2999,
    currency: 'usd',
    credits: 100,
  },
};

export function getPricingProduct(productId: string): PricingProduct | null {
  if (!productId) return null;
  return pricingCatalog[productId] ?? null;
}

export function listPricingProducts(): PricingProduct[] {
  return Object.values(pricingCatalog);
}
