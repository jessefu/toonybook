import { tDynamic } from '@/core/i18n/dynamic';
import { m } from '@/paraglide/messages.js';

const CASES = [
  {
    src: '/imgs/generated/case-moon-fox-1790587202001.png',
    key: 'moon_fox',
  },
  {
    src: '/imgs/generated/case-panda-picnic-1790587260828.png',
    key: 'panda_picnic',
  },
  {
    src: '/imgs/generated/case-owl-library-1790587292907.png',
    key: 'owl_library',
  },
  {
    src: '/imgs/generated/case-submarine-1790587201856.png',
    key: 'coral_reef',
  },
];

export function Gallery() {
  return (
    <section id="gallery" className="bg-secondary/40 px-4 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <div className="mb-16 text-center">
          <h2 className="font-serif text-4xl font-bold tracking-tight sm:text-5xl">
            {m['landing.gallery.title']()}
          </h2>
          <p className="text-muted-foreground mx-auto mt-5 max-w-lg">
            {m['landing.gallery.description']()}
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {CASES.map(({ src, key }) => (
            <figure
              key={key}
              className="group bg-card ring-foreground/5 relative overflow-hidden rounded-3xl shadow-md ring-1 transition-all duration-500 hover:-translate-y-2 hover:shadow-xl"
            >
              <img
                src={src}
                alt={tDynamic(`landing.gallery.${key}.title`)}
                loading="lazy"
                className="aspect-[3/4] w-full object-cover transition-transform duration-700 group-hover:scale-105"
              />
              <figcaption className="from-foreground/80 via-foreground/30 absolute inset-x-0 bottom-0 bg-gradient-to-t to-transparent p-5 pt-16">
                <p className="text-background font-serif text-lg font-bold">
                  {tDynamic(`landing.gallery.${key}.title`)}
                </p>
                <p className="text-background/80 text-xs">
                  {tDynamic(`landing.gallery.${key}.prompt`)}
                </p>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
