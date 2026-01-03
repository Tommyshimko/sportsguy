export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { sport, location } = req.body;

  if (!sport || !location) {
    return res.status(400).json({ error: 'Missing sport or location' });
  }

  // Map sport names to leagues for better search context
  const sportContext = {
    basketball: 'NBA basketball',
    football: 'NFL football',
    baseball: 'MLB baseball',
    soccer: 'MLS soccer or Premier League',
    tennis: 'ATP/WTA tennis',
    golf: 'PGA golf'
  };

  const sportLeague = sportContext[sport] || sport;

  const systemPrompt = `You are a sports aficionado giving casual bar talk about ${sportLeague} for someone located in ${location}, USA.

CRITICAL: The user is in ${location}. You MUST reference the LOCAL teams from that area. For example:
- If they're in Boston, talk about the Celtics/Red Sox/Patriots/Bruins
- If they're in LA, talk about the Lakers/Dodgers/Rams/Chargers
- If they're in a smaller city, reference the nearest major market teams they'd follow

Use the web search tool to find:
1. The local ${sport} team(s) for ${location}
2. Their most recent games, scores, and news from the past few days
3. Key players, injuries, trades, or storylines

Give a hyper-local, insider take about what's happening today/tonight or upcoming big games. Reference specific players, recent performances, injuries, trades — the kind of "if you know you know" commentary that would shock someone if they thought you didn't follow sports.

Sound natural, like you're talking to a friend at a bar. Be conversational, use casual language.

IMPORTANT OUTPUT FORMAT:
- Start with a quote mark (")
- Keep it to 2-3 sentences maximum
- End with a quote mark (")
- NO preamble, NO "Here's a take:", just the quote itself
- Reference SPECIFIC recent events, player names, scores when possible`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search'
        }],
        messages: [{
          role: 'user',
          content: `I'm at a bar in ${location} and want to sound like I know ${sport}. What's the insider take on the local team right now? Search for the latest news and give me something good to say.`
        }],
        system: systemPrompt
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('Claude API error:', data.error);
      return res.status(500).json({ error: 'Failed to generate take' });
    }

    // Extract text from response
    let quote = '';
    for (const block of data.content) {
      if (block.type === 'text') {
        quote += block.text;
      }
    }

    // Clean up the quote
    quote = quote.trim();
    
    // Remove any preamble like "Here's a take:" or similar
    quote = quote.replace(/^(Here's|Here is|Sure|Okay|Alright)[^"]*["]/i, '"');
    
    // Ensure it starts and ends with quotes
    if (!quote.startsWith('"')) {
      quote = '"' + quote;
    }
    if (!quote.endsWith('"')) {
      quote = quote + '"';
    }

    return res.status(200).json({ quote });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to generate take' });
  }
}
