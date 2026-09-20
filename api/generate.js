import Anthropic from '@anthropic-ai/sdk';
import { getCache } from '@vercel/functions';
import { attachImages } from './_images.js';

export const config = { maxDuration: 60 };

// ==================== SETTINGS ====================
const MODEL = 'claude-sonnet-5';
const POOL_MAX = 4;                  // takes kept per sport + city
const TOPIC_POOL_MAX = 2;            // takes kept per topic within a sport + city
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

async function addToPool(cache, key, take, max) {
  const entry = await cache.get(key);
  const fresh = entry && Date.now() - entry.created <= POOL_TTL * 1000;
  const created = fresh ? entry.created : Date.now();
  const takes = fresh ? entry.takes : [];
  if (takes.length >= max || takes.some(entry => entry.quote === take.quote)) return;

  const ttl = Math.max(60, POOL_TTL - Math.floor((Date.now() - created) / 1000));
  await cache.set(key, { created, takes: [...takes, take] }, { ttl, name: 'take-pool' });
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
    .replace(/\btoday\b/gi, dayName(0))
    .replace(/\byesterday\b/gi, dayName(-1))
    .replace(/\btomorrow\b/gi, dayName(1));

  // Every number said out loud has to come from the sources, or the take is thrown away
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const evidenceNumbers = new Set(evidence.match(/\d+/g) || []);
  // "two touchdowns" is a number too: a spelled-out count needs the same count in the sources
  for (const word of (evidence.toLowerCase().match(/\b[a-z]+\b/g) || [])) {
    if (WORDS.includes(word)) evidenceNumbers.add(String(WORDS.indexOf(word)));
  }
  const spelled = (quote.toLowerCase().match(/\b[a-z]+\b/g) || [])
    .filter(word => WORDS.includes(word) && word !== 'one')
    .map(word => String(WORDS.indexOf(word)));
  // (\b...\b skips team names like 49ers and 76ers)
  const unsourced = [...(quote.match(/\b\d+\b/g) || []), ...spelled].filter(number => !evidenceNumbers.has(number));
  if (unsourced.length) {
    console.warn('Dropped take with unsourced numbers', { quote, unsourced });
    return null;
  }

  const words = quote.split(' ').length;
  if (!quote || /NO_TAKE/.test(quote) || words < 5 || words > 45) return null;
  return { quote: `"${quote}"`, evidence, topics: parseTopics(text, quote) };
}

// A second, separate model reads the take against the copied evidence and nothing else.
// It catches what a number check can't: a stat pinned on the wrong player, a flipped result.
// Sonnet, not Haiku: Haiku kept getting weekdays wrong even with the calendar in front of it
const CHECKER_MODEL = 'claude-sonnet-5';

export async function verifyTake(client, quote, evidence, calendar = '') {
  if (!evidence) return { pass: false, verdict: 'FAIL: no evidence' };
  const response = await client.messages.create({
    model: CHECKER_MODEL,
    max_tokens: 1500,
    output_config: { effort: 'low' },
    system: `You are a strict sports fact-checker. You get SOURCES (sentences copied from news pages) and a TAKE (one line of bar talk written from them). Be ruthless about the facts that get someone laughed at in a bar:
- who won and who lost, and the score
- every number, including spelled-out ones. A number is only supported if the sources give that same number for that same player or team (a receiver's two touchdowns are not the quarterback's two)
- every person named: the sources must show that person doing what the take says, on the team the take implies
- days and dates, checked against this calendar: ${calendar}

Be relaxed about the rest. Opinions, feelings, predictions and characterizations of a supported result ("looked rough" about a loss, "on fire" about a big win) need no support. Names of venues, tournaments and team nicknames only fail if the sources contradict them. "Last week" and "next week" are fine when the calendar agrees. Use only the sources for facts, never your own knowledge, because rosters and results change.

Reply with exactly PASS if every fact is directly supported. Otherwise reply FAIL: and the unsupported fact in a few words.`,
    messages: [{ role: 'user', content: `SOURCES:\n${evidence}\n\nTAKE:\n${quote}` }]
  });
  const verdict = response.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
  const pass = /^PASS\b/.test(verdict);
  if (!pass) console.warn('Fact-check rejected a take', { quote, verdict });
  return { pass, verdict };
}

// Cheap repair before paying for a whole new search: rewrite the take using only what the
// evidence supports, fixing what the checker flagged.
async function reviseTake(client, quote, evidence, verdict) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    output_config: { effort: 'low' },
    system: `You fix one line of sports bar talk. A fact-checker compared the TAKE with its SOURCES and flagged a problem. Rewrite the take so that every person, number, result and date in it is directly backed by the sources: correct the flagged part if the sources give the right fact, otherwise cut it. Keep the same voice and keep a simple fan opinion at the end. One or two short sentences, 25 words at most, everyday words, no dashes or semicolons, days by name. Reply with only <take>the rewritten take</take>.`,
    messages: [{ role: 'user', content: `SOURCES:\n${evidence}\n\nTAKE:\n${quote}\n\nCHECKER: ${verdict}` }]
  });
  return parseReply([{ type: 'text', text: `<evidence>${evidence}</evidence>` }, ...response.content]);
}

// Topics are the words the app highlights and the chips it offers under the take. Each line is
// "exact words from the take | chip label | kind". Anything not literally in the take is dropped.
const TOPIC_KINDS = ['team', 'player', 'event'];

function parseTopics(text, quote) {
  const block = text.match(/<topics>([\s\S]*?)(?:<\/topics|$)/i)?.[1] || '';
  const topics = [];
  for (const line of block.split('\n')) {
    let [words, label, kind, team] = line.replace(/^\s*[-*]\s*/, '').split('|').map(part => (part || '').trim());
    if (!words || !label || label.length > 28) continue;
    // Highlight just the name: the full label if the take says it, else the given words when they
    // are part of the name, else whichever piece of the name the take does say.
    const inLabel = words.split(' ').every(part => label.toLowerCase().includes(part.toLowerCase()));
    if (quote.includes(label)) words = label;
    else if (!(inLabel && quote.includes(words))) {
      words = label.split(' ').reverse().find(part => part.length > 2 && new RegExp(`\\b${part}\\b`).test(quote)) || '';
    }
    if (!words) continue;
    if (topics.some(t => t.text === words || t.label.toLowerCase() === label.toLowerCase())) continue;
    const topic = { text: words, label, kind: TOPIC_KINDS.includes(kind) ? kind : 'team' };
    // A player's team (as the sources state it) is what lets us vouch for his picture later
    if (topic.kind === 'player' && team && team.length < 40) topic.team = team;
    topics.push(topic);
    if (topics.length === 3) break;
  }
  return topics;
}

const TEAM_SPORTS = ['football', 'baseball', 'basketball', 'soccer'];

export async function generateTake(client, sport, location, usedTakes, topic = '') {
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
  const aboutTopic = `The person asked for a take about ${topic}. The whole take is about ${topic}: the newest thing that has happened with them, seen the way a fan in ${location} would see it.`;
  const pickStory = topic ? aboutTopic : isTeamSport
    ? `Pick the one ${league} team most people in ${location} root for. If the area has two, pick one. If it has none, pick the nearest team locals follow. The whole take is about that one team.`
    : `There is no home team in ${sport}, so use the biggest story on tour this week. Only make it local if a tour event is being played in or near ${location} within the next two weeks.`;

  const searchHow = topic
    ? `Look for the newest thing about ${topic}. If it is a team, search for its most recent game by date, like "${topic} score September 18 2026". If it is a player, search "${topic} ${league} latest game". If it is an event, search "${topic} results". Every search result shows how old its page is. Prefer pages from the last three days, and in a quiet stretch use the most recent real news there is and say when it happened.`
    : isTeamSport
    ? `Look for the most recent game or result itself, with a query like "New York Mets MLB score September 18 2026" or "New York Mets game recap", rather than general team news. Use the full team name and the league so you don't get a different team with the same nickname. Every search result shows how old its page is. When the season is on, rest the take only on pages from the last three days. In the offseason, use the newest real news you can find, or failing that the biggest move of this offseason.`
    : `Look for this week's tournament with a query like "${sport} tournament this week leaderboard" or "${sport} news this week". Every search result shows how old its page is. Prefer pages from the last three days. If it is a quiet week, use the result of the most recent big tournament or the next big event coming up, and say when it was or will be.`;

  const system = `You write one line of sports bar talk for someone who does not follow sports but wants to join the conversation. Today is ${today}. They are in ${place}. The sport is ${sport} (${league}).

1. Pick the story. ${pickStory}

2. Search by date. ${searchHow} Do not take recent results from undated pages, season roundups or Wikipedia, because those are often weeks behind and would make this person sound out of touch.

3. Copy your evidence first. Before writing, copy out the sentences from the search results that the take rests on (up to four), each with its page age. A separate fact-checker will read only these sentences and throw the take away if any person, number, result or date in it is not backed by them, so copy a sentence for each one. Then check them against each other: who won and who lost, the score, and what day it happened. If you cannot tell who won, or the pages disagree, leave that fact out. If a game or tournament is still being played, say it is still going rather than naming a winner. Use this calendar for weekdays: ${calendar}. One fact you are sure of beats three you are not. Every name, score, number and event in the take has to appear in the evidence you copied, spelled the same way. Do not add players, streaks, history or team line-ups from memory, since rosters change and memory is how mistakes get in. The opinion is yours. The facts are the sources'. Do not stretch them either: a one-shot lead is not running away with it, and being one game short of the playoff line is not being about to clinch. If you are not sure what a standings phrase means, leave it out. Only name the day something happened if the source gives the date. A player's number has to be that player's own number, stated about him in the source: a receiver catching two touchdowns does not mean the quarterback threw two. If you are not certain whose number it is, say he played great and leave the count out. Only mention a player if the source makes clear he plays for this team right now, because a quote from a rival talking about the team is not a player on it. Never use a score from a game that was still being played when the page was written. If all you have is a page from the middle of a game, use your second search to find how it ended ("recap" or "final score"), and if you still can't, talk about something else.

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

5. Pick the topics. List one to three things in the take that this person might want another take about next: the team, a player, an event. Give just the name exactly as the take says it (one to three words, like "Yankees" or "Judge", never a whole phrase), then the full proper name for a button, then the kind. For a player on a team, add the full name of the team the sources say he plays for right now, because it is used to find the right photo of him.

Reply in exactly this format and nothing else:
<evidence>
- (page age) "sentence copied from the source"
</evidence>
<take>the take, without quote marks</take>
<topics>
- exact words from the take | Full Name | team, player or event | player's current team
</topics>

If the search turns up nothing solid enough, reply with <take>NO_TAKE</take>.`;

  let userMessage = topic ? `Give me a fresh take about ${topic}.` : `Give me a fresh ${sport} take for ${location}.`;
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
  const take = parseReply(response.content);
  if (!take) return null;
  const first = await verifyTake(client, take.quote, take.evidence, calendar);
  if (first.pass) return take;

  const fixed = await reviseTake(client, take.quote, take.evidence, first.verdict);
  if (!fixed) return null;
  // The rewrite may have cut a name, so keep only the topics that survived it
  fixed.topics = take.topics.filter(topic => fixed.quote.includes(topic.text));
  const second = await verifyTake(client, fixed.quote, fixed.evidence, calendar);
  return second.pass ? fixed : null;
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
  const topic = cleanLocation(req.body?.topic || '').slice(0, 40);

  if (!LEAGUES[sport] || location.length < 2) {
    return res.status(400).json({ error: 'Missing sport or location' });
  }

  if (!process.env.CLAUDE_API_KEY) {
    console.error('CLAUDE_API_KEY not set');
    return res.status(500).json({ error: 'API key not configured' });
  }

  const cache = getCache({ namespace: 'sportsguy' });
  const poolMax = topic ? TOPIC_POOL_MAX : POOL_MAX;
  const poolKey = `takes:v14:${sport}:${location.toLowerCase()}${topic ? `:topic:${topic.toLowerCase()}` : ''}`;
  const pool = await readPool(cache, poolKey);
  const send = (take, cached, more) => res.status(200).json({ quote: take.quote, topics: take.topics || [], cached, more });

  // Already have this take (or the pool is full) - free, no API call.
  // `more` tells the app whether asking again can turn up something new.
  if (n < pool.length) return send(pool[n], true, n + 1 < poolMax);
  if (pool.length >= poolMax) return send(pool[n % pool.length], true, false);

  // A new take costs money - check the limits first
  const day = new Date().toISOString().slice(0, 10);
  const hour = new Date().toISOString().slice(0, 13);
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const dayKey = `spend:${day}`;
  const ipKey = `ip:${ip}:${hour}`;

  const [dayCount, ipCount] = await Promise.all([readCount(cache, dayKey), readCount(cache, ipKey)]);
  if (dayCount >= DAILY_LIMIT || ipCount >= IP_HOURLY_LIMIT) {
    console.warn('Limit hit', { dayCount, ipCount, ip });
    if (pool.length) return send(pool[n % pool.length], true, false);
    return res.status(429).json({ error: 'Too many takes right now. Try again in a bit.' });
  }

  try {
    await Promise.all([bumpCount(cache, dayKey, 26 * 60 * 60), bumpCount(cache, ipKey, 60 * 60)]);

    const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY, maxRetries: 1, timeout: 50_000 });
    // A take that fails the checks is thrown away, so give it one more go before giving up
    // A topic take should not repeat what this city's main takes already said
    const cityTakes = topic ? await readPool(cache, `takes:v14:${sport}:${location.toLowerCase()}`) : [];
    const used = [...pool, ...cityTakes].map(entry => entry.quote);
    let take = await generateTake(client, sport, location, used, topic);
    if (!take) {
      await bumpCount(cache, dayKey, 26 * 60 * 60);
      take = await generateTake(client, sport, location, used, topic);
    }

    if (!take) {
      return res.status(502).json({ error: 'No take came back' });
    }
    await attachImages(take.topics, sport, cache);
    console.log('New take', { sport, location, topic, quote: take.quote, topics: take.topics, evidence: take.evidence });

    // Re-read so two people generating at once don't overwrite each other
    await addToPool(cache, poolKey, { quote: take.quote, topics: take.topics }, poolMax);

    return send(take, false, n + 1 < poolMax);

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
