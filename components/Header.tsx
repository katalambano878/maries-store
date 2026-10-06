'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import MiniCart from './MiniCart';
import { useCart } from '@/context/CartContext';
import { supabase } from '@/lib/supabase';
import { useCMS } from '@/context/CMSContext';
import { useStorePricing } from '@/context/StorePricingContext';
import { resolveProductPrice } from '@/lib/pricing';
import { useDebouncedValue } from '@/components/useDebouncedValue';
import type { StorefrontSearchHit } from '@/lib/storefront-search-types';

const PRIMARY_NAV = [
  { label: 'Shop', href: '/shop' },
  { label: 'Categories', href: '/categories' },
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact' },
] as const;

const MOBILE_NAV = [
  { label: 'Home', href: '/' },
  ...PRIMARY_NAV,
] as const;

const MOBILE_SECONDARY = [
  { label: 'Track order', href: '/order-tracking' },
  { label: 'Wishlist', href: '/wishlist' },
  { label: 'My account', href: '/account' },
] as const;

function navIsActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Header() {
  const pathname = usePathname() || '/';
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<StorefrontSearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const debouncedSearch = useDebouncedValue(searchQuery, 280);
  const { salesActive, discountPercent, strictDiscount } = useStorePricing();
  const [wishlistCount, setWishlistCount] = useState(0);
  const [user, setUser] = useState<any>(null);

  const { cartCount, isCartOpen, setIsCartOpen } = useCart();
  const { getSetting } = useCMS();

  const siteName = getSetting('site_name') || 'Maries Hair';
  const headerLogo = getSetting('site_logo') || '/logo.png';
  const saleChip =
    salesActive && discountPercent > 0 && strictDiscount
      ? `${discountPercent}% off`
      : salesActive
        ? 'Sale on'
        : null;

  useEffect(() => {
    const updateWishlistCount = () => {
      const wishlist = JSON.parse(localStorage.getItem('wishlist') || '[]');
      setWishlistCount(wishlist.length);
    };

    updateWishlistCount();
    window.addEventListener('wishlistUpdated', updateWishlistCount);

    const checkUser = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setUser(session?.user ?? null);
    };

    checkUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      window.removeEventListener('wishlistUpdated', updateWishlistCount);
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isMobileMenuOpen && !isSearchOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isMobileMenuOpen, isSearchOpen]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      window.location.href = `/shop?search=${encodeURIComponent(searchQuery)}`;
    }
  };

  const closeSearchOverlay = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery('');
    setSearchHits([]);
    setSearchLoading(false);
  }, []);

  useEffect(() => {
    if (!isSearchOpen && !isMobileMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSearchOverlay();
        setIsMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSearchOpen, isMobileMenuOpen, closeSearchOverlay]);

  useEffect(() => {
    if (!isSearchOpen) return;
    const q = debouncedSearch.trim();
    if (q.length < 1) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }

    const ac = new AbortController();
    setSearchLoading(true);

    fetch(`/api/storefront/search?q=${encodeURIComponent(q)}&limit=12`, { signal: ac.signal })
      .then((res) => (res.ok ? res.json() : []))
      .then((data: StorefrontSearchHit[]) => {
        if (!ac.signal.aborted) setSearchHits(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!ac.signal.aborted) setSearchHits([]);
      })
      .finally(() => {
        if (!ac.signal.aborted) setSearchLoading(false);
      });

    return () => ac.abort();
  }, [debouncedSearch, isSearchOpen]);

  const accountHref = user ? '/account' : '/auth/login';
  const accountLabel = user ? 'Account' : 'Login';

  return (
    <>
      <header className="sticky top-0 z-50 bg-white border-b border-stone-100">
        <div className="safe-area-top" />
        <div className="px-4 sm:px-6 lg:px-8">
          <nav
            aria-label="Main navigation"
            className="relative mx-auto max-w-[1440px] h-16"
          >
            <div className="h-full flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  className="lg:hidden inline-flex h-10 w-10 items-center justify-center rounded-full text-stone-900 hover:bg-stone-100 active:scale-[0.98] transition"
                  onClick={() => setIsMobileMenuOpen(true)}
                  aria-label="Open menu"
                >
                  <i className="ri-menu-3-line text-xl" aria-hidden />
                </button>
                <Link
                  href="/"
                  className="flex items-center min-w-0 select-none"
                  aria-label="Go to homepage"
                >
                  <img
                    src={headerLogo}
                    alt={siteName}
                    className="h-11 md:h-12 w-auto max-w-[168px] object-contain object-left"
                  />
                </Link>
                {saleChip && (
                  <span className="hidden md:inline-flex items-center rounded-full bg-stone-950 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white">
                    {saleChip}
                  </span>
                )}
              </div>

              <div className="hidden lg:flex absolute left-1/2 -translate-x-1/2 justify-center">
                <div className="flex items-center gap-0.5 rounded-full bg-stone-950 p-1 text-white">
                  {PRIMARY_NAV.map((link) => {
                    const active = navIsActive(pathname, link.href);
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        className={`relative px-3.5 py-1.5 text-[13px] font-medium tracking-wide rounded-full transition-colors duration-200 ${
                          active ? 'text-stone-950' : 'text-white/80 hover:text-white'
                        }`}
                      >
                        {active && (
                          <span
                            className="absolute inset-0 rounded-full bg-white"
                            aria-hidden
                          />
                        )}
                        <span className="relative z-10">{link.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-end gap-1 sm:gap-1.5">
                <button
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-stone-900 hover:bg-stone-100 active:scale-[0.98] transition"
                  onClick={() => setIsSearchOpen(true)}
                  aria-label="Search"
                >
                  <i className="ri-search-line text-lg" aria-hidden />
                </button>

                <Link
                  href="/wishlist"
                  className="relative hidden sm:inline-flex h-10 w-10 items-center justify-center rounded-full text-stone-900 hover:bg-stone-100 active:scale-[0.98] transition"
                  aria-label="Wishlist"
                >
                  <i className="ri-heart-line text-lg" aria-hidden />
                  {wishlistCount > 0 && (
                    <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-stone-950" />
                  )}
                </Link>

                <Link
                  href={accountHref}
                  className="hidden sm:inline-flex h-10 w-10 items-center justify-center rounded-full text-stone-900 hover:bg-stone-100 active:scale-[0.98] transition"
                  aria-label={accountLabel}
                >
                  <i className="ri-user-line text-lg" aria-hidden />
                </Link>

                <div className="relative">
                  <button
                    className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white pl-3 pr-1 py-1 text-stone-900 hover:border-stone-400 active:scale-[0.98] transition"
                    onClick={() => setIsCartOpen(!isCartOpen)}
                    aria-label="Cart"
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-[0.16em]">Bag</span>
                    <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-stone-950 px-1.5 text-[11px] font-semibold tabular-nums text-white">
                      {cartCount}
                    </span>
                  </button>
                  <MiniCart isOpen={isCartOpen} onClose={() => setIsCartOpen(false)} />
                </div>
              </div>
            </div>
          </nav>
        </div>
      </header>

      {isSearchOpen && (
        <div className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center pt-16 sm:pt-0 px-3 overflow-y-auto">
          <div
            className="absolute inset-0 bg-stone-950/90"
            style={{ backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}
            onClick={closeSearchOverlay}
            aria-hidden="true"
          />

          <div
            className="relative w-full max-w-4xl mx-auto pt-8 sm:pt-0 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={closeSearchOverlay}
              className="absolute -top-4 sm:-top-16 right-0 w-12 h-12 flex items-center justify-center text-stone-400 hover:text-white transition-colors"
              aria-label="Close search"
            >
              <i className="ri-close-line text-3xl" aria-hidden />
            </button>

            <form onSubmit={handleSearch} className="relative group">
              <div className="relative flex items-center">
                <i className="ri-search-line text-2xl sm:text-3xl text-stone-500 group-focus-within:text-white transition-colors absolute left-0" aria-hidden />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Type a product name"
                  autoComplete="off"
                  aria-autocomplete="list"
                  aria-controls="storefront-search-results"
                  className="w-full bg-transparent border-none pl-10 sm:pl-14 py-4 sm:py-6 text-2xl sm:text-4xl md:text-5xl text-white placeholder-stone-600 focus:outline-none focus:ring-0 font-serif tracking-wide"
                  autoFocus
                />
              </div>
              <div className="h-px bg-stone-700">
                <div className="h-full bg-white w-0 group-focus-within:w-full transition-all duration-500" />
              </div>
            </form>

            <div
              id="storefront-search-results"
              className="mt-6 sm:mt-8 rounded-2xl border border-white/10 bg-stone-900/80 overflow-hidden max-h-[min(55vh,420px)] overflow-y-auto"
              role="listbox"
              aria-label="Matching products"
            >
              {searchLoading && searchQuery.trim() && (
                <div className="p-6 flex items-center justify-center gap-3 text-stone-400 text-sm">
                  <i className="ri-loader-4-line text-xl animate-spin" aria-hidden />
                  Finding products
                </div>
              )}

              {!searchLoading &&
                searchQuery.trim() &&
                debouncedSearch.trim() &&
                searchHits.length === 0 && (
                  <div className="p-8 text-center text-stone-500 text-sm">
                    No products match that yet. Try another letter or press Enter to search the shop.
                  </div>
                )}

              {!searchLoading && searchHits.length > 0 && (
                <ul className="divide-y divide-white/5">
                  {searchHits.map((p) => {
                    const { effective, originalDisplay } = resolveProductPrice({
                      salesActive,
                      price: Number(p.price) || 0,
                      salePrice: p.sale_price,
                      compareAtPrice: p.compare_at_price,
                      discountPercent,
                      strictDiscount,
                    });
                    const img = p.image || '/logo.png';
                    return (
                      <li key={p.id}>
                        <Link
                          href={`/product/${encodeURIComponent(p.slug)}`}
                          onClick={closeSearchOverlay}
                          className="flex items-center gap-3 sm:gap-4 p-3 sm:p-4 hover:bg-white/5 transition-colors text-left"
                        >
                          <div className="w-14 h-14 sm:w-16 sm:h-16 shrink-0 rounded-xl overflow-hidden bg-stone-800 ring-1 ring-white/10">
                            <img
                              src={img}
                              alt=""
                              className="w-full h-full object-cover object-center"
                              loading="lazy"
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-white font-medium text-sm sm:text-base leading-snug line-clamp-2">{p.name}</p>
                            {p.categoryName && (
                              <p className="text-stone-500 text-xs mt-0.5 truncate">{p.categoryName}</p>
                            )}
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-white font-semibold text-sm sm:text-base whitespace-nowrap">GH₵{effective.toFixed(2)}</p>
                            {originalDisplay != null && originalDisplay > effective && (
                              <p className="text-stone-500 text-xs line-through">GH₵{originalDisplay.toFixed(2)}</p>
                            )}
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}

              {!searchQuery.trim() && (
                <div className="p-6 text-center text-stone-500 text-sm">
                  Type a letter to see products that start with it.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {isMobileMenuOpen && (
        <div className="fixed inset-0 z-[100] lg:hidden">
          <div
            className="absolute inset-0 bg-stone-950/40"
            onClick={() => setIsMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-x-3 top-3 bottom-3 rounded-[1.75rem] bg-stone-950 text-white shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-5 pb-4">
              <p className="font-serif text-xl tracking-tight">{siteName}</p>
              <button
                onClick={() => setIsMobileMenuOpen(false)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/15"
                aria-label="Close menu"
              >
                <i className="ri-close-line text-2xl" aria-hidden />
              </button>
            </div>

            <nav className="flex-1 overflow-y-auto px-5 pb-6">
              <ul className="space-y-1">
                {MOBILE_NAV.map((link) => {
                  const active = navIsActive(pathname, link.href);
                  return (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className={`block py-3 font-serif text-3xl leading-tight tracking-tight ${
                          active ? 'text-white' : 'text-white/55 hover:text-white'
                        }`}
                        onClick={() => setIsMobileMenuOpen(false)}
                      >
                        {link.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-8 pt-6 border-t border-white/10 space-y-1">
                {MOBILE_SECONDARY.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="block py-2.5 text-sm text-white/60 hover:text-white"
                    onClick={() => setIsMobileMenuOpen(false)}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </nav>

            <div className="px-5 pb-6 text-xs text-white/40">
              {saleChip ? `${saleChip} across the shop` : `© ${new Date().getFullYear()} ${siteName}`}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
