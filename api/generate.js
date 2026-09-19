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

// Only the text written after the last search is the take itself -
// anything before it is the model narrating its search.
function extractQuote(content) {
  let lastSearch = -1;
  content.forEach((block, i) => {
    if (block.type === 'web_search_tool_result') lastSearch = i;
  });

  let quote = content
    .slice(lastSearch + 1)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();

  // Normalize to exactly one pair of straight quote marks
  quote = quote.replace(/[“”]/g, '"').replace(/^"+|"+$/g, '').trim();

  // Sometimes it answers with two separately-quoted takes - join them, then hold it to two sentences
  quote = quote.replace(/"\s+"/g, ' ');
  const sentences = quote.match(/[^.!?]+[.!?]+(?=\s|$)/g);
  if (sentences && sentences.length > 2) quote = sentences.slice(0, 2).join('').trim();

  // The model apologizing or talking about its search is not a take - never show or save it
  const notATake = /NO_TAKE|search limit|\b(I (wasn't|was not) able|(I|I'll|I will) (couldn't|could not|can't|cannot) (find|pull|search|confirm|confidently)|unable to (find|search|pull))\b/i;
  if (quote.length < 10 || notATake.test(quote)) return null;
  return `"${quote}"`;
}

async function generateTake(client, sport, location, usedTakes) {
  const league = LEAGUES[sport];
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/New_York'
  });

  const system = `You write sports bar talk for someone who doesn't follow sports but wants to sound like they do. Today is ${today}. They are in ${location}. The sport is ${sport} (${league}).

Search the web for what is happening right now with the local ${league} team or players for ${location} - last night's game, today's matchup, a trade, an injury, a streak, the standings. If the league is in its offseason, use the freshest offseason storyline instead (draft, signings, trades, training camp). Everything you mention must come from the last week or so of search results, never from memory, because rosters and records change constantly.

Then write exactly one take: what a real local fan would say out loud at the bar tonight. Casual, opinionated, specific - name a player or a score. Two sentences at most.

Your reply is shown directly on the person's screen, so reply with only the take itself wrapped in double quotes - no lead-in, no mention of searching, no sources. If the search turns up nothing current enough to build a take on, reply with exactly NO_TAKE instead.`;

  let userMessage = `Give me a fresh ${sport} take for ${location}.`;
  if (usedTakes.length) {
    userMessage += `\n\nI've already used the takes below, so build this one on a different storyline. It should stand on its own - don't refer back to them:\n${usedTakes.map(t => `- ${t}`).join('\n')}`;
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
  return extractQuote(response.content);
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
  const poolKey = `takes:${sport}:${location.toLowerCase()}`;
  const pool = await readPool(cache, poolKey);

  // Already have this take (or the pool is full) - free, no API call
  if (n < pool.length) {
    return res.status(200).json({ quote: pool[n], cached: true });
  }
  if (pool.length >= POOL_MAX) {
    return res.status(200).json({ quote: pool[n % pool.length], cached: true });
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
      return res.status(200).json({ quote: pool[n % pool.length], cached: true });
    }
    return res.status(429).json({ error: 'Too many takes right now. Try again in a bit.' });
  }

  try {
    await Promise.all([bumpCount(cache, dayKey, 26 * 60 * 60), bumpCount(cache, ipKey, 60 * 60)]);

    const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY, maxRetries: 1, timeout: 50_000 });
    const quote = await generateTake(client, sport, location, pool);

    if (!quote) {
      return res.status(502).json({ error: 'No take came back' });
    }

    // Re-read so two people generating at once don't overwrite each other
    await addToPool(cache, poolKey, quote);

    return res.status(200).json({ quote, cached: false });

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
