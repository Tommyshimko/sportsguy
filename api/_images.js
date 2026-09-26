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

// PLAYER PHOTOS COME FROM WIKIMEDIA COMMONS, NEVER FROM ESPN (2026-09-26).
// ESPN's logos and headshots were never ours to show. Commons photos are free to use under their
// licence as long as the photographer is credited, so every photo travels with its credit and the
// app lists them under Settings > Photo credits. Only free licences get through (public domain,
// CC0, CC BY, CC BY-SA), and a photo goes only to an app that says it can show credits - an app
// without that screen keeps initials, which is also what was declared to App Review for 1.4.0.
// Team logos stay OFF: they are trademarks, and Commons does not change that.
// TOPIC_PICTURES=off is the kill switch.
export const PICTURES_ON = process.env.TOPIC_PICTURES !== 'off';

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

// ==================== WIKIMEDIA ====================
// Wikimedia asks every client to say who it is (their User-Agent policy), and to go gently: each
// answer is cached for a week, so a player is looked up once, not once per take.
const WIKI = { 'User-Agent': 'SportsGuy/1.0 (https://sportsguy.xyz; hello@sportsguy.xyz)' };
// What makes someone the right person: a human (Q5) who plays this sport (P641) or has it as a job (P106)
const WIKI_SPORT = {
  football: { sport: 'Q41323', job: 'Q19204627' },
  baseball: { sport: 'Q5369', job: 'Q10871364' },
  basketball: { sport: 'Q5372', job: 'Q3665646' },
  soccer: { sport: 'Q2736', job: 'Q937857' },
  tennis: { sport: 'Q847', job: 'Q10833314' },
  golf: { sport: 'Q5377', job: 'Q13156709' },
};
// Free licences only. Anything else - "fair use", "all rights reserved", a logo - is not ours to show.
const FREE_LICENCE = /^(cc0|public domain|pd\b|pd-|cc by(-sa)? \d(\.\d)?)/i;

const wikiJson = async url => {
  const response = await fetch(url, { headers: WIKI, signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`Wikimedia ${response.status}`);
  return response.json();
};
const wikidata = params => wikiJson(`https://www.wikidata.org/w/api.php?${new URLSearchParams({ ...params, format: 'json' })}`);
const claimIds = (claims, prop) => (claims?.[prop] || []).map(s => s.mainsnak?.datavalue?.value?.id).filter(Boolean);
// Newer entries keep the name in "mul" (every language) rather than "en" - Carlos Alcaraz does
const namesOf = entity => [
  entity.labels?.en?.value, entity.labels?.mul?.value,
  ...(entity.aliases?.en || []).map(a => a.value), ...(entity.aliases?.mul || []).map(a => a.value),
].filter(Boolean).map(plain);

// The same accuracy rule as before: a missing photo is fine, a wrong one is not. Exact name, this
// sport, and exactly one such person - with the writer's team breaking a tie (two Josh Allens).
async function wikiPhoto(topic, sport) {
  const want = WIKI_SPORT[sport];
  if (!want || topic.kind !== 'player') return null;
  const found = await wikidata({ action: 'wbsearchentities', search: topic.label, language: 'en', uselang: 'en', type: 'item', limit: '12' });
  const ids = (found.search || []).map(item => item.id);
  if (!ids.length) return null;
  const { entities } = await wikidata({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels|aliases|claims', languages: 'en|mul' });
  let matches = Object.values(entities || {}).filter(entity =>
    claimIds(entity.claims, 'P31').includes('Q5') &&
    namesOf(entity).includes(plain(topic.label)) &&
    (claimIds(entity.claims, 'P641').includes(want.sport) || claimIds(entity.claims, 'P106').includes(want.job)));
  if (matches.length > 1 && topic.team) {
    const teamIds = [...new Set(matches.flatMap(entity => claimIds(entity.claims, 'P54')))];
    const teams = teamIds.length ? (await wikidata({ action: 'wbgetentities', ids: teamIds.slice(0, 50).join('|'), props: 'labels', languages: 'en|mul' })).entities || {} : {};
    matches = matches.filter(entity => claimIds(entity.claims, 'P54').some(id => {
      const label = teams[id]?.labels?.en?.value || teams[id]?.labels?.mul?.value;
      return label && sameTeam(label, topic.team);
    }));
  }
  if (matches.length !== 1) return null;

  const file = matches[0].claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (!file) return null;
  const info = await wikiJson(`https://commons.wikimedia.org/w/api.php?${new URLSearchParams({
    action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '240', format: 'json',
  })}`);
  const image = Object.values(info.query?.pages || {})[0]?.imageinfo?.[0];
  const meta = image?.extmetadata || {};
  const licence = String(meta.LicenseShortName?.value || '').trim();
  if (!image?.thumburl || !FREE_LICENCE.test(licence) || meta.NonFree?.value) return null;
  const author = String(meta.Artist?.value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Unknown photographer';
  return { url: image.thumburl, credit: { author, licence, source: image.descriptionurl } };
}

// Adds `image` + `credit` to every PLAYER it can vouch for, and only for an app that can show the
// credits. Never throws: pictures are a nicety, takes are the product.
export async function attachImages(topics, sport, cache, canCredit) {
  if (!PICTURES_ON || !canCredit) return topics;
  await Promise.all(topics.map(async topic => {
    if (topic.kind !== 'player') return;
    const key = `img:wiki1:${sport}:${plain(topic.label)}:${plain(topic.team)}`;
    try {
      let saved = await cache?.get(key);
      if (saved === undefined || saved === null) {
        saved = (await wikiPhoto(topic, sport)) || { url: '' };
        // A found photo is good for a week. A miss is looked at again in a day (Commons grows).
        await cache?.set(key, saved, { ttl: saved.url ? 7 * 24 * 3600 : 24 * 3600, name: 'topic-image' });
      }
      if (saved.url) { topic.image = saved.url; topic.credit = saved.credit; }
    } catch (error) {
      console.warn('Photo lookup failed', { label: topic.label, error: String(error.message || error) });
    }
  }));
  return topics;
}

/** The topics as this app may see them. Stored takes are always stripped first (older ones still hold
 *  ESPN links), then an app that lists credits gets the Commons photos put back from the cache. */
export async function forClient(topics, sport, cache, canCredit) {
  const bare = (topics || []).map(({ image, credit, ...topic }) => topic);
  return canCredit ? attachImages(bare, sport, cache, true) : bare;
}
