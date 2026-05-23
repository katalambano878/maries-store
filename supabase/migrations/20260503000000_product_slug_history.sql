-- =============================================================================
-- Product Slug History — supports permanent (308) redirects when a product's
-- slug changes, so old shared/indexed URLs don't 404.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.product_slug_history (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    old_slug text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Each old slug must map to exactly one product. If a slug is reused later,
-- the form layer is responsible for cleaning up the old history row first.
CREATE UNIQUE INDEX IF NOT EXISTS product_slug_history_old_slug_uidx
    ON public.product_slug_history (old_slug);

CREATE INDEX IF NOT EXISTS product_slug_history_product_id_idx
    ON public.product_slug_history (product_id);

ALTER TABLE public.product_slug_history ENABLE ROW LEVEL SECURITY;

-- Public can look up redirects (anon storefront needs this to resolve old URLs).
DROP POLICY IF EXISTS "Public read product_slug_history" ON public.product_slug_history;
CREATE POLICY "Public read product_slug_history"
    ON public.product_slug_history
    FOR SELECT
    USING (true);

-- Only staff can write entries (mirrors the products table policy).
DROP POLICY IF EXISTS "Staff manage product_slug_history" ON public.product_slug_history;
CREATE POLICY "Staff manage product_slug_history"
    ON public.product_slug_history
    FOR ALL
    USING (is_admin_or_staff())
    WITH CHECK (is_admin_or_staff());

COMMENT ON TABLE public.product_slug_history IS
    'Maps old product slugs to current products so /product/<old> can 308-redirect to /product/<current>.';
