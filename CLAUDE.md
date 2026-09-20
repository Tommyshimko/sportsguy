# SPORTSGUY PROJECT

## Overview
SportsGuy is a mobile-first web app that generates casual sports bar commentary using Claude API with web search. When you're at a bar with friends who like sports but don't know anything about sports, SportsGuy gives you credible takes to drop into conversation.

**Live Site:** https://sportsguy.xyz  
**GitHub:** https://github.com/Tommyshimko/sportsguy  
**Deployment:** Vercel (auto-deploys on push to main)

## Tech Stack
- **Frontend:** Single-page HTML/CSS/JS (no framework)
- **API:** Vercel function using the Anthropic SDK (Claude Sonnet 5 + web search)
- **Hosting:** Vercel
- **Version Control:** Git + GitHub

## Project Structure
```
sportsguy/
├── index.html          # Main application (single file)
├── api/
│   └── generate.js     # Vercel serverless function for Claude API
└── icons/
    ├── gradient.png    # Logo gradient
    ├── Arrow.png       # Navigation arrow
    └── [sport-balls]   # Baseball, Basketball, Golf, etc.
```

## Take Generator (api/generate.js)
Rebuilt Sept 2026 after a full QA. How it works, in order:
1. **Shared pool** - up to 4 takes per sport + city are kept for 3 hours (Vercel Runtime Cache). The app sends `{sport, location, n}`; `n` is which take it wants (a tap asks for the next one). Pool hits are free and instant.
2. **New take** (~7c, ~7s including the fact-check) - Claude Sonnet 5 + web search. The prompt makes it search by date for the actual game, copy out its evidence sentences first, then write the take using only those facts.
3. **Independent fact-check** - a separate model call (`verifyTake`) reads the take against the copied evidence only: ruthless on results, numbers, people and dates; relaxed on opinions. On a FAIL, `reviseTake` rewrites from the evidence using the checker's complaint and it is checked again, before paying for a new search. Added after a live take gave a quarterback a receiver's touchdown count. Keep the checker on Sonnet: Haiku got weekdays wrong with the calendar in front of it.
3b. **Hard checks in code** - any number in the take must appear in the evidence or the take is thrown away; "tonight / last night" are rewritten to real weekdays; over 45 words is rejected; one automatic retry.
4. **Limits** - `DAILY_TAKE_LIMIT` env (default 150 paid takes/day), 12/hour per IP, only sportsguy.xyz may call it from a browser.

**Voice rules** (in the prompt): ~20 words, everyday words a non-fan can say, one team, at most one player, no stats or slang, no dashes, ends on a simple opinion.

**QA** - `node qa/run.mjs qa/out.json` runs the real generator over 6 sports x 4 cities and records sources; `python3 qa/style.py qa/out.json` scores length and plain language. Needs `CLAUDE_API_KEY` in the environment (`vercel env pull`, delete the file after). Costs about $1.30 a round. Fact-check baseball against statsapi.mlb.com. Re-run this after ANY prompt change.

## Design System

### Colors
```css
--green: #22C55E
--blue: #3B82F6
--text-brown: #714E4E
--bg: #FAF9F6
```

### Typography
- **Anton** - Logo and headers ("SPORTSGUY")
- **Instrument Sans Bold** - Quotes, main text
- **Instrument Serif** - Sport names in selection modal
- **Inter Tight** - Hints and UI elements

### Logo
"SPORTS" (green) + "GUY" (blue) in Anton font

## Current Features
1. **Onboarding Flow**
   - "Want to be a SPORTSGUY?" intro
   - Location setup (GPS or manual entry)
   - Main screen

2. **Sports Selection**
   - 6 sports: Baseball, Basketball, Golf, Tennis, Soccer, Football
   - Full-screen modal with blurred background
   - Instrument Serif font for sport names

3. **Location Detection**
   - GPS detection
   - Manual zip/city entry with autocomplete
   - Modal matches sport selection design

4. **Quote Generation**
   - Tap to regenerate new takes
   - Sport-specific loading messages
   - Smooth loading animation (gradient + rotating balls)

5. **Text Scramble Effects**
   - Color-preserving scramble transitions
   - Main ↔ Sport modal: "SPORTSGUY" ↔ "CHOOSE SPORT"
   - Main ↔ Location modal: "SPORTSGUY" ↔ "YOUR LOCATION"
   - Logo tap easter egg (cycles through fun phrases)

## Animation Details

### Loading Animation
- **Gradient:** Scales 1.3x → 3x → 1.3x over 6 seconds
- **Sport Balls:** Rotate in circle, 0° → 1800° → 3600° (10 full rotations)
- **Easing:** `cubic-bezier(0.45, 0, 0.55, 1)` for organic pulse
- **Entrance:** Fade in from blur over 1.5s
- **Loading Messages:** Cycle every 2.5s with sport-specific wit

### Text Scramble
- Scoreboard-style character scramble effect
- Preserves color (green stays green, blue stays blue)
- Used for page transitions and logo easter egg

## Code Style Rules

### Keep It Simple
- No heavy frameworks - vanilla JS only
- Single HTML file for simplicity
- Inline styles when appropriate
- Mobile-first responsive design

### Animation Philosophy
- Smooth, organic easing functions
- Minimal but polished
- Performance-conscious (CSS transforms over layout changes)
- Design-driven timing (not arbitrary numbers)

### Code Organization
- Clear comments for complex sections
- Consistent naming conventions
- Keep related code together
- Preserve existing formatting patterns

## Common Commands

### Git Workflow
```bash
# Check what changed
git status

# Stage all changes
git add .

# Commit with message
git commit -m "describe your changes"

# Push to GitHub (triggers Vercel deploy)
git push

# Pull latest from GitHub
git pull origin main
```

### Testing Locally
```bash
# Open index.html in browser
open index.html

# Or navigate to file
# /Users/tommyshimko/Documents/sportsguy/index.html
```

### Vercel Deployment
- **Auto-deploys** on every push to `main` branch
- Check deployment status at vercel.com dashboard
- Live in ~30-60 seconds after push

## Working with Claude Code

### Making Changes
1. Describe what you want to change
2. Claude Code will edit the file
3. Review the changes
4. Push to GitHub when ready

### Example Prompts
- "Change the background color to light gray"
- "Add a new sport: Hockey"
- "Make the loading animation faster"
- "Fix the mobile layout on iPhone"
- "Add a new loading message for baseball"

### Pushing Changes
After Claude Code makes edits, just say:
- "Push this to GitHub"
- "Deploy this"
- "Ship it"

Claude Code will handle the git commands for you.

## File Locations

### Local Development
- Project root: `/Users/tommyshimko/Documents/sportsguy/`
- Main file: `/Users/tommyshimko/Documents/sportsguy/index.html`

### GitHub
- Repo: `https://github.com/Tommyshimko/sportsguy`
- Branch: `main`

### Production
- Live URL: `https://sportsguy.xyz`
- Hosted on: Vercel

## Design Notes

### Mobile-First
- Designed for phone screens first
- Touch-friendly tap targets
- Optimized for portrait orientation
- Responsive breakpoints for larger screens

### Performance
- Single HTML file loads instantly
- Minimal external dependencies
- Optimized images in `/icons/`
- CSS animations use `transform` for GPU acceleration

### Accessibility
- Semantic HTML structure
- Readable font sizes
- Sufficient color contrast
- Touch targets meet minimum size

## User Profile
- **You:** Senior staff designer at Google
- **Experience:** Design-focused, new to coding
- **Preferences:** 
  - Clean, elegant solutions
  - Detailed design execution
  - Iterative refinement
  - Figma-driven development

## Recent Updates
- ✅ Smooth loading animation with organic easing
- ✅ Color-preserving text scramble effects
- ✅ Sport modal with Instrument Serif typography
- ✅ Location modal header alignment
- ✅ Logo easter egg with scramble
- ✅ Git workflow setup complete

## Next Steps / Ideas
- [ ] Additional sports (Hockey, MMA, etc.)
- [ ] Save favorite quotes
- [ ] Share quote to social media
- [ ] Dark mode toggle
- [ ] More loading animation variants
- [ ] Custom sport ball icons

---

**Remember:** This project prioritizes polish and elegance over complexity. Every animation, transition, and interaction should feel considered and intentional.
