import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import { supabase } from '@/lib/supabase';
import ProductDetailClient from './ProductDetailClient';

type Params = { slug: string };

const fetchProductForMetadata = cache(async (slug: string) => {
  const { data, error } = await supabase
    .from('products')
    .select(
      'id, name, slug, description, seo_title, seo_description, price, status, product_images(url, position)'
    )
    .eq('slug', slug)
    .maybeSingle();

  if (error || !data) return null;
  return data as any;
});

const fetchCanonicalSlugFromHistory = cache(async (oldSlug: string) => {
  const { data: history, error } = await supabase
    .from('product_slug_history')
    .select('product_id')
    .eq('old_slug', oldSlug)
    .maybeSingle();

  if (error || !history?.product_id) return null;

  const { data: product } = await supabase
    .from('products')
    .select('slug, status')
    .eq('id', history.product_id)
    .maybeSingle();

  if (!product?.slug) return null;
  return product.slug as string;
});

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const product = await fetchProductForMetadata(slug);

  if (!product) {
    return {
      title: 'Product Not Found',
      robots: { index: false, follow: false },
    };
  }

  const title = (product.seo_title || product.name || '').trim();
  const description = (
    product.seo_description ||
    product.description ||
    `Shop ${product.name} at Maries Hair.`
  )
    .toString()
    .slice(0, 200);

  const sortedImages = Array.isArray(product.product_images)
    ? [...product.product_images].sort(
        (a: any, b: any) => (a.position ?? 0) - (b.position ?? 0)
      )
    : [];
  const primaryImage = sortedImages[0]?.url;

  const canonicalPath = `/product/${product.slug}`;

  return {
    title,
    description,
    alternates: { canonical: canonicalPath },
    openGraph: {
      title,
      description,
      url: canonicalPath,
      type: 'website',
      images: primaryImage
        ? [{ url: primaryImage, alt: product.name }]
        : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: primaryImage ? [primaryImage] : undefined,
    },
  };
}

export default async function ProductDetailPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;

  // If the requested slug doesn't match a current product, see if it's a
  // historical slug. If so, 308-redirect to the canonical slug so existing
  // links and search results don't break.
  const product = await fetchProductForMetadata(slug);
  if (!product) {
    const canonicalSlug = await fetchCanonicalSlugFromHistory(slug);
    if (canonicalSlug && canonicalSlug !== slug) {
      permanentRedirect(`/product/${canonicalSlug}`);
    }
    // Fall through — client component will show its own "not found" UI.
  }

  return <ProductDetailClient slug={slug} />;
}
