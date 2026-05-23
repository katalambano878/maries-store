-- Fix: reduce variant stock by variant_id (exact UUID) instead of variant_name text match.
-- Falls back to product_id + variant_name for legacy order_items that have no variant_id.
CREATE OR REPLACE FUNCTION public.mark_order_paid(order_ref text, moolre_ref text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  updated_order orders;
BEGIN
  -- 1. Update the order to paid
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

  -- 2. Reduce stock (only if we found the order and haven't reduced yet)
  IF updated_order.id IS NOT NULL THEN
      IF (updated_order.metadata->>'stock_reduced') IS NULL THEN
          
          -- Reduce main product stock
          UPDATE products p
          SET quantity = GREATEST(0, p.quantity - oi.quantity)
          FROM order_items oi
          WHERE oi.order_id = updated_order.id
            AND oi.product_id = p.id;

          -- Reduce variant stock: prefer exact variant_id match (precise),
          -- fall back to product_id + variant_name for older orders without variant_id
          UPDATE product_variants pv
          SET quantity = GREATEST(0, pv.quantity - oi.quantity)
          FROM order_items oi
          WHERE oi.order_id = updated_order.id
            AND (
              -- Primary: match by variant UUID (exact, no ambiguity)
              (oi.variant_id IS NOT NULL AND pv.id = oi.variant_id)
              OR
              -- Fallback: match by product + name for rows without a variant_id
              (oi.variant_id IS NULL AND oi.variant_name IS NOT NULL
               AND pv.product_id = oi.product_id
               AND pv.name = oi.variant_name)
            );
            
          -- Flag as reduced so we never double-deduct
          UPDATE orders 
          SET metadata = metadata || '{"stock_reduced": true}'::jsonb
          WHERE id = updated_order.id;
          
      END IF;
  ELSE
      -- Fallback search
      SELECT * INTO updated_order FROM orders WHERE order_number = order_ref;
  END IF;

  RETURN to_jsonb(updated_order);
END;
$$;
