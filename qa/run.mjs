// QA harness: runs the REAL take generator and records what the model searched, saw and cited.
// Usage: node qa/run.mjs <outfile.json> [sport:City, ST] ...
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import { generateTake } from '../api/generate.js';

const SPORTS = ['football', 'baseball', 'basketball', 'soccer', 'tennis', 'golf'];
const CITIES = (process.env.QA_CITIES || 'Brooklyn, NY|Chicago, IL|Austin, TX|Green Bay, WI').split('|');
const [,, outFile, ...only] = process.argv;
const jobs = only.length
  ? only.map(s => { const [sport, ...rest] = s.split(':'); return { sport, location: rest.join(':') }; })
  : SPORTS.flatMap(sport => CITIES.map(location => ({ sport, location })));

async function runJob({ sport, location, used = [] }) {
  const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY, maxRetries: 2, timeout: 90_000 });
  const responses = [];
  const create = client.messages.create.bind(client.messages);
  client.messages.create = async (...args) => { const r = await create(...args); responses.push(r); return r; };

  const t0 = Date.now();
  let take = null, evidence = '', error = null;
  try { const r = await generateTake(client, sport, location, used); take = r?.quote || null; evidence = r?.evidence || ''; } catch (e) { error = String(e.message || e); }
  const seconds = (Date.now() - t0) / 1000;

  const blocks = responses.flatMap(r => r.content);
  const queries = blocks.filter(b => b.type === 'server_tool_use').map(b => b.input?.query);
  const results = blocks.filter(b => b.type === 'web_search_tool_result')
    .flatMap(b => Array.isArray(b.content) ? b.content.map(r => ({ title: r.title, url: r.url, age: r.page_age })) : [{ error: b.content?.error_code }]);
  const citations = blocks.filter(b => b.type === 'text').flatMap(b => (b.citations || []).map(c => ({ url: c.url, text: c.cited_text })));
  const rawText = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  const usage = responses.reduce((a, r) => ({
    input: a.input + r.usage.input_tokens, output: a.output + r.usage.output_tokens,
    searches: a.searches + (r.usage.server_tool_use?.web_search_requests || 0) }), { input: 0, output: 0, searches: 0 });
  const cost = (usage.input * 2 + usage.output * 10) / 1e6 + usage.searches * 0.01;
  return { sport, location, take, evidence, error, seconds, cost, usage, queries, results, citations, rawText };
}

const out = [];
const queue = [...jobs];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const job = queue.shift();
    const followUp = job.location.endsWith('+');
    if (followUp) job.location = job.location.slice(0, -1);
    const r = await runJob(job);
    out.push(r);
    if (followUp && r.take) {
      const r2 = await runJob({ ...job, used: [r.take] });
      r2.location += ' (2nd take)';
      out.push(r2);
      console.log(`[${r2.sport} / ${r2.location}] ${r2.take}`);
    }
    console.log(`[${r.sport} / ${r.location}] ${r.seconds.toFixed(1)}s $${r.cost.toFixed(3)} ${r.take || 'FAILED: ' + (r.error || 'no take') + ' | raw: ' + r.rawText.slice(0, 160)}`);
  }
}));
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
const ok = out.filter(r => r.take);
console.log(`\n${ok.length}/${out.length} takes | avg ${(out.reduce((a, r) => a + r.seconds, 0) / out.length).toFixed(1)}s | total $${out.reduce((a, r) => a + r.cost, 0).toFixed(2)}`);
