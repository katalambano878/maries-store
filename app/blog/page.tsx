import { redirect } from 'next/navigation';

// The blog only ever showed the template's sample posts.
export default function BlogPage() {
  redirect('/shop');
}
