-- Fill customer profiles with the name and phone they typed at sign-up.
--
-- Sign-up stored them only on the login record (auth.users metadata), so the
-- admin saw registered customers as bare emails. Only empty profile fields are
-- filled; nothing typed later is overwritten. Safe to run twice.

UPDATE public.profiles p
SET full_name = nullif(trim(coalesce(u.raw_user_meta_data->>'first_name', '') || ' ' || coalesce(u.raw_user_meta_data->>'last_name', '')), '')
FROM auth.users u
WHERE u.id = p.id
  AND (p.full_name IS NULL OR p.full_name = '')
  AND nullif(trim(coalesce(u.raw_user_meta_data->>'first_name', '') || ' ' || coalesce(u.raw_user_meta_data->>'last_name', '')), '') IS NOT NULL;

UPDATE public.profiles p
SET phone = nullif(trim(u.raw_user_meta_data->>'phone'), '')
FROM auth.users u
WHERE u.id = p.id
  AND (p.phone IS NULL OR p.phone = '')
  AND nullif(trim(u.raw_user_meta_data->>'phone'), '') IS NOT NULL;
