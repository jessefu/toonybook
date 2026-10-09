import type { ComponentType, SVGProps } from 'react';

import { envConfigs } from '@/config';
import { m } from '@/paraglide/messages.js';
import {
  SiteFooter,
  type FooterColumn,
  type FooterSocial,
} from '@/components/site-footer';

function InstagramIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

function FacebookIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

function PinterestIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z" />
    </svg>
  );
}

function XIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function YouTubeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

/**
 * Footer social icons, driven by `VITE_SOCIAL_*` rather than hardcoded.
 *
 * Any platform left unset is simply not rendered. That matters beyond
 * tidiness: the template shipped links to the bare `instagram.com` front page,
 * and a dead or meaningless social link is one of the things a payment
 * provider's reviewer checks.
 */
type SocialConfigKey =
  | 'social_instagram'
  | 'social_facebook'
  | 'social_pinterest'
  | 'social_x'
  | 'social_youtube';

const SOCIAL_PLATFORMS: {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  configKey: SocialConfigKey;
}[] = [
  { label: 'Instagram', icon: InstagramIcon, configKey: 'social_instagram' },
  { label: 'Facebook', icon: FacebookIcon, configKey: 'social_facebook' },
  { label: 'Pinterest', icon: PinterestIcon, configKey: 'social_pinterest' },
  { label: 'X', icon: XIcon, configKey: 'social_x' },
  { label: 'YouTube', icon: YouTubeIcon, configKey: 'social_youtube' },
];

export function Footer() {
  const columns: FooterColumn[] = [
    {
      title: m['landing.footer.product'](),
      links: [
        { label: m['landing.nav.how'](), href: '/#how-it-works' },
        { label: m['landing.nav.gallery'](), href: '/#gallery' },
        { label: m['landing.nav.pricing'](), href: '/pricing' },
      ],
    },
    {
      title: m['landing.footer.resources'](),
      // "Help & FAQ" points at the public FAQ page. It used to point straight
      // at the signed-in ticket list, which bounces anyone who is not logged in
      // — including a reviewer — to the sign-in page.
      links: [
        { label: m['landing.footer.blog'](), href: '/blog' },
        { label: m['landing.footer.help'](), href: '/faq' },
      ],
    },
    {
      title: m['landing.footer.legal'](),
      // Five links, not two: a payment provider reviewing this site requires
      // Terms, Privacy, a Refund & Cancellation policy and a reachable contact
      // to be one click from every page, and the footer is on every page. The
      // Acceptable Use Policy is the fifth because the merchant of record
      // requires it of AI generation products specifically.
      links: [
        { label: m['landing.footer.terms'](), href: '/terms-of-service' },
        { label: m['landing.footer.privacy'](), href: '/privacy-policy' },
        { label: m['landing.footer.refund'](), href: '/refund-policy' },
        { label: m['landing.footer.aup'](), href: '/acceptable-use-policy' },
        { label: m['landing.footer.contact'](), href: '/contact' },
      ],
    },
  ];

  const socials: FooterSocial[] = SOCIAL_PLATFORMS.map(
    ({ label, icon, configKey }) => ({
      label,
      icon,
      href: envConfigs[configKey]?.trim() ?? '',
    })
  ).filter((social) => social.href.length > 0);

  return (
    <SiteFooter
      tagline={m['landing.footer.tagline']()}
      columns={columns}
      socials={socials}
    />
  );
}
