import { MetadataRoute } from 'next';

function normalizeSiteUrl(raw?: string): string {
  const fallback = 'https://www.shopmarieshair.com';
  if (!raw) return fallback;
  if (!/^https?:\/\//.test(raw)) raw = `https://${raw}`;
  return raw;
}
const BASE_URL = normalizeSiteUrl(process.env.NEXT_PUBLIC_APP_URL);

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin/',
          '/api/',
          '/checkout',
          '/cart',
          '/account/',
          '/auth/',
          '/pay/',
          '/order-success',
          '/order-tracking',
          '/maintenance',
          '/offline',
          '/pwa-settings',
          '/support/',
        ],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
