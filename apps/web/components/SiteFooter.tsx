import { Logo } from './ui/Logo';

export function SiteFooter() {
  return (
    <footer className="mt-10 border-t border-line py-7">
      <div className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-2 px-4 font-mono text-xs text-faint sm:gap-4 sm:px-6 sm:text-sm">
        <span className="flex items-center gap-2">
          <Logo size={18} />
          BSV Launchpad — hybrid, operator-settled · mainnet
        </span>
        <span className="text-teal">non-custodial · SPV-verifiable</span>
      </div>
    </footer>
  );
}
