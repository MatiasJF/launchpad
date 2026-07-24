import { Button, Card, StatTile, StatusPill } from '../components/ui';

/**
 * Home is a temporary design-system preview (WEB-002). The real explore page
 * arrives in WEB-001. It exercises the tokens + primitives so the build proves
 * they render.
 */
export default function Home() {
  return (
    <main style={{ maxWidth: 920, margin: '0 auto', padding: '48px 24px' }}>
      <header style={{ marginBottom: 32 }}>
        <p
          className="mono"
          style={{
            fontSize: 'var(--text-xs)',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--gold)',
            margin: 0,
          }}
        >
          BSV Launchpad · Design System
        </p>
        <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: '-0.03em', margin: '8px 0 0' }}>
          Issue and sell tokens on BSV
        </h1>
        <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>
          Foundation + P1 in progress. This page previews the design tokens and primitives.
        </p>
      </header>

      <section style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
        <Button variant="primary">Buy tokens</Button>
        <Button variant="secondary">Connect wallet</Button>
        <Button variant="ghost">View on-chain</Button>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, alignItems: 'start' }}>
        <Card>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <StatusPill status="live" />
            <StatusPill status="scheduled" />
            <StatusPill status="finalized" />
            <StatusPill status="failed" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            <StatTile label="Price" value="120 sats" />
            <StatTile label="Supply" value="30,000,000" />
            <StatTile label="Sold" value="41%" />
          </div>
        </Card>

        {/* Buy-card sketch (BuyCard primitive lands in WEB-001) */}
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <StatTile label="Price per token" value="120 sats" />
            <StatTile label="Ends in" value="4d 05h 12m" />
            <Button variant="primary" block>
              Buy on mainnet
            </Button>
            <p className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--teal)', margin: 0 }}>
              ✓ settlement is SPV-verifiable
            </p>
          </div>
        </Card>
      </div>
    </main>
  );
}
