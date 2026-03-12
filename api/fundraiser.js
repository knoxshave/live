export default async function handler(req, res) {
  // ── CORS headers (always set first) ──────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight – browsers send this before the real GET
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const response = await fetch(
      'https://www.worldsgreatestshave.com/fundraisers/knoxgrammar2026',
      {
        headers: {
          // Realistic browser UA to avoid bot-detection blocks
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-AU,en-GB;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          Referer: 'https://www.worldsgreatestshave.com/',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`WGS page returned ${response.status}`);
    }

    const html = await response.text();

    let raised = null;
    let goal   = null;
    let members = [];
    let donors  = [];

    // ── Strategy 1: __NEXT_DATA__ (Next.js injects this even on SSR) ──
    // This is the most reliable source — it's raw JSON embedded in a <script> tag.
    const nextDataMatch = html.match(
      /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        // Walk the props tree — path varies by WGS site version
        const props =
          nextData?.props?.pageProps?.fundraiser ||
          nextData?.props?.pageProps?.team       ||
          nextData?.props?.pageProps?.data       ||
          null;

        if (props) {
          // Amounts may be in cents (divide by 100) or whole dollars — detect which
          const raw   = props.amountRaised ?? props.raised ?? props.totalRaised ?? null;
          const rawG  = props.targetAmount ?? props.goal   ?? props.target      ?? null;
          if (raw  != null) raised = raw  > 500000 ? raw  / 100 : raw;
          if (rawG != null) goal   = rawG > 500000 ? rawG / 100 : rawG;

          // Extract member list if nested
          const memberList =
            props.participants ?? props.fundraisers ?? props.members ?? [];
          for (const m of memberList.slice(0, 60)) {
            const slug  = m.slug ?? m.fundraiserSlug ?? m.username ?? '';
            const name  = m.name ?? m.displayName ?? m.firstName ?? 'Unknown';
            const amt   = m.amountRaised ?? m.raised ?? 0;
            members.push({ name, slug, raised: amt > 100000 ? amt / 100 : amt });
          }
        }

        // Also check for an array of teams/participants at the top level
        const teamList = nextData?.props?.pageProps?.participants
          ?? nextData?.props?.pageProps?.fundraisers ?? [];
        if (members.length === 0 && teamList.length > 0) {
          for (const m of teamList.slice(0, 60)) {
            const amt = m.amountRaised ?? m.raised ?? 0;
            members.push({
              name:   m.name ?? m.displayName ?? 'Unknown',
              slug:   m.slug ?? m.username ?? '',
              raised: amt > 100000 ? amt / 100 : amt,
            });
          }
        }
      } catch (jsonErr) {
        console.warn('__NEXT_DATA__ parse failed:', jsonErr.message);
      }
    }

    // ── Strategy 2: scan all <script> tags for inline JSON objects ──
    if (raised === null || members.length === 0) {
      const scriptContents = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
      for (const [, content] of scriptContents) {
        if (!content.includes('amountRaised') && !content.includes('raised')) continue;
        // Look for amountRaised values
        const amtMatches = [...content.matchAll(/"amountRaised"\s*:\s*(\d+)/g)];
        if (amtMatches.length > 0 && raised === null) {
          const val = parseInt(amtMatches[0][1]);
          raised = val > 500000 ? val / 100 : val;
        }
        const targetMatch = content.match(/"targetAmount"\s*:\s*(\d+)/);
        if (targetMatch && goal === null) {
          const val = parseInt(targetMatch[1]);
          goal = val > 500000 ? val / 100 : val;
        }
      }
    }

    // ── Strategy 3: HTML regex fallback ──────────────────────────────
    if (raised === null) {
      const m =
        html.match(/Raised[\s\S]{0,200}?\$\s*([\d,]+)/i) ||
        html.match(/\$\s*([\d,]+)\s*raised/i)            ||
        html.match(/raised[^$]{0,30}\$\s*([\d,]+)/i);
      if (m) raised = parseInt(m[1].replace(/,/g, ''), 10);
    }
    if (goal === null) {
      const m =
        html.match(/goal of \$([\d,]+)/i)                     ||
        html.match(/Our Goal[\s\S]{0,200}?\$\s*([\d,]+)/i)    ||
        html.match(/target[^$]{0,30}\$\s*([\d,]+)/i);
      if (m) goal = parseInt(m[1].replace(/,/g, ''), 10);
    }

    if (members.length === 0) {
      const memberRegex =
        /fundraisers\/([^"]+?)\/2026"[\s\S]{0,500}?<h3[^>]*>\s*([\s\S]+?)\s*<\/h3>[\s\S]{0,300}?Raised so far:[\s\S]{0,100}?\$([\d,]+)/gi;
      let match;
      while ((match = memberRegex.exec(html)) !== null && members.length < 50) {
        const slug        = match[1];
        const name        = match[2].replace(/<[^>]+>/g, '').trim();
        const amountRaised = parseInt(match[3].replace(/,/g, ''), 10);
        members.push({ name, slug, raised: amountRaised });
      }
    }

    // Sort by raised descending
    members.sort((a, b) => b.raised - a.raised);

    // ── Donors (regex only — rarely in __NEXT_DATA__) ────────────────
    const donorRegex =
      /\$\s*([\d,]+)\s*<\/h5>[\s\S]{0,100}?<h4[^>]*>\s*([\s\S]+?)\s*<\/h4>/gi;
    let m2;
    while ((m2 = donorRegex.exec(html)) !== null && donors.length < 10) {
      const amount = parseInt(m2[1].replace(/,/g, ''), 10);
      const name   = m2[2].replace(/<[^>]+>/g, '').trim();
      if (name && amount) donors.push({ name, amount });
    }

    const gotData = raised !== null || members.length > 0;

    // ── Only cache if we actually got data — never cache failures ────
    if (gotData) {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    res.status(200).json({
      raised,
      goal,
      members,
      donors,
      memberCount: members.length,
      gotData,              // tells the frontend whether live data was available
      lastUpdated: new Date().toISOString(),
      // Debug info (harmless in prod, helpful for diagnosing future issues)
      _debug: {
        htmlBytes:    html.length,
        hasNextData:  !!nextDataMatch,
        strategy:     raised !== null ? (nextDataMatch ? 'next_data' : 'regex') : 'none',
      },
    });
  } catch (err) {
    console.error(err);
    // Never cache errors — every subsequent request should retry the live scrape
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: err.message });
  }
}
