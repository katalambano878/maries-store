import { redirect } from 'next/navigation';

// There is no email verification step yet; the account page shows the status.
export default function VerifyEmailPage() {
  redirect('/account?tab=security');
}
