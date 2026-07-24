export function Countdown({ d, h, m }: { d: number; h: number; m: number }) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <div className="countdown" aria-label={`Ends in ${d}d ${h}h ${m}m`}>
      <b>
        {pad(d)}
        <span>d</span>
      </b>
      <b>
        {pad(h)}
        <span>h</span>
      </b>
      <b>
        {pad(m)}
        <span>m</span>
      </b>
    </div>
  );
}
