import { ArrowRight, Play, Sparkles } from 'lucide-react';

import { Link } from '@/core/i18n/navigation';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { buttonVariants } from '@/components/ui/button';

const GALLERY_IMAGES = [
  {
    src: '/imgs/generated/case-moon-fox-1790587202001.png',
    alt: 'A little fox under the moonlight',
    captionKey: 'landing.hero.img_moon_fox' as const,
  },
  {
    src: '/imgs/generated/case-panda-picnic-1790587260828.png',
    alt: 'A panda having tea with a bunny',
    captionKey: 'landing.hero.img_panda' as const,
  },
  {
    src: '/imgs/generated/case-owl-library-1790587292907.png',
    alt: 'Owls reading in a cozy tree library',
    captionKey: 'landing.hero.img_owl' as const,
  },
  {
    src: '/imgs/generated/case-submarine-1790587201856.png',
    alt: 'A curious octopus exploring the coral reef',
    captionKey: 'landing.hero.img_octopus' as const,
  },
];

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* Warm ambient washes */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="animate-drift-a bg-primary/15 absolute -top-32 -left-32 size-[32rem] rounded-full blur-3xl" />
        <div className="animate-drift-b bg-accent/40 absolute top-1/3 -right-40 size-[36rem] rounded-full blur-3xl" />
        <div className="animate-drift-c bg-secondary/50 absolute bottom-0 left-1/3 size-[28rem] rounded-full blur-3xl" />
      </div>

      <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 pt-16 pb-20 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 lg:pt-24 lg:pb-28">
        {/* Copy */}
        <div className="max-w-xl space-y-8 text-center lg:text-left">
          <p className="bg-primary/10 text-primary inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-semibold">
            <Sparkles className="size-4" />
            {m['landing.hero.badge']()}
          </p>
          <h1 className="text-foreground font-serif text-5xl leading-[1.08] font-bold tracking-tight text-balance sm:text-6xl">
            {m['landing.hero.headline']()}
          </h1>
          <p className="text-muted-foreground mx-auto max-w-lg text-lg leading-relaxed lg:mx-0">
            {m['landing.hero.subheadline']()}
          </p>

          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
            <Link
              href="/settings"
              className={cn(
                buttonVariants({ size: 'lg' }),
                'shadow-primary/25 h-12 w-full gap-2 rounded-full px-8 text-base shadow-lg sm:w-auto'
              )}
            >
              {m['landing.hero.cta']()}
              <ArrowRight className="size-4" />
            </Link>
            <a
              href="#how-it-works"
              className={cn(
                buttonVariants({ variant: 'outline', size: 'lg' }),
                'h-12 w-full gap-2 rounded-full px-8 text-base sm:w-auto'
              )}
            >
              <Play className="size-4" />
              {m['landing.hero.secondary']()}
            </a>
          </div>

          <p className="text-muted-foreground text-sm">
            {m['landing.hero.note']()}
          </p>
        </div>

        {/* Illustration wall */}
        <div className="relative mx-auto w-full max-w-md lg:max-w-none">
          <div className="grid grid-cols-2 gap-4">
            {GALLERY_IMAGES.map((img, i) => (
              <figure
                key={img.src}
                className={cn(
                  'group shadow-foreground/10 ring-foreground/5 overflow-hidden rounded-3xl shadow-xl ring-1 transition-transform duration-500 hover:scale-[1.03]',
                  i % 2 === 1 && 'translate-y-6'
                )}
              >
                <img
                  src={img.src}
                  alt={img.alt}
                  loading={i > 1 ? 'lazy' : 'eager'}
                  className="aspect-[3/4] w-full object-cover"
                />
              </figure>
            ))}
          </div>
          {/* Floating star */}
          <div
            aria-hidden
            className="bg-card text-primary absolute -top-5 -left-5 flex size-14 rotate-[-8deg] items-center justify-center rounded-2xl shadow-lg"
          >
            <Sparkles className="size-6" />
          </div>
        </div>
      </div>
    </section>
  );
}
