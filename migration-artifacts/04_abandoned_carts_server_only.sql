-- Abandoned carts are written only by /api/abandoned-cart (server role).
--
-- Supabase let anyone INSERT any cart and UPDATE every cart (USING true): a
-- stranger could rewrite other shoppers' carts, phone numbers included, and
-- so redirect the reminder SMS. Checkout now saves and recovers carts through
-- the server route, so the public write policies go. Staff keep reading them.

DO $$ DECLARE p record; BEGIN
  FOR p IN SELECT policyname, cmd FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'abandoned_carts'
             AND cmd IN ('INSERT', 'UPDATE')
             AND coalesce(qual, 'true') = 'true' AND coalesce(with_check, 'true') = 'true' LOOP
    EXECUTE format('DROP POLICY %I ON public.abandoned_carts', p.policyname);
    RAISE NOTICE 'dropped abandoned_carts.% (%)', p.policyname, p.cmd;
  END LOOP;
END $$;
