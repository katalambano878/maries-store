-- After reducing variant stock, re-sync products.quantity = SUM(variant quantities)
-- so both tables always reflect the same truth for variant products.
CREATE OR REPLACE FUNCTION public.mark_order_paid(order_ref text, moolre_ref text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  updated_order orders;
BEGIN
  -- 1. Mark order as paid
  UPDATE orders
  SET
    payment_status = 'paid',
    status = CASE
        WHEN status = 'pending' THEN 'processing'::order_status
        WHEN status = 'awaiting_payment' THEN 'processing'::order_status
        ELSE status
    END,
    metadata = COALESCE(metadata, '{}'::jsonb) ||
               jsonb_build_object(
                   'moolre_reference', moolre_ref,
                   'payment_verified_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               )
  WHERE order_number = order_ref
  RETURNING * INTO updated_order;

  IF updated_order.id IS NOT NULL THEN
    IF (updated_order.metadata->>'stock_reduced') IS NULL THEN

      -- 2. Reduce product-level stock
      UPDATE products p
      SET quantity = GREATEST(0, p.quantity - oi.quantity)
      FROM order_items oi
      WHERE oi.order_id = updated_order.id
        AND oi.product_id = p.id;

      -- 3. Reduce variant-level stock (by id first, name fallback for legacy orders)
      UPDATE product_variants pv
      SET quantity = GREATEST(0, pv.quantity - oi.quantity)
      FROM order_items oi
      WHERE oi.order_id = updated_order.id
        AND (
          (oi.variant_id IS NOT NULL AND pv.id = oi.variant_id)
          OR
          (oi.variant_id IS NULL AND oi.variant_name IS NOT NULL
           AND pv.product_id = oi.product_id
           AND pv.name = oi.variant_name)
        );

      -- 4. Re-sync products.quantity to sum of its variant quantities
      --    for every product in this order that has variants.
      --    This ensures products.quantity always equals what the variants show.
      UPDATE products p
      SET quantity = (
        SELECT COALESCE(SUM(pv2.quantity), 0)
        FROM product_variants pv2
        WHERE pv2.product_id = p.id
      )
      WHERE p.id IN (
        SELECT DISTINCT oi.product_id
        FROM order_items oi
        WHERE oi.order_id = updated_order.id
      )
      AND EXISTS (
        SELECT 1 FROM product_variants pv3 WHERE pv3.product_id = p.id
      );

      -- 5. Flag so we never double-deduct
      UPDATE orders
      SET metadata = metadata || '{"stock_reduced": true}'::jsonb
      WHERE id = updated_order.id;

    END IF;
  ELSE
    SELECT * INTO updated_order FROM orders WHERE order_number = order_ref;
  END IF;

  RETURN to_jsonb(updated_order);
END;
$$;
