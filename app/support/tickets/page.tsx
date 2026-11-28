import { redirect } from 'next/navigation';

// Support requests go through the contact form, which emails the shop.
export default function SupportPage() {
  redirect('/contact');
}
