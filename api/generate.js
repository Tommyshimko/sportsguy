import Anthropic from '@anthropic-ai/sdk';
import { getCache, waitUntil } from '@vercel/functions';
import { attachImages, PICTURES_ON } from './_images.js';
import { accountsReady, followedTeams } from './_account.js';
import { chargeTake, clientIp, PAID_HOURLY_LIMIT, peekWallet, refundTake, resolveWallet, walletReady } from './_wallet.js';

export const config = { maxDuration: 120 };

// ==================== SETTINGS ====================
const MODEL = 'claude-sonnet-5';
const POOL_MAX = 4;                  // takes kept per sport + city
const TOPIC_POOL_MAX = 2;            // takes kept per topic within a sport + city
const POOL_TTL = 3 * 60 * 60;        // seconds a pool of takes stays fresh
const IP_HOURLY_LIMIT = 12;          // new FREE takes one IP can trigger per hour (paid takes: PAID_HOURLY_LIMIT per wallet, in _wallet.js)
const DEV_HOURLY_LIMIT = 80;         // the same, for testers (the daily limit still applies to everyone)
// Testers: signed-in account ids in the DEV_USER_IDS env var (comma list). Empty or unset = nobody.
const DEV_USER_IDS = new Set(String(process.env.DEV_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean));
// Emergency ceiling on ALL new takes per day, free and paid, everyone combined. The real limits are
// the wallet's (api/_wallet.js): a fixed free budget a day, and paid takes that someone bought.
const DAILY_LIMIT = Number(process.env.DAILY_TAKE_LIMIT) || 1000;

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
  // "Someone's got five tackles" is the writer dodging a name it wasn't sure of. Not a take.
  if (/\b(someone|somebody|some guy|some dude)\b/i.test(quote)) return null;
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
    if (topics.length === 3) break;   // three, because a player can be dropped below; the app shows two
  }
  return topics;
}

const TEAM_SPORTS = ['football', 'baseball', 'basketball', 'soccer'];

const WORDS = 52;                   // enough to carry where we are, what is next, and why
const SEASON_TTL = 6 * 60 * 60;      // a season doesn't move fast; one answer serves everyone for hours

// Where the season is, in the words a regular would use if you sat down next to him knowing nothing.
// This is the same for everyone on earth, so one generation serves the whole app for six hours.
// Cut a season line to length without losing what makes it worth reading. Cheap: no search, and it
// only ever removes, so nothing new can sneak in past the fact-check that follows.
async function tighten(client, line) {
  const response = await client.messages.create({
    model: CHECKER_MODEL,
    max_tokens: 400,
    output_config: { effort: 'low' },
    system: `Cut this to under ${WORDS} words. KEEP where the season is, the fixture and its date, and why it matters - those are the whole point. Drop caveats, hedging, background and anything a person would skip. Do not add anything, do not soften it, keep the voice. No dashes, semicolons or parentheses. Reply with the shortened line and nothing else.`,
    messages: [{ role: 'user', content: line }],
  });
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim().replace(/^"|"$/g, '');
}

export async function generateSeason(client, sport) {
  const league = LEAGUES[sport];
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York',
  });
  // The checker judges days against a calendar. Without one it has nothing to check "Monday night"
  // against and throws good lines away - football and golf both died that way before this was passed.
  const calendar = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7].map(offset => {
    const d = new Date(Date.now() + offset * 86400000);
    const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
    return offset === 0 ? `${label} (today)` : label;
  }).join(', ');

  const brief = plain => `You are the friend who actually follows ${sport} (${league}) and can bring someone up to speed who has not been paying attention. They are smart, they just do not follow it. Today is ${today}.

They want to know FOUR things, in this order, and nothing else:
  1. Where the season is. How far in, what stage, does it matter yet.
  2. What is coming up. The next games or events that are actually on.
  3. Which of those is worth watching, and why that one.
  4. Where the noise is. The team, player or story everyone is talking about right now.

1. GO AND FIND ALL FOUR. Several searches, not one. Where the ${league} season stands right now. The schedule for the next seven days - "${league} schedule this week", "${league} games ${today}" - because the fixtures are the heart of this answer and you may NOT supply them from memory. Then what people are actually talking about. Search ${league} by name every time: other competitions share these team names.

2. Copy your evidence first, up to five sentences from the results, each with its page age. A fact-checker reads ONLY these and throws the answer away if anything is not backed by them. Copy a sentence for every fixture, date, record and name you intend to use. Prefer pages from the last week; never an undated page or Wikipedia for what is happening now.

   You know this sport, and that is the danger. Every fact has to be in the sentences you copied, spelled the same way. Do not reach for a result, a record, a fixture or a date from memory to round it out, however sure you are - it has already failed that way by inventing a game nobody had reported. Do not say HOW something happened, or WHICH DAY, unless the copied sentence says so.

3. Write it the way that friend would, out loud:
- Three or four sentences, about 45 words, never more than 55. Count them.
- Open with where the season is in plain words: "three weeks in", "last week before the playoffs", "nothing on until March". Never "Week 3 of 18".
- Name the actual game or event worth watching AND WHEN IT IS, by day or date. This is the part they came for and the answer is unusable without it. If you could not find a fixture, say what is next in the calendar instead ("nothing on until March") and say you mean roughly.
- An answer about ONE PERSON is not this. A withdrawal, an injury, a contract, a court case: none of it is what is going on in the sport unless it changes who is playing in the thing you just told them to watch. Individual sports get this wrong most - the tour is still the season, and the next tournament is still the fixture.
- Say where the hype is and why, in one clause. A team nobody rated, a player carrying everything, a rivalry, a mess.
- Everyday words only. No standings jargon, no percentages, no rankings points, no playoff maths.
- Do not hand over a news story instead. A court case or a contract is not what is going on in the sport unless it changes who plays.
- No dashes, semicolons or parentheses. Do not greet them or explain yourself.
- This is read for hours, so name the day ("Sunday") rather than saying tonight or today.

Reply in exactly this format and nothing else:
<evidence>
- (page age) "sentence copied from the source"
</evidence>
<take>the answer, without quote marks</take>

If the searches turn up nothing solid, reply with <take>NO_TAKE</take>.${plain ? `

LAST ATTEMPT, SO PLAY IT SAFE. Earlier goes were thrown out for saying things the sources did not. Report ONLY what your copied sentences literally say: where the season is, and the next fixture you actually found with its date. Drop the hype sentence if you cannot support it. A flat true answer is worth far more than a good one that gets binned.` : ''}`;

  const system = brief(false);

  const request = {
    model: MODEL,
    max_tokens: 3000,
    output_config: { effort: 'low' },
    system,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    messages: [{ role: 'user', content: `What is going on in ${sport} right now? Tell me the thing that matters.` }],
  };

  // One retry: the checker is strict on dates and a season line is mostly dates, so a good answer
  // gets thrown out often enough that a single attempt leaves people staring at nothing.
  // Two goes, not three: a full cycle is about 45 seconds and three would run past the function's
  // time before the third could finish, so the third attempt was never really there.
  // Three goes. Two was one short: a single empty reply, which happens, used up half the budget
  // and left the sport silent. A cycle is about 35 seconds and the function has 120.
  for (let attempt = 0; attempt < 3; attempt++) {
    // The last go drops to a brief that is hard to fail. The checker is strict and every attempt
    // embellishes something different, so without this a sport just goes silent for six hours -
    // which is what kept happening to soccer. Plainer and true beats better and binned.
    const attemptRequest = attempt === 2 ? { ...request, system: brief(true) } : request;
    let reply = await client.messages.create(attemptRequest);
    while (reply.stop_reason === 'pause_turn') {
      reply = await client.messages.create({ ...attemptRequest, messages: [{ role: 'user', content: request.messages[0].content }, { role: 'assistant', content: reply.content }] });
    }
    const text = reply.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    let line = (text.match(/<take>([\s\S]*?)<\/take>/)?.[1] || '').trim().replace(/^"|"$/g, '');
    const evidence = (text.match(/<evidence>([\s\S]*?)<\/evidence>/)?.[1] || '').trim();
    if (!line || line === 'NO_TAKE' || line.split(/\s+/).length > 110) { console.warn('Season attempt empty', { sport, attempt, stop: reply.stop_reason, line: line.slice(0, 80) }); continue; }

    // CHECK THE FULL ANSWER, THEN CUT IT. The other way round loses the team sports: they write long,
    // so they always get trimmed, and trimming drops the clause a fact was resting on - the checker
    // then fails a line it would have passed. Cutting cannot add anything, so checking first is safe.
    const checked = await verifyTake(client, line, evidence, calendar);
    if (!checked.pass) { console.warn('Season attempt failed the check', { sport, attempt, line, verdict: checked.verdict || checked.reason }); continue; }

    // It writes 60 to 100 words however firmly the prompt asks for 40, so the cutting is done here
    // rather than asked for.
    if (line.split(/\s+/).length > WORDS) line = await tighten(client, line);
    line = (line || '').replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();   // the trimmer likes a dash; we don't
    if (!line || line.split(/\s+/).length > WORDS + 8) continue;
    // This answer is held for hours, so anything measured from the clock is a lie by the time most
    // people read it. Asking in the prompt was not enough - one came back with "Giants at Rams
    // tonight" - and throwing it away was worse: football HAS a game tonight, so every attempt
    // reached for the word and the sport just went silent. Pin it to a real weekday instead, the
    // same way the takes do, and only give up on the vaguer ones there is no rewriting.
    const dayName = offset => new Date(Date.now() + offset * 86400000)
      .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
    line = line
      .replace(/\blast night\b/gi, `${dayName(-1)} night`)
      .replace(/\btonight\b/gi, `${dayName(0)} night`)
      .replace(/\btoday\b/gi, dayName(0))
      .replace(/\byesterday\b/gi, dayName(-1))
      .replace(/\btomorrow\b/gi, dayName(1));
    if (/\b(right now|currently|at the moment)\b/i.test(line)) continue;
    // The prompt asks for something specific and named; this is what makes it stick. Without a
    // capitalised name or a number the answer is calendar filler - "two weeks in, nothing settled
    // yet" passed every other check and told a reader nothing while ten games went unmentioned.
    const named = (line.match(/\b[A-Z][a-z]{2,}/g) || []).filter(w => !/^(Just|Next|The|This|That|Still|Nothing|Early|Real|Worth|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)$/.test(w));
    if (!named.length) continue;
    // The phrases that mean nothing. These are what calendar filler is made of, and asking the
    // prompt not to write them was not enough. (Demanding a numeral as well was too much: plenty of
    // good answers are all names and no digits.)
    if (/\b(early days|nothing settled|nothing has settled|too early to|worth keeping an eye|heating up|shaping up|anyone's guess|wide open so far|not much to)\b/i.test(line)) continue;
    // SOMETHING HAS TO BE COMING UP, AND IT HAS TO HAVE A DAY ON IT. This is question two, and it is
    // the one people actually opened the app for. Every other check can pass on an answer that never
    // gets there: tennis came back with a player withdrawing from a tournament to recover - a real
    // name, no filler phrases, fact-checked, and not one word about what is on or what to watch.
    // A weekday or a month is what a fixture looks like in plain words, and the sport that is truly
    // out of season still has one ("nothing on until March"), so this costs those nothing.
    if (!/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(line)) continue;
    return line;
  }
  return null;
}

export async function generateTake(client, sport, location, usedTakes, topic = '', follows = []) {
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
  const followLine = follows.length
    ? ` This person follows ${follows.join(' and ')}, so if one of them has something worth talking about, that is the story. If none of them do, use the local team as usual.`
    : '';
  const pickStory = topic ? aboutTopic : isTeamSport
    ? `Pick the one ${league} team most people in ${location} root for. If the area has two, pick one. If it has none, pick the nearest team locals follow. The whole take is about that one team.`
    : `There is no home team in ${sport}, so use the biggest story on tour this week. Only make it local if a tour event is being played in or near ${location} within the next two weeks.`;

  const searchHow = topic
    ? `Look for the newest thing about ${topic}. If it is a team, search for its most recent game by date, like "${topic} score September 18 2026". If it is a player, search "${topic} ${league} latest game". If it is an event, search "${topic} results". Every search result shows how old its page is. Prefer pages from the last three days, and in a quiet stretch use the most recent real news there is and say when it happened.`
    : isTeamSport
    ? `Look for the most recent game or result itself, with a query like "New York Mets MLB score September 18 2026" or "New York Mets game recap", rather than general team news. Use the full team name and the league so you don't get a different team with the same nickname. Every search result shows how old its page is. When the season is on, rest the take only on pages from the last three days. In the offseason, use the newest real news you can find, or failing that the biggest move of this offseason.`
    : `Look for this week's tournament with a query like "${sport} tournament this week leaderboard" or "${sport} news this week". Every search result shows how old its page is. Prefer pages from the last three days. If it is a quiet week, use the result of the most recent big tournament or the next big event coming up, and say when it was or will be.`;

  const system = `You write one line of sports bar talk for someone who does not follow sports but wants to join the conversation. Today is ${today}. They are in ${place}. The sport is ${sport} (${league}).

1. Pick the story. ${pickStory}${followLine}

2. Search by date. ${searchHow} Do not take recent results from undated pages, season roundups or Wikipedia, because those are often weeks behind and would make this person sound out of touch.

3. Copy your evidence first. Before writing, copy out the sentences from the search results that the take rests on (up to four), each with its page age. A separate fact-checker will read only these sentences and throw the take away if any person, number, result or date in it is not backed by them, so copy a sentence for each one. Then check them against each other: who won and who lost, the score, and what day it happened. If you cannot tell who won, or the pages disagree, leave that fact out. This take may be read up to three hours from now, so never give the current score of a game that is still being played, and do not say a game is happening right now: both will be wrong by the time someone reads it. Use something that will still be true tonight instead, like the last finished game, who is starting, or what is at stake. For a tournament that is still going, you can say who led after the last completed round, and name that round. Use this calendar for weekdays: ${calendar}. One fact you are sure of beats three you are not. Every name, score, number and event in the take has to appear in the evidence you copied, spelled the same way. Do not add players, streaks, history or team line-ups from memory, since rosters change and memory is how mistakes get in. The opinion is yours. The facts are the sources'. Do not stretch them either: a one-shot lead is not running away with it, and being one game short of the playoff line is not being about to clinch. If you are not sure what a standings phrase means, leave it out. Only name the day something happened if the source gives the date. A player's number has to be that player's own number, stated about him in the source: a receiver catching two touchdowns does not mean the quarterback threw two. If you are not certain whose number it is, say he played great and leave the count out. Never write around a missing name with "someone", "somebody" or "a guy": a fact with no name attached is useless at a bar, so drop the whole fact and build the take on something you can name. Only mention a player if the source makes clear he plays for this team right now, because a quote from a rival talking about the team is not a player on it. Never use a score from a game that was still being played when the page was written. If all you have is a page from the middle of a game, use your second search to find how it ended ("recap" or "final score"), and if you still can't, talk about something else.

4. Write the take. It is what a local fan would say out loud at the bar, and the person saying it is not a fan, so it has to be easy to say and easy to understand:
- One or two short sentences, about 20 words in total and never more than 25. Count them. Cut anything that is not needed.
- EXCEPTION, a game worth watching: if this team, or the biggest game in the league, is playing within the next two days, that is the take. Say who plays who and name the day, say in one phrase what is at stake or how they match up, and say the one thing to watch for. A take like that may run to 35 words because it has to carry all three. Still everyday words, still no stat talk. Never say "tonight" - name the day, because this is read for hours afterwards.
- Name the team. Mention at most one player.
- Everyday words only. No insider slang or stat talk: say "home run" not "bomb", "losing streak" not "skid", "won it in the last inning" not "walk-off". No percentages, ratings, rankings points or playoff math. If a word would need explaining to someone who never watches ${sport}, do not use it.
- At most one number besides a score.
- Never write "last night", "tonight", "tomorrow" or "yesterday". Name the day instead ("Friday night"), since this may be read hours from now.
- No dashes, semicolons or parentheses.
- End on a simple opinion a fan would have.
- Just say the take. Do not greet anyone, address the fans, or explain that there is no local team or event.
- Keep it about the games: no politics, legal trouble or betting.

5. Pick the topics. Always list the team the take is about first, then up to two more interesting things in the take that this person might want another take about next: the team, a player, an event. Give just the name exactly as the take says it (one to three words, like "Yankees" or "Judge", never a whole phrase), then the full proper name for a button (for a player that means his first AND last name, even when the take says only one of them), then the kind. For a player on a team, add the full name of the team the sources say he plays for right now, because it is used to find the right photo of him.

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
  // Whose wallet pays: the signed-in account, else the RevenueCat id the app sent, else the IP
  const ip = clientIp(req);
  const { walletId, userId } = await resolveWallet(req.body, ip);
  // Testers get unlimited takes, and that has to hold HERE: for a signed-in tester the balance lives
  // on the server, so a client-only flag would still be charged. It used to be a shared password in
  // the request, which anyone reading this public repo could copy; now it is only the accounts listed
  // in DEV_USER_IDS. An old app still sending `dev` in the body is fine - it's simply ignored.
  const devKey = !!userId && DEV_USER_IDS.has(userId);
  const follows = userId ? await followedTeams(userId, sport) : [];

  if (!LEAGUES[sport] || location.length < 2) {
    return res.status(400).json({ error: 'Missing sport or location' });
  }

  if (!process.env.CLAUDE_API_KEY) {
    console.error('CLAUDE_API_KEY not set');
    return res.status(500).json({ error: 'API key not configured' });
  }

  const cache = getCache({ namespace: 'sportsguy' });

  // WHERE THE SEASON IS. Free, and never charged: it is the same answer for everyone on earth, so one
  // generation serves the whole app for six hours. This is the thing people open the app to see when
  // nothing in particular has happened, so putting it behind the take counter would be backwards.
  if (req.body?.kind === 'season') {
    const day = new Date().toISOString().slice(0, 10);
    const key = `season:v12:${sport}:${day}`;
    // Deliberately NOT versioned: the whole point of the last-good answer is to cover a failure, and
    // the likeliest moment to fail is right after the wording changes, which is exactly when a
    // versioned fallback store would be empty. Golf came back blank that way.
    const lastKey = `season:last2:${sport}`;
    const held = await cache.get(key);
    if (held) return res.status(200).json({ line: held, cached: true });

    // NEVER MAKE SOMEONE WAIT FOR ONE. Writing a season line is up to three searched, fact-checked
    // attempts - thirty seconds to two minutes - and the fresh answer only lives six hours, so by any
    // morning every sport is cold. Switching sport then sat there showing nothing at all for the
    // whole of that time, which on a phone is indistinguishable from the button being broken.
    //
    // So this endpoint NEVER BLOCKS ON THE MODEL. It answers straight away with what it has - the
    // last good line if there is one, otherwise a plain "not yet" the phone turns into a take - and
    // the writing always happens BEHIND the response, for the next person. A season does not turn
    // over in six hours; yesterday's line is a fine thing to read while today's is being checked.
    const busyKey = `season:writing:${sport}`;
    if (!(await cache.get(busyKey))) {
      // One writer per sport at a time, or a burst of switches is a burst of generations
      await cache.set(busyKey, 1, { ttl: 180 });
      waitUntil((async () => {
        try {
          const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY, maxRetries: 1, timeout: 50_000 });
          const started = Date.now();
          const fresh = await generateSeason(client, sport);
          console.log('Season writer finished', { sport, ok: !!fresh, seconds: Math.round((Date.now() - started) / 1000), line: fresh });
          if (fresh) {
            await cache.set(key, fresh, { ttl: SEASON_TTL, tags: ['season'] });
            await cache.set(lastKey, fresh, { ttl: 2 * 24 * 60 * 60, tags: ['season'] });
          }
        } catch (error) { console.error('Season writer crashed', { sport, error: String(error?.message || error) }); } finally {
          await cache.delete(busyKey).catch(() => {});
        }
      })());
    }
    const lastGood = await cache.get(lastKey);
    if (lastGood) return res.status(200).json({ line: lastGood, cached: true, stale: true });
    return res.status(503).json({ error: 'No season line yet', writing: true });
  }

  const poolMax = topic ? TOPIC_POOL_MAX : POOL_MAX;
  // Followed teams change what a take is about, so they get their own shelf
  const follow = follows.length ? `:for:${follows.join(',').toLowerCase()}` : '';
  const poolKey = `takes:v18:${sport}:${location.toLowerCase()}${topic ? `:topic:${topic.toLowerCase()}` : ''}${follow}`;
  const pool = await readPool(cache, poolKey);
  // Every take carries the balance; `takesLeft` is the same thing as one number, for older app builds.
  // A pool hit only reads the wallet (and leaves the balance out if that read fails).
  const send = async (take, cached, more, wallet) => {
    if (wallet === undefined && walletReady()) wallet = await peekWallet(walletId).catch(() => undefined);
    return res.status(200).json({
      // Pool takes written before pictures were switched off still carry ESPN links, so strip on the way out
      quote: take.quote, topics: (take.topics || []).map(t => PICTURES_ON ? t : { ...t, image: undefined }), cached, more,
      ...(wallet ? { wallet, takesLeft: wallet.freeLeft + wallet.paid } : {}),
    });
  };

  // Already have this take (or the pool is full) - free, no API call.
  // `more` tells the app whether asking again can turn up something new; when it is false the app
  // says the city is caught up and switches the pull off. Dev mode is meant to be unlimited, so the
  // pool is a free head start for it, never a ceiling - otherwise testing stops dead after four.
  if (n < pool.length) return send(pool[n], true, devKey || n + 1 < poolMax);
  if (pool.length >= poolMax && !devKey) return send(pool[n % pool.length], true, false);

  // A new take costs money - check the limits first
  const day = new Date().toISOString().slice(0, 10);
  const hour = new Date().toISOString().slice(0, 13);
  const dayKey = `spend:${day}`;
  const ipKey = `ip:${ip}:${hour}`;
  const paidKey = `paid:${walletId}:${hour}`;
  const tooMany = () => pool.length
    ? send(pool[n % pool.length], true, false)
    : res.status(429).json({ error: 'Too many takes right now. Try again in a bit.' });

  const [dayCount, ipCount, paidCount] = await Promise.all([readCount(cache, dayKey), readCount(cache, ipKey), readCount(cache, paidKey)]);
  // The IP brake is for FREE takes (and testers); paid takes have their own brake per wallet
  const hourly = devKey ? DEV_HOURLY_LIMIT : IP_HOURLY_LIMIT;
  if (dayCount >= DAILY_LIMIT || (devKey && ipCount >= hourly)) {
    console.warn('Limit hit', { dayCount, ipCount, ip });
    return tooMany();
  }

  // PAY FOR IT FIRST. Testers are never charged. Without a working wallet nothing new is generated:
  // failing closed is the whole point.
  let charge = null;
  if (!devKey) {
    if (!walletReady()) return res.status(503).json({ error: 'Takes are unavailable right now.' });
    try {
      charge = await chargeTake(walletId, cache, { freeBlocked: ipCount >= hourly, paidBlocked: paidCount >= PAID_HOURLY_LIMIT });
    } catch (error) {
      console.error('Wallet charge failed', { walletId, error: error.message });
      return res.status(503).json({ error: 'Could not check your takes. Try again in a bit.' });
    }
    if (!charge.ok) {
      if (charge.code === 'rate') {
        console.warn('Hourly limit hit', { ip, walletId, ipCount, paidCount });
        return tooMany();
      }
      return res.status(402).json({
        error: charge.code === 'out' ? 'Out of takes' : "Today's free takes are all used up. Get more takes, or come back tomorrow.",
        code: charge.code,
        wallet: charge.wallet,
      });
    }
  }
  let refunded = false;
  const refund = async () => {
    if (!charge || refunded) return;
    refunded = true;
    await refundTake(walletId, charge, cache);
  };

  try {
    const brakeKey = charge?.kind === 'paid' ? paidKey : ipKey;
    await Promise.all([bumpCount(cache, dayKey, 26 * 60 * 60), bumpCount(cache, brakeKey, 60 * 60)]);

    const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY, maxRetries: 1, timeout: 50_000 });
    // A take that fails the checks is thrown away, so give it one more go before giving up
    // A topic take should not repeat what this city's main takes already said
    const cityTakes = topic ? await readPool(cache, `takes:v18:${sport}:${location.toLowerCase()}`) : [];
    const used = [...pool, ...cityTakes].map(entry => entry.quote);

    let take = await generateTake(client, sport, location, used, topic, follows);
    if (!take) {
      await bumpCount(cache, dayKey, 26 * 60 * 60);
      take = await generateTake(client, sport, location, used, topic, follows);
    }
    if (!take) {
      await refund();
      return res.status(502).json({ error: 'No take came back' });
    }
    await attachImages(take.topics, sport, cache);
    // Tommy's rule: every highlighted PLAYER shows his headshot. If we can't vouch for a photo, the
    // player simply isn't offered as a topic (his name stays in the take, just not highlighted).
    // (Only while pictures are on - with them off every pill shows initials, players included.)
    const withPhotos = take.topics.filter(entry => !PICTURES_ON || entry.kind !== 'player' || entry.image);
    // A take with nothing highlighted looks broken, so if dropping photo-less players would leave
    // none, keep the teams and events (which never need a photo) rather than nothing.
    take.topics = withPhotos.length ? withPhotos : take.topics.filter(entry => entry.kind !== 'player');
    console.log('New take', { sport, location, topic, quote: take.quote, topics: take.topics, evidence: take.evidence });

    // Re-read so two people generating at once don't overwrite each other
    await addToPool(cache, poolKey, { quote: take.quote, topics: take.topics }, poolMax);

    return send(take, false, devKey || n + 1 < poolMax, charge?.wallet);

  } catch (error) {
    await refund().catch(() => {});
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
