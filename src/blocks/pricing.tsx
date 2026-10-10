'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  CalendarDays,
  Check,
  Coins,
  CreditCard,
  Download,
  Headphones,
  Infinity as InfinityIcon,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import { useSession } from '@/core/auth/client';
import { useRouter } from '@/core/i18n/navigation';
import { apiPost } from '@/lib/api-client';
import { currentPathWithQuery } from '@/lib/redirect';
import { m } from '@/paraglide/messages.js';
import { usePublicConfig } from '@/hooks/use-public-config';
import {
  PaymentProviderModal,
  type PaymentProvider,
} from '@/components/payment-provider-modal';
import {
  PricingTable,
  type PricingGroup,
  type PricingPlan,
} from '@/components/pricing-table';

const ALL_PROVIDERS: PaymentProvider[] = [
  'stripe',
  'creem',
  'paypal',
  'alipay',
  'wechat',
];

export function Pricing({ title }: { title?: string } = {}) {
  const router = useRouter();
  const { data: session } = useSession();

  const { data: configsData } = usePublicConfig();
  const configs = configsData ?? {};
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<PricingPlan | null>(null);
  const [loadingProvider, setLoadingProvider] =
    useState<PaymentProvider | null>(null);

  const enabledProviders = useMemo<PaymentProvider[]>(
    () => ALL_PROVIDERS.filter((p) => configs[`${p}_enabled`] === 'true'),
    [configs]
  );

  const freeFeatures = [
    { icon: Sparkles, label: m['landing.pricing.feature_free_credits']() },
    { icon: CreditCard, label: m['landing.pricing.feature_no_card']() },
    { icon: Download, label: m['landing.pricing.feature_pdf_export']() },
  ];
  // One credit is one illustrated page, so every plan line below counts pages
  // and the per-page rate falls as you move right (see src/config/pricing.ts).
  const storytellerMonthlyFeatures = [
    {
      icon: CalendarDays,
      label: m['landing.pricing.feature_40_credits_month'](),
    },
    {
      icon: InfinityIcon,
      label: m['landing.pricing.feature_credits_refresh'](),
    },
    { icon: Download, label: m['landing.pricing.feature_pdf_export']() },
    {
      icon: Headphones,
      label: m['landing.pricing.feature_priority_support'](),
    },
  ];
  const storytellerYearlyFeatures = [
    {
      icon: CalendarDays,
      label: m['landing.pricing.feature_480_credits_year'](),
    },
    { icon: Check, label: m['landing.pricing.feature_two_months_free']() },
    {
      icon: InfinityIcon,
      label: m['landing.pricing.feature_credits_refresh'](),
    },
    { icon: Download, label: m['landing.pricing.feature_pdf_export']() },
    {
      icon: Headphones,
      label: m['landing.pricing.feature_priority_support'](),
    },
  ];
  const classroomMonthlyFeatures = [
    {
      icon: CalendarDays,
      label: m['landing.pricing.feature_150_credits_month'](),
    },
    {
      icon: InfinityIcon,
      label: m['landing.pricing.feature_credits_refresh'](),
    },
    { icon: Download, label: m['landing.pricing.feature_pdf_export']() },
    {
      icon: Headphones,
      label: m['landing.pricing.feature_dedicated_support'](),
    },
  ];
  const classroomYearlyFeatures = [
    {
      icon: CalendarDays,
      label: m['landing.pricing.feature_1800_credits_year'](),
    },
    { icon: Check, label: m['landing.pricing.feature_two_months_free']() },
    {
      icon: InfinityIcon,
      label: m['landing.pricing.feature_credits_refresh'](),
    },
    { icon: Download, label: m['landing.pricing.feature_pdf_export']() },
    {
      icon: Headphones,
      label: m['landing.pricing.feature_dedicated_support'](),
    },
  ];
  // Both packs promise the same two things and differ only in how many pages
  // they buy, so the shared lines are built rather than written out twice.
  const packFeatures = (creditsLabel: string) => [
    { icon: Coins, label: creditsLabel },
    { icon: InfinityIcon, label: m['landing.pricing.feature_never_expire']() },
    { icon: Check, label: m['landing.pricing.feature_one_time']() },
  ];

  const groups: PricingGroup[] = [
    {
      key: 'monthly',
      label: m['landing.pricing.tab_plans'](),
      plans: [
        {
          id: 'free',
          name: m['landing.pricing.free'](),
          description: m['landing.pricing.free_desc'](),
          price: '$0',
          features: freeFeatures,
          buttonText: m['landing.pricing.free_cta'](),
          // There is nothing to buy, so the CTA links somewhere useful rather
          // than opening a payment provider for a $0 order.
          href: session?.user ? '/settings/storybooks' : '/sign-up',
        },
        {
          id: 'storyteller-monthly',
          name: m['landing.pricing.pro'](),
          description: m['landing.pricing.pro_desc'](),
          price: '$9.99',
          interval: 'mo',
          featured: true,
          badge: m['landing.pricing.popular'](),
          features: storytellerMonthlyFeatures,
          productId: 'storyteller_monthly',
          priceInCents: 999,
          currency: 'usd',
          credits: 40,
          // Subscription credits lapse with the month they were granted for.
          creditsValidDays: 30,
          plan: { name: 'Storyteller', interval: 'month', intervalCount: 1 },
        },
        {
          id: 'classroom-monthly',
          name: m['landing.pricing.enterprise'](),
          description: m['landing.pricing.enterprise_desc'](),
          price: '$29.99',
          interval: 'mo',
          features: classroomMonthlyFeatures,
          productId: 'classroom_monthly',
          priceInCents: 2999,
          currency: 'usd',
          credits: 150,
          creditsValidDays: 30,
          plan: { name: 'Classroom', interval: 'month', intervalCount: 1 },
        },
      ],
    },
    {
      key: 'yearly',
      label: m['landing.pricing.tab_yearly'](),
      plans: [
        {
          id: 'storyteller-yearly',
          name: m['landing.pricing.pro'](),
          description: m['landing.pricing.pro_desc'](),
          price: '$99',
          originalPrice: '$119.88',
          interval: 'yr',
          featured: true,
          badge: m['landing.pricing.best_value'](),
          features: storytellerYearlyFeatures,
          productId: 'storyteller_yearly',
          priceInCents: 9900,
          currency: 'usd',
          // A year's allowance arrives in one grant — there is no monthly
          // re-grant for annual plans — so it lapses with the year it bought.
          credits: 480,
          creditsValidDays: 365,
          plan: { name: 'Storyteller', interval: 'year', intervalCount: 1 },
        },
        {
          id: 'classroom-yearly',
          name: m['landing.pricing.enterprise'](),
          description: m['landing.pricing.enterprise_desc'](),
          price: '$299',
          originalPrice: '$359.88',
          interval: 'yr',
          features: classroomYearlyFeatures,
          productId: 'classroom_yearly',
          priceInCents: 29900,
          currency: 'usd',
          credits: 1800,
          creditsValidDays: 365,
          plan: { name: 'Classroom', interval: 'year', intervalCount: 1 },
        },
      ],
    },
    {
      key: 'packs',
      label: m['landing.pricing.tab_packs'](),
      plans: [
        {
          id: 'credits-15',
          name: m['landing.pricing.pack_small'](),
          description: m['landing.pricing.pack_small_desc'](),
          price: '$4.99',
          features: packFeatures(m['landing.pricing.feature_15_credits']()),
          buttonText: m['landing.pricing.buy_pack'](),
          productId: 'credits_15',
          priceInCents: 499,
          currency: 'usd',
          credits: 15,
        },
        {
          id: 'credits-50',
          name: m['landing.pricing.pack_large'](),
          description: m['landing.pricing.pack_large_desc'](),
          price: '$14.99',
          featured: true,
          badge: m['landing.pricing.best_value'](),
          features: packFeatures(m['landing.pricing.feature_50_credits']()),
          buttonText: m['landing.pricing.buy_pack'](),
          productId: 'credits_50',
          priceInCents: 1499,
          currency: 'usd',
          credits: 50,
        },
      ],
    },
  ];

  const checkoutMutation = useMutation({
    mutationFn: ({
      plan,
      provider,
    }: {
      plan: PricingPlan;
      provider: PaymentProvider;
    }) =>
      apiPost<{ checkout_url?: string }>('/api/payment/checkout', {
        product_id: plan.productId,
        product_name: plan.productName || plan.name,
        plan_name: plan.plan?.name || plan.name,
        price: plan.priceInCents,
        currency: plan.currency || 'usd',
        type: plan.plan ? 'subscription' : 'one-time',
        description: plan.name,
        plan: plan.plan,
        credits: plan.credits,
        credits_valid_days: plan.creditsValidDays,
        payment_provider: provider,
        // Come back to the page the user paid from.
        redirect: currentPathWithQuery('/settings/billing'),
      }),
    onSuccess: (data) => {
      if (!data?.checkout_url) {
        toast.error('Checkout failed');
        setLoadingProvider(null);
        return;
      }
      window.location.href = data.checkout_url;
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Checkout failed');
      setLoadingProvider(null);
    },
  });

  function startCheckout(plan: PricingPlan, provider: PaymentProvider) {
    setLoadingProvider(provider);
    checkoutMutation.mutate({ plan, provider });
  }

  async function handleCheckout(plan: PricingPlan) {
    if (!session?.user) {
      const callbackUrl = encodeURIComponent(currentPathWithQuery('/pricing'));
      router.push(`/sign-in?callbackUrl=${callbackUrl}`);
      return;
    }

    const selectEnabled = configs.select_payment_enabled === 'true';
    const defaultProvider = (configs.default_payment_provider ||
      enabledProviders[0] ||
      'stripe') as PaymentProvider;

    if (selectEnabled && enabledProviders.length > 1) {
      setPendingPlan(plan);
      setModalOpen(true);
      return;
    }

    await startCheckout(plan, defaultProvider);
  }

  function handleProviderSelect(provider: PaymentProvider) {
    if (!pendingPlan) return;
    startCheckout(pendingPlan, provider);
  }

  return (
    <section
      id="pricing"
      className="border-border border-t px-4 py-24 sm:py-32"
    >
      <div className="mx-auto max-w-5xl">
        <div className="mb-20 text-center">
          <h2 className="font-serif text-4xl font-normal tracking-tight sm:text-5xl">
            {title ?? m['landing.pricing.title']()}
          </h2>
          <p className="text-muted-foreground mt-5">
            {m['landing.pricing.description']()}
          </p>
        </div>
        <PricingTable groups={groups} onCheckout={handleCheckout} />
      </div>

      <PaymentProviderModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) {
            setPendingPlan(null);
            setLoadingProvider(null);
          }
        }}
        providers={enabledProviders.length ? enabledProviders : ['stripe']}
        loadingProvider={loadingProvider}
        onSelect={handleProviderSelect}
        planName={pendingPlan?.name}
        price={pendingPlan?.price}
      />
    </section>
  );
}
