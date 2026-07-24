import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  pad?: boolean;
  children: ReactNode;
}

export function Card({ pad = true, className, children, ...rest }: CardProps) {
  const cls = ['card', pad ? 'card-pad' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
