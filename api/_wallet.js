// THE WALLET. Every take someone asks for is paid for from here, so the owner is never exposed to an
// open-ended bill:
//   - FREE takes: FREE_PER_DAY per wallet per UTC day, and never more than FREE_DAILY_BUDGET new free
//     takes a day across everyone put together.
//   - PAID takes: bought through RevenueCat (App Store, Google Play, web), credited by api/revenuecat.js,
//     one spent per new take. Paid takes don't count against the free budget.
// Pool hits, replays and season lines never touch the wallet.
//
// A wallet is keyed by the RevenueCat app user id the app sends (an anonymous "$RCAnonymousID:..."
// before sign-in, the Supabase user id after), or by "ip:<address>" for old builds that send nothing.
// Tables: qa/2026-09-24-wallets.sql. Service key only - RLS is on with no policies.
import { whoIs } from './_account.js';

// ==================== SETTINGS ====================
export const FREE_PER_DAY = Number(process.env.FREE_TAKES_PER_DAY) || 3;
export const FREE_DAILY_BUDGET = Number(process.env.FREE_DAILY_BUDGET) || 150;   // new free takes/day, everyone
export const PAID_HOURLY_LIMIT = Number(process.env.PAID_HOURLY_LIMIT) || 40;    // abuse brake, per wallet
export const PRODUCTS = { takes_10: 10, takes_30: 30, takes_70: 70 };            // RevenueCat product id -> takes

export const WALLET_ID = /^[A-Za-z0-9$:_\-.]{8,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const todayUTC = () => new Date().toISOString().slice(0, 10);
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
  return (await readWallet(id)) || { id, paid: 0, free_day: null, free_used: 0 };
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
export function walletView(row) {
  const usedToday = row && row.free_day && String(row.free_day).slice(0, 10) === todayUTC() ? Number(row.free_used) || 0 : 0;
  return { freeLeft: Math.max(0, FREE_PER_DAY - usedToday), paid: Math.max(0, Number(row?.paid) || 0), freePerDay: FREE_PER_DAY };
}

export async function peekWallet(id) {
  return walletView(await readWallet(id));
}

// ==================== CHARGING ====================
// Spends one take for a NEW generation. Free first (if the person has one left today AND the shared
// free budget isn't spent AND free isn't blocked by the IP brake), else paid (unless paid is braked).
//   { ok: true, kind: 'free'|'paid', wallet }
//   { ok: false, code: 'out'|'free-budget'|'rate', wallet }
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
    if (paid > 0 && !paidBlocked) {
      const updated = await patchIf(id, `&paid=eq.${paid}`, { paid: paid - 1 });
      if (!updated) continue;
      return { ok: true, kind: 'paid', wallet: walletView(updated) };
    }
    const wallet = walletView(row);
    if (paid > 0 && paidBlocked) return { ok: false, code: 'rate', wallet };
    if (personalFree && freeBlocked && budgetLeft) return { ok: false, code: 'rate', wallet };
    return { ok: false, code: personalFree ? 'free-budget' : 'out', wallet };
  }
  throw new Error('wallet busy');
}

// Gives back exactly what chargeTake spent. A free take is only returned on the same UTC day.
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
