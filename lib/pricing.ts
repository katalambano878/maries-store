/**
 * Site-wide sale mode: when salesActive and sale_price is valid, effective = sale_price
 * and originalDisplay shows the regular price for strikethrough.
 */

export function isValidSalePrice(n: number | null | undefined): boolean {
  return n != null && Number(n) > 0;
}

/** Apply a percentage discount to a price */
function applyDiscount(price: number, discountPercent: number): number {
  if (discountPercent <= 0 || discountPercent > 100) return price;
  return Math.round(price * (1 - discountPercent / 100) * 100) / 100;
}

export type ResolvedPrice = {
  effective: number;
  /** For UI strikethrough / "was" price; null if none */
  originalDisplay: number | null;
};

export function resolveProductPrice(args: {
  salesActive: boolean;
  price: number;
  salePrice?: number | null;
  compareAtPrice?: number | null;
  discountPercent?: number;
}): ResolvedPrice {
  const { salesActive, price, salePrice, compareAtPrice, discountPercent = 0 } = args;
  const base = Number(price) || 0;

  if (salesActive) {
    // Per-product sale price takes priority
    if (isValidSalePrice(salePrice)) {
      return {
        effective: Number(salePrice),
        originalDisplay: base > Number(salePrice) ? base : null,
      };
    }
    // Bulk discount fallback
    if (discountPercent > 0) {
      const discounted = applyDiscount(base, discountPercent);
      return {
        effective: discounted,
        originalDisplay: base > discounted ? base : null,
      };
    }
  }

  const compare = compareAtPrice != null ? Number(compareAtPrice) : null;
  const orig =
    compare != null && !Number.isNaN(compare) && compare > base ? compare : null;
  return { effective: base, originalDisplay: orig };
}

export function resolveVariantPrice(args: {
  salesActive: boolean;
  productPrice: number;
  productSalePrice?: number | null;
  variantPrice: number;
  variantSalePrice?: number | null;
  compareAtPrice?: number | null;
  discountPercent?: number;
}): ResolvedPrice {
  const {
    salesActive,
    productPrice,
    productSalePrice,
    variantPrice,
    variantSalePrice,
    compareAtPrice,
    discountPercent = 0,
  } = args;

  const vPrice = Number(variantPrice) || Number(productPrice) || 0;

  if (salesActive) {
    const vSale = isValidSalePrice(variantSalePrice)
      ? Number(variantSalePrice)
      : null;
    const pSale = isValidSalePrice(productSalePrice)
      ? Number(productSalePrice)
      : null;
    const chosenSale = vSale ?? pSale;

    if (chosenSale != null) {
      const regular = vPrice;
      return {
        effective: chosenSale,
        originalDisplay: regular > chosenSale ? regular : null,
      };
    }

    // Bulk discount fallback
    if (discountPercent > 0) {
      const discounted = applyDiscount(vPrice, discountPercent);
      return {
        effective: discounted,
        originalDisplay: vPrice > discounted ? vPrice : null,
      };
    }
  }

  const compare = compareAtPrice != null ? Number(compareAtPrice) : null;
  const orig =
    compare != null && !Number.isNaN(compare) && compare > vPrice
      ? compare
      : null;
  return { effective: vPrice, originalDisplay: orig };
}

/** Parse store_pricing JSON from site_settings.value */
export function parseStorePricingValue(
  value: unknown
): { sales_active: boolean; discount_percent: number } {
  if (value && typeof value === 'object' && 'sales_active' in value) {
    const obj = value as { sales_active?: unknown; discount_percent?: unknown };
    return {
      sales_active: Boolean(obj.sales_active),
      discount_percent: Number(obj.discount_percent) || 0,
    };
  }
  return { sales_active: false, discount_percent: 0 };
}

/** Map DB product + variants to ProductCard price props */
export function getProductCardPricing(
  p: {
    price: number;
    sale_price?: number | null;
    compare_at_price?: number | null;
    product_variants?: Array<{
      price?: number | null;
      sale_price?: number | null;
    }>;
  },
  salesActive: boolean,
  discountPercent: number = 0
): {
  price: number;
  minVariantPrice?: number;
  originalPrice?: number;
  saleBadge: boolean;
} {
  const variants = p.product_variants || [];
  const hasVariants = variants.length > 0;

  if (!hasVariants) {
    const r = resolveProductPrice({
      salesActive,
      price: p.price,
      salePrice: p.sale_price,
      compareAtPrice: p.compare_at_price,
      discountPercent,
    });
    const orig = r.originalDisplay ?? undefined;
    return {
      price: r.effective,
      originalPrice: orig,
      saleBadge: orig != null && orig > r.effective,
    };
  }

  const resolvedList = variants.map((v) =>
    resolveVariantPrice({
      salesActive,
      productPrice: p.price,
      productSalePrice: p.sale_price,
      variantPrice: Number(v.price ?? p.price),
      variantSalePrice: v.sale_price,
      compareAtPrice: p.compare_at_price,
      discountPercent,
    })
  );
  const minEff = Math.min(...resolvedList.map((r) => r.effective));
  const firstMin = resolvedList.find((r) => r.effective === minEff)!;
  let orig = firstMin.originalDisplay;
  if (
    orig == null &&
    p.compare_at_price != null &&
    Number(p.compare_at_price) > minEff
  ) {
    orig = Number(p.compare_at_price);
  }
  return {
    price: p.price,
    minVariantPrice: minEff,
    originalPrice: orig != null && orig > minEff ? orig : undefined,
    saleBadge: orig != null && orig > minEff,
  };
}

/** Resolve authoritative unit price at checkout/POS from DB row + cart variant label */
export function resolveCartLineUnitPrice(
  product: {
    price: number;
    sale_price?: number | null;
    compare_at_price?: number | null;
    product_variants?: Array<{
      name?: string | null;
      option1?: string | null;
      option2?: string | null;
      price?: number | null;
      sale_price?: number | null;
    }>;
  },
  variantLabel: string | undefined | null,
  salesActive: boolean,
  discountPercent: number = 0
): number {
  const variants = product.product_variants || [];
  if (!variantLabel?.trim() || variants.length === 0) {
    return resolveProductPrice({
      salesActive,
      price: product.price,
      salePrice: product.sale_price,
      compareAtPrice: product.compare_at_price,
      discountPercent,
    }).effective;
  }
  const parts = variantLabel
    .split(' / ')
    .map((s) => s.trim())
    .filter(Boolean);
  let v:
    | NonNullable<(typeof product)['product_variants']>[number]
    | undefined;
  if (parts.length >= 2) {
    v = variants.find(
      (x) =>
        (x.option2 || '').trim() === parts[0] &&
        (x.name || '').trim() === parts[1]
    );
  }
  if (!v && parts.length === 1) {
    v = variants.find(
      (x) =>
        (x.name || '').trim() === parts[0] ||
        (x.option2 || '').trim() === parts[0]
    );
  }
  if (!v) {
    return resolveProductPrice({
      salesActive,
      price: product.price,
      salePrice: product.sale_price,
      compareAtPrice: product.compare_at_price,
      discountPercent,
    }).effective;
  }
  return resolveVariantPrice({
    salesActive,
    productPrice: product.price,
    productSalePrice: product.sale_price,
    variantPrice: Number(v.price ?? product.price),
    variantSalePrice: v.sale_price,
    compareAtPrice: product.compare_at_price,
    discountPercent,
  }).effective;
}
