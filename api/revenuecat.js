// REVENUECAT WEBHOOK. RevenueCat calls this after every purchase, refund and transfer on the App Store,
// Google Play and RevenueCat Web Billing (Stripe). It's the only thing that ever adds paid takes.
//
// Set up in RevenueCat > Project > Integrations > Webhooks:
//   URL                   https://sportsguy.xyz/api/revenuecat
//   Authorization header  Bearer <REVENUECAT_WEBHOOK_SECRET>   (the same value as the Vercel env var)
//
// Every event is applied at most once: its id goes into `purchases` first, and a repeat is a no-op
// that still answers 200. Anything that isn't a 200 makes RevenueCat retry, so a failure half way
// through removes the record again and answers 500. Sandbox purchases credit too (App Review buys in
// the sandbox) - they're logged with their environment so they can be told apart.
import { timingSafeEqual } from 'node:crypto';
import { addPaid, forgetPurchase, isUuid, movePaid, PRODUCTS, recordPurchase, WALLET_ID, walletReady } from './_wallet.js';

export const config = { maxDuration: 20 };

const CREDIT = new Set(['NON_RENEWING_PURCHASE', 'INITIAL_PURCHASE']);
const REFUND = new Set(['CANCELLATION', 'REFUND']);

function authorised(header, secret) {
  const got = Buffer.from(String(header || ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

// Idempotent apply: record the event, then do the work; undo the record if the work fails.
async function once(record, work) {
  if (!(await recordPurchase(record))) return { duplicate: true };
  try {
    return { result: await work() };
  } catch (error) {
    await forgetPurchase(record.event_id).catch(() => console.error('REVENUECAT: could not un-record', record.event_id));
    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook not configured' });
  if (!authorised(req.headers.authorization, secret)) return res.status(401).json({ error: 'Unauthorized' });
  if (!walletReady()) return res.status(503).json({ error: 'Wallet is not set up' });

  const event = req.body?.event || {};
  const { id, type, app_user_id: wallet, product_id: product, store, environment } = event;
  const log = { id, type, wallet, product, store, environment };
  if (!id || !type) return res.status(200).json({ ok: true, ignored: 'no event' });

  try {
    // BOUGHT TAKES
    if (CREDIT.has(type) && PRODUCTS[product]) {
      if (!WALLET_ID.test(String(wallet || ''))) {
        console.error('REVENUECAT: purchase for an unusable app_user_id', log);
        return res.status(200).json({ ok: true, ignored: 'bad app_user_id' });
      }
      const takes = PRODUCTS[product];
      const done = await once({ event_id: id, wallet, product, takes, kind: 'purchase', store: store || null },
        () => addPaid(wallet, takes));
      console.log(done.duplicate ? 'RevenueCat purchase (repeat, skipped)' : 'RevenueCat purchase credited', { ...log, takes });
      return res.status(200).json({ ok: true, duplicate: !!done.duplicate });
    }

    // REFUNDED TAKES: take them back, never below zero
    if (REFUND.has(type) && PRODUCTS[product]) {
      if (!WALLET_ID.test(String(wallet || ''))) return res.status(200).json({ ok: true, ignored: 'bad app_user_id' });
      const takes = PRODUCTS[product];
      const done = await once({ event_id: id, wallet, product, takes, kind: 'refund', store: store || null },
        () => addPaid(wallet, -takes));
      console.log(done.duplicate ? 'RevenueCat refund (repeat, skipped)' : 'RevenueCat refund deducted', { ...log, takes, removed: done.result ? -done.result.moved : 0 });
      return res.status(200).json({ ok: true, duplicate: !!done.duplicate });
    }

    // TRANSFER: the purchases moved to another app user id (e.g. restore on a new account)
    if (type === 'TRANSFER') {
      const clean = list => (Array.isArray(list) ? list : []).map(String).filter(entry => WALLET_ID.test(entry));
      const fromIds = clean(event.transferred_from);
      const to = clean(event.transferred_to)[0];
      if (!to || !fromIds.length) return res.status(200).json({ ok: true, ignored: 'nothing to transfer' });
      const done = await once({ event_id: id, wallet: to, product: 'transfer', takes: 0, kind: 'transfer', store: store || null },
        async () => {
          let moved = 0;
          for (const from of fromIds) if (from !== to) moved += await movePaid(from, to);
          return moved;
        });
      console.log('RevenueCat transfer', { ...log, fromIds, to, moved: done.result, duplicate: !!done.duplicate, uuids: fromIds.filter(isUuid).length });
      return res.status(200).json({ ok: true, duplicate: !!done.duplicate });
    }

    console.log('RevenueCat event ignored', log);
    return res.status(200).json({ ok: true, ignored: type });
  } catch (error) {
    console.error('RevenueCat webhook failed', { ...log, error: error.message });
    return res.status(500).json({ error: 'Could not apply the event' });
  }
}
