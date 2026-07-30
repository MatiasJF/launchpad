'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@launchpad/db';
import { ADMIN_COOKIE, isAdmin } from './auth';
import { isIdentityPubkey } from './identity';
import { isProjectOwner } from './account-actions';

function field(form: FormData, key: string): string {
  return String(form.get(key) ?? '').trim();
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Public submission — creates a pending project owned by the SUBMITTER's wallet
 * (BRC-100 identity), awaiting admin approval. The owner identity + payout
 * address come from the connected wallet (see SubmitForm). This is what makes
 * the project self-serviceable: only this wallet can later issue/settle it.
 */
export async function createProject(form: FormData): Promise<void> {
  const name = field(form, 'name');
  const ticker = field(form, 'ticker');
  const identityPubkey = field(form, 'identityPubkey');
  const payoutAddress = field(form, 'payoutAddress');
  const logoUrl = field(form, 'logoUrl');
  const banner = field(form, 'banner');
  const website = field(form, 'website');
  if (!name || !ticker) redirect('/submit?error=missing');
  if (!isIdentityPubkey(identityPubkey)) redirect('/submit?error=wallet');
  if (!payoutAddress) redirect('/submit?error=payout');
  const isHttps = (u: string) => /^https:\/\/\S+$/i.test(u);
  const isImage = (u: string, max: number) =>
    isHttps(u) ||
    (/^data:image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|jpg|webp|svg\+xml);base64,/i.test(u) && u.length <= max);

  const slug = slugify(name);
  const existing = await prisma.project.findUnique({ where: { slug } });
  if (existing) redirect('/submit?error=slug');

  // Owner = the connecting wallet. Owning a project makes them an issuer.
  const owner = await prisma.account.upsert({
    where: { identityPubkey },
    update: { role: 'issuer' },
    create: { identityPubkey, role: 'issuer' },
  });

  await prisma.project.create({
    data: {
      ownerId: owner.id,
      payoutAddress,
      slug,
      name,
      tagline: field(form, 'blurb'),
      description: field(form, 'about'),
      logoUrl: isImage(logoUrl, 300_000) ? logoUrl : null,
      media: isImage(banner, 1_200_000) ? JSON.stringify({ banner }) : null,
      links: isHttps(website) ? JSON.stringify({ website }) : null,
      status: 'pending',
      tokens: {
        create: {
          name,
          ticker,
          decimals: 0,
          totalSupply: BigInt(field(form, 'totalSupply') || '0'),
          allocations: JSON.stringify([{ label: 'Public sale', pct: 100 }]),
          sales: {
            create: {
              type: 'instant',
              priceSats: BigInt(field(form, 'priceSats') || '0'),
              allocationForSale: BigInt(field(form, 'publicAllocation') || '0'),
              status: 'scheduled',
            },
          },
        },
      },
    },
  });

  revalidatePath('/admin');
  redirect('/submit?ok=1');
}

/**
 * Update a project's display metadata from the owner dashboard. Owner-gated
 * (identity must match the project owner). Set logo/website before (re)issuing so
 * the metadata lands in the genesis OP_RETURN too. Empty string clears a field.
 */
export async function updateProjectMeta(input: {
  projectId: string;
  identityPubkey: string;
  logoUrl: string;
  bannerUrl: string;
  website: string;
  description: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!(await isProjectOwner(input.projectId, input.identityPubkey))) {
    return { ok: false, error: 'not the project owner' };
  }
  const isHttps = (u: string) => /^https:\/\/\S+$/i.test(u);
  // An image may be an https URL OR an uploaded data URI (png/ico/jpeg/webp/svg);
  // cap the data URI so the DB row stays sane (banners allowed larger than logos).
  const isImage = (u: string, max: number) =>
    isHttps(u) ||
    (/^data:image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|jpg|webp|svg\+xml);base64,/i.test(u) && u.length <= max);
  const logoUrl = input.logoUrl.trim();
  const bannerUrl = input.bannerUrl.trim();
  const website = input.website.trim();
  try {
    await prisma.project.update({
      where: { id: input.projectId },
      data: {
        logoUrl: logoUrl === '' ? null : isImage(logoUrl, 300_000) ? logoUrl : undefined,
        // Banner cover lives in the `media` JSON field.
        media: bannerUrl === '' ? null : isImage(bannerUrl, 1_200_000) ? JSON.stringify({ banner: bannerUrl }) : undefined,
        links: website === '' ? null : isHttps(website) ? JSON.stringify({ website }) : undefined,
        description: input.description.trim() || null,
      },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'update failed' };
  }
  revalidatePath('/');
  revalidatePath(`/project/${input.projectId}/manage`);
  return { ok: true };
}

/**
 * Owner sets the sale schedule: status (scheduled | live | finalized) plus optional
 * start/end times. Buyers can only buy while `live`; a scheduled sale shows a
 * "starts in" countdown. Owner-gated.
 */
export async function updateSaleSchedule(input: {
  projectId: string;
  identityPubkey: string;
  status: string;
  startsAt: string; // ISO or ''
  endsAt: string; // ISO or ''
}): Promise<{ ok: boolean; error?: string }> {
  if (!(await isProjectOwner(input.projectId, input.identityPubkey))) {
    return { ok: false, error: 'not the project owner' };
  }
  if (!['scheduled', 'live', 'finalized'].includes(input.status)) {
    return { ok: false, error: 'invalid status' };
  }
  const toDate = (s: string) => {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };
  try {
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      include: { tokens: { include: { sales: true } } },
    });
    const sale = project?.tokens.flatMap((t) => t.sales)[0];
    if (!sale) return { ok: false, error: 'no sale found' };
    await prisma.sale.update({
      where: { id: sale.id },
      data: { status: input.status, startsAt: toDate(input.startsAt), endsAt: toDate(input.endsAt) },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'update failed' };
  }
  revalidatePath('/');
  revalidatePath(`/project/${input.projectId}/manage`);
  return { ok: true };
}

/**
 * Owner sets the escrow-presale terms (ADR-025): sale type, soft/hard cap, and the
 * fixed pledge unit. Caps must be whole multiples of the pledge unit so pledges
 * compose exactly. Owner-gated.
 */
export async function updateSaleEscrow(input: {
  projectId: string;
  identityPubkey: string;
  type: 'instant' | 'escrow_presale';
  softCapSats: number;
  hardCapSats: number;
  pledgeUnitSats: number;
}): Promise<{ ok: boolean; error?: string }> {
  if (!(await isProjectOwner(input.projectId, input.identityPubkey))) {
    return { ok: false, error: 'not the project owner' };
  }
  if (input.type === 'escrow_presale') {
    const { softCapSats: soft, hardCapSats: hard, pledgeUnitSats: unit } = input;
    if (unit <= 0) return { ok: false, error: 'pledge unit must be positive' };
    if (soft <= 0 || soft % unit !== 0) return { ok: false, error: 'soft cap must be a positive multiple of the pledge unit' };
    if (hard < soft || hard % unit !== 0) return { ok: false, error: 'hard cap must be ≥ soft cap and a multiple of the pledge unit' };
  }
  try {
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      include: { tokens: { include: { sales: true } } },
    });
    const token = project?.tokens[0];
    const sale = project?.tokens.flatMap((t) => t.sales)[0];
    if (!sale || !token) return { ok: false, error: 'no sale found' };

    // Guard against selling more tokens than exist: tokens owed at the hard cap
    // (hardCap / price) must fit the sale allocation (or the total supply).
    if (input.type === 'escrow_presale') {
      const price = Number(sale.priceSats) || 0;
      if (price <= 0) return { ok: false, error: 'set a token price before configuring a presale' };
      const maxTokens = Number(sale.allocationForSale) || Number(token.totalSupply);
      const tokensAtHardCap = Math.floor(input.hardCapSats / price);
      if (tokensAtHardCap > maxTokens) {
        return {
          ok: false,
          error: `hard cap sells ${tokensAtHardCap} tokens but only ${maxTokens} are available — lower the hard cap or the price, or issue more supply`,
        };
      }
    }

    await prisma.sale.update({
      where: { id: sale.id },
      data:
        input.type === 'escrow_presale'
          ? {
              type: 'escrow_presale',
              softCap: BigInt(Math.floor(input.softCapSats)),
              hardCap: BigInt(Math.floor(input.hardCapSats)),
              pledgeUnitSats: BigInt(Math.floor(input.pledgeUnitSats)),
              // Total tokens the presale can distribute (soft-cap pledges + instant
              // top-up above it) = hardCap / price. Bounds the oversell guard.
              allocationForSale: BigInt(Math.floor(input.hardCapSats / (Number(sale.priceSats) || 1))),
            }
          : { type: 'instant' },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'update failed' };
  }
  revalidatePath('/');
  revalidatePath(`/project/${input.projectId}/manage`);
  return { ok: true };
}

/**
 * Delete a project and everything under it (token → sale → orders, plus events).
 * Allowed for the project OWNER (pass identity) or the platform ADMIN. This only
 * removes DB records — any tokens already issued on-chain still exist on mainnet.
 */
export async function deleteProject(
  projectId: string,
  identityPubkey?: string,
): Promise<{ ok: boolean; error?: string }> {
  const admin = await isAdmin();
  const owner = identityPubkey ? await isProjectOwner(projectId, identityPubkey) : false;
  if (!admin && !owner) return { ok: false, error: 'not authorized to delete this project' };

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { tokens: { include: { sales: { include: { orders: true } } } } },
    });
    if (!project) return { ok: false, error: 'project not found' };

    const tokenIds = project.tokens.map((t) => t.id);
    const saleIds = project.tokens.flatMap((t) => t.sales.map((s) => s.id));
    const orderIds = project.tokens.flatMap((t) => t.sales.flatMap((s) => s.orders.map((o) => o.id)));

    await prisma.$transaction([
      prisma.order.deleteMany({ where: { saleId: { in: saleIds } } }),
      prisma.sale.deleteMany({ where: { tokenId: { in: tokenIds } } }),
      prisma.token.deleteMany({ where: { projectId } }),
      prisma.event.deleteMany({ where: { entityId: { in: [projectId, ...tokenIds, ...saleIds, ...orderIds] } } }),
      prisma.project.delete({ where: { id: projectId } }),
    ]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'delete failed' };
  }
  revalidatePath('/');
  revalidatePath('/admin');
  return { ok: true };
}

/** Admin form-action wrapper: delete a project by id from the admin page. */
export async function deleteProjectForm(form: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const id = field(form, 'id');
  if (id) await deleteProject(id);
  revalidatePath('/admin');
}

export async function adminLogin(form: FormData): Promise<void> {
  const secret = field(form, 'secret');
  if (secret && secret === process.env.ADMIN_SECRET) {
    const store = await cookies();
    store.set(ADMIN_COOKIE, 'ok', { httpOnly: true, sameSite: 'lax', path: '/' });
  }
  redirect('/admin');
}

export async function adminLogout(): Promise<void> {
  const store = await cookies();
  store.delete(ADMIN_COOKIE);
  redirect('/admin');
}

export async function setProjectStatus(form: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const id = field(form, 'id');
  const status = field(form, 'status');
  if (!id || !status) return;
  await prisma.project.update({ where: { id }, data: { status } });
  revalidatePath('/admin');
  revalidatePath('/');
}
