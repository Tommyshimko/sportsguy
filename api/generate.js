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
    basketball: 'NBA 2024-25 season',
    football: 'NFL 2024-25 season',
    baseball: 'MLB 2025 season',
    soccer: 'MLS 2025 season',
    tennis: 'current ATP/WTA tour',
    golf: 'PGA Tour 2025'
  };

  const sportLeague = sportContext[sport] || sport;

  const currentDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const systemPrompt = `You give brief, punchy sports bar talk. Today is ${currentDate}. Location: ${location}. Sport: ${sportLeague}.

FRESHNESS REQUIREMENTS - CRITICAL:
1. ONLY reference events from the current 2024-25 season (or current active season)
2. Prioritize TODAY'S games/news first, then yesterday's, then this week's
3. NEVER mention outdated seasons, retired players, or events older than 2 weeks unless directly relevant to current storylines
4. Always search for the MOST RECENT available information about local teams
5. If no recent games, reference current standings, trades, injuries, or hot storylines from THIS WEEK

LOCAL TEAM FOCUS:
6. Reference the LOCAL team for ${location} (e.g., NYC = Giants/Jets/Knicks/Yankees/Mets depending on sport)
7. Mention specific players, scores, or developments from the LAST 48 HOURS if available
8. Include current season context (playoffs, standings, streaks, recent performance)

TONE & FORMAT - CRITICAL:
9. Sound like a real fan - casual, opinionated, current
10. Use current sports slang and references
11. Output ONLY the quote, nothing else
12. 2 sentences maximum
13. Start with " and end with "
14. NO preamble like "Let me search" or "Here's a take"
15. NO meta-commentary about searching
16. Just the bar talk quote itself

AVOID: Old stats, retired players, past seasons, or anything that sounds dated or stale.`;

  // Retry function with exponential backoff
  async function callWithRetry(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
              content: `Search for what happened TODAY (${currentDate}) or in the LAST 48 HOURS in ${sportLeague} involving ${location}'s local team. Find the most recent: game results, breaking news, trades, injuries, or current storylines. If no recent games, search for current season standings, player performance, or trending stories from THIS WEEK. Give me a fresh, current 2-sentence sports bar take that sounds like it's happening right now.`
            }],
            system: systemPrompt
          })
        });

        const data = await response.json();

        // Check for rate limit error
        if (data.error && data.error.type === 'rate_limit_error') {
          console.log(`Rate limited, attempt ${attempt}/${maxRetries}`);
          if (attempt < maxRetries) {
            // Wait before retry: 2s, 4s, 8s
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
            continue;
          }
        }

        return data;
      } catch (error) {
        console.error(`Attempt ${attempt} failed:`, error);
        if (attempt === maxRetries) throw error;
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }

  try {
    const data = await callWithRetry(3);

    if (data.error) {
      console.error('Claude API error:', data.error);
      return res.status(500).json({ error: 'API error: ' + (data.error.message || data.error.type) });
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
