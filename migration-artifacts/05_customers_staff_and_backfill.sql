-- Customers: let POS staff save walk-in customers, and backfill the list.
--
-- upsert_customer_from_order only allowed the server role, so the POS
-- "save customer" button (run by signed-in staff) was refused and the POS
-- customer picker never grew past 3 rows. Shoppers stay blocked.
--
-- The backfill adds one customer per person who has a paid order and no
-- customer row yet: guests are matched by phone (last 9 digits), else email.
-- Existing rows are left untouched. Safe to run twice.

CREATE OR REPLACE FUNCTION public.upsert_customer_from_order(p_email text, p_phone text, p_full_name text, p_first_name text, p_last_name text, p_user_id uuid DEFAULT NULL::uuid, p_address jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_customer_id UUID; v_existing_email TEXT; v_existing_phone TEXT; v_existing_secondary_email TEXT; v_existing_secondary_phone TEXT;
BEGIN
  -- Server code and signed-in staff (POS "save customer") may write customers; shoppers may not.
  IF auth.role() != 'service_role' AND NOT public.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Access denied: service_role or staff required';
  END IF;
  SELECT id, email, phone, secondary_email, secondary_phone INTO v_customer_id, v_existing_email, v_existing_phone, v_existing_secondary_email, v_existing_secondary_phone FROM customers WHERE email = p_email OR secondary_email = p_email LIMIT 1;
  IF v_customer_id IS NULL AND p_phone IS NOT NULL AND p_phone != '' THEN
    SELECT id, email, phone, secondary_email, secondary_phone INTO v_customer_id, v_existing_email, v_existing_phone, v_existing_secondary_email, v_existing_secondary_phone FROM customers WHERE phone = p_phone OR secondary_phone = p_phone LIMIT 1;
  END IF;
  IF v_customer_id IS NULL THEN
    INSERT INTO customers (email, phone, full_name, first_name, last_name, user_id, default_address) VALUES (p_email, p_phone, p_full_name, p_first_name, p_last_name, p_user_id, p_address) RETURNING id INTO v_customer_id;
  ELSE
    UPDATE customers SET secondary_email = CASE WHEN p_email IS NOT NULL AND p_email != '' AND p_email != v_existing_email AND (v_existing_secondary_email IS NULL OR v_existing_secondary_email = '' OR v_existing_secondary_email != p_email) THEN p_email ELSE secondary_email END, secondary_phone = CASE WHEN p_phone IS NOT NULL AND p_phone != '' AND p_phone != v_existing_phone AND (v_existing_secondary_phone IS NULL OR v_existing_secondary_phone = '' OR v_existing_secondary_phone != p_phone) THEN p_phone ELSE secondary_phone END, full_name = COALESCE(NULLIF(p_full_name, ''), full_name), first_name = COALESCE(NULLIF(p_first_name, ''), first_name), last_name = COALESCE(NULLIF(p_last_name, ''), last_name), user_id = user_id /* not re-linked by a public call (2026-11-27) */, default_address = COALESCE(p_address, default_address), updated_at = NOW() WHERE id = v_customer_id;
  END IF;
  RETURN v_customer_id;
END;
$function$;

WITH paid AS (
  SELECT o.*,
         right(regexp_replace(coalesce(nullif(o.phone, ''), o.shipping_address->>'phone', ''), '\D', '', 'g'), 9) AS phone9,
         CASE WHEN o.email ~* '^guest-[0-9]+@shopmarieshair\.com$' OR o.email ILIKE '%@store.local' OR o.email ILIKE '%@pos.local'
              THEN NULL ELSE lower(o.email) END AS real_email
  FROM orders o
  WHERE o.payment_status = 'paid' AND o.status <> 'cancelled'
), keyed AS (
  SELECT p.*,
         CASE WHEN length(p.phone9) = 9 THEN 'p:' || p.phone9 WHEN p.real_email IS NOT NULL THEN 'e:' || p.real_email END AS ckey
  FROM paid p
), people AS (
  SELECT ckey,
         count(*) AS orders,
         sum(total) AS spent,
         max(created_at) AS last_at,
         min(created_at) AS first_at,
         (array_agg(real_email ORDER BY created_at DESC) FILTER (WHERE real_email IS NOT NULL))[1] AS email,
         (array_agg(phone9 ORDER BY created_at DESC) FILTER (WHERE length(phone9) = 9))[1] AS phone9,
         (array_agg(user_id ORDER BY created_at DESC) FILTER (WHERE user_id IS NOT NULL))[1] AS user_id,
         (array_agg(coalesce(shipping_address->>'firstName', metadata->>'first_name') ORDER BY created_at DESC))[1] AS first_name,
         (array_agg(coalesce(shipping_address->>'lastName', metadata->>'last_name') ORDER BY created_at DESC))[1] AS last_name
  FROM keyed
  WHERE ckey IS NOT NULL
  GROUP BY ckey
)
INSERT INTO customers (email, phone, full_name, first_name, last_name, user_id, total_orders, total_spent, last_order_at, created_at)
SELECT coalesce(pe.email, pe.phone9 || '@pos.local'),
       CASE WHEN pe.phone9 IS NOT NULL THEN '0' || pe.phone9 END,
       nullif(trim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')), ''),
       pe.first_name, pe.last_name, pe.user_id, pe.orders, pe.spent, pe.last_at, pe.first_at
FROM people pe
WHERE NOT EXISTS (
  SELECT 1 FROM customers c
  WHERE lower(c.email) = coalesce(pe.email, pe.phone9 || '@pos.local')
     OR lower(c.secondary_email) = coalesce(pe.email, pe.phone9 || '@pos.local')
     OR (pe.phone9 IS NOT NULL AND right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 9) = pe.phone9)
     OR (pe.phone9 IS NOT NULL AND right(regexp_replace(coalesce(c.secondary_phone, ''), '\D', '', 'g'), 9) = pe.phone9)
)
ON CONFLICT (email) DO NOTHING;
