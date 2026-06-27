/**
 * Server-side order preparation before payment initiation:
 * re-price from DB, validate stock, auto-remove unavailable lines.
 */
import { supabaseAdmin } from '@/lib/supabase-admin';
import { parseStorePricingValue, resolveCartLineUnitPrice } from '@/lib/pricing';

const ORDER_SELECT =
  'id, order_number, email, phone, subtotal, tax_total, shipping_total, discount_total, total, payment_status, metadata, shipping_address';

export interface RemovedOrderItem {
  order_item_id: string;
  product_name: string;
  variant_name: string | null;
  quantity: number;
  reason: string;
}

export interface PreparedOrder {
  order: Record<string, unknown>;
  removedItems: RemovedOrderItem[];
  repriced: boolean;
}

async function findOrderByIdOrNumber(orderId: string): Promise<Record<string, unknown> | null> {
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);

  if (isUUID) {
    const { data: byId } = await supabaseAdmin
      .from('orders')
      .select(ORDER_SELECT)
      .eq('id', orderId)
      .maybeSingle();
    if (byId) return byId as Record<string, unknown>;

    const { data: byNumber } = await supabaseAdmin
      .from('orders')
      .select(ORDER_SELECT)
      .eq('order_number', orderId)
      .maybeSingle();
    return (byNumber as Record<string, unknown>) ?? null;
  }

  const { data } = await supabaseAdmin
    .from('orders')
    .select(ORDER_SELECT)
    .eq('order_number', orderId)
    .maybeSingle();
  return (data as Record<string, unknown>) ?? null;
}

function findVariant(
  product: {
    product_variants?: Array<{
      id: string;
      name?: string | null;
      option1?: string | null;
      option2?: string | null;
      quantity?: number | null;
    }>;
  },
  variantId: string | null,
  variantName: string | null
) {
  const variants = product.product_variants || [];
  if (variantId) return variants.find((v) => v.id === variantId);
  if (!variantName?.trim()) return null;

  const parts = variantName
    .split(' / ')
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    const hit = variants.find(
      (x) => (x.option2 || '').trim() === parts[0] && (x.name || '').trim() === parts[1]
    );
    if (hit) return hit;
  }
  if (parts.length === 1) {
    return variants.find(
      (x) => (x.name || '').trim() === parts[0] || (x.option2 || '').trim() === parts[0]
    );
  }
  return null;
}

function availableStock(
  product: { quantity?: number | null; track_quantity?: boolean | null },
  variant: { quantity?: number | null } | null
): number | null {
  const track = product.track_quantity !== false;
  if (!track) return null; // unlimited
  if (variant) return Number(variant.quantity ?? 0);
  return Number(product.quantity ?? 0);
}

/**
 * Re-price order lines from authoritative product/variant prices and validate stock.
 * Updates the order row when totals change or items are removed.
 */
export async function prepareOrderForPayment(orderId: string): Promise<PreparedOrder | { error: string; status: number }> {
  const order = await findOrderByIdOrNumber(orderId);
  if (!order) return { error: 'Order not found', status: 404 };

  if (order.payment_status === 'paid') {
    return { error: 'Order is already paid', status: 400 };
  }

  const orderIdUuid = order.id as string;

  const { data: orderItems, error: itemsErr } = await supabaseAdmin
    .from('order_items')
    .select('id, product_id, product_name, variant_id, variant_name, quantity, unit_price, total_price')
    .eq('order_id', orderIdUuid);

  if (itemsErr) {
    return { error: 'Failed to load order items', status: 500 };
  }

  const items = orderItems || [];
  if (items.length === 0) {
    return { error: 'Order has no items', status: 400 };
  }

  const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))];

  const { data: pricingRow } = await supabaseAdmin
    .from('site_settings')
    .select('value')
    .eq('key', 'store_pricing')
    .maybeSingle();
  const { sales_active: salesActive, discount_percent: discountPercent } = parseStorePricingValue(
    pricingRow?.value
  );

  const { data: products, error: prodErr } = await supabaseAdmin
    .from('products')
    .select(
      'id, price, sale_price, compare_at_price, quantity, track_quantity, product_variants(id, name, option1, option2, price, sale_price, quantity)'
    )
    .in('id', productIds);

  if (prodErr) {
    return { error: 'Failed to load product prices', status: 500 };
  }

  const productMap = new Map((products || []).map((p) => [p.id, p]));

  const removedItems: RemovedOrderItem[] = [];
  let computedSubtotal = 0;
  const keptItemUpdates: Array<{ id: string; unit_price: number; total_price: number }> = [];

  for (const item of items) {
    const product = productMap.get(item.product_id);
    if (!product) {
      removedItems.push({
        order_item_id: item.id,
        product_name: item.product_name,
        variant_name: item.variant_name,
        quantity: item.quantity,
        reason: 'product_not_found',
      });
      continue;
    }

    const variant = findVariant(product, item.variant_id, item.variant_name) ?? null;
    const stock = availableStock(product, variant);

    if (stock !== null && stock <= 0) {
      removedItems.push({
        order_item_id: item.id,
        product_name: item.product_name,
        variant_name: item.variant_name,
        quantity: item.quantity,
        reason: 'out_of_stock',
      });
      continue;
    }

    if (stock !== null && stock < item.quantity) {
      removedItems.push({
        order_item_id: item.id,
        product_name: item.product_name,
        variant_name: item.variant_name,
        quantity: item.quantity,
        reason: `insufficient_stock (${stock} available)`,
      });
      continue;
    }

    const unit = resolveCartLineUnitPrice(
      product,
      item.variant_name,
      salesActive,
      discountPercent
    );
    const lineTotal = unit * item.quantity;
    computedSubtotal += lineTotal;
    keptItemUpdates.push({
      id: item.id,
      unit_price: unit,
      total_price: lineTotal,
    });
  }

  if (keptItemUpdates.length === 0) {
    return { error: 'All items are out of stock', status: 409 };
  }

  for (const removed of removedItems) {
    await supabaseAdmin.from('order_items').delete().eq('id', removed.order_item_id);
  }

  for (const upd of keptItemUpdates) {
    await supabaseAdmin
      .from('order_items')
      .update({ unit_price: upd.unit_price, total_price: upd.total_price })
      .eq('id', upd.id);
  }

  const taxTotal = Number(order.tax_total || 0);
  const shippingTotal = Number(order.shipping_total || 0);
  const discountTotal = Number(order.discount_total || 0);
  const computedTotal = computedSubtotal + taxTotal + shippingTotal - discountTotal;
  const storedTotal = Number(order.total || 0);
  const repriced = Math.abs(storedTotal - computedTotal) > 0.01 || removedItems.length > 0;

  const existingMeta =
    order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata)
      ? (order.metadata as Record<string, unknown>)
      : {};

  const metaUpdates: Record<string, unknown> = { ...existingMeta };
  if (removedItems.length > 0) {
    metaUpdates.auto_removed_items = removedItems;
  }
  if (repriced && Math.abs(storedTotal - computedTotal) > 0.01) {
    metaUpdates.server_repriced_at = new Date().toISOString();
    metaUpdates.client_total_attempted = storedTotal;
  }

  if (repriced) {
    await supabaseAdmin
      .from('orders')
      .update({
        subtotal: computedSubtotal,
        total: computedTotal,
        metadata: metaUpdates,
      })
      .eq('id', orderIdUuid);

    order.subtotal = computedSubtotal;
    order.total = computedTotal;
    order.metadata = metaUpdates;
  }

  return { order, removedItems, repriced };
}
