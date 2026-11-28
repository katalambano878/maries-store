-- Take stock off the variant that was actually sold.
--
-- Stock was matched on the variant's name only. Colour variants ordered from
-- the product page carried labels like "Pink / Pink" (and no variant id), so
-- those sales never reduced stock (Trolley, Home Services Bag Big). Match the
-- variant id first, then the name, then the "colour / name" label.

CREATE OR REPLACE FUNCTION public.mark_order_paid(order_ref text, moolre_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE updated_order orders;
BEGIN
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;
  UPDATE orders SET payment_status = 'paid', status = CASE WHEN status = 'pending' THEN 'processing'::order_status WHEN status = 'awaiting_payment' THEN 'processing'::order_status ELSE status END, metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('moolre_reference', moolre_ref, 'payment_verified_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE order_number = order_ref RETURNING * INTO updated_order;
  IF updated_order.id IS NOT NULL AND (updated_order.metadata->>'stock_reduced') IS NULL THEN
    UPDATE products p SET quantity = GREATEST(0, p.quantity - oi.quantity) FROM order_items oi WHERE oi.order_id = updated_order.id AND oi.product_id = p.id;
    UPDATE product_variants pv SET quantity = GREATEST(0, pv.quantity - oi.quantity) FROM order_items oi WHERE oi.order_id = updated_order.id AND oi.product_id = pv.product_id AND (
      pv.id = oi.variant_id
      OR (oi.variant_id IS NULL AND oi.variant_name IS NOT NULL AND (
            pv.name = oi.variant_name
            OR coalesce(pv.option2, '') || ' / ' || pv.name = oi.variant_name)));
    UPDATE orders SET metadata = metadata || '{"stock_reduced": true}'::jsonb WHERE id = updated_order.id;
  END IF;
  RETURN to_jsonb(updated_order);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reduce_stock_on_order(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;
  UPDATE products p SET quantity = GREATEST(p.quantity - oi.quantity, 0), updated_at = now() FROM order_items oi WHERE oi.order_id = p_order_id AND oi.product_id = p.id;
  UPDATE product_variants pv SET quantity = GREATEST(pv.quantity - oi.quantity, 0), updated_at = now() FROM order_items oi WHERE oi.order_id = p_order_id AND oi.product_id = pv.product_id AND (
      pv.id = oi.variant_id
      OR (oi.variant_id IS NULL AND oi.variant_name IS NOT NULL AND (
            pv.name = oi.variant_name
            OR coalesce(pv.option2, '') || ' / ' || pv.name = oi.variant_name)));
END;
$function$;
