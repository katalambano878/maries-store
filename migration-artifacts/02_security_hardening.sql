-- Close privilege holes inherited from the Supabase row-level security setup.
-- None of these paths is used by the storefront or dashboard; they were only
-- reachable by calling the data API directly.
--
-- 1. profiles: "auth.uid() = id" on UPDATE let any customer set their own
--    role to 'admin'. Only an admin (or server code) may change a role, and a
--    self-created profile is always a customer.
-- 2. orders: shoppers could UPDATE any guest order (user_id IS NULL) and their
--    own orders, e.g. set payment_status = 'paid'. The browser never updates
--    orders; payment confirmation and status changes run on the server or by
--    staff (covered by the staff policy).
-- 3. orders: an INSERT from the browser could arrive already 'paid'. New
--    browser orders always start pending; the payment callbacks mark them paid.

CREATE OR REPLACE FUNCTION public.caller_is_admin_or_server()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  -- No claims at all means a direct database session (operator, migration
  -- script), which is as trusted as the server; browser requests always
  -- carry 'anon' or 'authenticated'.
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'service_role') = 'service_role'
      OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$$;
REVOKE EXECUTE ON FUNCTION public.caller_is_admin_or_server() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.protect_profile_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.role IS DISTINCT FROM 'customer' AND NOT public.caller_is_admin_or_server() THEN
      NEW.role := 'customer';
    END IF;
  ELSIF NEW.role IS DISTINCT FROM OLD.role AND NOT public.caller_is_admin_or_server() THEN
    RAISE EXCEPTION 'Only an admin can change account roles' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.protect_profile_role() FROM PUBLIC;

DROP TRIGGER IF EXISTS protect_profile_role ON public.profiles;
CREATE TRIGGER protect_profile_role
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_role();

DO $$ DECLARE p record; BEGIN
  -- Policy names differ between environments; drop by definition.
  FOR p IN SELECT policyname FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'orders' AND cmd = 'UPDATE'
             AND qual IN ('(user_id IS NULL)', '(auth.uid() = user_id)') LOOP
    EXECUTE format('DROP POLICY %I ON public.orders', p.policyname);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.browser_orders_start_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'service_role') <> 'service_role'
     AND NOT public.is_admin_or_staff() THEN
    NEW.status := 'pending';
    NEW.payment_status := 'pending';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.browser_orders_start_pending() FROM PUBLIC;

DROP TRIGGER IF EXISTS browser_orders_start_pending ON public.orders;
CREATE TRIGGER browser_orders_start_pending
  BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.browser_orders_start_pending();
