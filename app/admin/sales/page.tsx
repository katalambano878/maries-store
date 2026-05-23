'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { parseStorePricingValue } from '@/lib/pricing';

export default function AdminSalesPage() {
  const [salesActive, setSalesActive] = useState(false);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [customDiscount, setCustomDiscount] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingDiscount, setSavingDiscount] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discountSuccess, setDiscountSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.user?.id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', session.user.id)
          .single();
        setIsAdmin(profile?.role === 'admin');
      } else {
        setIsAdmin(false);
      }

      const { data, error: fetchError } = await supabase
        .from('site_settings')
        .select('id, value')
        .eq('key', 'store_pricing')
        .maybeSingle();

      if (fetchError) {
        setError(fetchError.message);
        setSalesActive(false);
        setDiscountPercent(0);
        return;
      }

      const parsed = parseStorePricingValue(data?.value);
      setSalesActive(parsed.sales_active);
      setDiscountPercent(parsed.discount_percent);
      if (parsed.discount_percent > 0) {
        setCustomDiscount(String(parsed.discount_percent));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = async (next: boolean) => {
    if (!isAdmin) return;
    setSaving(true);
    setError(null);
    try {
      const { error: upsertError } = await supabase.from('site_settings').upsert(
        {
          key: 'store_pricing',
          value: { sales_active: next, discount_percent: discountPercent },
          category: 'pricing',
        },
        { onConflict: 'key' }
      );
      if (upsertError) throw upsertError;
      setSalesActive(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const handleSetDiscount = async (percent: number) => {
    if (!isAdmin) return;
    setSavingDiscount(true);
    setError(null);
    setDiscountSuccess(null);
    try {
      const { error: upsertError } = await supabase.from('site_settings').upsert(
        {
          key: 'store_pricing',
          value: { sales_active: salesActive, discount_percent: percent },
          category: 'pricing',
        },
        { onConflict: 'key' }
      );
      if (upsertError) throw upsertError;
      setDiscountPercent(percent);
      setCustomDiscount(percent > 0 ? String(percent) : '');
      setDiscountSuccess(
        percent > 0
          ? `${percent}% discount applied to all products`
          : 'Bulk discount removed'
      );
      setTimeout(() => setDiscountSuccess(null), 3000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save discount');
    } finally {
      setSavingDiscount(false);
    }
  };

  const handleCustomDiscountSubmit = () => {
    const val = parseFloat(customDiscount);
    if (isNaN(val) || val < 0 || val > 100) {
      setError('Please enter a valid percentage between 0 and 100');
      return;
    }
    handleSetDiscount(Math.round(val * 100) / 100);
  };

  const presetDiscounts = [10, 15, 20, 25, 30, 50];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] text-gray-500">
        <i className="ri-loader-4-line text-3xl animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Sale pricing</h1>
        <p className="text-gray-600 mt-1">
          Turn on site-wide sale mode so customers see each product&apos;s <strong>sale price</strong> (set
          per product in Products → Pricing) instead of the regular price. Products without a sale price
          keep the regular price.
        </p>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-50 text-red-800 text-sm border border-red-100">{error}</div>
      )}

      {/* ─── Store-wide sale toggle (unchanged) ─── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Store-wide sale</h2>
            <p className="text-sm text-gray-500 mt-1">
              Current status:{' '}
              <span className={salesActive ? 'text-red-600 font-medium' : 'text-gray-700 font-medium'}>
                {salesActive ? 'ON — sale prices active' : 'OFF — regular prices'}
              </span>
            </p>
          </div>
          {isAdmin ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => handleToggle(!salesActive)}
              className={`relative inline-flex h-10 w-[3.5rem] shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-stone-500 focus:ring-offset-2 ${
                salesActive ? 'bg-red-600' : 'bg-gray-300'
              } ${saving ? 'opacity-60 cursor-wait' : ''}`}
              role="switch"
              aria-checked={salesActive}
            >
              <span
                className={`pointer-events-none inline-block h-9 w-9 transform rounded-full bg-white shadow ring-0 transition ${
                  salesActive ? 'translate-x-[1.4rem]' : 'translate-x-0.5'
                }`}
              />
            </button>
          ) : (
            <p className="text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded-lg border border-amber-100">
              Only administrators can change this setting.
            </p>
          )}
        </div>
        {isAdmin && (
          <p className="text-xs text-gray-500 mt-4">
            Tip: After toggling, refresh the storefront if you have it open. Cart totals use prices from when
            items were added; checkout always uses current sale rules.
          </p>
        )}
      </div>

      {/* ─── Bulk percentage discount ─── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <i className="ri-percent-line text-stone-500" />
              Bulk percentage discount
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Apply a flat percentage discount to <strong>all products</strong> that don&apos;t already have a per-product sale price set.
              Requires <strong>Store-wide sale</strong> to be <strong>ON</strong>.
            </p>
          </div>
          {discountPercent > 0 && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold bg-red-100 text-red-700 shrink-0">
              {discountPercent}% OFF
            </span>
          )}
        </div>

        {!salesActive && (
          <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-100 text-amber-800 text-sm flex items-start gap-2">
            <i className="ri-information-line text-lg shrink-0 mt-0.5" />
            <span>
              Turn on <strong>Store-wide sale</strong> above first. The bulk discount only takes effect when sales mode is active.
            </span>
          </div>
        )}

        {isAdmin && (
          <div className={`mt-5 space-y-5 ${!salesActive ? 'opacity-50 pointer-events-none' : ''}`}>
            {/* Preset discount buttons */}
            <div>
              <p className="text-sm font-medium text-gray-700 mb-3">Quick presets</p>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {presetDiscounts.map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    disabled={savingDiscount}
                    onClick={() => handleSetDiscount(pct)}
                    className={`px-3 py-3 rounded-xl text-sm font-bold transition-all border-2 ${
                      discountPercent === pct
                        ? 'bg-stone-800 text-white border-stone-800 shadow-md scale-[1.02]'
                        : 'bg-white text-gray-700 border-gray-200 hover:border-stone-400 hover:bg-stone-50'
                    } ${savingDiscount ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>

            {/* Custom input */}
            <div>
              <p className="text-sm font-medium text-gray-700 mb-3">Custom percentage</p>
              <div className="flex items-center gap-3">
                <div className="relative flex-1 max-w-[200px]">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={customDiscount}
                    onChange={(e) => setCustomDiscount(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCustomDiscountSubmit();
                    }}
                    placeholder="e.g. 12"
                    className="w-full pl-4 pr-10 py-3 border-2 border-gray-200 rounded-xl text-sm font-medium focus:ring-2 focus:ring-stone-500 focus:border-stone-500 transition-all"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 font-bold text-sm">%</span>
                </div>
                <button
                  type="button"
                  disabled={savingDiscount || !customDiscount}
                  onClick={handleCustomDiscountSubmit}
                  className="px-5 py-3 bg-stone-700 text-white rounded-xl font-semibold text-sm hover:bg-stone-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap cursor-pointer"
                >
                  {savingDiscount ? (
                    <i className="ri-loader-4-line animate-spin" />
                  ) : (
                    'Apply'
                  )}
                </button>
              </div>
            </div>

            {/* Clear discount */}
            {discountPercent > 0 && (
              <button
                type="button"
                disabled={savingDiscount}
                onClick={() => handleSetDiscount(0)}
                className="flex items-center gap-2 text-sm text-red-600 hover:text-red-700 font-medium transition-colors cursor-pointer disabled:opacity-50"
              >
                <i className="ri-close-circle-line" />
                Remove bulk discount
              </button>
            )}
          </div>
        )}

        {/* Success message */}
        {discountSuccess && (
          <div className="mt-4 p-3 rounded-lg bg-green-50 border border-green-100 text-green-800 text-sm flex items-center gap-2 animate-fade-in">
            <i className="ri-checkbox-circle-fill text-green-600" />
            {discountSuccess}
          </div>
        )}

        {isAdmin && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-500">
              <strong>How it works:</strong> When Store-wide sale is ON, any product with a manually set sale price will use that price.
              Products <em>without</em> a sale price will have this bulk discount applied to their regular price automatically.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
