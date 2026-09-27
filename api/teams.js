// Search for a team to follow. The app asks this instead of ESPN directly, so the shape of a team is
// decided in one place and every answer is checked the same way logos are.
import { getCache } from '@vercel/functions';
import { findTeams, WEB_PICTURES_ON } from './_images.js';

// Logos go to the WEBSITE only (`web=1`); an app's team search never carries one, even from a
// search cached with them
const bare = (teams, web) => (web && WEB_PICTURES_ON ? teams : teams.map(team => ({ ...team, image: null })));

export const config = { maxDuration: 15 };

const SPORTS = ['football', 'baseball', 'basketball', 'soccer', 'tennis', 'golf'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const query = String(req.query?.q || '').trim().slice(0, 40);
  const sport = String(req.query?.sport || '').toLowerCase();
  const web = String(req.query?.web || '') === '1';
  if (query.length < 2) return res.status(200).json({ teams: [] });

  const cache = getCache({ namespace: 'sportsguy' });
  const key = `teams:v1:${sport}:${query.toLowerCase()}`;
  try {
    const saved = await cache.get(key);
    if (saved) return res.status(200).json({ teams: bare(saved, web) });
  } catch {}

  try {
    const teams = await findTeams(query, SPORTS.includes(sport) ? sport : '');
    await cache.set(key, teams, { ttl: 7 * 24 * 3600, name: 'team-search' }).catch(() => {});
    return res.status(200).json({ teams: bare(teams, web) });
  } catch (error) {
    console.error('Team search failed', error);
    return res.status(200).json({ teams: [] });
  }
}
