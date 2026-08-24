import { Logo } from './ui/Logo';
import { WalletButton } from './WalletButton';
import { MobileMenu } from './MobileMenu';

export function SiteHeader() {
  return (
    <header className="glass sticky top-0 z-50 border-x-0 border-t-0">
      <div className="mx-auto flex h-16 max-w-[1120px] items-center gap-4 px-4 sm:gap-5 sm:px-6">
        <a href="/" className="flex items-center gap-2.5 font-display text-[1.05rem] font-semibold transition-opacity hover:opacity-90">
          <Logo size={30} />
          BSV Launchpad
        </a>
        <nav className="ml-2 hidden gap-1.5 sm:flex">
          {[
            { label: 'Explore', href: '/#explore' },
            { label: 'Portfolio', href: '/portfolio' },
            { label: 'Submit', href: '/submit' },
            { label: 'Docs', href: '#' },
          ].map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-fg"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <span className="flex-1" />
        <WalletButton />
        <MobileMenu />
      </div>
    </header>
  );
}
