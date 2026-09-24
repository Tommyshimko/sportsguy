// Delete my account. The app's Settings > Delete account calls this with the person's sign-in token.
// POST, with the token as JSON {token} or as "Authorization: Bearer <token>".
//   200 {ok:true}   the account, its profile, its followed teams and its takes wallet are gone
//   401             no token, or Supabase doesn't recognise it
//   405             anything but POST
//   500 / 503       something went wrong on our side (nothing was half-deleted: it's one call)
import { accountsReady, deleteUser, whoIs } from './_account.js';
import { deleteWallet } from './_wallet.js';

export const config = { maxDuration: 20 };

const ALLOWED_ORIGINS = [
  /^https:\/\/(www\.)?sportsguy\.xyz$/,
  /^https:\/\/sportsguy-[a-z0-9-]+\.vercel\.app$/,
  /^http:\/\/localhost(:\d+)?$/
];

export default async function handler(req, res) {
  // Same rule as generate.js: browsers only from our own site. The phone app sends no Origin.
  const origin = req.headers.origin;
  if (origin) {
    if (!ALLOWED_ORIGINS.some(pattern => pattern.test(origin))) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!accountsReady()) return res.status(503).json({ error: 'Accounts are not set up' });

  const header = String(req.headers.authorization || '');
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const token = (typeof req.body?.token === 'string' && req.body.token.trim()) || bearer;

  const userId = await whoIs(token);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  // TODO(Tommy): Sign in with Apple accounts should also have their Apple token revoked
  // (POST https://appleid.apple.com/auth/revoke), which Apple asks for on account deletion. That needs
  // a Sign in with Apple private key (.p8) + key id + team id as env vars to sign the client secret,
  // and the app to hand us the Apple authorization code at sign-in. Add it once the key exists.

  try {
    await deleteUser(userId);
    // Their wallet goes too (its id is the account id). Store receipts in `purchases` stay, as records.
    await deleteWallet(userId).catch(error => console.error('Wallet delete failed', { userId, error: error.message }));
    console.log('Account deleted', { userId });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Account delete failed', { userId, error: error.message });
    return res.status(500).json({ error: 'Could not delete the account. Try again, or email tommyshimko@gmail.com.' });
  }
}
