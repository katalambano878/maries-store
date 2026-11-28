/** Only follow same-site paths from ?redirect=, never another domain. */
export function safeRedirect(value: string | null | undefined, fallback = '/account'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}
