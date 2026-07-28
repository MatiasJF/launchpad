'use client';

import { useRef } from 'react';

function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {up ? <path d="M2.5 7.5 6 4l3.5 3.5" /> : <path d="M2.5 4.5 6 8l3.5-3.5" />}
    </svg>
  );
}

/**
 * Numeric input with themed chevron steppers instead of the browser's generic
 * spinner (which is hidden app-wide in globals.css). Works either controlled
 * (pass `value` + `onValueChange`) or uncontrolled for native forms (pass `name`
 * + `defaultValue`, stepped via the input's own stepUp/stepDown).
 */
export function NumberField({
  name,
  value,
  onValueChange,
  defaultValue,
  min = 0,
  max,
  step = 1,
  placeholder,
  required,
  className,
  title,
}: {
  name?: string;
  value?: number;
  onValueChange?: (n: number) => void;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  required?: boolean;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const controlled = value !== undefined && !!onValueChange;

  function bump(dir: 1 | -1) {
    if (controlled) {
      let next = (Number.isFinite(value) ? (value as number) : 0) + dir * step;
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      onValueChange!(next);
    } else {
      const el = ref.current;
      if (!el) return;
      if (dir > 0) el.stepUp();
      else el.stepDown();
    }
  }

  return (
    <div className={`relative ${className ?? ''}`}>
      <input
        ref={ref}
        type="number"
        name={name}
        value={controlled ? value : undefined}
        defaultValue={controlled ? undefined : defaultValue}
        onChange={controlled ? (e) => onValueChange!(Number(e.target.value)) : undefined}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        required={required}
        title={title}
        className="w-full rounded-md border border-line bg-elevated py-2.5 pl-3 pr-9 font-mono tabular-nums text-fg outline-none transition focus:border-gold"
      />
      <div className="absolute inset-y-1 right-1 flex flex-col gap-px">
        <button
          type="button"
          tabIndex={-1}
          aria-label="increase"
          onClick={() => bump(1)}
          className="grid h-1/2 w-6 place-items-center rounded text-muted transition hover:bg-surface hover:text-gold"
        >
          <Chevron up />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="decrease"
          onClick={() => bump(-1)}
          className="grid h-1/2 w-6 place-items-center rounded text-muted transition hover:bg-surface hover:text-gold"
        >
          <Chevron up={false} />
        </button>
      </div>
    </div>
  );
}
