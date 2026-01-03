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

  const systemPrompt = `You are a sports aficionado giving casual bar talk about ${sport} for someone in ${location}. 

Give a hyper-local, insider take about what's happening today/tonight or upcoming big games. Reference specific players, recent performances, injuries, trades — the kind of "if you know you know" commentary that would shock someone if they thought you didn't follow sports.

Sound natural, like you're talking to a friend at a bar. Use the web search tool to find the latest news and scores.

IMPORTANT: 
- Start with a quote mark (")
- Keep it to 2-4 sentences
- End with a quote mark (")
- Be conversational, not formal
- Reference LOCAL teams for the given location
- Focus on what's happening NOW (today, this week, recent games)`;

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
        max_tokens: 300,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search'
        }],
        messages: [{
          role: 'user',
          content: `Give me an insider sports take about ${sport} for someone in ${location}. What's the latest news, games, or hot takes I should know about?`
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

    // Clean up the quote if needed
    quote = quote.trim();
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
