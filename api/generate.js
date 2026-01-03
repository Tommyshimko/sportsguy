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

  if (!process.env.CLAUDE_API_KEY) {
    console.error('CLAUDE_API_KEY not set');
    return res.status(500).json({ error: 'API key not configured' });
  }

  const sportContext = {
    basketball: 'NBA',
    football: 'NFL',
    baseball: 'MLB',
    soccer: 'MLS',
    tennis: 'ATP/WTA tennis',
    golf: 'PGA Tour'
  };

  const sportLeague = sportContext[sport] || sport;

  const systemPrompt = `You give brief, punchy sports bar talk. Location: ${location}. Sport: ${sportLeague}.

RULES:
1. Reference the LOCAL team for ${location} (e.g., NYC = Giants/Jets/Knicks/Yankees)
2. Use web search to find what happened in the last few days
3. Mention specific players, scores, or storylines
4. Sound like a real fan - casual, opinionated

FORMAT - CRITICAL:
- Output ONLY the quote, nothing else
- 2 sentences maximum
- Start with " and end with "
- NO preamble like "Let me search" or "Here's a take"
- NO meta-commentary about searching
- Just the bar talk quote itself`;

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
        tool_choice: { type: 'auto' },
        messages: [{
          role: 'user',
          content: `Give me a quick ${sportLeague} take for ${location}. Search for recent news, then give me 2 sentences max.`
        }],
        system: systemPrompt
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('Claude API error:', data.error);
      return res.status(500).json({ error: 'API error: ' + data.error.message });
    }

    if (!data.content || data.content.length === 0) {
      return res.status(500).json({ error: 'No content in response' });
    }

    // Extract text from response
    let quote = '';
    for (const block of data.content) {
      if (block.type === 'text') {
        quote += block.text;
      }
    }

    // Clean up the quote aggressively
    quote = quote.trim();
    
    // Remove any preamble/meta text before the actual quote
    quote = quote.replace(/^.*?(Let me|I'll|I will|Searching|Looking)[^"]*["]/gi, '"');
    quote = quote.replace(/^[^"]*["]/i, '"');
    
    // If there's no quote mark, find the meat of the response
    if (!quote.includes('"')) {
      // Remove common preambles
      quote = quote.replace(/^(Let me search|I'll search|Searching|Looking for|Here's)[^.]*\.\s*/gi, '');
      quote = '"' + quote + '"';
    }
    
    // Ensure proper quote marks
    if (!quote.startsWith('"')) {
      quote = '"' + quote;
    }
    
    // Find last quote and trim, or add one
    const lastQuoteIndex = quote.lastIndexOf('"');
    if (lastQuoteIndex > 0 && lastQuoteIndex < quote.length - 1) {
      quote = quote.substring(0, lastQuoteIndex + 1);
    } else if (!quote.endsWith('"')) {
      quote = quote + '"';
    }

    return res.status(200).json({ quote });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to generate take: ' + error.message });
  }
}
