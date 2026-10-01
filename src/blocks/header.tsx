import { m } from '@/paraglide/messages.js';
import { SiteHeader } from '@/components/site-header';

export function Header() {
  const navLinks = [
    { href: '/#how-it-works', label: m['landing.nav.how']() },
    { href: '/#gallery', label: m['landing.nav.gallery']() },
    { href: '/#features', label: m['landing.nav.features']() },
    { href: '/pricing', label: m['landing.nav.pricing']() },
    { href: '/blog', label: m['landing.nav.blog']() },
  ];

  return <SiteHeader navLinks={navLinks} />;
}
