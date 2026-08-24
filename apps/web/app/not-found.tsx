import Link from 'next/link';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="flex min-h-[calc(100dvh-10rem)] items-center justify-center px-4">
        <div className="max-w-md text-center">
          <div className="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-full border-2 border-line bg-elevated/40">
            <span className="font-mono text-3xl font-bold text-gold">404</span>
          </div>
          <h1 className="mb-3 text-3xl font-semibold">Page not found</h1>
          <p className="mb-8 text-base text-muted">
            The page you're looking for doesn't exist or has been moved.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Link href="/" className="btn btn-primary">
              Back to home
            </Link>
            <Link href="/#explore" className="btn btn-secondary">
              Explore sales
            </Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
