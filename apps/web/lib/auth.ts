import { cookies } from 'next/headers';

const COOKIE = 'admin_session';

/**
 * Dev-grade admin gate (ADR-007: legal/KYC out of scope for the demo). A cookie
 * is set only after the admin secret is verified server-side. Not production
 * security — a placeholder for the admin approval flow.
 */
export async function isAdmin(): Promise<boolean> {
  const store = await cookies();
  return store.get(COOKIE)?.value === 'ok';
}

export { COOKIE as ADMIN_COOKIE };
