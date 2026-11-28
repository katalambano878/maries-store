import { redirect } from 'next/navigation';

// There is no phone verification step yet; the account page shows the status.
export default function VerifyPhonePage() {
  redirect('/account?tab=security');
}
