import { getCache } from '@vercel/functions';
import { seasonKey, writeSeason } from './generate.js';

// THE 6AM WARM-UP (vercel.json cron). Switching sport shows that sport's season line straight
// away - but a line takes 30s to 2 minutes to write, and it used to be written only when somebody
// switched, so the first person each morning got nothing and fell through to a take. This writes
// all six before anyone is up. It skips a sport that already has today's line, so calling it again
// costs nothing; that is also why it needs no secret.
export const config = { maxDuration: 300 };

const SPORTS = ['football', 'baseball', 'basketball', 'soccer', 'tennis', 'golf'];

export default async function handler(req, res) {
  const cache = getCache({ namespace: 'sportsguy' });
  const done = {};
  await Promise.all(SPORTS.map(async sport => {
    if (await cache.get(seasonKey(sport))) { done[sport] = 'already fresh'; return; }
    done[sport] = (await writeSeason(sport, cache)) ? 'written' : 'failed (last good line kept)';
  }));
  console.log('Season warm-up', done);
  return res.status(200).json(done);
}
