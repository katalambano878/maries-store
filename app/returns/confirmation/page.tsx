'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

function ConfirmationContent() {
  const order = useSearchParams().get('order');

  return (
    <main className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-2xl mx-auto px-4">
        <div className="bg-white rounded-xl shadow-sm p-8 text-center">
          <div className="w-20 h-20 flex items-center justify-center mx-auto mb-6 bg-stone-100 rounded-full">
            <i className="ri-check-line text-4xl text-stone-700"></i>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-3">Return request sent</h1>
          <p className="text-gray-600 mb-8">
            {order ? <>We have your request for order <strong>{order}</strong>. </> : null}
            The shop will contact you by phone or email to arrange the next step.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/shop" className="px-6 py-3 bg-stone-800 hover:bg-stone-900 text-white rounded-lg font-semibold">
              Continue shopping
            </Link>
            <Link href="/contact" className="px-6 py-3 border-2 border-gray-300 text-gray-900 rounded-lg font-semibold hover:bg-gray-50">
              Contact us
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function ReturnConfirmationPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmationContent />
    </Suspense>
  );
}
