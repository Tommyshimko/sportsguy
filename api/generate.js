import Anthropic from '@anthropic-ai/sdk';
import { getCache } from '@vercel/functions';

export const config = { maxDuration: 60 };

// ==================== SETTINGS ====================
const MODEL = 'claude-sonnet-5';
const POOL_MAX = 4;                  // takes kept per sport + city
const POOL_TTL = 3 * 60 * 60;        // seconds a pool of takes stays fresh
const IP_HOURLY_LIMIT = 12;          // new (paid) takes one person can trigger per hour
const DAILY_LIMIT = Number(process.env.DAILY_TAKE_LIMIT) || 150; // new (paid) takes per day, everyone combined

const LEAGUES = {
  basketball: 'NBA',
  football: 'NFL',
  baseball: 'MLB',
  soccer: 'MLS',
  tennis: 'the ATP/WTA tour',
  golf: 'the PGA Tour'
};

const ALLOWED_ORIGINS = [
  /^https:\/\/(www\.)?sportsguy\.xyz$/,
  /^https:\/\/sportsguy-[a-z0-9-]+\.vercel\.app$/,
  /^http:\/\/localhost(:\d+)?$/
];

// ==================== HELPERS ====================
function cleanLocation(raw) {
  return String(raw)
    .replace(/[^\p{L}\p{N} ,.'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

async function readCount(cache, key) {
  return (await cache.get(key)) || 0;
}

async function bumpCount(cache, key, ttl) {
  const next = (await readCount(cache, key)) + 1;
  await cache.set(key, next, { ttl });
  return next;
}

// A pool expires POOL_TTL after its FIRST take, however many are added later
async function readPool(cache, key) {
  const entry = await cache.get(key);
  if (!entry || Date.now() - entry.created > POOL_TTL * 1000) return [];
  return entry.takes;
}

async function addToPool(cache, key, quote) {
  const entry = await cache.get(key);
  const fresh = entry && Date.now() - entry.created <= POOL_TTL * 1000;
  const created = fresh ? entry.created : Date.now();
  const takes = fresh ? entry.takes : [];
  if (takes.length >= POOL_MAX || takes.includes(quote)) return;

  const ttl = Math.max(60, POOL_TTL - Math.floor((Date.now() - created) / 1000));
  await cache.set(key, { created, takes: [...takes, quote] }, { ttl, name: 'take-pool' });
}

// The model replies as <evidence>...</evidence><take>...</take>. Only the take is shown;
// the evidence is what it copied from its sources, kept for logs and QA.
export function parseReply(content) {
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('');
  const evidence = (text.match(/<evidence>([\s\S]*?)<\/evidence>/i)?.[1] || '').trim();
  // The closing tag is sometimes cut off, so don't require it
  let quote = (text.match(/<take>([\s\S]*?)(?:<\/take|$)/i)?.[1] || '').trim();

  // Straight quotes only, no wrapping quotes, and nothing that's awkward to say out loud
  quote = quote.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/^"+|"+$/g, '');
  quote = quote.replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();

  // Relative days go stale while a take sits in the pool - pin them to real weekdays
  const dayName = offset => new Date(Date.now() + offset * 86400000)
    .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
  quote = quote
    .replace(/\blast night\b/gi, `${dayName(-1)} night`)
    .replace(/\btonight\b/gi, `${dayName(0)} night`)
    .replace(/\byesterday\b/gi, dayName(-1))
    .replace(/\btomorrow\b/gi, dayName(1));

  // Every number said out loud has to come from the sources, or the take is thrown away
  const evidenceNumbers = new Set(evidence.match(/\d+/g) || []);
  // (\b...\b skips team names like 49ers and 76ers)
  const unsourced = (quote.match(/\b\d+\b/g) || []).filter(number => !evidenceNumbers.has(number));
  if (unsourced.length) {
    console.warn('Dropped take with unsourced numbers', { quote, unsourced });
    return null;
  }

  const words = quote.split(' ').length;
  if (!quote || /NO_TAKE/.test(quote) || words < 5 || words > 45) return null;
  return { quote: `"${quote}"`, evidence };
}

const TEAM_SPORTS = ['football', 'baseball', 'basketball', 'soccer'];

export async function generateTake(client, sport, location, usedTakes) {
  const league = LEAGUES[sport];
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/New_York'
  });

  // Spell out the days around today so the model never has to work out a weekday itself
  const calendar = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3].map(offset => {
    const d = new Date(Date.now() + offset * 86400000);
    const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
    return offset === 0 ? `${label} (today)` : label;
  }).join(', ');

  const isTeamSport = TEAM_SPORTS.includes(sport);
  const place = /^\d{5}$/.test(location) ? `US zip code ${location} (work out which city that is first)` : location;
  const pickStory = isTeamSport
    ? `Pick the one ${league} team most people in ${location} root for. If the area has two, pick one. If it has none, pick the nearest team locals follow. The whole take is about that one team.`
    : `There is no home team in ${sport}, so use the biggest story on tour this week. Only make it local if a tour event is being played in or near ${location} within the next two weeks.`;

  const searchHow = isTeamSport
    ? `Look for the most recent game or result itself, with a query like "New York Mets MLB score September 18 2026" or "New York Mets game recap", rather than general team news. Use the full team name and the league so you don't get a different team with the same nickname. Every search result shows how old its page is. When the season is on, rest the take only on pages from the last three days. In the offseason, use the newest real news you can find, or failing that the biggest move of this offseason.`
    : `Look for this week's tournament with a query like "${sport} tournament this week leaderboard" or "${sport} news this week". Every search result shows how old its page is. Prefer pages from the last three days. If it is a quiet week, use the result of the most recent big tournament or the next big event coming up, and say when it was or will be.`;

  const system = `You write one line of sports bar talk for someone who does not follow sports but wants to join the conversation. Today is ${today}. They are in ${place}. The sport is ${sport} (${league}).

1. Pick the story. ${pickStory}

2. Search by date. ${searchHow} Do not take recent results from undated pages, season roundups or Wikipedia, because those are often weeks behind and would make this person sound out of touch.

3. Copy your evidence first. Before writing, copy out the one or two sentences from the search results that the take rests on, each with its page age. Then check them against each other: who won and who lost, the score, and what day it happened. If you cannot tell who won, or the pages disagree, leave that fact out. If a game or tournament is still being played, say it is still going rather than naming a winner. Use this calendar for weekdays: ${calendar}. One fact you are sure of beats three you are not. Every name, score, number and event in the take has to appear in the evidence you copied, spelled the same way. Do not add players, streaks, history or team line-ups from memory, since rosters change and memory is how mistakes get in. The opinion is yours. The facts are the sources'. Do not stretch them either: a one-shot lead is not running away with it, and being one game short of the playoff line is not being about to clinch. If you are not sure what a standings phrase means, leave it out. Only name the day something happened if the source gives the date. Only mention a player if the source makes clear he plays for this team right now, because a quote from a rival talking about the team is not a player on it. Never use a score from a game that was still being played when the page was written. If all you have is a page from the middle of a game, use your second search to find how it ended ("recap" or "final score"), and if you still can't, talk about something else.

4. Write the take. It is what a local fan would say out loud at the bar, and the person saying it is not a fan, so it has to be easy to say and easy to understand:
- One or two short sentences, about 20 words in total and never more than 25. Count them. Cut anything that is not needed.
- Name the team. Mention at most one player.
- Everyday words only. No insider slang or stat talk: say "home run" not "bomb", "losing streak" not "skid", "won it in the last inning" not "walk-off". No percentages, ratings, rankings points or playoff math. If a word would need explaining to someone who never watches ${sport}, do not use it.
- At most one number besides a score.
- Never write "last night", "tonight", "tomorrow" or "yesterday". Name the day instead ("Friday night"), since this may be read hours from now.
- No dashes, semicolons or parentheses.
- End on a simple opinion a fan would have.
- Just say the take. Do not greet anyone, address the fans, or explain that there is no local team or event.
- Keep it about the games: no politics, legal trouble or betting.

Reply in exactly this format and nothing else:
<evidence>
- (page age) "sentence copied from the source"
</evidence>
<take>the take, without quote marks</take>

If the search turns up nothing solid enough, reply with <take>NO_TAKE</take>.`;

  let userMessage = `Give me a fresh ${sport} take for ${location}.`;
  if (usedTakes.length) {
    userMessage += `\n\nI've already used the takes below, so build this one on a different fact or storyline about the same team. It should stand on its own - don't refer back to them:\n${usedTakes.map(t => `- ${t}`).join('\n')}`;
  }

  const messages = [{ role: 'user', content: userMessage }];
  const request = {
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' },
    system,
    // Basic search on purpose: measured 4c / 6s a take vs 8c / 16s for the filtering variant
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    messages
  };

  let response = await client.messages.create(request);

  // Server-side search can pause a long turn; resume it (at most twice)
  for (let i = 0; i < 2 && response.stop_reason === 'pause_turn'; i++) {
    response = await client.messages.create({
      ...request,
      messages: [...messages, { role: 'assistant', content: response.content }]
    });
  }

  if (response.stop_reason === 'refusal') return null;
  return parseReply(response.content);
}

// ==================== HANDLER ====================
export default async function handler(req, res) {
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sport = String(req.body?.sport || '').toLowerCase();
  const location = cleanLocation(req.body?.location || '');
  const n = Math.max(0, Math.min(1000, parseInt(req.body?.n, 10) || 0));

  if (!LEAGUES[sport] || location.length < 2) {
    return res.status(400).json({ error: 'Missing sport or location' });
  }

  if (!process.env.CLAUDE_API_KEY) {
    console.error('CLAUDE_API_KEY not set');
    return res.status(500).json({ error: 'API key not configured' });
  }

  const cache = getCache({ namespace: 'sportsguy' });
  const poolKey = `takes:v9:${sport}:${location.toLowerCase()}`;
  const pool = await readPool(cache, poolKey);

  // Already have this take (or the pool is full) - free, no API call
  // `more` tells the app whether another tap can turn up something new
  if (n < pool.length) {
    return res.status(200).json({ quote: pool[n], cached: true, more: n + 1 < POOL_MAX });
  }
  if (pool.length >= POOL_MAX) {
    return res.status(200).json({ quote: pool[n % pool.length], cached: true, more: false });
  }

  // A new take costs money - check the limits first
  const day = new Date().toISOString().slice(0, 10);
  const hour = new Date().toISOString().slice(0, 13);
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const dayKey = `spend:${day}`;
  const ipKey = `ip:${ip}:${hour}`;

  const [dayCount, ipCount] = await Promise.all([readCount(cache, dayKey), readCount(cache, ipKey)]);
  if (dayCount >= DAILY_LIMIT || ipCount >= IP_HOURLY_LIMIT) {
    console.warn('Limit hit', { dayCount, ipCount, ip });
    if (pool.length) {
      return res.status(200).json({ quote: pool[n % pool.length], cached: true, more: false });
    }
    return res.status(429).json({ error: 'Too many takes right now. Try again in a bit.' });
  }

  try {
    await Promise.all([bumpCount(cache, dayKey, 26 * 60 * 60), bumpCount(cache, ipKey, 60 * 60)]);

    const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY, maxRetries: 1, timeout: 50_000 });
    // A take that fails the checks is thrown away, so give it one more go before giving up
    let take = await generateTake(client, sport, location, pool);
    if (!take) {
      await bumpCount(cache, dayKey, 26 * 60 * 60);
      take = await generateTake(client, sport, location, pool);
    }

    if (!take) {
      return res.status(502).json({ error: 'No take came back' });
    }
    const { quote, evidence } = take;
    console.log('New take', { sport, location, quote, evidence });

    // Re-read so two people generating at once don't overwrite each other
    await addToPool(cache, poolKey, quote);

    return res.status(200).json({ quote, cached: false, more: n + 1 < POOL_MAX });

  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      console.error('Claude rate limit:', error.message);
      return res.status(429).json({ error: 'Too many takes right now. Try again in a bit.' });
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`Claude API error ${error.status}:`, error.message);
      return res.status(502).json({ error: 'Take generator is down' });
    }
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to generate take' });
  }
}
