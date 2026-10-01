import {
  Baby,
  Globe,
  Languages,
  Palette,
  Printer,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

import { tDynamic } from '@/core/i18n/dynamic';
import { m } from '@/paraglide/messages.js';

const FEATURES: { key: string; icon: LucideIcon }[] = [
  { key: 'hero_child', icon: Baby },
  { key: 'art', icon: Palette },
  { key: 'safe', icon: ShieldCheck },
  { key: 'languages', icon: Languages },
  { key: 'print', icon: Printer },
  { key: 'worlds', icon: Globe },
];

export function Features() {
  return (
    <section id="features" className="px-4 py-24 sm:py-32">
      <div className="mx-auto max-w-5xl">
        <div className="mb-20 text-center">
          <h2 className="font-serif text-4xl font-bold tracking-tight sm:text-5xl">
            {m['landing.features.title']()}
          </h2>
          <p className="text-muted-foreground mx-auto mt-5 max-w-lg">
            {m['landing.features.description']()}
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ key, icon: Icon }) => (
            <div
              key={key}
              className="group border-border bg-card hover:border-primary/40 hover:shadow-primary/5 relative flex flex-col gap-4 rounded-3xl border p-6 transition-all hover:shadow-lg"
            >
              <div className="bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground inline-flex size-11 items-center justify-center rounded-2xl transition-colors">
                <Icon className="size-5" strokeWidth={1.75} />
              </div>
              <div className="space-y-2">
                <h3 className="font-semibold">
                  {tDynamic(`landing.features.${key}.title`)}
                </h3>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {tDynamic(`landing.features.${key}.description`)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
