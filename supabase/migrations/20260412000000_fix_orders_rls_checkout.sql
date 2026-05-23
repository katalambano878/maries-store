-- Fix checkout: anon + authenticated must be able to INSERT orders/order_items.
-- Applied via Supabase MCP (user-marieshair) — keep in sync with production.

GRANT SELECT, INSERT, UPDATE ON public.orders TO anon;
GRANT SELECT, INSERT, UPDATE ON public.orders TO authenticated;
GRANT SELECT, INSERT ON public.order_items TO anon;
GRANT SELECT, INSERT ON public.order_items TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
DROP POLICY IF EXISTS "Users can create orders" ON public.orders;
DROP POLICY IF EXISTS "Anon can create guest orders" ON public.orders;
DROP POLICY IF EXISTS "Anyone can create orders" ON public.orders;
DROP POLICY IF EXISTS "Authenticated users can view own orders" ON public.orders;
DROP POLICY IF EXISTS "Anon view guest orders" ON public.orders;
DROP POLICY IF EXISTS "Anon can view guest orders" ON public.orders;
DROP POLICY IF EXISTS "Anon can view guest orders by email" ON public.orders;
DROP POLICY IF EXISTS "Users can update own orders" ON public.orders;
DROP POLICY IF EXISTS "Anon update guest orders" ON public.orders;
DROP POLICY IF EXISTS "Auth users view own orders" ON public.orders;
DROP POLICY IF EXISTS "Anyone can place orders" ON public.orders;
DROP POLICY IF EXISTS "Auth users update own orders" ON public.orders;

DROP POLICY IF EXISTS "Users can view own order items" ON public.order_items;
DROP POLICY IF EXISTS "Users can insert order items" ON public.order_items;
DROP POLICY IF EXISTS "Anyone can insert order items" ON public.order_items;
DROP POLICY IF EXISTS "View own order items" ON public.order_items;

CREATE POLICY "Auth users view own orders"
  ON public.orders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Anon view guest orders"
  ON public.orders FOR SELECT
  USING (user_id IS NULL);

CREATE POLICY "Anyone can place orders"
  ON public.orders FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Auth users update own orders"
  ON public.orders FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Anon update guest orders"
  ON public.orders FOR UPDATE
  USING (user_id IS NULL);

CREATE POLICY "View own order items"
  ON public.order_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = order_items.order_id
        AND (orders.user_id = auth.uid() OR orders.user_id IS NULL)
    )
  );

CREATE POLICY "Anyone can insert order items"
  ON public.order_items FOR INSERT
  WITH CHECK (true);
