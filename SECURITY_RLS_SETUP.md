# Supabase Row Level Security (RLS) Setup — CRITICAL

## Why This Is Urgent

Your Supabase anon key is public (visible in browser JavaScript). Without RLS, **anyone** can query ALL your tables directly using that key. This is the most likely way customer data was accessed.

## How to Enable RLS

Go to your Supabase Dashboard → **Database → Tables** (or **Table Editor**).

For EACH table below, click on the table, go to **Policies**, and:
1. **Enable RLS** (toggle it ON)
2. **Add the policies listed below**

You can also apply everything at once using the SQL block at the bottom of this document.

---

## Table: `orders`

### Enable RLS: YES

**Policy 1: Authenticated users can view their own orders**
```sql
CREATE POLICY "Users can view own orders"
ON orders FOR SELECT
TO authenticated
USING (auth.uid() = user_id);
```
> **Important:** Do NOT add `OR user_id IS NULL` to the SELECT policy. Guest orders must only be accessible server-side via the service role client (API routes), matched by order number + email together. Adding `user_id IS NULL` to SELECT would let anyone read all guest orders with just the anon key.

**Policy 2: Anyone can insert orders (guest + authenticated checkout)**
```sql
CREATE POLICY "Anyone can create orders"
ON orders FOR INSERT
WITH CHECK (
  auth.uid() = user_id
  OR user_id IS NULL
);
```
> This allows both authenticated users and guests to place orders. The `user_id IS NULL` is safe here because INSERT only creates a row — it doesn't expose existing data.

**Policy 3: Authenticated users can update their own pending orders (e.g. address correction)**
```sql
CREATE POLICY "Users can update own pending orders"
ON orders FOR UPDATE
TO authenticated
USING (auth.uid() = user_id AND status = 'pending')
WITH CHECK (auth.uid() = user_id);
```

> The service role key (used in API routes) bypasses RLS automatically — no policy needed for server-side operations.

---

## Table: `order_items`

### Enable RLS: YES

**Policy 1: Users can view items for their own orders**
```sql
CREATE POLICY "Users can view own order items"
ON order_items FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM orders
    WHERE orders.id = order_items.order_id
    AND orders.user_id = auth.uid()
  )
);
```

**Policy 2: Allow insert during checkout (guest + authenticated)**
```sql
CREATE POLICY "Anyone can insert order items during checkout"
ON order_items FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM orders
    WHERE orders.id = order_items.order_id
    AND (orders.user_id = auth.uid() OR orders.user_id IS NULL)
  )
);
```

---

## Table: `profiles`

### Enable RLS: YES

**Policy 1: Users can view their own profile**
```sql
CREATE POLICY "Users can view own profile"
ON profiles FOR SELECT
TO authenticated
USING (auth.uid() = id);
```

**Policy 2: Users can update their own profile**
```sql
CREATE POLICY "Users can update own profile"
ON profiles FOR UPDATE
TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);
```

**Policy 3: Users can insert their own profile (on first sign-up)**
```sql
CREATE POLICY "Users can insert own profile"
ON profiles FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = id);
```

> Never add a SELECT policy with `USING (true)` on profiles — that would expose every user's role and personal info to all authenticated users.

---

## Table: `customers`

### Enable RLS: YES

No public or authenticated-user policies. All access must go through server-side API routes using the service role key.

If you need an admin-facing policy (e.g. for a Supabase Studio view):
```sql
CREATE POLICY "Admins and staff can access customers"
ON customers FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role IN ('admin', 'staff')
  )
);
```

---

## Table: `cart_items`

### Enable RLS: YES

```sql
CREATE POLICY "Users can manage their own cart"
ON cart_items FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
```

---

## Table: `wishlist_items`

### Enable RLS: YES

```sql
CREATE POLICY "Users can manage their own wishlist"
ON wishlist_items FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
```

---

## Table: `addresses`

### Enable RLS: YES

```sql
CREATE POLICY "Users can manage their own addresses"
ON addresses FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
```

---

## Table: `notifications`

### Enable RLS: YES

```sql
CREATE POLICY "Users can view their own notifications"
ON notifications FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can mark their own notifications read"
ON notifications FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
```

> INSERT and DELETE on notifications should only happen server-side via the service role — no client-facing policies needed for those operations.

---

## Table: `products`

### Enable RLS: YES

```sql
CREATE POLICY "Public can view active products"
ON products FOR SELECT
USING (status IN ('active', 'published') OR status IS NULL);
```

> Admin writes go through the service role — no INSERT/UPDATE/DELETE policies needed for the anon or authenticated role.

---

## Table: `product_images`

### Enable RLS: YES

```sql
CREATE POLICY "Public can view product images"
ON product_images FOR SELECT
USING (true);
```

---

## Table: `categories`

### Enable RLS: YES

```sql
CREATE POLICY "Public can view categories"
ON categories FOR SELECT
USING (true);
```

---

## Table: `banners`

### Enable RLS: YES

```sql
CREATE POLICY "Public can view active banners"
ON banners FOR SELECT
USING (active = true OR active IS NULL);
```

---

## Table: `store_modules`

### Enable RLS: YES

```sql
CREATE POLICY "Public can view store modules"
ON store_modules FOR SELECT
USING (true);
```

---

## Table: `reviews`

### Enable RLS: YES

```sql
CREATE POLICY "Public can view approved reviews"
ON reviews FOR SELECT
USING (status = 'approved');

CREATE POLICY "Authenticated users can submit reviews"
ON reviews FOR INSERT
TO authenticated
WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Users can update their own pending reviews"
ON reviews FOR UPDATE
TO authenticated
USING (auth.uid() = user_id AND status = 'pending')
WITH CHECK (auth.uid() = user_id);
```

---

## Table: `blog_posts`

### Enable RLS: YES

```sql
CREATE POLICY "Public can view published blog posts"
ON blog_posts FOR SELECT
USING (status = 'published');
```

---

## Table: `site_settings`, `navigation`, `cms_content`, `pages`

### Enable RLS: YES

```sql
-- Apply this pattern to each table:
CREATE POLICY "Public read access"
ON <table_name> FOR SELECT
USING (true);
```

> Admin writes go through the service role only.

---

## Catch-All Rule for Unlisted Tables

For any table not listed above:

1. **Enable RLS** — always.
2. If it holds user-specific data: add `USING (auth.uid() = user_id)` SELECT policy.
3. If it's public reference data: add `USING (true)` SELECT policy.
4. If in doubt: **enable RLS with NO policies** — this blocks all anon/authenticated access, and server-side service role access still works.

---

## Environment Variables to Add

Add to your `.env.local`:
```
# Required for payment callback verification — get from Moolre dashboard
MOOLRE_CALLBACK_SECRET=<strong random string or value from Moolre dashboard>

# Must NOT have NEXT_PUBLIC_ prefix — server-side only
SUPABASE_SERVICE_ROLE_KEY=<your service role key>
```

Confirm `SUPABASE_SERVICE_ROLE_KEY` does NOT appear anywhere with `NEXT_PUBLIC_` prefix in any `.env*` file or in `next.config.js`.

---

## Apply Everything at Once (SQL Migration)

You can run this in Supabase SQL Editor or via `apply_migration`:

```sql
-- Enable RLS on all sensitive tables
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE banners ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;

-- Drop any existing overly-permissive policies before recreating
-- (adjust names to match what exists in your project)
DROP POLICY IF EXISTS "Allow public read" ON orders;
DROP POLICY IF EXISTS "Enable read access for all users" ON orders;
DROP POLICY IF EXISTS "Allow anonymous select" ON orders;

-- ORDERS
CREATE POLICY "Users can view own orders"
ON orders FOR SELECT TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Anyone can create orders"
ON orders FOR INSERT
WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Users can update own pending orders"
ON orders FOR UPDATE TO authenticated
USING (auth.uid() = user_id AND status = 'pending')
WITH CHECK (auth.uid() = user_id);

-- ORDER ITEMS
CREATE POLICY "Users can view own order items"
ON order_items FOR SELECT TO authenticated
USING (
  EXISTS (SELECT 1 FROM orders WHERE orders.id = order_items.order_id AND orders.user_id = auth.uid())
);

CREATE POLICY "Anyone can insert order items during checkout"
ON order_items FOR INSERT
WITH CHECK (
  EXISTS (SELECT 1 FROM orders WHERE orders.id = order_items.order_id AND (orders.user_id = auth.uid() OR orders.user_id IS NULL))
);

-- PROFILES
CREATE POLICY "Users can view own profile"
ON profiles FOR SELECT TO authenticated USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
ON profiles FOR UPDATE TO authenticated
USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
ON profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

-- CART / WISHLIST / ADDRESSES
CREATE POLICY "Users can manage their own cart"
ON cart_items FOR ALL TO authenticated
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage their own wishlist"
ON wishlist_items FOR ALL TO authenticated
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage their own addresses"
ON addresses FOR ALL TO authenticated
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- NOTIFICATIONS
CREATE POLICY "Users can view their own notifications"
ON notifications FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can mark their own notifications read"
ON notifications FOR UPDATE TO authenticated
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- PRODUCTS / CATALOG
CREATE POLICY "Public can view active products"
ON products FOR SELECT USING (status IN ('active', 'published') OR status IS NULL);

CREATE POLICY "Public can view product images"
ON product_images FOR SELECT USING (true);

CREATE POLICY "Public can view categories"
ON categories FOR SELECT USING (true);

CREATE POLICY "Public can view active banners"
ON banners FOR SELECT USING (active = true OR active IS NULL);

CREATE POLICY "Public can view store modules"
ON store_modules FOR SELECT USING (true);

-- REVIEWS
CREATE POLICY "Public can view approved reviews"
ON reviews FOR SELECT USING (status = 'approved');

CREATE POLICY "Authenticated users can submit reviews"
ON reviews FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);

-- BLOG
CREATE POLICY "Public can view published blog posts"
ON blog_posts FOR SELECT USING (status = 'published');
```

---

## Verification

After setting up RLS, test from your browser DevTools console (while logged out):

```javascript
// Should return empty array or error — NOT data
const { data: orders } = await supabase.from('orders').select('*');
console.assert(orders.length === 0, 'FAIL: orders exposed to anon');

const { data: customers } = await supabase.from('customers').select('*');
console.assert(customers.length === 0, 'FAIL: customers exposed to anon');

const { data: profiles } = await supabase.from('profiles').select('*');
console.assert(profiles.length === 0, 'FAIL: profiles exposed to anon');

// Should return data (public tables)
const { data: products } = await supabase.from('products').select('id, name').limit(1);
console.assert(products.length > 0, 'FAIL: products not accessible');
```

Then log in as a regular (non-admin) customer and verify:
- You can see your own orders
- You cannot see other users' orders (test with a known order ID from a different account)
- You can view and update your own profile
- You cannot read the `customers` table at all

---

## Summary of All Changes Made in Code

1. **Payment verify endpoint** — No longer trusts `fromRedirect` flag; only Moolre API verification counts
2. **Payment initiation** — Amount always fetched from database; client-provided amount rejected
3. **Payment callback** — Signature verification is mandatory when secret is configured; amount mismatches rejected with 400
4. **Middleware** — Full server-side auth check for all `/admin` routes; uses `getUser()` not `getSession()`
5. **Notifications API** — All sensitive types require verified admin/staff token; contact form validated and rate-limited
6. **Order tracking** — Email + order number both required; server-side lookup via service role; fields explicitly selected
7. **HTML sanitization** — `lib/sanitize.ts` created; all user input escaped before insertion into HTML emails
8. **Security headers** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` added
9. **CSRF guard** — Origin header checked on all browser-facing POST endpoints
10. **Structured logging** — Security events logged in parseable JSON format
11. **`lib/supabase-admin.ts`** — Service role client isolated from client-side code
12. **`lib/auth.ts`** — Shared `verifyAuth()` and `verifyAdminToken()` used consistently across all API routes
