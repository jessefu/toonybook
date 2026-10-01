import {
  BookOpenText,
  PencilLine,
  Share2,
  type LucideIcon,
} from 'lucide-react';

import { tDynamic } from '@/core/i18n/dynamic';
import { m } from '@/paraglide/messages.js';

const STEPS: { key: string; icon: LucideIcon }[] = [
  { key: 'describe', icon: PencilLine },
  { key: 'create', icon: BookOpenText },
  { key: 'share', icon: Share2 },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="px-4 py-24 sm:py-32">
      <div className="mx-auto max-w-5xl">
        <div className="mb-16 text-center">
          <h2 className="font-serif text-4xl font-bold tracking-tight sm:text-5xl">
            {m['landing.how.title']()}
          </h2>
          <p className="text-muted-foreground mx-auto mt-5 max-w-lg">
            {m['landing.how.description']()}
          </p>
        </div>

        <div className="relative grid gap-10 sm:grid-cols-3 sm:gap-6">
          {/* Connector line (desktop) */}
          <div
            aria-hidden
            className="border-border absolute top-7 right-[16%] left-[16%] hidden border-t-2 border-dashed sm:block"
          />
          {STEPS.map(({ key, icon: Icon }, i) => (
            <div
              key={key}
              className="relative flex flex-col items-center gap-5 text-center"
            >
              <div className="bg-primary text-primary-foreground shadow-primary/25 relative z-10 flex size-14 items-center justify-center rounded-2xl shadow-lg">
                <Icon className="size-6" strokeWidth={1.75} />
              </div>
              <span className="text-primary text-xs font-bold tracking-[0.2em] uppercase">
                {m['landing.how.step_label']({ number: String(i + 1) })}
              </span>
              <h3 className="text-lg font-semibold">
                {tDynamic(`landing.how.${key}.title`)}
              </h3>
              <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
                {tDynamic(`landing.how.${key}.description`)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
