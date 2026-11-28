import { redirect } from 'next/navigation';

// Checkout has no coupon codes; store-wide discounts are set on Sale pricing.
export default function CouponsPage() {
  redirect('/admin/sales');
}
