import Anthropic from '@anthropic-ai/sdk';
import { generateTake } from '../api/generate.js';
const jobs = [['football','Los Angeles, CA'],['football','New York City, NY'],['baseball','Denver, CO'],['basketball','Boston, MA'],['golf','Miami, FL'],['tennis','Seattle, WA']];
let empty = 0;
await Promise.all(jobs.map(async ([sport, loc], i) => {
  const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY, maxRetries: 2, timeout: 90000 });
  const raws = [];
  const create = client.messages.create.bind(client.messages);
  client.messages.create = async (...a) => { const r = await create(...a); raws.push(r.content.filter(b=>b.type==='text').map(b=>b.text).join('')); return r; };
  const take = await generateTake(client, sport, loc, []);
  const topicsBlock = raws.map(t => (t.match(/<topics>([\s\S]*?)(?:<\/topics|$)/i)||[])[1]||'').filter(Boolean).pop() || '(none emitted)';
  if (!take?.topics?.length) empty++;
  console.log(`\n[${i}] ${sport} / ${loc}  calls=${raws.length}`);
  console.log('  quote :', take?.quote || 'FAILED');
  console.log('  raw   :', topicsBlock.trim().replace(/\n/g,' | '));
  console.log('  parsed:', JSON.stringify(take?.topics || []));
}));
console.log(`\n${empty}/${jobs.length} takes had NO topics`);
