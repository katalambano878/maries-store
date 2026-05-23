'use client';

import { useState, useEffect } from 'react';

const WHATSAPP_NUMBER = '233547742920';
const DEFAULT_MESSAGE = 'Hi! I have a question about your products.';

export default function MessengerChatButton() {
  const [showTooltip, setShowTooltip] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
    const timer = setTimeout(() => setShowTooltip(true), 3000);
    const hideTimer = setTimeout(() => setShowTooltip(false), 9000);
    return () => { clearTimeout(timer); clearTimeout(hideTimer); };
  }, []);

  if (!hasMounted) return null;

  const waUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(DEFAULT_MESSAGE)}`;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-end gap-3">
      {showTooltip && (
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 px-4 py-3 max-w-[200px] animate-fade-in mb-2">
          <button
            onClick={() => setShowTooltip(false)}
            className="absolute -top-2 -right-2 w-5 h-5 bg-gray-200 hover:bg-gray-300 rounded-full flex items-center justify-center text-gray-600 text-xs"
          >
            ×
          </button>
          <p className="text-sm text-gray-800 font-medium">Need help?</p>
          <p className="text-xs text-gray-500 mt-0.5">Chat with us on WhatsApp!</p>
        </div>
      )}

      <a
        href={waUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Chat on WhatsApp"
        className="w-[60px] h-[60px] bg-[#25D366] hover:bg-[#1fb855] text-white rounded-full shadow-2xl hover:scale-110 transition-all flex items-center justify-center"
      >
        <svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor">
          <path d="M16.004 2.667A13.26 13.26 0 002.74 15.93a13.15 13.15 0 001.81 6.64L2.667 29.333l7.013-1.84a13.27 13.27 0 006.324 1.614h.005A13.27 13.27 0 0029.333 15.93 13.26 13.26 0 0016.004 2.667zm0 24.273a11.01 11.01 0 01-5.613-1.537l-.403-.239-4.173 1.095 1.114-4.069-.263-.418A10.95 10.95 0 015 15.93a11.01 11.01 0 0111.004-11.004A11.01 11.01 0 0127.07 15.93a11.02 11.02 0 01-11.066 11.01zm6.037-8.242c-.33-.166-1.96-.968-2.264-1.078-.304-.112-.525-.166-.746.166-.222.33-.859 1.078-.053 1.298-.192.221-.746.33-1.43.651-.25.117-1.08.418-2.057-.398-.76-.677-1.274-1.514-1.423-1.77-.149-.257-.016-.396.112-.524.115-.115.256-.302.385-.452.128-.152.17-.26.256-.433.085-.173.043-.324-.022-.453-.064-.128-.746-1.798-1.022-2.462-.269-.647-.542-.559-.746-.57l-.636-.01c-.222 0-.581.083-.886.406-.304.324-1.162 1.136-1.162 2.77s1.19 3.213 1.355 3.434c.166.222 2.34 3.572 5.67 5.008.792.342 1.41.546 1.892.698.795.253 1.519.217 2.09.132.638-.095 1.96-.802 2.237-1.576.277-.774.277-1.438.194-1.576-.083-.139-.304-.222-.636-.387z" />
        </svg>
      </a>
    </div>
  );
}
