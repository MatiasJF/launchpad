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
  const website = field(form, 'website');
  if (!name || !ticker) redirect('/submit?error=missing');
  if (!isIdentityPubkey(identityPubkey)) redirect('/submit?error=wallet');
  if (!payoutAddress) redirect('/submit?error=payout');
  const isHttps = (u: string) => /^https:\/\/\S+$/i.test(u);

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
      logoUrl: isHttps(logoUrl) ? logoUrl : null,
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
  website: string;
  description: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!(await isProjectOwner(input.projectId, input.identityPubkey))) {
    return { ok: false, error: 'not the project owner' };
  }
  const isHttps = (u: string) => /^https:\/\/\S+$/i.test(u);
  // A logo may be an https URL OR an uploaded image embedded as a data URI
  // (png / ico / jpeg / webp / svg). Cap the data URI so the DB row stays sane.
  const isLogo = (u: string) =>
    isHttps(u) ||
    (/^data:image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|jpg|webp|svg\+xml);base64,/i.test(u) && u.length <= 300_000);
  const logoUrl = input.logoUrl.trim();
  const website = input.website.trim();
  try {
    await prisma.project.update({
      where: { id: input.projectId },
      data: {
        logoUrl: logoUrl === '' ? null : isLogo(logoUrl) ? logoUrl : undefined,
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
