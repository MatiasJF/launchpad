import { Bolt } from './ui/icons';
import { WalletButton } from './WalletButton';

export function SiteHeader() {
  return (
    <header
      className="sticky top-0 z-50 border-b border-line backdrop-blur-md"
      style={{ background: 'color-mix(in srgb, var(--c-ink) 72%, transparent)' }}
    >
      <div className="mx-auto flex h-16 max-w-[1120px] items-center gap-5 px-6">
        <a href="/" className="flex items-center gap-2.5 font-display text-[1.05rem] font-semibold">
          <span
            className="grid h-[30px] w-[30px] place-items-center rounded-[9px] text-[#0a0e15]"
            style={{ backgroundImage: 'linear-gradient(135deg, var(--c-gold), var(--c-teal))' }}
          >
            <Bolt width={17} height={17} />
          </span>
          BSV Launchpad
        </a>
        <nav className="ml-2 hidden gap-1.5 sm:flex">
          {[
            { label: 'Explore', href: '/#explore' },
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
      </div>
    </header>
  );
}
