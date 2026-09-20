// Signed-in people keep their takes on the server, so the count can't be edited on the phone.
// Signing in is optional: without a token everything here is skipped and the app counts locally.
const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;

export const accountsReady = () => !!(URL && ANON && SERVICE);

// Who is this? Asks Supabase to vouch for the token; a forged one gets nothing.
export async function whoIs(token) {
  if (!accountsReady() || !token) return null;
  try {
    const response = await fetch(`${URL}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const user = await response.json();
    return user?.id || null;
  } catch {
    return null;
  }
}

async function rest(path, options = {}) {
  const response = await fetch(`${URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`supabase ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export async function readAccount(userId) {
  const [profile] = await rest(`profiles?id=eq.${userId}&select=takes_left,unlimited_until`);
  if (!profile) return null;
  const unlimited = !!profile.unlimited_until && new Date(profile.unlimited_until) > new Date();
  return { takesLeft: profile.takes_left, unlimited };
}

// Takes one take off the balance, and only if there is one to take. Returns what's left, or null
// when they're out (someone on unlimited is never charged).
export async function chargeOneTake(userId) {
  const account = await readAccount(userId);
  if (!account) return null;
  if (account.unlimited) return account;
  if (account.takesLeft <= 0) return null;
  const [updated] = await rest(`profiles?id=eq.${userId}&takes_left=gt.0&select=takes_left`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ takes_left: account.takesLeft - 1 }),
  });
  return updated ? { takesLeft: updated.takes_left, unlimited: false } : null;
}

export async function refundOneTake(userId) {
  const account = await readAccount(userId);
  if (!account || account.unlimited) return;
  await rest(`profiles?id=eq.${userId}`, { method: 'PATCH', body: JSON.stringify({ takes_left: account.takesLeft + 1 }) }).catch(() => {});
}

// The teams this person follows, in the sport they're looking at.
export async function followedTeams(userId, sport) {
  try {
    const rows = await rest(`favorite_teams?user_id=eq.${userId}&sport=eq.${sport}&select=label&limit=6`);
    return (rows || []).map(row => row.label);
  } catch {
    return [];
  }
}
