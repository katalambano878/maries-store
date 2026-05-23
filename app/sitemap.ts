import { MetadataRoute } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function normalizeSiteUrl(raw?: string): string {
  const fallback = 'https://www.shopmarieshair.com';
  if (!raw) return fallback;
  if (!/^https?:\/\//.test(raw)) raw = `https://${raw}`;
  return raw;
}
const BASE_URL = normalizeSiteUrl(process.env.NEXT_PUBLIC_APP_URL);

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE_URL, lastModified: now, changeFrequency: 'daily', priority: 1 },
    { url: `${BASE_URL}/shop`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${BASE_URL}/categories`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${BASE_URL}/about`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${BASE_URL}/contact`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${BASE_URL}/blog`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE_URL}/faqs`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE_URL}/help`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE_URL}/shipping`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${BASE_URL}/returns`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${BASE_URL}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE_URL}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ];

  let productPages: MetadataRoute.Sitemap = [];
  let categoryPages: MetadataRoute.Sitemap = [];
  let blogPages: MetadataRoute.Sitemap = [];

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: products } = await supabase
      .from('products')
      .select('slug, updated_at')
      .eq('status', 'active');

    if (products) {
      productPages = products.map((p) => ({
        url: `${BASE_URL}/product/${p.slug}`,
        lastModified: new Date(p.updated_at),
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      }));
    }

    const { data: categories } = await supabase
      .from('categories')
      .select('slug, updated_at');

    if (categories) {
      categoryPages = categories.map((c) => ({
        url: `${BASE_URL}/categories?cat=${c.slug}`,
        lastModified: new Date(c.updated_at),
        changeFrequency: 'weekly' as const,
        priority: 0.6,
      }));
    }

    const { data: blogs } = await supabase
      .from('blog_posts')
      .select('id, updated_at')
      .eq('status', 'published');

    if (blogs) {
      blogPages = blogs.map((b) => ({
        url: `${BASE_URL}/blog/${b.id}`,
        lastModified: new Date(b.updated_at),
        changeFrequency: 'monthly' as const,
        priority: 0.5,
      }));
    }
  } catch (error) {
    console.error('Error generating sitemap:', error);
  }

  return [...staticPages, ...productPages, ...categoryPages, ...blogPages];
}
