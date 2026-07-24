# Design System

The visual language for the launchpad app. Grounded in real launchpad / web3
patterns surveyed on Mobbin (references below), carrying the project's brand
accents: **gold = value**, **teal = verified / on-chain**.

Tokens live in `apps/web/app/globals.css`; primitive components in
`apps/web/components/ui`. Update this doc when tokens or primitives change
(golden rule 1).

Styling is **Tailwind CSS v4** (ADR-018): the tokens are CSS variables on
`:root` (theme-switchable) exposed to Tailwind via `@theme inline`, so utilities
like `bg-surface text-gold rounded-lg` stay theme-aware. Repeated primitives
(`.btn`, `.pill`, `.chip`, `.progress`, `.countdown`) sit in `@layer components`.

## Principles

1. **Dark-first, navy neutrals.** The app leads in a refined dark theme
   (crypto convention; see refs) built on a **navy-blue** neutral palette —
   brand-adjacent to the BSV ecosystem without using the BSV Association's owned
   identity; the gold accent keeps it distinctly ours. Fully-styled light theme
   via `data-theme="light"`.
2. **Value forward.** Price, supply, and progress are the loudest elements on a
   sale — the gold accent is reserved for value and primary actions.
3. **Trust is visible.** On-chain / verified states use teal; every sale surface
   can show its settlement truth (txid, SPV) without hunting.
4. **Calm dense.** Metric tiles and cards are information-dense but quiet — one
   accent per view, semantic color only for status.
5. **Numbers are typeset.** Amounts, prices, and addresses use tabular/mono so
   columns align and hashes are legible.

## References (Mobbin)

Surveyed 2026-07-24 (web). Cite when iterating.

- **Project / sale page** — [Foundation mint](https://mobbin.com/screens/d2485fee-0fa4-4a13-8930-d8fea5a33e7a) (buy card: minted/price/countdown/CTA), [Kickstarter](https://mobbin.com/screens/7dbeb7c8-4b60-4bdd-abe1-568e515aacd5) (funding progress + backers + days-to-go), [Gamma eligibility](https://mobbin.com/screens/2bbf8988-7d6d-495a-9720-d70b39a44574) (buy-confirm modal).
- **Connect wallet** — [OpenSea](https://mobbin.com/screens/599d52d0-9684-42f6-8292-fe8a9fe67d36) (wallet rows + tags), [Coinbase](https://mobbin.com/screens/0028e86d-943f-4bfd-8be6-ce4f873921ce) (privacy reassurance copy), [Rarible / WalletConnect](https://mobbin.com/screens/3da9323e-c3d6-49fd-a705-b8b8fc3ec847).
- **Explore / listing** — [Foundation "minting soon"](https://mobbin.com/screens/b239d9e9-c27f-4edd-91a2-c06898ef78e7) (status cards), [Foundation browse](https://mobbin.com/screens/6d36a5b2-8313-43d3-bfd3-4e21650a5b30) (filter chips w/ counts), [OpenSea Drops](https://mobbin.com/screens/c3fd1ffb-5d86-4bd3-a898-f2ea97b0ee68) (hero + countdown chips).
- **Admin create** — [OKX crypto listing](https://mobbin.com/screens/3a09f085-49b8-4da4-9fcd-9fd36375eb8a) (stepper form), [Foundation configure sale](https://mobbin.com/screens/0cc44a4f-e73b-4e24-85d7-7e69cc646900) (price + duration fields).

## Foundations

### Color

Dark is the default (`:root`); light overrides under `:root[data-theme="light"]`.
Both are also driven by `prefers-color-scheme`.

| Token             | Dark      | Light     | Use                              |
| ----------------- | --------- | --------- | -------------------------------- |
| `--bg`            | `#0a1124` | `#f6f7f9` | app background                   |
| `--surface`       | `#111a31` | `#ffffff` | cards / panels                   |
| `--surface-2`     | `#182444` | `#eef1f5` | inputs / elevated                |
| `--border`        | `#24325a` | `#e2e6ec` | hairlines                        |
| `--text`          | `#e9edf8` | `#131820` | primary text                    |
| `--text-muted`    | `#9aa6c4` | `#5a6675` | secondary text                  |
| `--gold`          | `#f0ba4a` | `#b07d15` | **value + primary action**       |
| `--teal`          | `#4fd0c0` | `#1f8175` | **verified / on-chain**          |
| `--success`       | `#4fce84` | `#1f9d57` | sale live                       |
| `--warning`       | `#e6bd57` | `#9a7a1f` | caution                         |
| `--danger`        | `#ef7a72` | `#c0453d` | failed / destructive            |
| `--info`          | `#62a8ee` | `#2f6fb0` | scheduled / neutral status      |

**Status mapping** — Sale: `scheduled → info`, `live → success`,
`finalized → gold`, `failed → danger`. Order: `pending → info`,
`settled → teal`, `refunded/withdrawn → warning`, `failed → danger`.

### Typography

- **Sans** (`--font-sans`): system UI stack now; Inter is the intended upgrade
  (add via `next/font` when we polish).
- **Mono** (`--font-mono`): `ui-monospace` for amounts, prices, txids, addresses
  — always with `font-variant-numeric: tabular-nums`.
- **Scale**: `xs .75 · sm .875 · base 1 · lg 1.125 · xl 1.375 · 2xl 1.75 ·
  3xl 2.25 rem`. Headings tight (`-0.02em`), balanced.

### Spacing, radius, elevation

- **Space**: 4px base — `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`.
- **Radius**: `--r-sm 6 · --r-md 10 · --r-lg 14 · --r-pill 999`.
- **Elevation**: `--shadow-1` (cards), `--shadow-2` (modals/popovers).

## Components (`components/ui`)

Primitives built for the P1+ screens:

- **Button** — `primary` (gold), `secondary` (surface + border), `ghost`. Pill
  radius, clear hover/active/focus, full-width option for CTAs.
- **Card** — surface panel, `--r-lg`, `--shadow-1`, optional padded header.
- **StatTile** — small uppercase label over a large tabular value (Price /
  Supply / Sold). The metric-row atom.
- **StatusPill** — status → tone color; used for sale and order states.
- _Planned next (WEB-001):_ **Countdown** (segmented chips), **ProgressBar**
  (allocation sold), **WalletRow** (connect modal), **ProjectCard** (explore),
  **BuyCard** (sale page), **AddressChip** (truncated mono + copy).

## Key screens (layout intent)

- **Explore** — status filter tabs (Upcoming · Live · Finalized) with counts, a
  responsive grid of ProjectCards (media, name, ticker badge, StatusPill, price,
  progress/countdown).
- **Project / sale page** — two columns: media + description + tokenomics left; a
  sticky **BuyCard** right (price, allocation sold ProgressBar, Countdown, amount
  input, primary CTA). Settlement/verify details shown on the same surface.
- **Connect wallet modal** — centered, reassurance line ("You sign in your own
  wallet; no keys leave BSV Desktop"), a single BSV Desktop WalletRow.
- **Admin · create project** — stepper form (Basics → Token/supply → Sale →
  Review), labeled fields, gold Continue CTA — mirrors the OKX/Foundation refs.

## Notes

- The planning-doc artifacts in `docs/artifacts/` use a separate print-ish
  identity; **this** system governs the product app.
- One accent per view. Semantic status color is not the accent.
