'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react';
import { supabase } from '@/lib/supabase';
import { parseStorePricingValue } from '@/lib/pricing';

type StorePricingContextType = {
  salesActive: boolean;
  discountPercent: number;
  loading: boolean;
  refresh: () => Promise<void>;
};

const StorePricingContext = createContext<StorePricingContextType>({
  salesActive: false,
  discountPercent: 0,
  loading: true,
  refresh: async () => {},
});

export function StorePricingProvider({ children }: { children: ReactNode }) {
  const [salesActive, setSalesActive] = useState(false);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('site_settings')
        .select('value')
        .eq('key', 'store_pricing')
        .maybeSingle();

      if (error) {
        console.warn('[StorePricing] fetch error:', error.message);
        setSalesActive(false);
        setDiscountPercent(0);
        return;
      }

      const parsed = parseStorePricingValue(data?.value);
      setSalesActive(parsed.sales_active);
      setDiscountPercent(parsed.discount_percent);
    } catch {
      setSalesActive(false);
      setDiscountPercent(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <StorePricingContext.Provider value={{ salesActive, discountPercent, loading, refresh }}>
      {children}
    </StorePricingContext.Provider>
  );
}

export function useStorePricing() {
  return useContext(StorePricingContext);
}
