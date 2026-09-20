// Finds the logo or headshot for a topic, and only returns one it can vouch for.
//
// The rule: a missing picture is fine, a wrong picture is not. So a picture is attached only when
//  - the name matches exactly (accents, punctuation and case aside)
//  - it's the same sport the take is about
//  - for a player on a team, ESPN's CURRENT team matches the team the writer saw in the news
//  - there is exactly one such match (two NFL players called Josh Allen with no team to tell them
//    apart = no picture)
//  - the image file really exists
// Anything else falls back to initials in the app.

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

  if (type === 'player' && LEAGUES[sport]) {
    // Team sports: the player has to be on the team the news said he's on. No stated team, no picture.
    if (!topic.team) return null;
    matches = matches.filter(item => (item.teamRelationships || []).some(rel => sameTeam(rel.displayName, topic.team)));
  }
  if (matches.length !== 1) return null;

  const source = type === 'team' ? matches[0].logos?.[0]?.href : matches[0].headshot?.href;
  if (!source || !source.startsWith('https://a.espncdn.com/')) return null;
  if (!(await imageExists(source))) return null;

  const path = source.replace('https://a.espncdn.com', '');
  return `${RESIZE}${path}&${type === 'team' ? 'w=120&h=120' : 'w=220&h=160'}`;
}

// Adds `image` to every topic it can vouch for. Never throws: pictures are a nicety, takes are the product.
export async function attachImages(topics, sport, cache) {
  await Promise.all(topics.map(async topic => {
    const key = `img:v1:${sport}:${topic.kind}:${plain(topic.label)}:${plain(topic.team)}`;
    try {
      const saved = await cache?.get(key);
      if (saved !== undefined && saved !== null) {
        if (saved.url) topic.image = saved.url;
        return;
      }
      const url = await lookUp(topic, sport);
      if (url) topic.image = url;
      // A found picture is good for a week (trades change teams). A miss is retried after a day.
      await cache?.set(key, { url: url || '' }, { ttl: url ? 7 * 24 * 3600 : 24 * 3600, name: 'topic-image' });
    } catch (error) {
      console.warn('Image lookup failed', { label: topic.label, error: String(error.message || error) });
    }
  }));
  return topics;
}
