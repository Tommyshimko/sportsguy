// Finds the logo or headshot for a topic, and only returns one it can vouch for.
//
// The rule: a missing picture is fine, a wrong picture is not. So a picture is attached only when
//  - the name matches exactly (accents, punctuation and case aside)
//  - it's the same sport the take is about
//  - there is exactly one such person. A unique name is enough: it's his face whatever team he's on.
//    When two players share a name (there are two Josh Allens in the NFL), the team the writer saw
//    in the news has to pick out exactly one of them, otherwise no picture
//  - the image file really exists
// Anything else falls back to initials in the app.

// PICTURES ARE OFF (2026-09-25). These logos and headshots are ESPN's, and we have no licence to show
// them, so for the App Store launch the app shows initials instead. Only switch this back on with a
// source we're allowed to use (Wikimedia Commons with credit, or a paid sports-data licence) - never
// by flipping ESPN back on after App Review has approved the app.
export const PICTURES_ON = process.env.TOPIC_PICTURES === 'on';

const SEARCH = 'https://site.web.api.espn.com/apis/common/v3/search';
const RESIZE = 'https://a.espncdn.com/combiner/i?img=';
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };

const ESPN_SPORT = { football: 'football', baseball: 'baseball', basketball: 'basketball', soccer: 'soccer', tennis: 'tennis', golf: 'golf' };
// For the big US leagues we only trust that league, so a college player never stands in for a pro
const LEAGUES = { football: ['nfl'], baseball: ['mlb'], basketball: ['nba'] };

const plain = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// "Inter Miami" and "Inter Miami CF", "LA Clippers" and "Los Angeles Clippers"
const sameTeam = (a, b) => {
  const x = plain(a).replace(/\b(fc|cf|sc)\b/g, '').replace(/^la /, 'los angeles ').trim();
  const y = plain(b).replace(/\b(fc|cf|sc)\b/g, '').replace(/^la /, 'los angeles ').trim();
  return !!x && x === y;
};

async function imageExists(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', headers: BROWSER, signal: AbortSignal.timeout(4000) });
    return response.ok && String(response.headers.get('content-type')).startsWith('image/');
  } catch {
    return false;
  }
}

async function lookUp(topic, sport) {
  if (topic.kind === 'event') return null;
  const type = topic.kind === 'team' ? 'team' : 'player';
  const url = `${SEARCH}?${new URLSearchParams({ query: topic.label, limit: '8', type })}`;
  const response = await fetch(url, { headers: BROWSER, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`ESPN search ${response.status}`);
  const items = (await response.json()).items || [];

  let matches = items.filter(item =>
    item.type === type &&
    item.sport === ESPN_SPORT[sport] &&
    (!LEAGUES[sport] || LEAGUES[sport].includes(item.league)) &&
    (type === 'team' ? sameTeam(item.displayName, topic.label) : plain(item.displayName) === plain(topic.label))
  );

  // Same name more than once: only the team can tell them apart
  if (type === 'player' && matches.length > 1 && topic.team) {
    matches = matches.filter(item => (item.teamRelationships || []).some(rel => sameTeam(rel.displayName, topic.team)));
  }
  if (matches.length !== 1) return null;

  const source = type === 'team' ? matches[0].logos?.[0]?.href : matches[0].headshot?.href;
  if (!source || !source.startsWith('https://a.espncdn.com/')) return null;
  if (!(await imageExists(source))) return null;

  const path = source.replace('https://a.espncdn.com', '');
  return `${RESIZE}${path}&${type === 'team' ? 'w=120&h=120' : 'w=220&h=160'}`;
}

// Teams matching what someone typed, for the "follow a team" search. Same sources as the logos, so a
// followed team and a highlighted team are always the same thing.
export async function findTeams(query, sport = '') {
  const url = `${SEARCH}?${new URLSearchParams({ query, limit: '12', type: 'team' })}`;
  const response = await fetch(url, { headers: BROWSER, signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`ESPN search ${response.status}`);

  const seen = new Set();
  return ((await response.json()).items || [])
    .filter(item => {
      const wanted = Object.entries(ESPN_SPORT).find(([, espn]) => espn === item.sport)?.[0];
      if (!wanted || item.type !== 'team') return false;
      if (sport && wanted !== sport) return false;
      if (LEAGUES[wanted] && !LEAGUES[wanted].includes(item.league)) return false;
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, 8)
    .map(item => {
      const logo = item.logos?.[0]?.href;
      return {
        id: String(item.id),
        label: item.displayName,
        sport: Object.entries(ESPN_SPORT).find(([, espn]) => espn === item.sport)[0],
        image: logo?.startsWith('https://a.espncdn.com/') ? `${RESIZE}${logo.replace('https://a.espncdn.com', '')}&w=120&h=120` : null,
      };
    });
}

// Adds `image` to every topic it can vouch for. Never throws: pictures are a nicety, takes are the product.
export async function attachImages(topics, sport, cache) {
  if (!PICTURES_ON) return topics;
  await Promise.all(topics.map(async topic => {
    const key = `img:v2:${sport}:${topic.kind}:${plain(topic.label)}:${plain(topic.team)}`;
    try {
      const saved = await cache?.get(key);
      if (saved !== undefined && saved !== null) {
        if (saved.url) topic.image = saved.url;
        return;
      }
      const url = await lookUp(topic, sport);
      if (url) topic.image = url;
      // A found picture is good for a week (trades change teams). A miss is retried within the hour:
      // a slow ESPN reply looks exactly like 'no picture', and a whole day of missing logos is worse
      // than looking again.
      await cache?.set(key, { url: url || '' }, { ttl: url ? 7 * 24 * 3600 : 3600, name: 'topic-image' });
    } catch (error) {
      console.warn('Image lookup failed', { label: topic.label, error: String(error.message || error) });
    }
  }));
  return topics;
}
