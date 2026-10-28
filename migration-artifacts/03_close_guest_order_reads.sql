-- Stop the public data API from listing guest orders.
--
-- Supabase's policies let anyone read every order with user_id IS NULL (and
-- its items): names, phones, emails and delivery addresses of all guest
-- shoppers, in one request. The storefront now reads a single order through
-- /api/orders/<ref> (exact order number or id, contact check for tracking)
-- and checkout no longer reads the order back after inserting it, so these
-- policies are no longer needed. Signed-in customers keep reading their own
-- orders; staff keep reading everything.

DO $$ DECLARE p record; BEGIN
  FOR p IN SELECT tablename, policyname FROM pg_policies
           WHERE schemaname = 'public' AND cmd = 'SELECT'
             AND (
               (tablename = 'orders' AND qual = '(user_id IS NULL)')
               OR (tablename = 'order_items' AND qual LIKE '%orders.user_id IS NULL%')
             ) LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename);
    RAISE NOTICE 'dropped %.%', p.tablename, p.policyname;
  END LOOP;
END $$;
