import { redirect } from 'next/navigation';

// The blog was template sample content and never saved posts.
export default function BlogAdminPage() {
  redirect('/admin');
}
