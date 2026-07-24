import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  pad?: boolean;
  children: ReactNode;
}

export function Card({ pad = true, className, children, ...rest }: CardProps) {
  const cls = [
    'rounded-lg border border-line bg-surface shadow-[var(--shadow-1)]',
    pad ? 'p-5' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
