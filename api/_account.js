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

// FREE DAILY TAKES. Everyone signed in gets topped back up to FREE_PER_DAY once a day (UTC). A top-up
// only ever raises the balance - someone holding more than that keeps what they have. The top-up is
// worked out on read and only written down when a take is actually charged, so reading the balance
// never changes anything. Needs the column in qa/2026-09-24-refilled_on.sql.
export const FREE_PER_DAY = 5;
const todayUTC = () => new Date().toISOString().slice(0, 10);

export async function readAccount(userId) {
  const [profile] = await rest(`profiles?id=eq.${userId}&select=takes_left,unlimited_until,refilled_on`);
  if (!profile) return null;
  const unlimited = !!profile.unlimited_until && new Date(profile.unlimited_until) > new Date();
  const stored = Number(profile.takes_left) || 0;
  const today = todayUTC();
  // refilled_on comes back as 'YYYY-MM-DD', so plain string order is date order
  const refillDue = !profile.refilled_on || String(profile.refilled_on).slice(0, 10) < today;
  const takesLeft = refillDue ? Math.max(stored, FREE_PER_DAY) : stored;
  return { takesLeft, unlimited, stored, refillDue, today };
}

// Takes one take off the balance, and only if there is one to take. Returns what's left, or null
// when they're out (someone on unlimited is never charged).
//
// Every write is conditional on the row still looking the way it did when we read it, so two taps at
// once can't both spend the same take or both collect the same day's top-up. If the row moved under
// us, read it again and have another go.
export async function chargeOneTake(userId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const account = await readAccount(userId);
    if (!account) return null;
    if (account.unlimited) return account;
    if (account.takesLeft <= 0) return null;

    let filter, body;
    if (account.refillDue) {
      // Top up and charge in one write, and only if nobody has topped up today already
      filter = `takes_left=eq.${account.stored}&or=(refilled_on.is.null,refilled_on.lt.${account.today})`;
      body = { takes_left: account.takesLeft - 1, refilled_on: account.today };
    } else {
      filter = `takes_left=eq.${account.stored}&takes_left=gt.0`;
      body = { takes_left: account.stored - 1 };
    }
    const [updated] = await rest(`profiles?id=eq.${userId}&${filter}&select=takes_left`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(body),
    });
    if (updated) return { takesLeft: updated.takes_left, unlimited: false };
  }
  return null;
}

export async function refundOneTake(userId) {
  // Give back against what's actually stored (the charge already wrote today's top-up down)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const account = await readAccount(userId);
      if (!account || account.unlimited) return;
      const [updated] = await rest(`profiles?id=eq.${userId}&takes_left=eq.${account.stored}&select=takes_left`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ takes_left: account.stored + 1 }),
      });
      if (updated) return;
    } catch {
      return;
    }
  }
}

// Deletes the person's sign-in for good. Their profile and followed teams go with it (the tables
// cascade from auth.users). Needs the service key, so it only ever runs here on the server.
export async function deleteUser(userId) {
  const response = await fetch(`${URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`supabase delete ${response.status}`);
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
