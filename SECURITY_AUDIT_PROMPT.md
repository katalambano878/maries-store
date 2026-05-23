# Security Audit & Fix Prompt

> **Use this prompt with Cursor Agent (or any AI coding assistant) to perform a full security audit and fix on any project built from the standardecom framework.**
>
> **Prerequisites:** Ensure the AI has access to your Supabase MCP connection before starting.

---

## The Prompt

Copy everything below this line and paste it as your message to the AI:

---

I need you to perform a comprehensive security audit and fix every vulnerability in this project. This is a Next.js e-commerce application using Supabase (database + auth), Moolre (payment gateway), and Resend/Moolre SMS (notifications). You have access to the Supabase MCP — use it to inspect and fix the database directly.

Work through every category below. For each one, investigate the current state, report what you find, and then **fix it immediately** — don't just report issues.

---

### 1. SUPABASE ROW LEVEL SECURITY (RLS)

**Use the Supabase MCP tools** to do all of the following:

- Run `list_tables` to get all tables and check `rls_enabled` status on each one.
- Run `execute_sql` to query `pg_policies` and review every policy on every table:
  ```sql
  SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies WHERE schemaname = 'public'
  ORDER BY tablename, policyname;
  ```
- **Flag any policy** where `qual` is `true` (unqualified) on sensitive tables (orders, customers, profiles, order_items, cart_items, wishlist_items, addresses, notifications).
- **Flag any policy** where `qual` contains `user_id IS NULL` on SELECT operations — this allows anonymous read access to guest order data.
- **Flag any policy** that grants `SELECT`, `UPDATE`, or `ALL` to the `anon` role on sensitive tables.
- **Drop dangerous policies** and replace them with secure ones:
  - `orders`: Authenticated users can only SELECT their own orders (`auth.uid() = user_id`). Guest orders (where `user_id IS NULL`) are NOT selectable by anyone via the anon key — only via the service role in API routes.
  - `order_items`: Users can only see items belonging to their own orders (via JOIN to orders table).
  - `profiles`: Users can only see/update their own profile (`auth.uid() = id`).
  - `customers`: Admin/staff only via service role. No public policies.
  - `cart_items`, `wishlist_items`, `addresses`, `notifications`: Owner only (`auth.uid() = user_id`).
  - Public data tables (products, categories, banners, images, pages, cms_content, site_settings, store_modules, navigation, blog_posts with `status = 'published'`): Public SELECT is fine.
  - `reviews`: Public SELECT for approved reviews; INSERT requires `auth.uid() IS NOT NULL`.
- Apply all fixes using `apply_migration`.

**Important distinction on guest orders:** The INSERT policy for orders must allow `user_id IS NULL` (so guest checkout works), but the SELECT policy must NOT. Guest order lookups must go through a server-side API route using the service role key, verified by matching the order number AND email address together.

### 2. SUPABASE FUNCTIONS (RPC)

- Run `execute_sql` to list all public SECURITY DEFINER functions:
  ```sql
  SELECT p.proname, pg_catalog.pg_get_function_arguments(p.oid) as args,
         CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'INVOKER' END as security
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' ORDER BY p.proname;
  ```
- **Any SECURITY DEFINER function that has no auth check inside is exploitable.** Anyone can call it via `POST /rest/v1/rpc/function_name` with just the anon key, and it bypasses ALL RLS.
- Read the definition of each SECURITY DEFINER function using `pg_get_functiondef(oid)`.
- **Classify each function** before applying a fix:
  - Functions that **should only be called server-side** (mark as paid, update stock, access customer data): Add `IF auth.role() != 'service_role' THEN RAISE EXCEPTION 'Access denied'; END IF;` at the top.
  - Functions that **admin/staff can call** (bulk operations, reporting): Add `IF auth.role() != 'service_role' AND NOT is_admin_or_staff() THEN RAISE EXCEPTION 'Access denied'; END IF;` at the top.
  - Functions that **any authenticated user can call** (e.g. get their own order summary): Add `IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;` at the top.
  - Functions that **must be callable by anonymous users** (e.g. check product availability): Convert to SECURITY INVOKER — they don't need elevated privileges.
- Pay special attention to functions that: return customer data, modify orders (mark as paid), modify stock, send notifications, or modify customer records.
- Apply all fixes using `apply_migration`.

### 3. PAYMENT ENDPOINTS

Read every file under `app/api/payment/` and fix these issues:

**Payment initiation (`app/api/payment/moolre/route.ts`):**
- The `amount` must NEVER come from the client request body. Always fetch the order from the database using the service role key and use `order.total`.
- Verify the order exists and has `status = 'pending'` before generating a payment link.
- If the order is already paid, return a 409 Conflict — not a 200.
- Add a server-side idempotency check: if a payment link was already generated for this order in the last 30 minutes, return the existing one rather than generating a new one.

**Payment verification (`app/api/payment/moolre/verify/route.ts`):**
- NEVER trust a client-provided flag like `fromRedirect: true` as proof of payment. This lets anyone mark any order as paid by sending `{ orderNumber: "ORD-xxx", fromRedirect: true }`.
- The ONLY trusted source is the payment provider's API. Call Moolre's verification endpoint using the reference/transaction ID, and confirm the returned amount matches `order.total` exactly.
- Add rate limiting: maximum 5 verification attempts per order number per 15 minutes using an in-memory or Redis-backed store.
- Log all verification attempts (order number, IP, result) for audit purposes.

**Payment callback (`app/api/payment/moolre/callback/route.ts`):**
- Secret verification must be MANDATORY when `MOOLRE_CALLBACK_SECRET` is set. If the HMAC/signature doesn't match, reject with 403 immediately — before processing any payload.
- Amount mismatch must REJECT the callback and return 400 — not just log a warning.
- Success validation must be strict: only accept explicit success status codes from Moolre (e.g. `status === 'SUCCESSFUL'`). Do not use string `.includes()` or loose matching on the message field.
- Use the server-side Supabase admin client (service role key) — never the anon client.
- After marking an order paid, emit a database event or call the notifications API server-side — do not rely on the client to trigger post-payment actions.

**Order success page (`app/(store)/order-success/page.tsx`):**
- Remove the `fromRedirect: true` parameter entirely.
- The page should display order confirmation data fetched server-side using the order number + email match — not by calling the verify endpoint.

### 4. MIDDLEWARE & ADMIN AUTHENTICATION

**Read `middleware.ts`** — if it only sets headers and doesn't verify authentication, it needs a full rewrite:

- For all `/admin` routes (except `/admin/login`), verify the Supabase session server-side.
- Read the Supabase auth cookie. The cookie name varies by Supabase version:
  - Older versions: `sb-<project-ref>-auth-token`
  - Newer versions (SSR package): check for `sb-access-token` or use `@supabase/ssr` `createServerClient`
- Extract the access token and call `supabase.auth.getUser(token)` — do NOT use `getSession()` for auth decisions (it reads from cookie without server verification).
- After confirming the user, query `profiles` table for `role IN ('admin', 'staff')` using the service role client.
- If auth or role check fails, redirect to `/admin/login?reason=unauthorized`.
- Add security headers on all routes:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - For admin routes also: `Cache-Control: no-store, no-cache, must-revalidate`

**Check `app/admin/layout.tsx`** — if auth is only in a client-side `useEffect`, it can be bypassed before React hydrates. The middleware fix provides the server-side gate; the layout check is just a UX fallback, not a security control. Make this explicit in a comment.

**Check all `app/admin/**/page.tsx` files** — any page that fetches sensitive data should also call `verifyAuth()` at the top of the server component, as a defence-in-depth measure in case middleware is misconfigured.

### 5. NOTIFICATION API

Read `app/api/notifications/route.ts` and fix:

- **ALL notification types that send emails/SMS must require authentication**, except `contact` (public contact form).
- Types requiring admin/staff auth: `campaign`, `order_updated`, `order_status`, `payment_link`, `welcome`, `test_sms`. Verify the Bearer token using `verifyAdminToken()` from `lib/auth.ts`.
- Type `order_created`: Verify the order exists in the database AND was created within the last 10 minutes AND matches the authenticated user's session OR was placed from the same IP (for guest orders). Do not allow arbitrary order IDs.
- Type `contact`: 
  - Validate email format using `isValidEmail()`.
  - Enforce length limits: name ≤ 100 chars, subject ≤ 200 chars, message ≤ 5000 chars, phone ≤ 20 chars.
  - Strip all HTML from all fields using `escapeHtml()`.
  - Rate limit by IP: maximum 3 contact submissions per hour.
  - Do NOT echo user input back in the success response.
- Log all notification sends with timestamp, type, recipient (hashed), and success/failure for auditing.

### 6. ORDER TRACKING

Read `app/(store)/order-tracking/page.tsx` and fix:

- Email verification must be **mandatory**. Without it, anyone with an order number can retrieve full customer PII (name, address, phone, email, line items).
- Both the order number AND the email must match before returning any order data.
- The lookup must be done server-side via an API route using the service role client — never directly from the client using the anon key.
- The email field label must say "Email address (required)", not "optional".
- The form must not submit (and the server must reject the request) if email is missing or invalid.
- Auto-tracking from URL parameters must also require an `email` parameter — if it's absent, show the form rather than auto-fetching.
- Explicitly select only the fields needed for display. Never use `select('*')`. A safe field list: `order_number, status, created_at, total, currency, items(product_name, quantity, unit_price), shipping_address(city, region, country)`. Do NOT return: `customer_email`, `customer_phone`, `full_shipping_address`, `payment_reference` in the tracking response.
- Rate limit by IP: maximum 10 lookups per 15 minutes.

### 7. SERVER ACTIONS

Read all files under `app/admin/` that use `'use server'` or server actions:

- Every server action must call `verifyAuth(request, { requireAdmin: true })` at the very top — before accessing any input data.
- Wrap all server action logic in `try/catch`. Never let Next.js serialize a raw `Error` to the client — it may expose stack traces or internal paths. Return a sanitized `{ error: 'Something went wrong' }` instead.
- Validate all inputs using a schema validation library (e.g. Zod). Reject requests with unexpected field types or values before processing.
- For file uploads in server actions: validate MIME type server-side (not just the extension), enforce a maximum file size, and scan for executable content.
- Avoid using `revalidatePath('/')` broadly — revalidate only the specific paths that changed to avoid cache stampedes.

### 8. CSRF PROTECTION

- Next.js App Router server actions include built-in CSRF protection via the `Origin` header check for same-origin requests — verify this is not being disabled anywhere.
- For all custom API routes that accept `POST`/`PATCH`/`DELETE` from the browser (not from Moolre callbacks), verify the `Origin` or `Referer` header matches your deployment domain:
  ```typescript
  const origin = request.headers.get('origin');
  if (origin !== process.env.NEXT_PUBLIC_SITE_URL) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  ```
- Do NOT apply this check to payment callback endpoints — they are called server-to-server by Moolre.

### 9. HTML SANITIZATION

Read `lib/notifications.ts` (or wherever emails are composed):

- Any user-provided text inserted into HTML email templates must be escaped using `escapeHtml()` from `lib/sanitize.ts`. This includes: contact form fields, customer names, product names sourced from user input, campaign subjects and messages.
- For rich/CMS content that legitimately contains HTML (blog posts, page content), use `sanitizeHtml()` with a strict allowlist — never use `dangerouslySetInnerHTML` with raw unsanitized content.
- Create `lib/sanitize.ts` with the following exports:
  ```typescript
  export function escapeHtml(str: string): string
  // Converts <, >, &, ", ' to HTML entities. Use for all user input in HTML contexts.

  export function sanitizeHtml(html: string): string
  // Strips all tags not in a safe allowlist (p, br, b, i, ul, ol, li, a[href], h2, h3).
  // Strips all attributes except href on <a> tags.
  // Strips javascript: and data: URLs from href.

  export function isValidEmail(email: string): boolean
  // RFC 5322 compliant check, max 254 chars.

  export function isValidGhanaPhone(phone: string): boolean
  // Validates +233 format and major network prefixes.

  export function truncate(str: string, maxLength: number): string
  // Hard-truncates a string for safe use in logs and error messages.
  ```

### 10. ENVIRONMENT & SECRETS

- Check `.env.local` and all `.env*` files — `SUPABASE_SERVICE_ROLE_KEY` must NEVER have the `NEXT_PUBLIC_` prefix. It must only ever be used in server-side code.
- Confirm `NEXT_PUBLIC_SUPABASE_ANON_KEY` is the only Supabase key used in client components.
- Create `lib/supabase-admin.ts` for the service role client:
  ```typescript
  // This file must NEVER be imported from any client component or 'use client' file.
  import { createClient } from '@supabase/supabase-js';
  export const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  ```
- Create `lib/auth.ts` with:
  ```typescript
  export async function verifyAuth(
    request: Request,
    options: { requireAdmin?: boolean } = {}
  ): Promise<{ userId: string; role: string } | never>
  // Reads Bearer token from Authorization header.
  // Calls supabase.auth.getUser(token) — NOT getSession().
  // If requireAdmin: true, checks profiles.role IN ('admin', 'staff').
  // Throws a typed AuthError if verification fails — caller converts to 401/403 response.

  export async function verifyAdminToken(token: string): Promise<boolean>
  // Convenience wrapper for API routes that only need a yes/no admin check.
  ```
- Check whether any secret values appear in `next.config.js` `env` block — values in that block are bundled into the client by default. Move them to server-only env vars.
- Add a startup check in `instrumentation.ts` (or equivalent) that throws if `SUPABASE_SERVICE_ROLE_KEY` or `MOOLRE_CALLBACK_SECRET` are missing in production.

### 11. LOGGING & MONITORING

Add structured logging for all security-sensitive events. Do not log PII (full email, full phone, full card details). Log the following:

- Failed admin login attempts (timestamp, IP, username fragment)
- Payment verification results (order number, amount, result, IP)
- Callback signature failures (timestamp, IP, payload hash)
- RPC calls to sensitive functions (function name, caller role)
- Rate limit triggers (endpoint, IP, time window)
- Any catch block in payment or auth code (error type, endpoint — no stack trace in production)

Use a structured format (JSON lines) so logs are parseable:
```typescript
console.log(JSON.stringify({ event: 'payment_verify_failed', orderNumber, ip, reason, ts: Date.now() }));
```

In production, pipe these to your observability tool (e.g. Vercel Log Drains, Datadog, Logtail).

### 12. SUPABASE SECURITY ADVISOR

After all fixes, run the Supabase security advisor:
```
get_advisors({ type: "security" })
```
Report all warnings. Fix anything flagged as HIGH or CRITICAL. For MEDIUM warnings, fix them if they apply to tables that hold PII or financial data.

Also run:
```sql
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anon' AND table_schema = 'public'
ORDER BY table_name;
```
Any `anon` grant on a sensitive table that is not covered by a restrictive RLS policy is a vulnerability. Revoke unnecessary grants.

---

### IMPORTANT RULES

1. **Fix everything, don't just report.** Apply code changes and database migrations.
2. **Use the Supabase MCP** for all database operations — `list_tables`, `execute_sql`, `apply_migration`, `get_advisors`.
3. **Create `lib/supabase-admin.ts`** for the service role client — never import it in client components.
4. **Create `lib/auth.ts`** with shared auth verification functions.
5. **Create `lib/sanitize.ts`** with HTML escaping and validation utilities.
6. **Run TypeScript type-check** (`tsc --noEmit`) after all changes to confirm nothing is broken.
7. **Don't break guest checkout** — guest orders must still work for INSERT. The fix is that guest order data is only accessible server-side via service role, matched by order number + email together.
8. **Don't break the admin panel** — admin/staff must still be able to manage everything via their authenticated session and the verified middleware.
9. **Test the callback endpoint** with a valid and an invalid signature after fixing to confirm the guard works.
10. **Document every security fix** in a `SECURITY_CHANGELOG.md` file with: what was vulnerable, what was done, and the date.
