import { createFileRoute } from '@tanstack/react-router';

import { envConfigs } from '@/config';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales, localizeUrl } from '@/paraglide/runtime.js';
import { Blog } from '@/blocks/blog';
import { CTA } from '@/blocks/cta';
import { FAQ } from '@/blocks/faq';
import { Features } from '@/blocks/features';
import { Footer } from '@/blocks/footer';
import { Gallery } from '@/blocks/gallery';
import { Header } from '@/blocks/header';
import { Hero } from '@/blocks/hero';
import { HowItWorks } from '@/blocks/how-it-works';
import { Pricing } from '@/blocks/pricing';
import { SupportWidget } from '@/blocks/support-widget';
import { getBlogPostsFn } from '@/content/posts/server';

/**
 * Default landing page — demo content. Rewrite this file (and the blocks in
 * src/blocks/) for your project. The primitives in src/components/ stay.
 * See /quick-start or /clone-website to automate the rewrite.
 */
function HomePage() {
  const { posts } = Route.useLoaderData();

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <main>
        <Hero />
        <HowItWorks />
        <Gallery />
        <Features />
        <Pricing />
        <FAQ />
        <Blog posts={posts} />
        <CTA />
      </main>
      <Footer />
      <SupportWidget />
    </div>
  );
}

export const Route = createFileRoute('/')({
  loader: async () => {
    const locale = getLocale();
    const posts = await getBlogPostsFn({ data: { locale, limit: 3 } });
    return { locale, posts };
  },
  head: ({ loaderData }) => {
    const locale = loaderData?.locale ?? 'en';
    const urlFor = (loc: string) =>
      localizeUrl(`${envConfigs.app_url}/`, { locale: loc as any }).href;
    return {
      meta: [
        {
          name: 'description',
          content: m['landing.hero.subheadline']({}, { locale: locale as any }),
        },
      ],
      links: [
        { rel: 'canonical', href: urlFor(locale) },
        ...locales.map((loc) => ({
          rel: 'alternate',
          hrefLang: loc,
          href: urlFor(loc),
        })),
        { rel: 'alternate', hrefLang: 'x-default', href: urlFor('en') },
      ],
    };
  },
  component: HomePage,
});
