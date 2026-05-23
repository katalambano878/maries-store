'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

function getVisitorId(): string {
  const key = '_mv_id';
  let id = '';
  try {
    id = localStorage.getItem(key) || '';
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
  } catch {
    id = Math.random().toString(36).slice(2);
  }
  return id;
}

export default function VisitTracker() {
  const pathname = usePathname();

  useEffect(() => {
    const controller = new AbortController();
    const visitorId = getVisitorId();

    fetch('/api/track-visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: pathname || '/',
        referrer: document.referrer || null,
        visitorId,
      }),
      signal: controller.signal,
    }).catch(() => {});

    return () => controller.abort();
  }, [pathname]);

  return null;
}
