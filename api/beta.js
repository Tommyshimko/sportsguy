// IS THE BETA ACTUALLY LETTING PEOPLE IN?
//
// An external TestFlight group's public link exists the moment you make it, but nobody can join
// until a build in that group has passed Apple's Beta App Review - and until then the link is a
// dead end that reads "this beta isn't accepting any new testers right now". Sharing a link that
// does that is worse than not sharing at all, and the first person it was sent to hit exactly that.
//
// Apple renders that sentence into the page server-side, so it can simply be read. The rule is
// deliberately one-sided: only a POSITIVE reading of "closed" holds anyone back. Anything else -
// the page loads fine, Apple is slow, the wording changes - forwards to TestFlight, because that is
// what the link is for. The answer is cached at the edge so a burst of shares is one fetch.
const LINK = 'https://testflight.apple.com/join/hDGJhjs2';
const SHUT = /isn&#?3?9?;?t accepting|isn't accepting|not accepting any new testers|no longer accepting/i;

export default async function handler(req, res) {
  let open = true;
  try {
    const page = await fetch(LINK, {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
    });
    if (page.ok) open = !SHUT.test(await page.text());
  } catch {}
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
  res.json({ open, link: LINK });
}
