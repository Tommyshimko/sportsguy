// THE WALLET. Every take someone asks for is paid for from here, so the owner is never exposed to an
// open-ended bill:
//   - FREE takes: FREE_PER_DAY per wallet per UTC day, and never more than FREE_DAILY_BUDGET new free
//     takes a day across everyone put together.
//   - PRO takes: while the wallet's pro_until is in the future (a pro_monthly / pro_annual subscription,
//     kept current by api/revenuecat.js), PRO_PER_MONTH new takes per UTC calendar month.
//   - PAID takes: bought packs through RevenueCat (App Store, Google Play, web), credited by
//     api/revenuecat.js, one spent per new take.
//   Spent in that order: free, then Pro, then paid. Pro and paid takes don't count against the free budget.
// Pool hits, replays and season lines never touch the wallet.
//
// A wallet is keyed by the RevenueCat app user id the app sends (an anonymous "$RCAnonymousID:..."
// before sign-in, the Supabase user id after), or by "ip:<address>" for old builds that send nothing.
// Tables: qa/2026-09-24-wallets.sql + qa/2026-09-25-pro.sql. Service key only - RLS is on with no policies.
import { whoIs } from './_account.js';

// ==================== SETTINGS ====================
export const FREE_PER_DAY = Number(process.env.FREE_TAKES_PER_DAY) || 2;
export const PRO_PER_MONTH = Number(process.env.PRO_TAKES_PER_MONTH) || 80;      // Pro takes per UTC month
export const FREE_DAILY_BUDGET = Number(process.env.FREE_DAILY_BUDGET) || 150;   // new free takes/day, everyone
export const PAID_HOURLY_LIMIT = Number(process.env.PAID_HOURLY_LIMIT) || 40;    // abuse brake, per wallet
// RevenueCat product id -> takes. The 10/30/70 ids were never sold; kept so nothing breaks if one turns up.
export const PRODUCTS = { takes_12: 12, takes_35: 35, takes_80: 80, takes_10: 10, takes_30: 30, takes_70: 70 };
export const PRO_PRODUCTS = new Set(['pro_monthly', 'pro_annual']);
// Google Play sends subscriptions as "subscription:base-plan" (pro_monthly:monthly). Keep the first part.
export const normaliseProduct = product => String(product || '').split(':')[0];

export const WALLET_ID = /^[A-Za-z0-9$:_\-.]{8,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const todayUTC = () => new Date().toISOString().slice(0, 10);
export const monthUTC = () => new Date().toISOString().slice(0, 7);
export const freeKey = (day = todayUTC()) => `free:${day}`;
const TRIES = 3;

// ==================== SUPABASE ====================
export const walletReady = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

async function rest(path, options = {}) {
  const SERVICE = process.env.SUPABASE_SERVICE_KEY;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`supabase ${response.status}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const q = value => encodeURIComponent(value);

// PATCH only if the row still looks like it did when read. [] back means someone moved it first.
async function patchIf(id, conditions, body) {
  const rows = await rest(`wallets?id=eq.${q(id)}${conditions}&select=*`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
  });
  return rows?.[0] || null;
}

export async function readWallet(id) {
  const rows = await rest(`wallets?id=eq.${q(id)}&select=*`);
  return rows?.[0] || null;
}

// First sight: make the row. Does nothing if it's already there.
async function ensureWallet(id) {
  const existing = await readWallet(id);
  if (existing) return existing;
  await rest('wallets?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ id }),
  });
  return (await readWallet(id)) || { id, paid: 0, free_day: null, free_used: 0, pro_until: null, pro_month: null, pro_used: 0, pro_product: null };
}

// ==================== IDENTITY ====================
// Signed in (token verifies) -> the account id. Otherwise the wallet id the app sent, as long as it
// isn't pretending to be somebody's account (a bare user id without that user's token) or an ip:
// wallet. Otherwise (old builds) the caller's IP.
export async function resolveWallet(body, ip) {
  const userId = body?.token ? await whoIs(body.token) : null;
  if (userId) return { walletId: userId, userId };
  const sent = typeof body?.wallet === 'string' ? body.wallet.trim() : '';
  if (WALLET_ID.test(sent) && !UUID.test(sent) && !sent.startsWith('ip:')) return { walletId: sent, userId: null };
  return { walletId: `ip:${ip || 'unknown'}`, userId: null };
}

export const clientIp = req => String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();

// ==================== BALANCE ====================
// What the app shows. Today's top-up is worked out here, never written just by looking.
const ms = value => (typeof value === 'number' ? value : value ? Date.parse(value) : NaN);
export const isPro = row => ms(row?.pro_until) > Date.now();
// Pro takes used in the CURRENT month (a stored count from an earlier month is a fresh start)
const proUsedNow = row => (row?.pro_month === monthUTC() ? Number(row.pro_used) || 0 : 0);
const iso = value => (Number.isFinite(ms(value)) ? new Date(ms(value)).toISOString() : null);

export function walletView(row) {
  const usedToday = row && row.free_day && String(row.free_day).slice(0, 10) === todayUTC() ? Number(row.free_used) || 0 : 0;
  const pro = isPro(row);
  return {
    freeLeft: Math.max(0, FREE_PER_DAY - usedToday),
    paid: Math.max(0, Number(row?.paid) || 0),
    freePerDay: FREE_PER_DAY,
    pro,
    proLeft: pro ? Math.max(0, PRO_PER_MONTH - proUsedNow(row)) : 0,
    proPerMonth: PRO_PER_MONTH,
    proUntil: iso(row?.pro_until),
  };
}

// PostgREST filter matching a column's value exactly as it was read (null included)
const same = (column, value) => (value == null ? `&${column}=is.null` : `&${column}=eq.${q(String(value))}`);

export async function peekWallet(id) {
  return walletView(await readWallet(id));
}

// ==================== CHARGING ====================
// Spends one take for a NEW generation. Free first (if the person has one left today AND the shared
// free budget isn't spent AND free isn't blocked by the IP brake), else Pro (subscribed and some of this
// month's allowance left), else paid. Pro and paid share the per-wallet brake (paidBlocked).
//   { ok: true, kind: 'free'|'pro'|'paid', wallet }   (+ day for free, month for pro)
//   { ok: false, code: 'out'|'pro-out'|'free-budget'|'rate', wallet }
export async function chargeTake(id, cache, { freeBlocked = false, paidBlocked = false } = {}) {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const row = await ensureWallet(id);
    const today = todayUTC();
    const sameDay = row.free_day && String(row.free_day).slice(0, 10) === today;
    const used = sameDay ? Number(row.free_used) || 0 : 0;
    const paid = Number(row.paid) || 0;
    const budgetUsed = (await cache.get(freeKey(today))) || 0;
    const personalFree = used < FREE_PER_DAY;
    const budgetLeft = budgetUsed < FREE_DAILY_BUDGET;

    if (personalFree && budgetLeft && !freeBlocked) {
      // Tops up and spends in one write, and only if nobody else touched today's count in between
      const dayCond = row.free_day ? `&free_day=eq.${q(String(row.free_day).slice(0, 10))}` : '&free_day=is.null';
      const updated = await patchIf(id, `${dayCond}&free_used=eq.${Number(row.free_used) || 0}`, { free_day: today, free_used: used + 1 });
      if (!updated) continue;
      await cache.set(freeKey(today), ((await cache.get(freeKey(today))) || 0) + 1, { ttl: 26 * 60 * 60 });
      return { ok: true, kind: 'free', day: today, wallet: walletView(updated) };
    }
    const pro = isPro(row);
    const month = monthUTC();
    const proUsed = proUsedNow(row);
    const proLeft = pro && proUsed < PRO_PER_MONTH;
    if (proLeft && !paidBlocked) {
      // Resets a stale month and spends in one write, only if the month/count are as read
      const updated = await patchIf(id, `${same('pro_month', row.pro_month)}&pro_used=eq.${Number(row.pro_used) || 0}`,
        { pro_month: month, pro_used: proUsed + 1 });
      if (!updated) continue;
      return { ok: true, kind: 'pro', month, wallet: walletView(updated) };
    }
    if (paid > 0 && !paidBlocked) {
      const updated = await patchIf(id, `&paid=eq.${paid}`, { paid: paid - 1 });
      if (!updated) continue;
      return { ok: true, kind: 'paid', wallet: walletView(updated) };
    }
    const wallet = walletView(row);
    if ((paid > 0 || proLeft) && paidBlocked) return { ok: false, code: 'rate', wallet };
    if (personalFree && freeBlocked && budgetLeft) return { ok: false, code: 'rate', wallet };
    if (pro) return { ok: false, code: 'pro-out', wallet };
    return { ok: false, code: personalFree ? 'free-budget' : 'out', wallet };
  }
  throw new Error('wallet busy');
}

// Gives back exactly what chargeTake spent. A free take is only returned on the same UTC day, a Pro
// take only in the same UTC month.
export async function refundTake(id, charge, cache) {
  if (!charge?.ok) return;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    try {
      const row = await readWallet(id);
      if (!row) return;
      let updated;
      if (charge.kind === 'free') {
        if (String(row.free_day || '').slice(0, 10) !== charge.day) return;
        const used = Number(row.free_used) || 0;
        if (used <= 0) return;
        updated = await patchIf(id, `&free_day=eq.${charge.day}&free_used=eq.${used}`, { free_used: used - 1 });
        if (updated) {
          const key = freeKey(charge.day);
          await cache.set(key, Math.max(0, ((await cache.get(key)) || 0) - 1), { ttl: 26 * 60 * 60 });
        }
      } else if (charge.kind === 'pro') {
        if (row.pro_month !== charge.month) return;
        const used = Number(row.pro_used) || 0;
        if (used <= 0) return;
        updated = await patchIf(id, `&pro_month=eq.${q(charge.month)}&pro_used=eq.${used}`, { pro_used: used - 1 });
      } else {
        const paid = Number(row.paid) || 0;
        updated = await patchIf(id, `&paid=eq.${paid}`, { paid: paid + 1 });
      }
      if (updated) return walletView(updated);
    } catch (error) {
      console.error('Wallet refund failed', { id, kind: charge.kind, error: error.message });
      return;
    }
  }
  console.error('Wallet refund gave up', { id, kind: charge.kind });
}

// ==================== PURCHASES ====================
// Adds (or, with a negative n, removes - never below zero) paid takes.
export async function addPaid(id, n) {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const row = await ensureWallet(id);
    const paid = Number(row.paid) || 0;
    const next = Math.max(0, paid + n);
    if (next === paid) return { wallet: walletView(row), moved: 0 };
    const updated = await patchIf(id, `&paid=eq.${paid}`, { paid: next });
    if (updated) return { wallet: walletView(updated), moved: next - paid };
  }
  throw new Error('wallet busy');
}

// Moves every paid take from one wallet to another. The source is zeroed first (conditionally), so
// running this twice moves nothing the second time. If the credit then fails, the source is put back.
export async function movePaid(fromId, toId) {
  if (fromId === toId) return 0;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const row = await readWallet(fromId);
    const paid = Number(row?.paid) || 0;
    if (!row || paid <= 0) return 0;
    const zeroed = await patchIf(fromId, `&paid=eq.${paid}`, { paid: 0 });
    if (!zeroed) continue;
    try {
      await addPaid(toId, paid);
    } catch (error) {
      console.error('Wallet move failed, putting it back', { fromId, toId, paid, error: error.message });
      await addPaid(fromId, paid).catch(() => console.error('WALLET MOVE LOST TAKES', { fromId, toId, paid }));
      throw error;
    }
    return paid;
  }
  throw new Error('wallet busy');
}

// ==================== PRO ====================
// Sets Pro to run until `until` (ms or ISO) - never shortens a later end already on the wallet.
// `carry` ({month, used}) brings another wallet's Pro use this month along (merge / transfer), so moving
// a subscription between ids never hands out a second month's allowance.
export async function extendPro(id, until, product, carry = null) {
  const target = ms(until);
  if (!Number.isFinite(target)) throw new Error('bad pro_until');
  const month = monthUTC();
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const row = await ensureWallet(id);
    const current = ms(row.pro_until);
    const body = {};
    if (!(current >= target)) body.pro_until = new Date(target).toISOString();
    if (product && (body.pro_until || !row.pro_product)) body.pro_product = product;
    const carried = carry?.month === month ? Number(carry.used) || 0 : 0;
    if (carried > proUsedNow(row)) Object.assign(body, { pro_month: month, pro_used: carried });
    if (!Object.keys(body).length) return walletView(row);
    const updated = await patchIf(id,
      `${same('pro_until', row.pro_until)}${same('pro_month', row.pro_month)}&pro_used=eq.${Number(row.pro_used) || 0}`, body);
    if (updated) return walletView(updated);
  }
  throw new Error('wallet busy');
}

// Ends Pro now (refund / expiry), if it's still running. `unlessAfter` (ms): leave it alone when the
// wallet already runs past that - a renewal landed after the subscription this event is about.
export async function endPro(id, { unlessAfter } = {}) {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const row = await readWallet(id);
    const current = ms(row?.pro_until);
    if (!row || !(current > Date.now())) return walletView(row);
    if (Number.isFinite(unlessAfter) && current > unlessAfter + 60_000) return walletView(row);
    const updated = await patchIf(id, same('pro_until', row.pro_until), { pro_until: new Date().toISOString() });
    if (updated) return walletView(updated);
  }
  throw new Error('wallet busy');
}

// Copies Pro (later end wins, this month's use carried) from one wallet to another. Nothing to copy -> false.
export async function copyPro(fromId, toId) {
  if (fromId === toId) return false;
  const row = await readWallet(fromId);
  if (!row?.pro_until) return false;
  await extendPro(toId, row.pro_until, row.pro_product, { month: row.pro_month, used: row.pro_used });
  return true;
}

// Moves Pro to another wallet (store TRANSFER): copy, then clear the source. Re-running is harmless.
export async function movePro(fromId, toId) {
  if (!(await copyPro(fromId, toId))) return false;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const row = await readWallet(fromId);
    if (!row?.pro_until) return true;
    if (await patchIf(fromId, same('pro_until', row.pro_until), { pro_until: null, pro_product: null })) return true;
  }
  throw new Error('wallet busy');
}

// Records a store event once. true = new (go ahead and apply it), false = seen before.
export async function recordPurchase(row) {
  const inserted = await rest('purchases?on_conflict=event_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  return Array.isArray(inserted) && inserted.length > 0;
}

// Lets a failed apply be retried by the store (RevenueCat retries anything that isn't a 200)
export async function forgetPurchase(eventId) {
  await rest(`purchases?event_id=eq.${q(eventId)}`, { method: 'DELETE' });
}

export async function deleteWallet(id) {
  if (!walletReady()) return;
  await rest(`wallets?id=eq.${q(id)}`, { method: 'DELETE' });
}

export const isUuid = value => UUID.test(String(value || ''));
