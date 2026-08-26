// ESM loader hooks that intercept Next-runtime-only specifiers with no-op modules, so
// the real 'use server' actions (stas-actions.ts et al.) can be imported + called from a
// plain tsx script (no Next server). Only cache/routing/cookies are stubbed — pure DB +
// chain logic runs for real. Registered via module.register in the harness before import.
const STUBS = {
  'server-only': '',
  'client-only': '',
  'next/cache': 'export const revalidatePath=()=>{};export const revalidateTag=()=>{};export const unstable_cache=(f)=>f;export const unstable_noStore=()=>{};',
  'next/navigation': 'export const redirect=(u)=>{const e=new Error("NEXT_REDIRECT");e.digest="NEXT_REDIRECT;"+u;throw e;};export const notFound=()=>{throw new Error("NEXT_NOT_FOUND");};',
  'next/headers': 'export const cookies=()=>({get:(k)=>k==="admin_session"?{value:"ok"}:undefined,set:()=>{},delete:()=>{}});export const headers=()=>new Map();',
};
export async function resolve(spec, ctx, next) {
  if (Object.prototype.hasOwnProperty.call(STUBS, spec)) return { url: 'stubnext:' + encodeURIComponent(spec), shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url.startsWith('stubnext:')) return { format: 'module', source: STUBS[decodeURIComponent(url.slice(9))] ?? '', shortCircuit: true };
  return next(url, ctx);
}
