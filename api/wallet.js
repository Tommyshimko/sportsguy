// THE BALANCE, AND MOVING IT ON SIGN-IN. POST only.
//   {wallet, token?}                  -> 200 {freeLeft, paid, freePerDay}
//       Same identity rules as /api/generate (signed-in account, else the RevenueCat id, else the IP).
//       Only reads: today's top-up is shown, never written.
//   {action:'merge', from, token}     -> 200 {freeLeft, paid, freePerDay} of the signed-in account
//       Takes bought before signing in (on the anonymous RevenueCat id `from`) move into the account.
//       Safe to call again: the second call finds nothing left to move. Free takes don't move.
//   401 merge without a valid token, 400 bad `from`, 503 wallet not set up / database trouble.
import { whoIs } from './_account.js';
import { clientIp, isUuid, movePaid, peekWallet, resolveWallet, WALLET_ID, walletReady } from './_wallet.js';

export const config = { maxDuration: 20 };

const ALLOWED_ORIGINS = [
  /^https:\/\/(www\.)?sportsguy\.xyz$/,
  /^https:\/\/sportsguy-[a-z0-9-]+\.vercel\.app$/,
  /^http:\/\/localhost(:\d+)?$/
];

export default async function handler(req, res) {
  // Browsers only from our own site. The phone app sends no Origin.
  const origin = req.headers.origin;
  if (origin) {
    if (!ALLOWED_ORIGINS.some(pattern => pattern.test(origin))) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!walletReady()) return res.status(503).json({ error: 'Wallet is not set up' });

  const body = req.body || {};
  try {
    if (body.action === 'merge') {
      const userId = await whoIs(body.token);
      if (!userId) return res.status(401).json({ error: 'Not signed in' });
      const from = typeof body.from === 'string' ? body.from.trim() : '';
      if (from === userId) return res.status(200).json(await peekWallet(userId));
      // Only an anonymous store id can be merged: never an IP wallet, never another person's account
      if (!WALLET_ID.test(from) || isUuid(from) || from.startsWith('ip:')) {
        return res.status(400).json({ error: 'Nothing to merge from that id' });
      }
      const moved = await movePaid(from, userId);
      if (moved) console.log('Wallet merged', { from, userId, moved });
      return res.status(200).json(await peekWallet(userId));
    }

    const { walletId } = await resolveWallet(body, clientIp(req));
    return res.status(200).json(await peekWallet(walletId));
  } catch (error) {
    console.error('Wallet request failed', { error: error.message });
    return res.status(503).json({ error: 'Could not read your takes. Try again in a bit.' });
  }
}
