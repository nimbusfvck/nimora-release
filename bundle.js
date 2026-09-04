// Football fixtures catalog, as a JS extension.
//
// Sourced from FotMob's daily match feed for schedule and live status. Stream
// providers only resolve a selected event and never create catalog metadata.
//
// The host provides: `fetch(url, options)` -> Promise<{status, headers, url,
// body}>. Nothing else — no fs, no process, no ambient network.
//
// This is the file that loads first in the bundle (see build_bundle.dart):
// it declares `EXTENSION_ID` and installs the base `globalThis.__extension`
// object every other file adds to.

// Overridable purely so a test can point this at a loopback fixture server;
// production otherwise. Not a general configuration mechanism — extensions
// have none yet, and this is not one.
const FOTMOB_BASE = globalThis.__fotmobBaseUrl || 'https://www.fotmob.com';
// Keep the match feed localized for Indonesian users, but use the US league
// market for FotMob's popular list so Indonesian domestic competitions are not
// promoted into the Football catalog just because the app is localized to ID.
const FOTMOB_CCODE3 = 'IDN';
const FOTMOB_LEAGUE_COUNTRY = 'USA';
const FOTMOB_IMAGE_BASE = 'https://images.fotmob.com/image_resources/logo/teamlogo';
const BY433_LEAGUE_IMAGE_BASE =
  'https://media.prod.by433.com/media/logos/league';
const FOTMOB_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const TIME_ZONE = 'Asia/Jakarta';

const EXTENSION_ID = 'nimora';
const PROVIDER_ID = 'nimora.matches';

// The one catalog this extension declares, and the categories inside it.
// `live` is based on FotMob's match status; `sport` is the daily match
// schedule. `all` includes the live football items alongside the other live
// sports catalog entries.
const CATALOG_ID = 'fixtures';
const LIVE_CATEGORY = 'live';
const ALL_CATEGORY = 'all';

// Unfinished fixtures remain relevant while live and up to a week before
// kickoff. Finished fixtures are removed at catalog takeout below.
const UPCOMING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIXTURES_TTL_MS = 15 * 60 * 1000;
const LEAGUE_BRANDING_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

// Editorial ranking for globally recognisable clubs. FotMob ids are the
// primary key; aliases cover alternate names returned by football feeds. This
// belongs to the extension because the shell must not know what
// counts as a top football club.
const TOP_CLUBS = [
  { id: '8634', aliases: ['barcelona', 'fc barcelona', 'barca', 'barça'] },
  { id: '8650', aliases: ['liverpool', 'liverpool fc'] },
  { id: '8633', aliases: ['real madrid', 'real madrid cf'] },
  { id: '8456', aliases: ['manchester city', 'man city'] },
  { id: '9825', aliases: ['arsenal', 'arsenal fc'] },
  { id: '10260', aliases: ['manchester united', 'man united', 'man utd'] },
  { id: '9823', aliases: ['bayern munich', 'bayern munchen', 'fc bayern'] },
  {
    id: '9847',
    aliases: ['paris saint-germain', 'paris saint germain', 'psg'],
  },
  { id: '8636', aliases: ['inter milan', 'internazionale', 'inter'] },
  { id: '9885', aliases: ['juventus', 'juve'] },
];

const TOP_CLUB_BY_ID = new Map(
  TOP_CLUBS.map((club, index) => [club.id, index]),
);
const TOP_CLUB_BY_NAME = new Map(
  TOP_CLUBS.flatMap((club, index) =>
    club.aliases.map((alias) => [alias, index]),
  ),
);

// How long a match is assumed to still be in play after kickoff when the
// upstream status has no explicit ongoing flag.
const ASSUMED_MATCH_DURATION_MS = 130 * 60 * 1000;

// --- fetch ---

function fotmobDateKey(nowMs, dayOffset) {
  const shifted = new Date(nowMs + JAKARTA_OFFSET_MS + dayOffset * DAY_MS);
  return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, '0')}${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

async function fetchFotmobMatchesForDate(dateKey) {
  const url =
    `${FOTMOB_BASE}/api/data/matches?date=${dateKey}` +
    `&timezone=${encodeURIComponent(TIME_ZONE)}` +
    `&ccode3=${encodeURIComponent(FOTMOB_CCODE3)}` +
    '&includeNextDayLateNight=true';
  const response = await fetch(url, {
    headers: {
      'User-Agent': FOTMOB_USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      Referer: `${FOTMOB_BASE}/?show=ongoing`,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Request to matches failed: ${response.status}`);
  }
  const data = JSON.parse(response.body);
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray(data.leagues)
  ) {
    throw new Error('matches response has no leagues');
  }
  return data;
}

async function fetchFotmobPopularLeagues() {
  const url =
    `${FOTMOB_BASE}/api/data/allLeagues?locale=en` +
    `&country=${encodeURIComponent(FOTMOB_LEAGUE_COUNTRY)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': FOTMOB_USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      Referer: `${FOTMOB_BASE}/`,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Request to league list failed: ${response.status}`);
  }
  const data = JSON.parse(response.body);
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray(data.popular)
  ) {
    throw new Error('league list response has no popular leagues');
  }
  return flattenFotmobLeagueList(data);
}

function flattenFotmobLeagueList(data) {
  const popular = Array.isArray(data?.popular) ? data.popular : [];
  const international = Array.isArray(data?.international)
    ? data.international.flatMap((group) =>
      Array.isArray(group?.leagues) ? group.leagues : [],
    )
    : [];
  return [...popular, ...international];
}

function validFotmobColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : null;
}

function leagueIdKey(value) {
  if (value == null) return null;
  const key = String(value).trim();
  return /^\d+$/.test(key) ? key : null;
}

function fetchFotmobLeagueBranding(leagueId) {
  const key = leagueIdKey(leagueId);
  if (key == null) return Promise.resolve(null);

  const nowMs = Date.now();
  const cached = leagueBrandingMemo.get(key);
  if (cached != null && nowMs - cached.fetchedAt < LEAGUE_BRANDING_TTL_MS) {
    return cached.promise;
  }

  const logo = { url: leagueLogoUrl(key) };
  const promise = fetch(
    `${FOTMOB_BASE}/api/data/leagues?id=${encodeURIComponent(key)}`,
    {
      headers: {
        'User-Agent': FOTMOB_USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        Referer: `${FOTMOB_BASE}/leagues/${key}`,
      },
    },
  )
    .then((response) => {
      if (response.status < 200 || response.status >= 300) return { logo };
      const data = JSON.parse(response.body);
      const color = validFotmobColor(data?.details?.leagueColor);
      return color == null ? { logo } : { logo, primaryColor: color };
    })
    .catch(() => ({ logo }));

  leagueBrandingMemo.set(key, { promise, fetchedAt: nowMs });
  return promise;
}

async function leagueBrandingFor(matches) {
  const keys = [
    ...new Set(
      matches
        .map((match) => leagueIdKey(match.leagueId))
        .filter((key) => key != null),
    ),
  ];
  const entries = await Promise.all(
    keys.map(async (key) => [key, await fetchFotmobLeagueBranding(key)]),
  );
  return new Map(entries.filter((entry) => entry[1] != null));
}

// The daily match feed is fetched for today plus the next seven Jakarta dates.
// Deduplication below handles the endpoint's next-day late-night overlap.
let fixturesMemo = null;
let popularLeaguesMemo = null;
const leagueBrandingMemo = new Map();

function fetchFixturesMemo(nowMs) {
  if (
    fixturesMemo === null ||
    nowMs - fixturesMemo.fetchedAt >= FIXTURES_TTL_MS
  ) {
    const promise = fetchFotmobMatches(nowMs).catch((e) => {
      fixturesMemo = null;
      throw e;
    });
    fixturesMemo = { promise, fetchedAt: nowMs };
  }
  return fixturesMemo.promise;
}

function fetchPopularLeaguesMemo() {
  if (popularLeaguesMemo === null) {
    popularLeaguesMemo = fetchFotmobPopularLeagues().catch((e) => {
      popularLeaguesMemo = null;
      throw e;
    });
  }
  return popularLeaguesMemo;
}

async function fetchFotmobMatches(nowMs) {
  const payloads = await Promise.all(
    Array.from({ length: 8 }, (_, offset) =>
      fetchFotmobMatchesForDate(fotmobDateKey(nowMs, offset)),
    ),
  );
  const matchesById = new Map();
  for (const payload of payloads) {
    for (const match of flattenFotmobMatches(payload)) {
      const key = match.id == null
        ? `${match.leagueId}:${match.utcTime}:${match.home?.name}:${match.away?.name}`
        : String(match.id);
      if (!matchesById.has(key)) matchesById.set(key, match);
    }
  }
  return [...matchesById.values()];
}

// The daily response is `{ leagues: [{ id, name, matches: [...] }] }`.
// Match status and kickoff are already provided by FotMob, so no second live
// feed or team-name reconciliation is needed.
function flattenFotmobMatches(data) {
  const matches = [];
  for (const league of data.leagues) {
    const leagueMatches = Array.isArray(league.matches) ? league.matches : [];
    for (const match of leagueMatches) {
      const status = match.status || {};
      matches.push({
        ...match,
        leagueName: match.leagueName || league.name,
        leagueId: match.leagueId != null ? match.leagueId : league.id,
        utcTime: match.utcTime || status.utcTime,
        isLive: status.ongoing === true,
        isFinished: status.finished === true,
      });
    }
  }
  return matches;
}

// Filter the complete daily match feed by FotMob's popular and international
// league lists. This filters visibility only; all match metadata still comes
// from `/api/data/matches`.
function filterPopularMatches(matches, popularLeagues) {
  const allowedIds = new Set(
    popularLeagues
      .filter((league) => league != null && league.id != null)
      .map((league) => String(league.id)),
  );
  return matches.filter(
    (match) => match.leagueId != null && allowedIds.has(String(match.leagueId)),
  );
}

function isWomenMatch(match) {
  const womenSuffix = /\s\(W\)$/i;
  const womenLeague = /\b(women|woman|female|ladies|girls)\b/i;
  const homeName = match.home && (match.home.longName || match.home.name);
  const awayName = match.away && (match.away.longName || match.away.name);
  return womenLeague.test(`${match.leagueName || ''}`) ||
    womenSuffix.test(`${homeName || ''}`) ||
    womenSuffix.test(`${awayName || ''}`);
}

function isFinishedMatch(match) {
  return match.isFinished === true || match.status?.finished === true;
}

// FotMob abbreviates some club names in its daily response. Keep verified
// aliases for the editorial top-club ranking.
const CLUB_NAME_ALIASES = {
  'nottm forest': 'nottingham forest',
  'man utd': 'manchester united',
  'man united': 'manchester united',
  'man city': 'manchester city',
  spurs: 'tottenham hotspur',
  wolves: 'wolverhampton wanderers',
  'west brom': 'west bromwich albion',
  'west bromwich': 'west bromwich albion',
};

function normalizedClubName(team) {
  const normalized = `${team && (team.longName || team.name) || ''}`
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
  return CLUB_NAME_ALIASES[normalized] || normalized;
}

function topClubRank(team) {
  if (team == null) return null;
  if (team.id != null) {
    const rankById = TOP_CLUB_BY_ID.get(String(team.id));
    if (rankById != null) return rankById;
  }
  const rankByName = TOP_CLUB_BY_NAME.get(normalizedClubName(team));
  return rankByName == null ? null : rankByName;
}

function topClubMatchRank(match) {
  const ranks = [topClubRank(match.home), topClubRank(match.away)]
    .filter((rank) => rank != null);
  if (ranks.length === 0) return null;
  return {
    clubs: ranks.length,
    rank: Math.min(...ranks),
  };
}

// Maps the editorial club rank onto the generic protocol rating consumed by
// the app's Featured Hero. A fixture involving both configured clubs gets a
// small bonus, while the ordered list still makes Barcelona rank above
// Liverpool and the remaining clubs.
function topClubEditorialRating(match) {
  const priority = topClubMatchRank(match);
  if (priority == null) return null;
  const clubScore = TOP_CLUBS.length - priority.rank;
  const fixtureBonus = priority.clubs > 1 ? 0.5 : 0;
  return clubScore + fixtureBonus;
}

// Keep FotMob's response order as the default. A fixture involving two
// configured top clubs comes first, followed by fixtures involving one; ties
// retain their original response order. This gives the app a useful editorial
// lead without replacing the upstream schedule with a hardcoded league order.
function prioritizeTopClubMatches(matches) {
  return matches
    .map((match, index) => ({
      match,
      index,
      priority: topClubMatchRank(match),
    }))
    .sort((a, b) => {
      if (a.priority == null && b.priority == null) return a.index - b.index;
      if (a.priority == null) return 1;
      if (b.priority == null) return -1;
      if (a.priority.clubs !== b.priority.clubs) {
        return b.priority.clubs - a.priority.clubs;
      }
      if (a.priority.rank !== b.priority.rank) {
        return a.priority.rank - b.priority.rank;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.match);
}

// --- status / relevance ---

function kickoffMs(match) {
  if (match.utcTime == null) return null;
  const parsed = new Date(match.utcTime);
  return isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function isMatchLive(match, nowMs) {
  if (match.isLive === true) return true;
  if (match.isFinished === true || match.status?.finished === true) return false;
  if (match.status?.cancelled === true) return false;
  const start = kickoffMs(match);
  if (start == null) return false;
  return nowMs >= start && nowMs <= start + ASSUMED_MATCH_DURATION_MS;
}

function isRelevantMatch(match, nowMs) {
  if (isMatchLive(match, nowMs)) return true;
  const start = kickoffMs(match);
  // No kickoff to judge by — keep it rather than discard data this can't
  // evaluate.
  if (start == null) return true;
  const untilStart = start - nowMs;
  return untilStart <= UPCOMING_WINDOW_MS && untilStart >= -RECENT_WINDOW_MS;
}

// --- mapping ---

function fotmobRefId(matchId) {
  return `fotmob:${matchId}`;
}

function footballRefId(match) {
  return fotmobRefId(match.id);
}

function teamLogoUrl(teamId) {
  return `${FOTMOB_IMAGE_BASE}/${teamId}_large.png`;
}

function leagueLogoUrl(leagueId) {
  if (leagueId == null) return null;
  const key = String(leagueId).trim();
  if (!/^\d+$/.test(key)) return null;
  return `${BY433_LEAGUE_IMAGE_BASE}/${key}.png`;
}

function fotmobParticipantsOf(match) {
  const home = match.home;
  const away = match.away;
  if (home == null || away == null || home.name == null || away.name == null) {
    return [];
  }
  const side = (team) => {
    const p = { name: team.name };
    if (team.id != null) p.logo = { url: teamLogoUrl(team.id) };
    return p;
  };
  return [side(home), side(away)];
}

function toMediaItem(match, nowMs, brandingByLeague) {
  const home = match.home || {};
  const away = match.away || {};
  if (match.utcTime == null || kickoffMs(match) == null) return null;
  const item = {
    ref: {
      extensionId: EXTENSION_ID,
      providerId: PROVIDER_ID,
      id: footballRefId(match),
    },
    kind: 'event',
    title: `${home.name == null ? 'Unknown' : home.name} vs ${
      away.name == null ? 'Unknown' : away.name
    }`,
    schedule: {
      startsAt: new Date(kickoffMs(match)).toISOString(),
      state: isMatchLive(match, nowMs) ? 'live' : 'scheduled',
    },
  };

  const topClubRating = topClubEditorialRating(match);
  if (topClubRating != null) item.rating = topClubRating;

  if (match.leagueName != null) item.subtitle = match.leagueName;
  const participants = fotmobParticipantsOf(match);
  if (participants.length > 0) item.participants = participants;
  const branding = brandingByLeague?.get(leagueIdKey(match.leagueId));
  if (branding != null) item.branding = branding;

  return item;
}

// Indonesia observes no daylight saving, so a fixed UTC+7 offset gives the
// exact Asia/Jakarta calendar day with no Intl/timezone database needed in
// this engine.
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function jakartaDayIndex(ms) {
  return Math.floor((ms + JAKARTA_OFFSET_MS) / DAY_MS);
}

function jakartaDateLabel(ms) {
  const shifted = new Date(ms + JAKARTA_OFFSET_MS);
  return `${WEEKDAY_NAMES[shifted.getUTCDay()]}, ${shifted.getUTCDate()} ` +
    MONTH_NAMES[shifted.getUTCMonth()];
}

// Chronological order, editorial ranking (prioritizeTopClubMatches) and
// league order set aside: a viewer expects the same "what's on soonest"
// order everywhere football is shown, not just inside the dedicated Football
// subcategory page. Drops entries with no usable kickoff, same as byDate.
function sortedByKickoff(matches) {
  return matches
    .map((match) => ({ match, kickoff: kickoffMs(match) }))
    .filter((entry) => entry.kickoff != null)
    .sort((a, b) => a.kickoff - b.kickoff);
}

// Groups by kickoff day rather than league: league order says nothing about
// when a fixture kicks off, so a distant match from a league that happens to
// come first in the feed could otherwise show ahead of one kicking off soon.
function byDate(matches, nowMs, brandingByLeague) {
  const todayIndex = jakartaDayIndex(nowMs);
  const buckets = new Map();
  for (const entry of sortedByKickoff(matches)) {
    const dayIndex = jakartaDayIndex(entry.kickoff);
    let bucket = buckets.get(dayIndex);
    if (bucket == null) {
      bucket = [];
      buckets.set(dayIndex, bucket);
    }
    bucket.push(entry);
  }

  const sections = [];
  for (const dayIndex of [...buckets.keys()].sort((a, b) => a - b)) {
    // sortedByKickoff already put these in kickoff order; the Map bucket
    // preserves that insertion order, so no second sort is needed here.
    const entries = buckets.get(dayIndex);
    const items = entries
      .map((entry) => toMediaItem(entry.match, nowMs, brandingByLeague))
      .filter((item) => item != null);
    if (items.length === 0) continue;
    const offset = dayIndex - todayIndex;
    const title =
      offset === 0 ? 'Today'
      : offset === 1 ? 'Tomorrow'
      : offset === -1 ? 'Yesterday'
      : jakartaDateLabel(entries[0].kickoff);
    sections.push({ id: `date:${dayIndex}`, title, items });
  }
  return sections;
}

// --- catalog navigation ---

const FOOTBALL = { id: 'football', name: 'Football' };

function sportIdOf(name) {
  return `${name}`.trim().toLowerCase().replace(/\s+/g, '-');
}

function isFootballCategory(category) {
  const name = `${category || ''}`.toLowerCase();
  return name.includes('football') || name.includes('soccer');
}

function isExcludedSportCategory(category) {
  const name = `${category || ''}`.toLowerCase();
  return (
    name.includes('cricket') ||
    name.includes('baseball') ||
    name.includes('rugby') ||
    name === 'mlb' ||
    name === 'nfl' ||
    name.includes('american football')
  );
}

function cricfyArtworkUrl(value) {
  const url = `${value || ''}`.trim();
  return /^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(url) ? url : null;
}

function cricfyEventItem(event, status) {
  let title = `${event.eventName || ''}`.trim();
  const teamA = `${event.teamAName || ''}`.trim();
  const teamB = `${event.teamBName || ''}`.trim();
  const versus = teamA.length > 0 && teamB.length > 0 && teamA !== teamB;
  if (versus) title = `${teamA} vs ${teamB}`;
  if (title.length === 0 || event.linksPath.length === 0) return null;

  const startsAt = cricfyParseEventDateTime(event.date, event.time);
  if (startsAt === null) return null;
  const eventLogo = cricfyArtworkUrl(event.eventLogo);
  const teamALogo = cricfyArtworkUrl(event.teamALogo);
  const teamBLogo = cricfyArtworkUrl(event.teamBLogo);
  const item = {
    ref: {
      extensionId: EXTENSION_ID,
      providerId: PROVIDER_ID,
      id: `cricfy:${event.linksPath}`,
    },
    kind: 'event',
    title,
    subtitle: event.category || 'Other',
    schedule: {
      startsAt: startsAt.toISOString(),
      state: status === 'live' ? 'live' : 'scheduled',
    },
  };
  if (eventLogo !== null) {
    item.artwork = { landscape: { url: eventLogo } };
  }
  if (versus) {
    item.participants = [
      {
        name: teamA,
        ...(teamALogo !== null ? { logo: { url: teamALogo } } : {}),
      },
      {
        name: teamB,
        ...(teamBLogo !== null ? { logo: { url: teamBLogo } } : {}),
      },
    ];
  }
  return item;
}

async function getCricfySportEntries(nowMs) {
  if (typeof cricfyFetchEventsMemo !== 'function') return [];
  try {
    const events = await cricfyFetchEventsMemo(nowMs);
    const entries = [];
    for (const event of events) {
      if (!event.visible) continue;
      if (isFootballCategory(event.category)) continue;
      if (isExcludedSportCategory(event.category)) continue;

      const status = cricfyEventStatusAt(event, nowMs);
      if (status === 'ended') continue;
      const startsAt = cricfyParseEventDateTime(event.date, event.time);
      if (
        status !== 'live' &&
        startsAt !== null &&
        startsAt.getTime() - nowMs > UPCOMING_WINDOW_MS
      ) continue;

      const item = cricfyEventItem(event, status);
      if (item === null) continue;
      const sportName = event.category || 'Other';
      entries.push({
        sportId: sportIdOf(sportName),
        sportName,
        live: status === 'live',
        item,
      });
    }
    return entries;
  } catch (_) {
    return [];
  }
}

function sportsOf(matches, cricfyEntries) {
  const sports = [];
  if (matches.length > 0) sports.push(FOOTBALL);
  const seen = new Set();
  for (const entry of cricfyEntries) {
    if (seen.has(entry.sportId)) continue;
    seen.add(entry.sportId);
    sports.push({ id: entry.sportId, name: entry.sportName });
  }
  return sports;
}

function buildPage(query, matches, cricfyEntries, nowMs, brandingByLeague) {
  const selected = query.subCategory == null ? null : query.subCategory;
  const subCategories = sportsOf(matches, cricfyEntries);

  if (selected === FOOTBALL.id) {
    return {
      sections: byDate(matches, nowMs, brandingByLeague),
      subCategories,
    };
  }

  if (selected != null) {
    const entries = cricfyEntries.filter((entry) => entry.sportId === selected);
    return {
      sections: entries.length === 0
        ? []
        : [{ id: `sport:${selected}`, title: entries[0].sportName, items: entries.map((e) => e.item) }],
      subCategories,
    };
  }

  if (query.category === ALL_CATEGORY) {
    const liveFootballMatches = sortedByKickoff(
      matches.filter((match) => isMatchLive(match, nowMs)),
    ).map((entry) => entry.match);
    const footballItems = liveFootballMatches
      .map((match) => toMediaItem(match, nowMs, brandingByLeague))
      .filter((item) => item != null);

    const items = [
      ...footballItems,
      ...cricfyEntries.filter((entry) => entry.live).map((entry) => entry.item),
    ];
    return {
      sections: items.length === 0
        ? []
        : [{ id: 'live', title: 'Live', items }],
      subCategories,
    };
  }

  const sections = [];
  const footballItems = sortedByKickoff(matches)
    .map((entry) => toMediaItem(entry.match, nowMs, brandingByLeague))
    .filter((item) => item != null);
  if (footballItems.length > 0) {
    sections.push({ id: `sport:${FOOTBALL.id}`, title: FOOTBALL.name, items: footballItems });
  }
  for (const sport of subCategories) {
    if (sport.id === FOOTBALL.id) continue;
    const items = cricfyEntries
      .filter((entry) => entry.sportId === sport.id)
      .map((entry) => entry.item);
    if (items.length > 0) {
      sections.push({ id: `sport:${sport.id}`, title: sport.name, items });
    }
  }
  return { sections, subCategories };
}

// --- the extension surface the host calls ---

async function fixturesCatalog(query) {
  const live = query.category === LIVE_CATEGORY;
  // One instant for the whole call, so a match right at the window boundary
  // and the other catalog entries are judged against the same "now".
  const nowMs = Date.now();

  let [matches, popularLeagues] = await Promise.all([
    fetchFixturesMemo(nowMs),
    fetchPopularLeaguesMemo(),
  ]);
  matches = matches
    .filter(
      (match) =>
        !isFinishedMatch(match) &&
        !isWomenMatch(match) &&
        isRelevantMatch(match, nowMs),
    );
  matches = filterPopularMatches(matches, popularLeagues);
  matches = prioritizeTopClubMatches(matches);
  if (live) {
    matches = matches.filter((match) => isMatchLive(match, nowMs));
  }

  const brandingByLeague = await leagueBrandingFor(matches);

  let cricfyEntries = await getCricfySportEntries(nowMs);
  if (live) {
    cricfyEntries = cricfyEntries.filter((entry) => entry.live);
  }

  return buildPage(query, matches, cricfyEntries, nowMs, brandingByLeague);
}

// Registers into `__catalogProviders` rather than assigning
// `__extension.catalog` outright, so catalog files can load in either order
// without clobbering each other. This matches the stream provider registry.
globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: CATALOG_ID,
  catalog: fixturesCatalog,
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.catalog) {
  globalThis.__extension.catalog = async (query) => {
    const provider = globalThis.__catalogProviders.find(
      (p) => p.catalogId === query.catalogId,
    );
    if (!provider) {
      throw new Error(`No catalog provider registered for "${query.catalogId}"`);
    }
    return provider.catalog(query);
  };
}

// Shared helpers for source labels.
//
// Providers pass their original upstream label to sourceAliasWithQuality.
// This file only normalizes real quality tokens; it does not invent aliases.

function sourceAlias(sourceId, serverKey) {
  return String(serverKey ?? sourceId ?? '').trim();
}

function sourceAliasWithQuality(sourceId, serverKey, realName) {
  const label = String(realName ?? '').trim() || sourceAlias(sourceId, serverKey);
  const quality = sourceQuality(realName);
  return quality && !label.toLowerCase().includes(quality.toLowerCase())
    ? `${label} (${quality})`
    : label;
}

function sourceQuality(value) {
  const match = /(?:^|[^0-9])((?:2160|1440|1080|720|576|480|360|240)\s*p?|(?:4|2)k)(?=$|[^a-z0-9])/i.exec(
    String(value ?? ''),
  );
  if (match == null) return '';
  const normalized = match[1].replace(/\s+/g, '').toLowerCase();
  const numeric = /^(2160|1440|1080|720|576|480|360|240)p?$/.exec(normalized);
  return numeric == null ? normalized.toUpperCase() : `${numeric[1]}p`;
}

// VaPlayer as a stream provider, over the host `fetch` API.
//
// Ported from CineStream's `invokeVaPlayer` (CineStreamExtractors.kt). The
// one upstream in this family that hands back playable URLs in the clear:
// `api.php` answers with `data.stream_urls`, a plain list of HLS playlists,
// plus a large `default_subs` list. No cipher, no key exchange, nothing to
// decrypt.
//
// That is worth stating because its sibling is not. `data.vidsrcme.ru` serves
// the same `api.php` shape, but its `stream_urls` is a single encrypted blob
// with a `vs.wasm_url` beside it — a per-response WebAssembly module that
// decrypts it, whose id rotates on every request. This sandbox has no
// `WebAssembly` at all, so that host cannot be integrated without widening
// the runtime; this one needs nothing new.
//
// Keyed by tmdbId, which the `movie:<tmdbId>` / `series:<tmdbId>` references
// already carry, so no id translation is needed
// (the upstream accepts `imdb=` too — verified — but nothing here has an
// IMDB id to give it).
//
// Both movies and series. A series item must carry `extra.season` and
// `extra.episode`; without them there is no episode to ask for, and the call
// is declined with an empty list rather than guessed at.

const VAPLAYER_BASE =
  globalThis.__vaplayerBaseUrl || 'https://streamdata.vaplayer.ru';

const VAPLAYER_PROVIDER_KEY = 'vaplayer';

// The upstream serves these only to its own embed host.
const VAPLAYER_REFERER = 'https://nextgencloudfabric.com/';
const VAPLAYER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function vaplayerHeaders() {
  return {
    Accept: '*/*',
    Referer: VAPLAYER_REFERER,
    'User-Agent': VAPLAYER_UA,
  };
}

// Reads `movie:<tmdbId>` / `series:<tmdbId>` references.
function parseVaplayerRef(refId) {
  if (typeof refId !== 'string') return null;
  const episode = /^series:([^:]+):season:([^:]+):episode:([^:]+)$/.exec(refId);
  if (episode != null) {
    return {
      kind: 'series',
      tmdbId: episode[1],
      season: episode[2],
      episode: episode[3],
    };
  }
  const separator = refId.indexOf(':');
  if (separator < 0) return null;
  const kind = refId.slice(0, separator);
  const tmdbId = refId.slice(separator + 1);
  if ((kind !== 'movie' && kind !== 'series') || tmdbId.length === 0) {
    return null;
  }
  return { kind, tmdbId, season: null, episode: null };
}

function vaplayerApiUrl(tmdbId, kind, season, episode) {
  const base = `${VAPLAYER_BASE}/api.php?tmdb=${encodeURIComponent(tmdbId)}`;
  if (kind === 'movie') return `${base}&type=movie`;
  return (
    `${base}&type=tv&season=${encodeURIComponent(season)}` +
    `&episode=${encodeURIComponent(episode)}`
  );
}

async function fetchVaplayer(url) {
  let response;
  try {
    response = await fetch(url, { headers: vaplayerHeaders() });
  } catch (_) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;
  try {
    return JSON.parse(response.body);
  } catch (_) {
    return null;
  }
}

function vaplayerStreamUrls(payload) {
  const urls = payload && payload.data && payload.data.stream_urls;
  if (!Array.isArray(urls)) return [];
  return urls.filter((u) => typeof u === 'string' && u.length > 0);
}

// `default_subs` entries are `{lang, code, url}`. `lang` is the human label
// ("Portuguese - Brazilian"); `code` is the two-letter tag the app groups by.
function vaplayerSubtitles(payload) {
  const subs = payload && payload.default_subs;
  if (!Array.isArray(subs)) return [];
  return subs
    .filter((s) => s && typeof s.url === 'string' && s.url.length > 0)
    .map((s) => ({
      language: s.code || s.lang || '',
      url: s.url,
      label: s.lang || s.code || '',
    }));
}

// Source ids carry everything resolve() needs to ask again, plus which of the
// returned URLs this source stands for. The URL itself is deliberately *not*
// baked in: resolve() has to re-fetch anyway to get the subtitles, which are
// far too many to carry in an id.
function encodeVaplayerSourceId(payload) {
  const json = JSON.stringify({
    m: payload.tmdbId,
    k: payload.kind,
    i: payload.index,
    ...(payload.season != null
      ? { s: payload.season, e: payload.episode }
      : {}),
  });
  return base64ToBase64Url(host.codec.textToBase64(json));
}

function decodeVaplayerSourceId(encoded) {
  const json = host.codec.base64ToText(base64UrlToBase64(encoded));
  return JSON.parse(json);
}

// sources() — one entry per stream URL the upstream offers.
//
// This does fetch, unlike videasy.js's server list: how many URLs there are
// is only known from the response, and offering a fixed number would mean
// either inventing sources that don't resolve or hiding ones that do.
async function vaplayerListSources(args) {
  const item = args.item || {};
  const refId = (item.ref && item.ref.id) || item.id || '';
  const parsed = parseVaplayerRef(refId);
  if (!parsed) return { sources: [] };

  const isSeries = parsed.kind === 'series';
  if (isSeries && (parsed.season == null || parsed.episode == null)) {
    return { sources: [] };
  }

  const payload = await fetchVaplayer(
    vaplayerApiUrl(parsed.tmdbId, parsed.kind, parsed.season, parsed.episode),
  );
  const urls = vaplayerStreamUrls(payload);

  return {
    sources: urls.map((_, index) => {
      const id = `${VAPLAYER_PROVIDER_KEY}:${encodeVaplayerSourceId({
        tmdbId: parsed.tmdbId,
        kind: parsed.kind,
        index,
        season: isSeries ? parsed.season : null,
        episode: isSeries ? parsed.episode : null,
      })}`;
      // The upstream distinguishes them in no way at all — they are
      // The upstream gives these playlists no distinct names.
      return {
        id,
        label: `VaPlayer ${index + 1}`,
        provider: 'Nimora',
        providerId: 'nimora.vaplayer',
      };
    }),
  };
}

async function vaplayerResolveSource(sourceId) {
  const prefix = `${VAPLAYER_PROVIDER_KEY}:`;
  if (!sourceId.startsWith(prefix)) {
    throw new Error(`Invalid VaPlayer sourceId: ${sourceId}`);
  }
  const payloadId = decodeVaplayerSourceId(sourceId.slice(prefix.length));
  const { m: tmdbId, k: kind, i: index, s: season, e: episode } = payloadId;

  const payload = await fetchVaplayer(
    vaplayerApiUrl(tmdbId, kind, season, episode),
  );
  if (!payload) throw new Error('VaPlayer: failed to fetch sources');

  const urls = vaplayerStreamUrls(payload);
  // Re-fetched, so the list can be shorter than when the id was minted.
  if (index >= urls.length) {
    throw new Error('VaPlayer: stream no longer offered');
  }

  return {
    url: urls[index],
    format: 'hls',
    headers: {
      Referer: VAPLAYER_REFERER,
      'User-Agent': VAPLAYER_UA,
    },
    subtitles: vaplayerSubtitles(payload),
  };
}

// ---- registration — see kora.js's tail for the shared aggregator ----

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: VAPLAYER_PROVIDER_KEY,
  sources: vaplayerListSources,
  resolve: (sourceId) => vaplayerResolveSource(sourceId),
});

// Vidrock as a stream provider, in JS on the host `fetch`/`codec`/`crypto` API.
//
// A port of CineStream's `invokeVidrock` (CineStreamExtractors.kt) and
// `decryptVidrockUrl` (CineStreamUtils.kt) — CineStream
// (github.com/SaurabhKaperwan/CineStream) is a CloudStream-style Kotlin
// aggregator with ~60 upstream integrations, most of them HTML-scrape-heavy
// in a way this sandbox has no primitive for yet (no `host.html`, per
// PLAN.md §18). Vidrock is the one ported here: one JSON GET, one field to
// decrypt per server — the same shape kora.js/cricfy.js already handle, and
// the only new capability it needs is `host.crypto.aesGcmDecrypt`, added
// alongside this file.
//
// Movies only. Vidrock's TV endpoint is keyed by tmdbId+season+episode, and
// nothing in the app yet lets a user choose either — PLAN.md flags
// "children (series)" as an acknowledged, not-yet-built capability — so a
// series item's `sources()` call is declined with an empty list, exactly how
// kora.js declines an item without two participants.
//
// Matches TMDB-backed items through their `movie:<tmdbId>` reference.
//
// Vidrock only returns subtitles that belong to its resolved stream. Shegu is
// a separate external-subtitles provider and is intentionally not consulted
// from this resolver.

const VIDROCK_BASE = globalThis.__vidrockBaseUrl || 'https://vidrock.ru';

// Static across the whole upstream (verified against the live API, not just
// the Kotlin source): AES-256-GCM, no AAD, 12-byte nonce prepended to the
// ciphertext+tag, the base64url-of-hex-key form CineStream hardcodes.
const VIDROCK_KEY_HEX =
  '7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f';
const VIDROCK_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const VIDROCK_PROVIDER_KEY = 'vidrock';
const VIDROCK_PROVIDER_ID = 'nimora.vidrock';

function vidrockHeaders() {
  return {
    Origin: VIDROCK_BASE,
    Referer: `${VIDROCK_BASE}/`,
    'User-Agent': VIDROCK_UA,
  };
}

// Reads a `movie:<tmdbId>` reference.
function parseTmdbMovieRef(refId) {
  if (typeof refId !== 'string') return null;
  const prefix = 'movie:';
  if (!refId.startsWith(prefix)) return null;
  const tmdbId = refId.slice(prefix.length);
  return tmdbId.length > 0 ? tmdbId : null;
}

// Reads a `series:<tmdbId>` reference.
function parseTmdbSeriesRef(refId) {
  if (typeof refId !== 'string') return null;
  const prefix = 'series:';
  if (!refId.startsWith(prefix)) return null;
  const tmdbId = refId.slice(prefix.length);
  return tmdbId.length > 0 ? tmdbId : null;
}

function parseVidrockEpisodeRef(refId) {
  if (typeof refId !== 'string') return null;
  const match = /^series:([^:]+):season:([^:]+):episode:([^:]+)$/.exec(refId);
  return match == null
    ? null
    : { tmdbId: match[1], season: match[2], episode: match[3] };
}

// ---- base64url (same pair kora.js defines; kept local — see this
// extension's no-shared-helpers convention, one file per provider) ----

function base64UrlToBase64(token) {
  let normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder !== 0) normalized += '='.repeat(4 - remainder);
  return normalized;
}

function base64ToBase64Url(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_');
}

// ---- source id ----
//
// Bakes the still-encrypted url straight in, so `resolve()` needs no second
// fetch for the stream itself — same shape as kora.js's `encodeKoraSourceId`.
// The tmdbId rides along because the upstream API response and source label
// are TMDB-keyed; `resolve(sourceId)` receives only this opaque id.

function encodeVidrockSourceId(payload) {
  const json = JSON.stringify({
    u: payload.encryptedUrl,
    type: payload.type,
    m: payload.tmdbId,
    // season/episode are present only for TV; omit for movies.
    ...(payload.season != null ? { s: payload.season, e: payload.episode } : {}),
  });
  return base64ToBase64Url(host.codec.textToBase64(json));
}

function decodeVidrockSourceId(encoded) {
  const json = host.codec.base64ToText(base64UrlToBase64(encoded));
  return JSON.parse(json);
}

// ---- decrypt (port of decryptVidrockUrl) ----

function decryptVidrockUrl(encryptedPayload) {
  const dataHex = host.codec.base64ToHex(base64UrlToBase64(encryptedPayload));
  const nonceHex = dataHex.slice(0, 24); // 12 bytes
  const cipherHex = dataHex.slice(24); // ciphertext + 16-byte tag
  if (nonceHex.length !== 24 || cipherHex.length === 0) return null;

  const keyB64 = host.codec.hexToBase64(VIDROCK_KEY_HEX);
  const nonceB64 = host.codec.hexToBase64(nonceHex);
  const cipherB64 = host.codec.hexToBase64(cipherHex);

  const plainB64 = host.crypto.aesGcmDecrypt(keyB64, nonceB64, cipherB64);
  return plainB64 === null ? null : host.codec.base64ToText(plainB64);
}

// ---- network ----

async function vidrockSources(args) {
  const item = args.item;
  const enabled = args.enabledProviders;
  if (enabled != null && enabled.indexOf(VIDROCK_PROVIDER_ID) === -1) {
    return { sources: [] };
  }

  const refId = item.ref && item.ref.id;

  // ---- TV series episode path ----
  const episodeRef = parseVidrockEpisodeRef(refId);
  if (episodeRef !== null) {
    const seriesTmdbId = episodeRef.tmdbId;
    const season = episodeRef.season;
    const episode = episodeRef.episode;

    let response;
    try {
      response = await fetch(
        `${VIDROCK_BASE}/api/tv/${seriesTmdbId}/${season}/${episode}`,
        { headers: vidrockHeaders() },
      );
    } catch (_) {
      return { sources: [] };
    }
    if (response.status < 200 || response.status >= 300) return { sources: [] };

    let servers;
    try {
      servers = JSON.parse(response.body);
    } catch (_) {
      return { sources: [] };
    }

    const sources = [];
    for (const name of Object.keys(servers)) {
      const server = servers[name];
      const encryptedUrl = server && server.url;
      if (!encryptedUrl || encryptedUrl === 'error' || encryptedUrl === 'null') {
        continue;
      }
      const id = encodeVidrockSourceId({
        encryptedUrl,
        type: server.type || 'hls',
        tmdbId: seriesTmdbId,
        season,
        episode,
      });
      const lang = server.language ? ` (${server.language})` : '';
      const realName = [
        name,
        server.name,
        server.quality,
        server.resolution,
      ]
        .filter((value) => value != null && String(value).trim().length > 0)
        .join(' ');
      const sourceId = `${VIDROCK_PROVIDER_KEY}:${id}`;
      sources.push({
        id: sourceId,
        // Keep the provider's original server name and the dub language.
        label: `${sourceAliasWithQuality(sourceId, name, realName)}${lang}`,
        provider: 'Nimora',
        providerId: 'nimora.vidrock',
      });
    }
    return { sources };
  }

  // ---- Movie path (unchanged) ----
  const tmdbId = parseTmdbMovieRef(refId);
  if (tmdbId === null) return { sources: [] };

  let response;
  try {
    response = await fetch(`${VIDROCK_BASE}/api/movie/${tmdbId}/`, {
      headers: vidrockHeaders(),
    });
  } catch (_) {
    return { sources: [] };
  }
  if (response.status < 200 || response.status >= 300) return { sources: [] };

  let servers;
  try {
    servers = JSON.parse(response.body);
  } catch (_) {
    return { sources: [] };
  }

  const sources = [];
  for (const name of Object.keys(servers)) {
    const server = servers[name];
    const encryptedUrl = server && server.url;
    if (!encryptedUrl || encryptedUrl === 'error' || encryptedUrl === 'null') {
      continue;
    }
    const id = encodeVidrockSourceId({
      encryptedUrl,
      type: server.type || 'hls',
      tmdbId,
    });
    const lang = server.language ? ` (${server.language})` : '';
    const realName = [
      name,
      server.name,
      server.quality,
      server.resolution,
    ]
      .filter((value) => value != null && String(value).trim().length > 0)
      .join(' ');
    const sourceId = `${VIDROCK_PROVIDER_KEY}:${id}`;
    sources.push({
      id: sourceId,
      // Keep the provider's original server name and the dub language.
      label: `${sourceAliasWithQuality(sourceId, name, realName)}${lang}`,
      provider: 'Nimora',
      providerId: 'nimora.vidrock',
    });
  }
  return { sources };
}

async function resolveVidrockSource(sourceId) {
  const prefix = `${VIDROCK_PROVIDER_KEY}:`;
  const inner = sourceId.startsWith(prefix) ? sourceId.slice(prefix.length) : sourceId;
  const decoded = decodeVidrockSourceId(inner);

  const url = decryptVidrockUrl(decoded.u);
  if (url === null) throw new Error('Vidrock source failed to decrypt');

  const format = decoded.type === 'hls' || url.indexOf('.m3u8') !== -1 ? 'hls' : 'other';
  const result = { url, headers: vidrockHeaders(), format };

  return result;
}

// ---- registration — see kora.js's tail for the shared aggregator ----

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: VIDROCK_PROVIDER_KEY,
  sources: vidrockSources,
  resolve: (sourceId) => resolveVidrockSource(sourceId),
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.sources) {
  globalThis.__extension.sources = async (args) => {
    const calls = globalThis.__streamProviders.map((p) =>
      Promise.resolve()
        .then(() => p.sources(args))
        .catch(() => ({ sources: [] })),
    );
    if (args.fast !== true) {
      const perProvider = await Promise.all(calls);
      return { sources: perProvider.flatMap((r) => r.sources) };
    }
    return new Promise((resolve) => {
      let remaining = calls.length;
      let returned = false;
      for (const call of calls) {
        call.then((result) => {
          if (returned) return;
          const sources = Array.isArray(result.sources) ? result.sources : [];
          if (sources.length > 0) {
            returned = true;
            resolve({ sources });
            return;
          }
          remaining -= 1;
          if (remaining === 0) resolve({ sources: [] });
        });
      }
    });
  };
  globalThis.__extension.resolve = async (args) => {
    const sourceId = args.sourceId;
    const separator = sourceId.indexOf(':');
    if (separator < 0) throw new Error(`Malformed source id: ${sourceId}`);
    const providerKey = sourceId.slice(0, separator);
    const provider = globalThis.__streamProviders.find((p) => p.providerKey === providerKey);
    if (!provider) throw new Error(`No stream provider registered for "${providerKey}"`);
    return provider.resolve(sourceId);
  };
}

// FlyStream as a stream provider, over the host `fetch` API.
//
// flystream.net serves one or more adaptive HLS playlists per title from
// `/api/streams`, keyed by TMDB id. AniList episode refs use the site's
// `/api/anilist/identity` mapping first, then enter the same TMDB-keyed flow.
// It is worth the file because of what is
// behind that playlist: a real 4K ladder (hvc1 2160p / avc1 1080p / 720p /
// 360p, fMP4 segments) rather than the single re-encode most of the other
// upstreams here hand back — verified by summing `#EXTINF` durations against
// the known runtime for Inception (148.1 vs ~148 min), Breaking Bad S01E01
// (58.0 vs ~58), Severance S02E01 (48.9 vs ~49) and Toy Story (81.1 vs ~81).
// A tmdbId with no match answers `{"streams":[]}`, so a wrong id is a miss
// rather than someone else's film.
//
// Two things gate the API, and missing either one answers
// `403 {"error":"Playback unavailable"}`:
//
//   1. an `fs_seen2` cookie, which `GET /` hands out to anyone who asks, and
//   2. `Sec-Fetch-Site: same-origin` on the API request itself.
//
// Referer, Origin, sec-ch-ua and Accept-Language are all checked and none of
// them matter.
//
// What does matter, and is the reason nothing here sends a User-Agent:
// **do not claim to be a browser.** Cloudflare holds a request that says it
// is Chrome to a Chrome-shaped TLS and HTTP fingerprint, and refuses it with
// a `403` when the shape doesn't match — the plain homepage included. An
// honest one is not held to that and is simply let through. Measured from
// one `dart:io` client, same second, same IP:
//
//   (nothing set, so `Dart/3.12 (dart:io)`)  -> 200
//   ExoPlayer/okhttp                          -> 200
//   Mozilla/5.0 ... Chrome/131.0.0.0          -> 403
//
// This is also why the pure-Dart port this was written from (PlayTorrioV3's
// `flystream.dart`) finds nothing and reports it as an empty result: it
// sends a Chrome User-Agent, and no cookie or `Sec-Fetch-Site` besides.
// Leaving the header off entirely lets the host and the player each send
// their own, which is the truthful thing for either to say.
//
// `title` is a required query parameter but is *not* used for matching — a
// deliberately wrong title with a right tmdbId still resolves the right
// film — so nothing here depends on title spelling. `viewerId` is required
// too, and is the rate-limit key: omit it and the API answers
// `429 {"error":"Too many requests","retryAfterSec":600}`. The site itself
// keeps one per browsing session in `sessionStorage.fs_viewer_id`, which is
// what `flystreamViewerId` mirrors.
//
// Both movies and series. A series item must carry season and episode in its
// reference; a bare `series:<tmdbId>` is declined rather than guessed at,
// the same way vidrock.js and vaplayer.js decline it.

const FLYSTREAM_BASE = globalThis.__flystreamBaseUrl || 'https://flystream.net';
// Playlists and segments come off a separate host, and a relative `url` in
// the API response is relative to *that* host, not to the API's own — the
// Dart port resolves those against the API base and 403s on every one.
const FLYSTREAM_MEDIA_BASE =
  globalThis.__flystreamMediaBaseUrl || 'https://media.flystream.net';

const FLYSTREAM_PROVIDER_KEY = 'flystream';
const FLYSTREAM_PROVIDER_ID = 'nimora.flystream';

const FLYSTREAM_COOKIE_NAME = 'fs_seen2';
const FLYSTREAM_COOKIE_CACHE_KEY = 'flystream:seen2';
// Stands in for the cookie when the handshake succeeded but the platform's
// HTTP client kept `Set-Cookie` to itself. NSURLSession does exactly that —
// it moves the cookie into its own `HTTPCookieStorage` and replays it on the
// next request to the same host, so the header never reaches this code and
// none has to be sent by hand. Cronet and `dart:io` both expose it instead.
// Chosen so it can never collide with a real value, which is always
// `fs_seen2=…`.
const FLYSTREAM_COOKIE_IN_JAR = 'jar';
// The upstream sets Max-Age=2592000 (30 days). Cached for a week instead:
// a stale cookie costs one wasted request and a re-handshake (below), and
// there is nothing to gain from holding one for a month.
const FLYSTREAM_COOKIE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FLYSTREAM_VIEWER_CACHE_KEY = 'flystream:viewer';
const FLYSTREAM_VIEWER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ---- base64url ----
//
// Local, deliberately: this file loads before kora.js/vidrock.js in the
// bundle (it has to, to list first), so it cannot borrow theirs, and the
// bundle is one scope so the names have to differ from theirs.

function flystreamBase64ToUrl(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_');
}

function flystreamUrlToBase64(token) {
  let normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder !== 0) normalized += '='.repeat(4 - remainder);
  return normalized;
}

// ---- storage ----
//
// Same contract cricfy.js states: a cache an extension may use, never one it
// may rely on. Every read treats a miss as ordinary.

function flystreamStorage() {
  return typeof host === 'object' && host !== null && host.storage
    ? host.storage
    : null;
}

function flystreamCacheRead(key) {
  const storage = flystreamStorage();
  if (storage === null) return null;
  let raw;
  try {
    raw = storage.read(key);
  } catch (_) {
    return null;
  }
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function flystreamCacheWrite(key, value, ttlMs) {
  const storage = flystreamStorage();
  if (storage === null) return;
  try {
    storage.write(key, value, ttlMs);
  } catch (_) {
    // A cache that won't take the value changes nothing about this session.
  }
}

function flystreamCacheDelete(key) {
  const storage = flystreamStorage();
  if (storage === null) return;
  try {
    storage.delete(key);
  } catch (_) {
    // Nothing to do; the stale value simply expires on its own.
  }
}

// ---- viewer id ----

function flystreamRandomHex(length) {
  let out = '';
  while (out.length < length) {
    out += Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, '0');
  }
  return out.slice(0, length);
}

let flystreamViewerMemo = null;

function flystreamViewerId() {
  if (flystreamViewerMemo !== null) return flystreamViewerMemo;
  const cached = flystreamCacheRead(FLYSTREAM_VIEWER_CACHE_KEY);
  if (cached !== null && /^[0-9a-f]{32}$/.test(cached)) {
    flystreamViewerMemo = cached;
    return cached;
  }
  const generated = flystreamRandomHex(32);
  flystreamCacheWrite(
    FLYSTREAM_VIEWER_CACHE_KEY,
    generated,
    FLYSTREAM_VIEWER_CACHE_TTL_MS,
  );
  flystreamViewerMemo = generated;
  return generated;
}

// ---- session cookie ----

function flystreamResponseHeader(response, name) {
  const headers = response && response.headers;
  if (headers == null || typeof headers !== 'object') return '';
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return String(headers[key] || '');
  }
  return '';
}

// The host joins repeated response headers with ", ", so a Set-Cookie value
// can arrive alongside others in one string. Match the named pair wherever it
// sits rather than assuming it is first.
function flystreamParseCookie(setCookie) {
  const match = new RegExp(
    `(?:^|[,;\\s])${FLYSTREAM_COOKIE_NAME}=([^;,\\s]+)`,
  ).exec(setCookie);
  return match == null ? null : `${FLYSTREAM_COOKIE_NAME}=${match[1]}`;
}

let flystreamCookieMemo = null;

async function flystreamFetchCookie() {
  let response;
  try {
    response = await fetch(`${FLYSTREAM_BASE}/`, {
      headers: { Accept: 'text/html' },
    });
  } catch (_) {
    return null;
  }
  if (response.status < 200 || response.status >= 400) return null;
  const cookie = flystreamParseCookie(
    flystreamResponseHeader(response, 'set-cookie'),
  );
  // A 2xx means the handshake was accepted, and that is what the API checks
  // for. Whether the cookie is visible here is the platform's business.
  return cookie === null ? FLYSTREAM_COOKIE_IN_JAR : cookie;
}

// Returns the session cookie, minting one if there isn't a usable one.
// In-process the promise itself is memoized, so several items opened at once
// share a single handshake instead of racing one each.
function flystreamCookie() {
  if (flystreamCookieMemo !== null) return flystreamCookieMemo;

  const cached = flystreamCacheRead(FLYSTREAM_COOKIE_CACHE_KEY);
  if (cached !== null) {
    flystreamCookieMemo = Promise.resolve(cached);
    return flystreamCookieMemo;
  }

  flystreamCookieMemo = flystreamFetchCookie().then((cookie) => {
    if (cookie === null) {
      // Don't hold a failed handshake: the next item should try again.
      flystreamCookieMemo = null;
      return null;
    }
    flystreamCacheWrite(
      FLYSTREAM_COOKIE_CACHE_KEY,
      cookie,
      FLYSTREAM_COOKIE_CACHE_TTL_MS,
    );
    return cookie;
  });
  return flystreamCookieMemo;
}

function flystreamForgetCookie() {
  flystreamCookieMemo = null;
  flystreamCacheDelete(FLYSTREAM_COOKIE_CACHE_KEY);
}

// ---- the API ----

function flystreamApiHeaders(cookie) {
  return {
    Accept: 'application/json',
    // The gate. Without it the API answers 403 no matter what else is sent.
    'Sec-Fetch-Site': 'same-origin',
    ...(cookie === FLYSTREAM_COOKIE_IN_JAR ? {} : { Cookie: cookie }),
  };
}

function flystreamStreamsUrl(query) {
  const parts = [];
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (value == null || String(value).length === 0) continue;
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return `${FLYSTREAM_BASE}/api/streams?${parts.join('&')}`;
}

// A 429 carries `retryAfterSec` and the upstream means it — asking again
// inside the window just extends it. Held in memory only: it describes this
// process's standing with the API, not anything worth surviving a restart.
let flystreamCooldownUntilMs = 0;

// One request, with a single retry reserved for the one failure a retry can
// fix: a cookie the upstream no longer accepts.
async function flystreamRequestStreams(query, { allowRetry = true } = {}) {
  return flystreamRequestJson(flystreamStreamsUrl(query), { allowRetry });
}

async function flystreamRequestJson(url, { allowRetry = true } = {}) {
  if (Date.now() < flystreamCooldownUntilMs) return null;

  const cookie = await flystreamCookie();
  if (cookie === null) return null;

  let response;
  try {
    response = await fetch(url, {
      headers: flystreamApiHeaders(cookie),
    });
  } catch (_) {
    return null;
  }

  if (response.status === 429) {
    let retryAfterSec = 600;
    try {
      const parsed = JSON.parse(response.body);
      if (parsed && typeof parsed.retryAfterSec === 'number') {
        retryAfterSec = parsed.retryAfterSec;
      }
    } catch (_) {
      // Keep the upstream's own default window.
    }
    flystreamCooldownUntilMs = Date.now() + retryAfterSec * 1000;
    return null;
  }

  if (response.status === 403 && allowRetry) {
    // The cookie is the only thing a 403 here is ever about; mint a new one
    // and give the request exactly one more go.
    flystreamForgetCookie();
    return flystreamRequestJson(url, { allowRetry: false });
  }

  if (response.status < 200 || response.status >= 300) return null;

  try {
    return JSON.parse(response.body);
  } catch (_) {
    return null;
  }
}

function flystreamPlaybackUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    return rawUrl;
  }
  if (rawUrl.startsWith('/')) return `${FLYSTREAM_MEDIA_BASE}${rawUrl}`;
  return null;
}

// The media host wants the Referer and refuses the request without it. It
// wants no User-Agent from us: the player sends its own, which is honest and
// accepted, and overriding it with a browser's would get the playlist
// refused for the same reason the API would be.
function flystreamPlaybackHeaders() {
  return { Referer: `${FLYSTREAM_BASE}/` };
}

function flystreamFormat(stream) {
  if (stream && stream.isDash === true) return 'dash';
  if (stream && stream.isHls === true) return 'hls';
  const url = stream && typeof stream.url === 'string' ? stream.url : '';
  if (url.indexOf('.m3u8') !== -1) return 'hls';
  if (url.indexOf('.mpd') !== -1) return 'dash';
  return 'other';
}

// `quality` is the top rung of the ladder inside the playlist, not the only
// one on offer — the URL is a master playlist and the player picks from
// `resolutions`. Labelling it as the quality is still the honest summary:
// it is the best this source can give.
//
// `videoCodec` is deliberately ignored. The API reports "h264" for playlists
// whose 2160p variant is plainly `hvc1`, so surfacing it would be stating
// something wrong with more confidence than the API has earned.
function flystreamQualityScore(stream) {
  const explicit = stream && stream.quality;
  const values = typeof explicit === 'string' && explicit.trim() !== ''
    ? [explicit]
    : Array.isArray(stream && stream.resolutions)
      ? stream.resolutions
      : [];
  let score = 0;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const match = /(?:^|[^0-9])(\d{3,4})\s*p?(?=$|[^a-z0-9])/i.exec(value);
    if (match != null) {
      score = Math.max(score, Number(match[1]));
      continue;
    }
    if (/^4k$/i.test(value.trim())) score = Math.max(score, 2160);
    if (/^2k$/i.test(value.trim())) score = Math.max(score, 1440);
  }
  return score;
}

function flystreamBestStream(streams) {
  const candidates = [];
  const seenUrls = new Set();
  for (const [index, stream] of streams.entries()) {
    if (stream == null || typeof stream !== 'object') continue;
    const url = flystreamPlaybackUrl(stream.url);
    if (url === null || seenUrls.has(url)) continue;
    seenUrls.add(url);
    candidates.push({ stream, url, index, quality: flystreamQualityScore(stream) });
  }
  candidates.sort((a, b) => b.quality - a.quality || a.index - b.index);
  return candidates[0] || null;
}

// ---- source ids ----
//
// The playlist URL is baked straight in, so resolve() needs no second
// request — the same shape kora.js's `encodeKoraSourceId` uses, and here it
// also keeps a rate-limited endpoint to exactly one call per item opened.

function encodeFlystreamSourceId(payload) {
  return flystreamBase64ToUrl(
    host.codec.textToBase64(
      JSON.stringify({ u: payload.url, f: payload.format }),
    ),
  );
}

function decodeFlystreamSourceId(encoded) {
  return JSON.parse(host.codec.base64ToText(flystreamUrlToBase64(encoded)));
}

// ---- references ----

function flystreamEpisodeSeason(item) {
  const episode = item && item.episode;
  const groupId = episode && typeof episode.groupId === 'string'
    ? episode.groupId
    : '';
  const match = /(?:^|:)season:(\d+)/i.exec(groupId);
  return match == null ? '1' : match[1];
}

function flystreamSeriesTitle(item) {
  const subtitle = item && typeof item.subtitle === 'string'
    ? item.subtitle.trim()
    : '';
  if (subtitle) return subtitle;
  return item && typeof item.title === 'string' ? item.title : '';
}

// Reads `movie:<tmdbId>`, `series:<tmdbId>:season:<s>:episode:<e>`, and
// AniList's `anilist:episode:<id>:<episode>` protocol-v2 refs.
function parseFlystreamRef(refId, item) {
  if (typeof refId !== 'string') return null;
  const episode = /^series:([^:]+):season:([^:]+):episode:([^:]+)$/.exec(refId);
  if (episode != null) {
    return {
      type: 'tv',
      tmdbId: episode[1],
      season: episode[2],
      episode: episode[3],
    };
  }
  const anilistEpisode = /^anilist:episode:(\d+):(\d+)$/.exec(refId);
  if (anilistEpisode != null) {
    return {
      type: 'tv',
      tmdbId: null,
      anilistId: anilistEpisode[1],
      season: flystreamEpisodeSeason(item),
      episode: anilistEpisode[2],
    };
  }
  const prefix = 'movie:';
  if (!refId.startsWith(prefix)) return null;
  const tmdbId = refId.slice(prefix.length);
  return tmdbId.length > 0
    ? { type: 'movie', tmdbId, season: null, episode: null }
    : null;
}

function flystreamAnilistIdentityUrl(parsed, item) {
  const parts = [
    `anilistId=${encodeURIComponent(parsed.anilistId)}`,
    `title=${encodeURIComponent(flystreamSeriesTitle(item) || parsed.anilistId)}`,
  ];
  if (Number.isInteger(item && item.releaseYear)) {
    parts.push(`year=${encodeURIComponent(String(item.releaseYear))}`);
  }
  return `${FLYSTREAM_BASE}/api/anilist/identity?${parts.join('&')}`;
}

function flystreamIdentity(payload) {
  const candidates = [
    payload,
    payload && payload.data,
    payload && payload.identity,
    payload && payload.result,
  ];
  for (const candidate of candidates) {
    if (candidate == null || typeof candidate !== 'object') continue;
    for (const key of ['tmdbId', 'tmdb_id', 'tmdb']) {
      const value = candidate[key];
      let tmdbId = null;
      if (Number.isInteger(value) && value > 0) tmdbId = String(value);
      if (typeof value === 'string' && /^\d+$/.test(value)) tmdbId = value;
      if (tmdbId == null) continue;

      const season = candidate.season;
      const mappedSeason = Number.isInteger(season) && season > 0
        ? String(season)
        : typeof season === 'string' && /^\d+$/.test(season)
          ? season
          : null;
      return { tmdbId, season: mappedSeason };
    }
  }
  return null;
}

async function flystreamResolveAnilistIdentity(parsed, item) {
  const payload = await flystreamRequestJson(
    flystreamAnilistIdentityUrl(parsed, item),
  );
  return flystreamIdentity(payload);
}

// ---- provider ----

async function flystreamListSources(args) {
  const enabled = args.enabledProviders;
  if (enabled != null && enabled.indexOf(FLYSTREAM_PROVIDER_ID) === -1) {
    return { sources: [] };
  }

  const item = args.item || {};
  const refId = (item.ref && item.ref.id) || item.id || '';
  const parsed = parseFlystreamRef(refId, item);
  if (parsed === null) return { sources: [] };

  let tmdbId = parsed.tmdbId;
  let season = parsed.season;
  if (tmdbId == null) {
    const identity = await flystreamResolveAnilistIdentity(parsed, item);
    if (identity == null) return { sources: [] };
    tmdbId = identity.tmdbId;
    if (identity.season != null) season = identity.season;
  }

  const payload = await flystreamRequestStreams({
    type: parsed.type,
    viewerId: flystreamViewerId(),
    // Required by the endpoint, unused for matching. The tmdbId stands in
    // when an item has no title rather than leaving the parameter empty,
    // which the API rejects as a missing lookup id.
    title:
      typeof item.title === 'string' && item.title.length > 0
        ? item.title
        : tmdbId,
    tmdbId,
    year: Number.isInteger(item.releaseYear) ? item.releaseYear : null,
    season,
    episode: parsed.episode,
  });

  const streams =
    payload && Array.isArray(payload.streams) ? payload.streams : [];

  const selected = flystreamBestStream(streams);
  if (selected === null) return { sources: [] };

  const format = flystreamFormat(selected.stream);
  const sourceId = `${FLYSTREAM_PROVIDER_KEY}:${encodeFlystreamSourceId({
    url: selected.url,
    format,
  })}`;
  return {
    sources: [{
      id: sourceId,
      label: sourceAliasWithQuality(sourceId, 'FlyStream', 'FlyStream'),
      provider: 'Nimora',
      providerId: FLYSTREAM_PROVIDER_ID,
    }],
  };
}

async function flystreamResolveSource(sourceId) {
  const prefix = `${FLYSTREAM_PROVIDER_KEY}:`;
  if (!sourceId.startsWith(prefix)) {
    throw new Error(`Invalid FlyStream sourceId: ${sourceId}`);
  }
  const decoded = decodeFlystreamSourceId(sourceId.slice(prefix.length));
  if (!decoded || typeof decoded.u !== 'string' || decoded.u.length === 0) {
    throw new Error('Malformed FlyStream source id');
  }
  return {
    url: decoded.u,
    format: decoded.f || 'hls',
    headers: flystreamPlaybackHeaders(),
  };
}

// ---- registration — see kora.js's tail for the shared aggregator ----
//
// The aggregator concatenates each provider's list in registration order and
// nothing downstream re-sorts, so the bundle's file order decides where this
// one sits. It no longer leads: these renditions are fMP4, which the FFmpeg
// libmpv is built against cannot seek without the player's cut-playlist
// path, while VaPlayer and vidrock seek through libmpv's own. FlyStream
// stays for the 4K ladder nothing else here offers.

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: FLYSTREAM_PROVIDER_KEY,
  sources: flystreamListSources,
  resolve: (sourceId) => flystreamResolveSource(sourceId),
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.sources) {
  globalThis.__extension.sources = async (args) => {
    const calls = globalThis.__streamProviders.map((p) =>
      Promise.resolve()
        .then(() => p.sources(args))
        .catch(() => ({ sources: [] })),
    );
    if (args.fast !== true) {
      const perProvider = await Promise.all(calls);
      return { sources: perProvider.flatMap((r) => r.sources) };
    }
    return new Promise((resolve) => {
      let remaining = calls.length;
      let returned = false;
      for (const call of calls) {
        call.then((result) => {
          if (returned) return;
          const sources = Array.isArray(result.sources) ? result.sources : [];
          if (sources.length > 0) {
            returned = true;
            resolve({ sources });
            return;
          }
          remaining -= 1;
          if (remaining === 0) resolve({ sources: [] });
        });
      }
    });
  };
  globalThis.__extension.resolve = async (args) => {
    const sourceId = args.sourceId;
    const separator = sourceId.indexOf(':');
    if (separator < 0) {
      throw new Error(`Malformed source id: ${sourceId}`);
    }
    const providerKey = sourceId.slice(0, separator);
    const provider = globalThis.__streamProviders.find(
      (p) => p.providerKey === providerKey,
    );
    if (!provider) {
      throw new Error(`No stream provider registered for "${providerKey}"`);
    }
    return provider.resolve(sourceId);
  };
}

// VidEasy stream provider, in JS on the host `fetch`/`codec` API.
//
// VidEasy (player.videasy.to) sources streams from api.speedracelight.com,
// which returns seed-encrypted JSON. We decrypt via enc-dec.app/api/dec-videasy.
//
// Servers available (language info from EncDecEndpoints README):
//   cdn        -> Original (may have 4K)
//   m4uhd      -> Original
//   vsrc       -> Original
//   hdmovie    -> Original (EN quality) / Hindi (quality == "Hindi")
//   meine      -> German
//   lamovie    -> Spanish
//   superflix  -> Portuguese
//
// Matches TMDB-backed items through their movie/series reference prefix.

const VIDEASY_SPEEDRACE_BASE =
  globalThis.__videasySpeedraceBaseUrl || 'https://api.speedracelight.com';
const VIDEASY_ENCDEC_BASE =
  globalThis.__videasyEncDecBaseUrl || 'https://enc-dec.app/api';

const VIDEASY_PROVIDER_KEY = 'videasy';
const VIDEASY_PROVIDER_ID = 'nimora.videasy';

const VIDEASY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// Servers exposed as stream sources. The key is the speedracelight.com path
// segment (e.g. /cdn/sources-with-title).
//
// Several, because which ones answer changes per *title*, not just per day:
// checked live, a film resolved only on `downloader2` while an episode of a
// series resolved only on `m4uhd`, `cdn` and `lamovie` — every other server
// returned 500 for that same request. Listing one server, or a short list
// that happens to miss the right one, reads to the viewer as "VidEasy has
// nothing" when it simply wasn't asked in the right place.
//
// Listing costs nothing: `videasyListSources` doesn't call these, it only
// names them. The requests happen when a source is resolved.
//
// Servers that answered 404 for every request (`myflixerzupcloud`, `jett`,
// `tejo`, `ym`) are left out — a 404 here is the path segment not existing,
// so those are wasted round trips rather than a server being down.
const VIDEASY_SERVERS = [
  { key: 'cdn', label: 'VidEasy Yoru', quality: '' },
  { key: 'downloader2', label: 'VidEasy Kite', quality: '' },
  { key: 'm4uhd', label: 'VidEasy Breach', quality: '' },
  { key: 'hdmovie', label: 'VidEasy Vyse', quality: '' },
  { key: 'lamovie', label: 'VidEasy Aura', quality: '' },
  { key: 'superflix', label: 'VidEasy Solstice', quality: '' },
  { key: 'neon2', label: 'VidEasy Neon', quality: '' },
];

function videasyHeaders() {
  return {
    Accept: '*/*',
    Origin: 'https://player.videasy.to',
    Referer: 'https://player.videasy.to/',
    'User-Agent': VIDEASY_UA,
  };
}

// Reads a `movie:<tmdbId>` reference.
function parseMovieRef(refId) {
  if (typeof refId !== 'string') return null;
  const prefix = 'movie:';
  if (!refId.startsWith(prefix)) return null;
  const id = refId.slice(prefix.length);
  return id.length > 0 ? id : null;
}

// Reads a `series:<tmdbId>` reference.
function parseSeriesRef(refId) {
  if (typeof refId !== 'string') return null;
  const prefix = 'series:';
  if (!refId.startsWith(prefix)) return null;
  const id = refId.slice(prefix.length);
  return id.length > 0 ? id : null;
}

function parseVideasyEpisodeRef(refId) {
  if (typeof refId !== 'string') return null;
  const match = /^series:([^:]+):season:([^:]+):episode:([^:]+)$/.exec(refId);
  return match == null
    ? null
    : { tmdbId: match[1], season: match[2], episode: match[3] };
}

// Source id encodes everything resolve() needs in base64url.
function encodeVideasySourceId(payload) {
  const json = JSON.stringify({
    s: payload.server,
    m: payload.tmdbId,
    t: payload.type,         // 'movie' or 'tv'
    se: payload.seed,
    // season/episode only for TV
    ...(payload.season != null ? { sn: payload.season, ep: payload.episode } : {}),
  });
  return host.codec.textToBase64(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodeVideasySourceId(sourceId) {
  // Restore standard base64 padding
  let b64 = sourceId.replace(/-/g, '+').replace(/_/g, '/');
  const rem = b64.length % 4;
  if (rem !== 0) b64 += '='.repeat(4 - rem);
  try {
    return JSON.parse(host.codec.base64ToText(b64));
  } catch (_) {
    return null;
  }
}

// Fetch the seed for a given tmdbId. Required to decrypt the response.
async function fetchSeed(tmdbId) {
  let response;
  try {
    response = await fetch(
      `${VIDEASY_SPEEDRACE_BASE}/seed?mediaId=${encodeURIComponent(tmdbId)}`,
      { headers: videasyHeaders() },
    );
  } catch (_) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;
  try {
    const data = JSON.parse(response.body);
    return data.seed != null ? String(data.seed) : null;
  } catch (_) {
    return null;
  }
}

// Double-encodes the title per VidEasy convention.
function doubleEncodeTitle(title) {
  return encodeURIComponent(encodeURIComponent(title));
}

// Returns the raw encrypted text from speedracelight.
async function fetchEncryptedSources(serverKey, query) {
  const params = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${VIDEASY_SPEEDRACE_BASE}/${serverKey}/sources-with-title?${params}`;
  let response;
  try {
    response = await fetch(url, { headers: videasyHeaders() });
  } catch (_) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;
  return response.body;
}

// Decrypts the encrypted text via enc-dec.app.
async function decryptVideasy(encryptedText, tmdbId, seed) {
  let response;
  try {
    response = await fetch(`${VIDEASY_ENCDEC_BASE}/dec-videasy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: encryptedText, id: tmdbId, seed }),
    });
  } catch (_) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;
  try {
    const data = JSON.parse(response.body);
    if (data.status !== 200) return null;
    return data.result;
  } catch (_) {
    return null;
  }
}

// sources() — lists one source entry per server for a given movie/series item.
// We list them by server without fetching (that happens on resolve()), so this
// is fast and doesn't hit the network per-server.
async function videasyListSources(args) {
  const item = args.item || {};
  const refId = (item.ref && item.ref.id) || item.id || '';

  const isMovie = parseMovieRef(refId) !== null;
  const episodeRef = parseVideasyEpisodeRef(refId);
  const isSeries = episodeRef !== null;
  if (!isMovie && !isSeries) return { sources: [] };

  const tmdbId = isMovie ? parseMovieRef(refId) : episodeRef.tmdbId;

  // For series, require season + episode in item.extra.
  // Fetch the seed now (one request) so resolve() can use it without a
  // redundant trip.
  const seed = await fetchSeed(tmdbId);
  if (!seed) return { sources: [] };

  const sources = VIDEASY_SERVERS.map((srv) => {
    const id = `${VIDEASY_PROVIDER_KEY}:${encodeVideasySourceId({
      server: srv.key,
      tmdbId,
      type: isMovie ? 'movie' : 'tv',
      seed,
      season: isSeries ? episodeRef.season : null,
      episode: isSeries ? episodeRef.episode : null,
    })}`;
    return { id, label: srv.label, provider: 'Nimora', providerId: 'nimora.videasy' };
  });

  return { sources };
}

// resolve() — fetches and decrypts the actual stream URL for the chosen server.
async function videasyResolveSource(sourceId) {
  const prefix = `${VIDEASY_PROVIDER_KEY}:`;
  if (!sourceId.startsWith(prefix)) {
    throw new Error(`Invalid VidEasy sourceId: ${sourceId}`);
  }
  const payload = decodeVideasySourceId(sourceId.slice(prefix.length));
  if (!payload) throw new Error('Malformed VidEasy source id');

  const { s: server, m: tmdbId, t: type, se: seed, sn: season, ep: episode } = payload;

  // Build the speedracelight query.
  const query = {
    tmdbId,
    mediaType: type,
    enc: '2',
    seed,
    // title is not needed when we have tmdbId; use a placeholder to satisfy
    // the endpoint signature.
    title: encodeURIComponent(String(tmdbId)),
  };
  if (type === 'tv') {
    query.seasonId = season;
    query.episodeId = episode;
  }

  const encrypted = await fetchEncryptedSources(server, query);
  if (!encrypted) throw new Error('VidEasy: failed to fetch encrypted sources');

  const decrypted = await decryptVideasy(encrypted, tmdbId, seed);
  if (!decrypted) throw new Error('VidEasy: decryption failed');

  // Decrypted is `{ sources: [{url, quality}], subtitles: [...] }`.
  //
  // Not `{file, type}` / `tracks`, which is what this read for until it was
  // checked against a live response — so even a server that answered fell
  // over here with "no stream URL". `quality` is a server nickname
  // ("playhq", "bk"), not a resolution, so it isn't treated as one.
  let parsed;
  try {
    parsed = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;
  } catch (_) {
    throw new Error('VidEasy: invalid decrypted JSON');
  }

  const sourcesArr = Array.isArray(parsed.sources) ? parsed.sources : [];
  const entry = sourcesArr.find((s) => s && typeof s.url === 'string' && s.url);
  if (!entry) throw new Error('VidEasy: no stream URL in decrypted payload');

  const rawSubs = Array.isArray(parsed.subtitles) ? parsed.subtitles : [];
  const subtitles = rawSubs
    .filter((t) => t && (t.url || t.file))
    .map((t) => ({
      language: t.language || t.label || t.lang || '',
      url: t.url || t.file,
      label: t.label || t.language || t.lang || '',
    }));

  return {
    url: entry.url,
    // These come back as both .m3u8 and .mp4 depending on the server.
    format: entry.url.includes('.m3u8') ? 'hls' : 'other',
    headers: {
      Origin: 'https://player.videasy.to',
      Referer: 'https://player.videasy.to/',
      'User-Agent': VIDEASY_UA,
    },
    subtitles,
  };
}

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: VIDEASY_PROVIDER_KEY,
  sources: videasyListSources,
  resolve: videasyResolveSource,
});

// Kora as a stream provider, in JS on the host `fetch`/`codec`/`match` API.
//
// A JavaScript port of the Kora upstream protocol. Three
// hosts: cdn.kora-api.org (daily list, XOR+base64 encoded), kora-api.space
// (match detail, plain JSON), and — once a match is picked — a per-match
// edge node, `{edge}.{edgeDomain}`, that mints the actual signed stream URL.
//
// Loaded alongside fixtures.js (see manifest.json's single `entry` and the
// app's loader, which concatenates them — there is no real bundler yet).
// Adds to the `globalThis.__extension` object fixtures.js already created,
// rather than replacing it.

// Overridable purely for tests — see fixtures.js's identical pattern.
const KORA_LIST_BASE =
  globalThis.__koraListBaseUrl || 'https://cdn.kora-api.org/api/';
const KORA_DETAIL_BASE =
  globalThis.__koraDetailBaseUrl || 'https://kora-api.space/api/';

const KORA_KEY = 'K0r@Api$3cr3tK3y';
const KORA_DEFAULT_UA = 'okhttp/4.12.0';
const KORA_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const KORA_PLAYER_VALUE = 12;

const KORA_PROVIDER_KEY = 'kora';
const KORA_PROVIDER_ID = 'nimora.kora';

// Football's own knowledge for the matcher — mirrors
// football_normalization_profile.dart exactly; see PLAN.md §12/M18 for why
// this is data the extension carries, not something the host knows.
const FOOTBALL_PROFILE = {
  aliases: {
    'man utd': 'manchester united',
    'man united': 'manchester united',
    'man city': 'manchester city',
    spurs: 'tottenham hotspur',
    psg: 'paris saint germain',
    barca: 'barcelona',
    inter: 'internazionale',
    juve: 'juventus',
    atleti: 'atletico madrid',
    // Athletic Bilbao's official name is "Athletic Club" — the "club" stop
    // token would otherwise strip it down to the bare "athletic", which is
    // an ambiguousAlone token and can never clear minTeamScore on its own.
    'athletic club': 'athletic bilbao',
    wolves: 'wolverhampton wanderers',
    'west brom': 'west bromwich albion',
    'west bromwich': 'west bromwich albion',
    // FotMob uses "A Coruña" while Spanish broadcast feeds often use the
    // club's traditional "La Coruña" spelling.
    'deportivo a coruna': 'deportivo la coruna',
  },
  stopTokens: ['fc', 'afc', 'cf', 'sc', 'ac', 'cd', 'club'],
  ambiguousAlone: [
    'united', 'city', 'town', 'rovers', 'wanderers', 'albion', 'athletic',
    'county', 'real', 'atletico', 'sporting', 'dynamo', 'racing', 'olympique',
  ],
};

// ---- KoraJson-equivalent tolerant readers ----
//
// Kora sends most scalars as strings; these coerce across string/number/bool
// and accept a list of alias keys, trying each in order — same contract as
// Dart's KoraJson.

function koraClean(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text.toLowerCase() === 'null' ? '' : text;
}

function koraStr(json, keys) {
  for (const key of keys) {
    const v = koraClean(json[key]);
    if (v.length > 0) return v;
  }
  return '';
}

function koraInt(json, keys) {
  for (const key of keys) {
    const v = json[key];
    if (typeof v === 'number') return Math.trunc(v);
    const cleaned = koraClean(v);
    if (cleaned.length === 0) continue;
    const parsed = parseInt(cleaned, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

function koraBool(json, keys) {
  for (const key of keys) {
    const value = json[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value).trim().toLowerCase();
    if (text.length === 0 || text === 'null') continue;
    return text !== 'false' && text !== '0' && text !== 'no';
  }
  return false;
}

function koraStrList(json, keys) {
  for (const key of keys) {
    const v = json[key];
    if (Array.isArray(v)) return v.map(koraClean).filter((s) => s.length > 0);
  }
  return [];
}

// ---- codec (port of KoraCodec) ----
//
// One stage: base64 -> XOR with a fixed repeating 16-byte key -> JSON. The
// repeating XOR needs no new host primitive: base64<->hex is enough to do it
// as plain byte arithmetic in JS, which is what this does.

function isPlainJson(text) {
  const t = text.replace(/^\s+/, '');
  return t.startsWith('{') || t.startsWith('[');
}

function unwrapJsonString(text) {
  // The list endpoint wraps the base64 in a JSON string literal (and stray
  // leading newlines), e.g. `\n\n"EEtQ…"`; the detail endpoint sends bare
  // JSON. A payload that isn't a quoted string passes through unchanged.
  if (text.length < 2 || text[0] !== '"') return text;
  try {
    const decoded = JSON.parse(text);
    if (typeof decoded === 'string') return decoded.trim();
  } catch (_) {
    // Not valid JSON — leave it be.
  }
  return text;
}

function asciiToHex(text) {
  let hex = '';
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

function xorHexRepeating(dataHex, keyHex) {
  const keyByteLen = keyHex.length / 2;
  let out = '';
  for (let i = 0; i < dataHex.length; i += 2) {
    const dByte = parseInt(dataHex.substr(i, 2), 16);
    const kByteIndex = ((i / 2) % keyByteLen) * 2;
    const kByte = parseInt(keyHex.substr(kByteIndex, 2), 16);
    out += (dByte ^ kByte).toString(16).padStart(2, '0');
  }
  return out;
}

function tryDecodeKora(text) {
  let dataHex;
  try {
    dataHex = host.codec.base64ToHex(text);
  } catch (_) {
    return null;
  }
  const plainHex = xorHexRepeating(dataHex, asciiToHex(KORA_KEY));
  const plain = host.codec.base64ToText(host.codec.hexToBase64(plainHex));
  // base64ToText never fails (malformed bytes become U+FFFD) — reject those
  // explicitly, to match Dart's strict utf8.decode, which throws (and so
  // returns null) on an invalid byte sequence. Without this, a wrong key
  // could still "succeed" into replacement-character garbage.
  if (plain.indexOf('�') !== -1) return null;
  if (!isPlainJson(plain)) return null;
  try {
    JSON.parse(plain);
  } catch (_) {
    return null;
  }
  return plain;
}

// Opens a Kora response into JSON text. Payloads that are already plain JSON
// pass through untouched, so this is safe to call whether or not a given
// response happens to be encoded.
function decodeKora(raw) {
  const text = unwrapJsonString(raw.trim());
  if (text.length === 0 || isPlainJson(text)) return text;
  const decoded = tryDecodeKora(text);
  if (decoded === null) throw new Error('Response could not be decoded');
  return decoded;
}

// ---- base64url ----

function base64UrlToBase64(token) {
  let normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder !== 0) normalized += '='.repeat(4 - remainder);
  return normalized;
}

// Padding kept, not stripped: Dart's `base64Url.encode` (what
// `KoraSourceId.encode` uses) pads by default, and matching that byte-for-
// byte is what lets `js_kora_conformance_test.dart` compare a JS-produced
// source id against the Dart original directly, not just structurally.
function base64ToBase64Url(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_');
}

// ---- source id (port of KoraSourceId) ----
//
// `resolve` is handed only a source id — the protocol is stateless — so
// everything a resolve needs (edges, edge domain, channel key) is packed
// into the id as base64url JSON. No crypto: this only has to round-trip.

function encodeKoraSourceId(payload) {
  const json = JSON.stringify({
    m: payload.matchId,
    e: payload.edges,
    d: payload.edgeDomain,
    k: payload.key,
    c: payload.ch,
    l: payload.label,
  });
  return base64ToBase64Url(host.codec.textToBase64(json));
}

function decodeKoraSourceId(encoded) {
  const json = host.codec.base64ToText(base64UrlToBase64(encoded));
  const obj = JSON.parse(json);
  return {
    matchId: obj.m,
    edges: obj.e,
    edgeDomain: obj.d,
    key: obj.k,
    ch: obj.c,
    label: obj.l,
  };
}

// ---- frame.php parsing (port of KoraFrameParser) ----
//
// The edge player mints the signed URL server-side and exposes it two ways:
// JSON `{url, exp}` (the token-renewal shape), or embedded in the page as
// `CONFIG.token` — a base64url of the full m3u8 URL. Both are handled; JSON
// is tried first, then scraping. `exp` isn't carried through: PlayableStream
// has no expiry field, it's Kora-internal.

function decodeKoraUrlToken(token) {
  return host.codec.base64ToText(base64UrlToBase64(token));
}

const KORA_TOKEN_PATTERN = /token\s*:\s*"([A-Za-z0-9_\-=]+)"/;
const KORA_CHANNEL_PATTERN = /channel\s*:\s*"([^"]*)"/;

function parseKoraFrame(body, headers) {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      const url = koraStr(obj, ['url']);
      if (url.length > 0) {
        return { url, headers, channel: koraStr(obj, ['channel', 'ch']) };
      }
    } catch (_) {
      // Fall through to the scrape path.
    }
  }

  const token = KORA_TOKEN_PATTERN.exec(body);
  if (token) {
    const url = decodeKoraUrlToken(token[1]);
    const channel = KORA_CHANNEL_PATTERN.exec(body);
    return { url, headers, channel: channel ? channel[1] : '' };
  }

  throw new Error('frame.php response carries no stream token');
}

// ---- status mapping + candidates (port of KoraBroadcastSource) ----

function koraStatusOf(statusCode) {
  switch (statusCode) {
    case 0:
      return 'upcoming';
    case 1:
      return 'live';
    case 2:
      return 'ended';
    default:
      return 'unknown';
  }
}

// Kora publishes kick-off in GMT with no zone marker (the player labels it
// "GMT") — appending Z directly is the correct read, not device-local.
function koraKickoffUtc(dateStr, timeStr) {
  if (!dateStr) return null;
  const iso = timeStr ? `${dateStr}T${timeStr}:00Z` : `${dateStr}T00:00:00Z`;
  const parsed = new Date(iso);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Football candidates, live or upcoming with channels — matches
// KoraBroadcastSource.candidatesFrom. Keeps the raw match object alongside
// so the matched candidate's id can be read back out by index (see M18: the
// matcher returns an index, never a payload).
function koraCandidatesFrom(matches) {
  const out = [];
  for (const m of matches) {
    if (!koraBool(m, ['has_channels'])) continue;
    const status = koraStatusOf(koraInt(m, ['status']));
    if (status !== 'live' && status !== 'upcoming') continue;
    out.push({
      teamA: koraStr(m, ['home_en', 'home']),
      teamB: koraStr(m, ['away_en', 'away']),
      startsAt: koraKickoffUtc(koraStr(m, ['date']), koraStr(m, ['time'])),
      match: m,
    });
  }
  return out;
}

// Edge channels only, encoded into resolvable source ids — matches
// KoraBroadcastSource.sourcesFromDetail.
function koraSourcesFromDetail(detail) {
  const edges = koraStrList(detail, ['edges']);
  const edgeDomain = koraStr(detail, ['edge_domain']);
  const channels = Array.isArray(detail.channels) ? detail.channels : [];
  const matchId = koraStr(detail, ['id']);

  const sources = [];
  for (const channel of channels) {
    if (!koraBool(channel, ['edge'])) continue;
    const key = koraStr(channel, ['key', 'ch']);
    if (key.length === 0 || edges.length === 0 || edgeDomain.length === 0) {
      continue;
    }
    const label = koraStr(channel, ['name', 'label', 'server_name', 'quality']) || 'Kora';
    const sourceId = `${KORA_PROVIDER_KEY}:${key}`;
    const id = encodeKoraSourceId({
      matchId,
      edges,
      edgeDomain,
      key,
      ch: koraStr(channel, ['ch']),
      label,
    });
    sources.push({ id: `${KORA_PROVIDER_KEY}:${id}`, label, provider: 'Nimora', providerId: 'nimora.kora' });
  }
  return sources;
}

// ---- network ----

function withQuery(url, query) {
  const parts = Object.entries(query).map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
  );
  return parts.length ? `${url}?${parts.join('&')}` : url;
}

function koraCacheBuster(date) {
  const p2 = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${p2(date.getUTCMonth() + 1)}` +
    `${p2(date.getUTCDate())}${p2(date.getUTCHours())}${p2(date.getUTCMinutes())}`
  );
}

async function koraGetText(url, headers) {
  const response = await fetch(url, { headers });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Request to ${url} failed: ${response.status}`);
  }
  return response.body;
}

async function fetchKoraMatches() {
  const now = new Date();
  const date =
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}` +
    `-${String(now.getUTCDate()).padStart(2, '0')}`;
  const url = withQuery(`${KORA_LIST_BASE}matches/${date}`, {
    t: koraCacheBuster(now),
  });
  const body = await koraGetText(url, {
    'User-Agent': KORA_DEFAULT_UA,
    Accept: 'application/json, text/plain, */*',
  });
  if (body.trim().length === 0) return [];
  const data = JSON.parse(decodeKora(body));
  if (!Array.isArray(data)) {
    throw new Error('Kora matches response is not a JSON array');
  }
  return data;
}

async function fetchKoraDetail(matchId) {
  const url = withQuery(`${KORA_DETAIL_BASE}matche/${matchId}/ar`, {
    t: Date.now(),
  });
  const body = await koraGetText(url, {
    'User-Agent': KORA_DEFAULT_UA,
    Accept: 'application/json, text/plain, */*',
  });
  const data = JSON.parse(decodeKora(body));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`Detail for match ${matchId} is not a JSON object`);
  }
  return data;
}

function koraUuidV4() {
  const bytes = [];
  for (let i = 0; i < 16; i++) bytes.push(Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = (a, b) =>
    bytes.slice(a, b).map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-${hex(8, 10)}-${hex(10, 16)}`;
}

// Frame headers a browser sends loading frame.php as a cross-site iframe.
// The edge hosts 302 away anything that looks automated, so the request has
// to look like the real player's — no Referer needed, it sends none either.
function koraFrameHeaders() {
  return {
    'User-Agent': KORA_BROWSER_UA,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,' +
      'image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.8',
    'sec-ch-ua': '"Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': 'iframe',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Upgrade-Insecure-Requests': '1',
  };
}

function koraFrameUrl(edge, edgeDomain, query) {
  const configuredBase = globalThis.__koraEdgeBaseUrl;
  const base = typeof configuredBase === 'string' && configuredBase.length > 0
    ? `${configuredBase.replace(/\/$/, '')}/${edge}/frame.php`
    : `https://${edge}.${edgeDomain}/frame.php`;
  return withQuery(base, query);
}

// A frame.php response only proves that an edge can mint an HLS URL. It does
// not prove the edge will keep serving a moving live playlist. Keep a small,
// in-memory cursor per stable source id so a player re-resolve after a live
// stall starts at a different edge instead of pinning itself to edges[0].
// The cursor deliberately never enters the source id: it is a session-local
// transport choice, not a new user-visible source.
const koraLastResolvedEdgeBySource =
  globalThis.__koraLastResolvedEdgeBySource ||
  (globalThis.__koraLastResolvedEdgeBySource = Object.create(null));

function koraEdgesForResolve(sourceKey, edges) {
  const uniqueEdges = [];
  for (const edge of edges) {
    if (typeof edge === 'string' && edge.length > 0 && uniqueEdges.indexOf(edge) === -1) {
      uniqueEdges.push(edge);
    }
  }
  if (uniqueEdges.length === 0) return uniqueEdges;

  const previousEdge = koraLastResolvedEdgeBySource[sourceKey];
  const previousIndex = uniqueEdges.indexOf(previousEdge);
  // A fresh extension session must not always prefer the first published
  // edge. Once an edge has been used, every subsequent resolve is strictly
  // round-robin so stall recovery gets a different route.
  const start = previousIndex >= 0
    ? (previousIndex + 1) % uniqueEdges.length
    : Math.floor(Math.random() * uniqueEdges.length);
  return [
    ...uniqueEdges.slice(start),
    ...uniqueEdges.slice(0, start),
  ];
}

async function resolveKoraSource(sourceId) {
  const prefix = `${KORA_PROVIDER_KEY}:`;
  const inner = sourceId.startsWith(prefix)
    ? sourceId.slice(prefix.length)
    : sourceId;
  const decoded = decodeKoraSourceId(inner);
  if (!decoded.edges || decoded.edges.length === 0 || !decoded.edgeDomain) {
    throw new Error('Kora source has no edge nodes to resolve from');
  }
  const chParam = decoded.ch || decoded.key;
  if (!chParam) throw new Error('Kora source has no stream key');

  let lastError = null;
  for (const edge of koraEdgesForResolve(inner, decoded.edges)) {
    const requestUrl = koraFrameUrl(edge, decoded.edgeDomain, {
      ch: chParam,
      p: String(KORA_PLAYER_VALUE),
      token: koraUuidV4(),
      kt: String(Math.floor(Date.now() / 1000)),
    });
    try {
      const body = await koraGetText(requestUrl, koraFrameHeaders());
      // The player carries a browser User-Agent into the m3u8/segment requests.
      const stream = parseKoraFrame(body, { 'User-Agent': KORA_BROWSER_UA });
      if (!/^https?:\/\//i.test(stream.url)) throw new Error('Kora frame returned an invalid stream URL');
      koraLastResolvedEdgeBySource[inner] = edge;
      return { url: stream.url, headers: stream.headers, format: 'hls', label: decoded.label };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Kora edge resolution failed');
}

async function koraSources(args) {
  const item = args.item;
  if (!item.participants || item.participants.length !== 2) {
    return { sources: [] };
  }
  const enabled = args.enabledProviders;
  if (enabled != null && enabled.indexOf(KORA_PROVIDER_ID) === -1) {
    return { sources: [] };
  }

  // Tolerant of this source failing — one broadcast source being down
  // shouldn't block whatever else is looking for sources on this item.
  let matches;
  try {
    matches = await fetchKoraMatches();
  } catch (_) {
    return { sources: [] };
  }
  const candidates = koraCandidatesFrom(matches);
  if (candidates.length === 0) return { sources: [] };

  const result = host.match.resolve(
    {
      teamA: item.participants[0].name,
      teamB: item.participants[1].name,
      teamAShort: item.participants[0].shortName || null,
      teamBShort: item.participants[1].shortName || null,
      kickoff: item.schedule ? item.schedule.startsAt : null,
    },
    candidates.map((c) => ({ teamA: c.teamA, teamB: c.teamB, startsAt: c.startsAt })),
    { profile: FOOTBALL_PROFILE },
  );
  if (!result) return { sources: [] };

  const matchId = koraStr(candidates[result.index].match, ['id']);
  let detail;
  try {
    detail = await fetchKoraDetail(matchId);
  } catch (_) {
    return { sources: [] };
  }
  return { sources: koraSourcesFromDetail(detail) };
}

// ---- stream provider registry ----
//
// Kora is the first stream provider registered here; Cricfy (cricfy.js) is
// the second. Both push themselves onto this array instead of assigning
// `__extension.sources`/`.resolve` directly, so loading one after the other
// doesn't stomp whichever loaded first. The aggregator below — installed once,
// idempotently, by whichever provider file happens to load first — fans a
// `sources()` call out to every registered provider (tolerant of one
// provider failing, same as Dart's `FvckExtension._sourcesFrom`) and unions
// the results, then routes `resolve()` by the `providerKey:` prefix each
// provider's own source ids carry, mirroring `FvckExtension.resolve` exactly.
globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: KORA_PROVIDER_KEY,
  sources: koraSources,
  resolve: (sourceId) => resolveKoraSource(sourceId),
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.sources) {
  globalThis.__extension.sources = async (args) => {
    const calls = globalThis.__streamProviders.map((p) =>
      Promise.resolve()
        .then(() => p.sources(args))
        .catch(() => ({ sources: [] })),
    );
    if (args.fast !== true) {
      const perProvider = await Promise.all(calls);
      return { sources: perProvider.flatMap((r) => r.sources) };
    }
    return new Promise((resolve) => {
      let remaining = calls.length;
      let returned = false;
      for (const call of calls) {
        call.then((result) => {
          if (returned) return;
          const sources = Array.isArray(result.sources) ? result.sources : [];
          if (sources.length > 0) {
            returned = true;
            resolve({ sources });
            return;
          }
          remaining -= 1;
          if (remaining === 0) resolve({ sources: [] });
        });
      }
    });
  };
  globalThis.__extension.resolve = async (args) => {
    const sourceId = args.sourceId;
    const separator = sourceId.indexOf(':');
    if (separator < 0) {
      throw new Error(`Malformed source id: ${sourceId}`);
    }
    const providerKey = sourceId.slice(0, separator);
    const provider = globalThis.__streamProviders.find(
      (p) => p.providerKey === providerKey,
    );
    if (!provider) {
      throw new Error(`No stream provider registered for "${providerKey}"`);
    }
    return provider.resolve(sourceId);
  };
}

// MovieBox (aoneroom) as a stream provider, over the host `fetch` API.
//
// Ported from CineStream's `invokeMoviebox` (CineStreamExtractors.kt). Four
// steps, and each one needs the previous:
//
//   1. a bearer token, read from the `x-user` *response header* of an
//      otherwise uninteresting "latest app packages" call
//   2. a search by title, which yields a `subjectId`
//   3. a `detailPath` for that subject, from a second host
//   4. `subject/play` + `subject/download`, which finally carry URLs
//
// Step 1 is why this provider exists here at all: it needs to read a response
// header, which the host `fetch` does expose (verified — `res.headers` is
// populated). Nothing else in this extension had needed one.
//
// Unlike every other provider here, MovieBox is keyed by **title**, not by a
// tmdb id — it has no idea what TMDB is. That makes matching the weak point:
// its index is regionally skewed (searching an English title readily returns
// unrelated Indonesian ones), so titles are compared exactly rather than
// fuzzily, and a near-miss is dropped instead of guessed at. Playing the
// wrong film is worse than offering nothing.
//
// An episode gets its *series* title from `extra.seriesTitle` — the item's own
// `title` is the episode's ("Ep 3 (S2E3)"), which would find nothing.

const MOVIEBOX_API = globalThis.__movieboxApiUrl || 'https://h5-api.aoneroom.com';
const MOVIEBOX_WEB = globalThis.__movieboxWebUrl || 'https://h5.aoneroom.com';

const MOVIEBOX_PROVIDER_KEY = 'moviebox';

// The upstream serves these only to its own player origin.
const MOVIEBOX_PLAYER_ORIGIN = 'https://fmoviesunblocked.net';
const MOVIEBOX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/138.0.0.0';

// A trailing season range — "Breaking Bad [Indonesian] S1-S2" — is how the
// index names a whole show, and is not part of the title being matched.
const MOVIEBOX_SEASON_SUFFIX = /\s+S\d+(?:-S?\d+)*$/i;

// "Title [Indonesian]" is the same subject in another dub; the bracket is the
// language, and worth keeping as a label rather than discarding.
const MOVIEBOX_LANGUAGE_SUFFIX = /^(.*?)(?:\s+\[([^\]]+)\])?$/;

// The token is a short-lived JWT handed out to anyone who asks, so it is
// fetched per call rather than cached: a stale one fails the whole chain, and
// the request that mints it is cheap.
async function movieboxToken() {
  let response;
  try {
    response = await fetch(
      `${MOVIEBOX_API}/wefeed-h5api-bff/app/get-latest-app-pkgs?app_name=moviebox`,
      { headers: { 'User-Agent': MOVIEBOX_UA } },
    );
  } catch (_) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;

  const headers = response.headers || {};
  const raw = headers['x-user'] || headers['X-User'];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.token ? parsed.token : null;
  } catch (_) {
    return null;
  }
}

function movieboxHeaders(token, extra) {
  return {
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.5',
    'X-Client-Info': '{"timezone":"Africa/Nairobi"}',
    Authorization: `Bearer ${token}`,
    'User-Agent': MOVIEBOX_UA,
    Referer: MOVIEBOX_API,
    ...(extra || {}),
  };
}

// Responses nest as `{data: {...}}` or `{data: {data: {...}}}` depending on
// the endpoint.
function movieboxUnwrap(payload) {
  const data = payload && payload.data;
  if (!data) return payload || {};
  return data.data || data;
}

async function movieboxJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (_) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;
  try {
    return JSON.parse(response.body);
  } catch (_) {
    return null;
  }
}

// Subjects whose title matches `title` exactly, once a season range is
// stripped and a language bracket set aside.
function movieboxMatches(items, title) {
  const wanted = `${title}`.trim().toLowerCase();
  const found = [];
  const seen = {};
  for (const item of items) {
    if (!item || !item.subjectId) continue;
    const raw = `${item.title || ''}`.replace(MOVIEBOX_SEASON_SUFFIX, '').trim();
    const parts = MOVIEBOX_LANGUAGE_SUFFIX.exec(raw);
    if (!parts) continue;
    const name = (parts[1] || '').trim().toLowerCase();
    if (name !== wanted) continue;

    const id = `${item.subjectId}`;
    if (seen[id]) continue;
    seen[id] = true;
    found.push({ subjectId: id, language: parts[2] || 'Original' });
  }
  return found;
}

async function movieboxSearch(token, title, isSeries) {
  const payload = await movieboxJson(
    `${MOVIEBOX_API}/wefeed-h5api-bff/subject/search`,
    {
      method: 'POST',
      headers: movieboxHeaders(token, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        keyword: title,
        page: 1,
        perPage: 24,
        subjectType: isSeries ? 2 : 1,
      }),
    },
  );
  const items = movieboxUnwrap(payload).items;
  return Array.isArray(items) ? movieboxMatches(items, title) : [];
}

// A subject's `detailPath`, which `play`/`download` both require. Served by a
// different host than everything else, and without a token.
async function movieboxDetailPath(subjectId) {
  const payload = await movieboxJson(
    `${MOVIEBOX_WEB}/wefeed-h5-bff/web/post/list/subject?id=${encodeURIComponent(subjectId)}`,
    { headers: { 'User-Agent': MOVIEBOX_UA } },
  );
  const items = (payload && payload.data && payload.data.items) || [];
  const subject = items[0] && items[0].subject;
  return (subject && subject.detailPath) || null;
}

function encodeMovieboxSourceId(payload) {
  return base64ToBase64Url(host.codec.textToBase64(JSON.stringify(payload)));
}

function decodeMovieboxSourceId(encoded) {
  return JSON.parse(host.codec.base64ToText(base64UrlToBase64(encoded)));
}

// the item's `movie:<tmdbId>` / `series:<tmdbId>` ref id, when it came
// from there. MovieBox itself never needs it — it searches by name — but the
// shegu.st subtitle fallback is keyed by tmdbId, so it is carried along when
// available and simply absent when not.
function movieboxTmdbOf(item) {
  const refId = (item.ref && item.ref.id) || '';
  if (typeof refId !== 'string') return null;
  const separator = refId.indexOf(':');
  if (separator < 0) return null;
  const kind = refId.slice(0, separator);
  const tmdbId = refId.slice(separator + 1);
  if ((kind !== 'movie' && kind !== 'series') || !tmdbId) return null;
  return tmdbId;
}

// The title to search on: a series' own name, never the episode's.
function movieboxTitleOf(item) {
  const extra = item.extra || {};
  const seriesTitle = extra.seriesTitle;
  if (typeof seriesTitle === 'string' && seriesTitle.length > 0) {
    return seriesTitle;
  }
  return typeof item.title === 'string' ? item.title : '';
}

// sources() — one entry per matching subject.
//
// Stops after the search: `detailPath` and the play/download calls are three
// more round trips per subject, and resolve() needs fresh URLs anyway.
async function movieboxListSources(args) {
  const item = args.item || {};
  const kind = item.kind;

  // Only the VOD kinds; a fixture has no title to look up here.
  const isSeries = kind === 'episode' || kind === 'series';
  if (kind !== 'video' && !isSeries) return { sources: [] };
  if (isSeries) return { sources: [] };

  const title = movieboxTitleOf(item);
  if (!title) return { sources: [] };

  const token = await movieboxToken();
  if (!token) return { sources: [] };

  const subjects = await movieboxSearch(token, title, isSeries);
  const tmdbId = movieboxTmdbOf(item);

  return {
    sources: subjects.map((subject, index) => {
      const id = `${MOVIEBOX_PROVIDER_KEY}:${encodeMovieboxSourceId({
        s: subject.subjectId,
        ...(tmdbId ? { m: tmdbId } : {}),
      })}`;
      // Keep the provider name and language; do not mask the source with an alias.
      const lang =
        subject.language === 'Original' ? '' : ` [${subject.language}]`;
      return {
        id,
        label: `MovieBox${lang}`,
        provider: 'Nimora',
        providerId: 'nimora.moviebox',
      };
    }),
  };
}

// Streams from `play`, plus `download`'s own list — the two overlap but each
// carries entries the other doesn't. VIP-locked entries are dropped: they
// resolve to something the viewer cannot actually play.
function movieboxStreams(playData, downloadData) {
  const out = [];
  for (const stream of playData.streams || []) {
    if (!stream || !stream.url || stream.vipLocked) continue;
    out.push({ url: stream.url, format: stream.format });
  }
  for (const download of downloadData.downloads || []) {
    if (!download || !download.url || download.vipLocked) continue;
    out.push({ url: download.url, format: download.format });
  }
  return out;
}

function movieboxCaptions(downloadData) {
  const captions = downloadData.captions;
  if (!Array.isArray(captions)) return [];
  return captions
    .filter((c) => c && typeof c.url === 'string' && c.url.length > 0)
    .map((c) => ({
      language: c.lan || c.lanName || '',
      url: c.url,
      label: c.lanName || c.lan || '',
    }));
}

function movieboxStreamFormat(stream) {
  const url = `${stream.url || ''}`;
  const format = `${stream.format || ''}`.toLowerCase();
  if (
    format === 'hls' ||
    /\.m3u8(?:$|\?)/i.test(url) ||
    /(?:^|\/)playlist(?:\/|$)/i.test(url)
  ) {
    return 'hls';
  }
  if (format === 'dash' || /\.mpd(?:$|\?)/i.test(url)) return 'dash';
  return 'other';
}

async function movieboxResolveSource(sourceId) {
  const prefix = `${MOVIEBOX_PROVIDER_KEY}:`;
  if (!sourceId.startsWith(prefix)) {
    throw new Error(`Invalid MovieBox sourceId: ${sourceId}`);
  }
  const decoded = decodeMovieboxSourceId(sourceId.slice(prefix.length));
  const { s: subjectId, m: tmdbId, se: season, ep: episode } = decoded;

  const token = await movieboxToken();
  if (!token) throw new Error('MovieBox: no token');

  const detailPath = await movieboxDetailPath(subjectId);
  if (!detailPath) throw new Error('MovieBox: no detailPath for subject');

  let params = `subjectId=${encodeURIComponent(subjectId)}`;
  if (season != null) {
    params += `&se=${encodeURIComponent(season)}&ep=${encodeURIComponent(episode)}`;
  }
  params += `&detailPath=${encodeURIComponent(detailPath)}`;

  const headers = movieboxHeaders(token, {
    Origin: MOVIEBOX_PLAYER_ORIGIN,
    Referer: `${MOVIEBOX_PLAYER_ORIGIN}/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail`,
  });
  const playbackReferer = headers.Referer;

  const [play, download] = await Promise.all([
    movieboxJson(`${MOVIEBOX_API}/wefeed-h5api-bff/subject/play?${params}`, {
      headers,
    }),
    movieboxJson(`${MOVIEBOX_API}/wefeed-h5api-bff/subject/download?${params}`, {
      headers,
    }),
  ]);

  const playData = movieboxUnwrap(play);
  const downloadData = movieboxUnwrap(download);
  const streams = movieboxStreams(playData, downloadData);
  if (streams.length === 0) {
    throw new Error('MovieBox: no playable stream for this subject');
  }

  const chosen = streams[0];
  // Some MovieBox playlists use `/playlist/` without an `.m3u8` suffix.
  // Preserve the provider's format, but recognize that URL shape as HLS so
  // the native player selects the playlist extractor.
  const format = movieboxStreamFormat(chosen);

  // Only captions advertised by MovieBox belong to this resolved source.
  // Shegu is an independent external-subtitles provider and is fetched by
  // the app only after the viewer asks for external subtitles.
  const subtitles = movieboxCaptions(downloadData);

  return {
    url: chosen.url,
    format,
    headers: {
      Origin: MOVIEBOX_PLAYER_ORIGIN,
      Referer: playbackReferer,
      'User-Agent': MOVIEBOX_UA,
    },
    subtitles,
  };
}

// ---- registration — see kora.js's tail for the shared aggregator ----

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: MOVIEBOX_PROVIDER_KEY,
  sources: movieboxListSources,
  resolve: (sourceId) => movieboxResolveSource(sourceId),
});

// Cricfy's content-list cipher, in JS on the host `crypto`/`codec` API.
//
// A port of Cricfy's content cipher. This is
// the hard case for the host API on purpose: it is the most hostile shape
// either provider has — derived AES key, swapped-alphabet base64, a
// code-unit-level scramble, and a payload that may need repairing.
//
//   stage 1: base64 -> flip -> check sentinel -> strip sentinel
//   stage 2: base64 -> AES-128-CBC -> flip -> base64 -> JSON
//
// Every constant is already decoded from the APK and covered by fixed vectors.

const SENTINEL = 'abcdefghijklmnop';
const FALLBACK_KEY = 'WT1sdkEvUlR4ckd2';
const IV = 'Q7sKcm9LR4VaX2pN';
const CERT_HASH =
  '42d56eca078d4521a1920a61e14a81fd674f91f2c55c53b42d3924c26e3f3835';
const ENTRY_HASH =
  '43744467f50639590811a23c84c6bf35e1394e73a80519dcbea97c805ab68c59';
const SALT = 'bf4b0a33d0f56bf8166fc55adbbcdd0a8a68e72615644a12';
const MASK_HEX = '4d6681537371296d4fc2168d7be6b308';

// `swapPairs` then `reverse`, over UTF-16 code units.
//
// This is the transform PLAN.md §18 flagged as non-portable, to be kept in
// Dart or rewritten byte-only. Neither turned out to be necessary: JS strings
// are UTF-16 like Dart's, so it ports as-is — *provided* the UTF-8 decode
// that produces the string is a host primitive, so malformed input becomes
// U+FFFD identically on both sides rather than diverging here.
function flip(value) {
  const units = Array.from(value, (c) => c.charCodeAt(0));
  for (let i = 0; i + 1 < units.length; i += 2) {
    const temp = units[i];
    units[i] = units[i + 1];
    units[i + 1] = temp;
  }
  units.reverse();
  return units.map((u) => String.fromCharCode(u)).join('');
}

/// The AES-128 key the APK derives from its own hashes, as base64.
function derivedKey() {
  const digest = host.crypto.sha256(
    host.codec.textToBase64(`${CERT_HASH}:${ENTRY_HASH}:${SALT}`),
  );
  // xor truncates to the shorter side, so masking a 32-byte digest with the
  // 16-byte mask yields the 16-byte key directly.
  return host.crypto.xor(digest, host.codec.hexToBase64(MASK_HEX));
}

// Keeps only valid base64 characters, then pads.
function cleanBase64(value) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const valid =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (valid) out += value[i];
  }
  const remainder = out.length % 4;
  return remainder === 0 ? out : out + '='.repeat(4 - remainder);
}

function parses(value) {
  try {
    JSON.parse(value);
    return true;
  } catch (_) {
    return false;
  }
}

// Trims a truncated JSON tail back to the last complete element.
function repairJsonTail(value) {
  const text = value.trim();
  if (text.length === 0 || parses(text)) return text;

  const closing = text.startsWith('[') ? ']' : '}';
  for (let i = text.length - 1; i > 0; i--) {
    if (text[i] !== '}') continue;
    const candidate = text.substring(0, i + 1) + closing;
    if (parses(candidate)) return candidate;
  }
  return text;
}

/// Opens a content-list response into JSON, or returns null if `raw` isn't
/// this shape of payload.
function decode(raw) {
  const text = raw.trim();
  if (text.length === 0) return null;

  let stage1;
  try {
    stage1 = flip(host.codec.base64ToText(text));
  } catch (_) {
    return null;
  }
  if (!stage1.endsWith(SENTINEL)) return null;

  const payload = stage1.substring(0, stage1.length - SENTINEL.length);
  const iv = host.codec.textToBase64(IV);

  // Same order as the APK: derived key first, then the fallback.
  for (const key of [derivedKey(), host.codec.textToBase64(FALLBACK_KEY)]) {
    const plain = host.crypto.aesCbcDecrypt(key, iv, cleanBase64(payload));
    if (plain === null) continue;

    const cleaned = cleanBase64(flip(host.codec.base64ToText(plain)));
    if (cleaned.length === 0) continue;
    try {
      return repairJsonTail(host.codec.base64ToText(cleaned));
    } catch (_) {
      continue;
    }
  }
  return null;
}

globalThis.cricfyCipher = { derivedKey, decode };

// Cricfy as a stream provider, in JS on the host `fetch`/`crypto`/`codec`/
// `match` API — the harder of the two providers ported so far (see
// cricfy_cipher.js, M14): not just a decode, but the full config → signed
// URL → event list → link list → exchange/token resolution pipeline.
//
// A JavaScript port of the Cricfy upstream protocol.
// Loaded alongside fixtures.js, kora.js, and cricfy_cipher.js (see
// manifest.json and the app's loader, which concatenates them all — there is
// no real bundler yet). Registers itself into `globalThis.__streamProviders`, the
// same registry kora.js's tail installs the aggregator for; adds a second
// entry rather than a second `__extension.sources` assignment.
//
// Reuses FOOTBALL_PROFILE from kora.js rather than redeclaring it: both
// providers are football-only and both need the same alias/stop-token
// knowledge, exactly mirroring how the Dart side runs one shared
// `EventMatchResolver` across every `BroadcastCandidateSource` in
// `FvckExtension` — the concatenated single-scope "bundle" is what makes
// sharing a plain top-level `const` possible.

// Overridable purely for tests — see fixtures.js/kora.js's identical pattern.
// `configMirrors: []` here matches `CricfyClient(configMirrors: [])` in
// the fixture tests: an empty list forces the fallback-config path
// immediately, no network round trip.
const CRICFY_CONFIG_MIRRORS =
  globalThis.__cricfyConfigMirrors === undefined
    ? ['https://p.genzdev.xyz/1-xnavxf.json', 'https://c.playtek.xyz/1-xnavxf.json']
    : globalThis.__cricfyConfigMirrors;
const CRICFY_API_BASE_URL =
  globalThis.__cricfyApiBaseUrl || 'https://cricyplayers.com/data/';

const CRICFY_GETDATA_ENDPOINT = 'getData.php';
const CRICFY_GETDATA_PATH_PREFIX = 'v2/';
const CRICFY_GETDATA_TOKEN =
  '8f4gha9affeegg7cigafdgc7hegfkefaicigdgg1haffhekgeeigcfgahedfhef';
const CRICFY_EVENTS_PATH = 'events.txt';
const CRICFY_EVENT_LINKS_PREFIX = 'pro/';
const CRICFY_DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 10; Pixel 3 XL) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';
const CRICFY_CONFIG_UA = 'Mozilla/5.0 Cricfy2/1.0';

const CRICFY_PROVIDER_KEY = 'cricfy';
const CRICFY_PROVIDER_ID = 'nimora.cricfy';

// Cricfy's own API answers in ~20 s when it is having a bad day, well past
// the engine-wide fetch budget every provider shares. Asking for more time
// on *these* calls only (see JsEngine's `timeoutMs`) keeps the fan-out to
// every other provider as tight as it was: this is the one host that needs
// it, so it is the only one that gets it. A host too old to know the option
// ignores it and times out as before.
const CRICFY_CONTENT_TIMEOUT_MS = 30 * 1000;

// The event list, kept across app launches (see `host.storage`). A cold
// start would otherwise have to wait out that same slow call before it could
// offer a single source, inside a discovery budget that has no room for it.
// Held longer than the in-session memo because its job is different: not
// "is this fresh?" but "is there anything at all to work from while the
// fresh copy is on its way?".
const CRICFY_EVENTS_CACHE_KEY = 'cricfy.events.v1';
const CRICFY_EVENTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// ---- codec (port of CricfyCodec, minus CricfyContentCipher — see
// cricfy_cipher.js, M14) ----

const CRICFY_CONFIG_PREFIX = 'cfj1:';
const CRICFY_A0 = [0x1d, 0x58, 0x11, 0x68, 0x42, 0x07, 0x5b, 0x22, 0x71, 0x05, 0x2f, 0x60];
const CRICFY_A1 = [0x47, 0x0c, 0x53, 0x2c, 0x09, 0x79, 0x24, 0x3a, 0x65, 0x16, 0x3f];
const CRICFY_A2 = [
  0x06, 0x27, 0x5f, 0x0e, 0x4a, 0x34, 0x75, 0x1b, 0x44, 0x03, 0x56, 0x29, 0x6d,
];
const CRICFY_PLAIN_ALPHABET =
  'aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ';
const CRICFY_CIPHER_ALPHABET =
  'fFgGjJkKaApPbBmMoOzZeEnNcCdDrRqQtTvVuUxXhHiIwWyYlLsS';

function cricfyConfigMaterial() {
  const out = new Array(32).fill(0);
  for (let i = 0; i < out.length; i++) {
    const rotation = i & 7;
    const source = CRICFY_A1[(3 * i + 1) % CRICFY_A1.length];
    const rotated = ((source << rotation) | (source >>> (8 - rotation))) & 0xff;
    out[i] =
      (CRICFY_A0[i % CRICFY_A0.length] ^
        rotated ^
        CRICFY_A2[(5 * i + 2) % CRICFY_A2.length] ^
        0x5a ^
        i) &
      0xff;
  }
  return out;
}

function decodeCricfyConfigPayload(raw) {
  let text = raw.trim();
  if (text.startsWith('{') || text.startsWith('[')) return text;
  if (text.startsWith(CRICFY_CONFIG_PREFIX)) {
    text = text.slice(CRICFY_CONFIG_PREFIX.length);
  }
  text = text.replace(/[\r\n\t ]/g, '');

  const dataHex = host.codec.base64ToHex(text);
  const material = cricfyConfigMaterial();
  const len = dataHex.length / 2;
  const outBytes = new Array(len);
  for (let i = 0; i < len; i++) {
    const dByte = parseInt(dataHex.substr(i * 2, 2), 16);
    const value =
      (material[i % material.length] ^ dByte ^ ((0x1d * i + 0x47) & 0xff)) & 0xff;
    outBytes[len - 1 - i] = value;
  }
  const outHex = outBytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return host.codec.base64ToText(host.codec.hexToBase64(outHex)).trim();
}

// Opens a `getData.php` response, whatever shape it's in: an already-plain
// response passes through, content lists go through `cricfyCipher` (the AES
// path, cricfy_cipher.js), everything else through the substituted-alphabet
// `decodeCricfyPayload`.
function decodeCricfyResponse(raw) {
  const text = raw.trim();
  if (text.length === 0 || text.startsWith('[') || text.startsWith('{')) {
    return text;
  }
  const viaCipher = cricfyCipher.decode(text);
  if (viaCipher !== null && viaCipher.length > 0) return viaCipher;
  return decodeCricfyPayload(text);
}

function decodeCricfyPayload(raw) {
  const text = raw.trim();
  if (text.length === 0 || text.startsWith('[') || text.startsWith('{')) {
    return text;
  }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const idx = CRICFY_CIPHER_ALPHABET.indexOf(ch);
    out += idx < 0 ? ch : CRICFY_PLAIN_ALPHABET[idx];
  }
  return host.codec.base64ToText(out);
}

// XORs every UTF-8 byte with 0x5a then hex-encodes — the `key`/`hmac` on a
// signed URL. `base64ToHex` does the byte extraction; the XOR itself is
// plain hex-pair arithmetic in JS, the same approach kora.js's repeating XOR
// uses, and (again) needs no new host primitive.
function cricfyXorHex(value) {
  const hex = host.codec.base64ToHex(host.codec.textToBase64(value));
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substr(i, 2), 16);
    out += (byte ^ 0x5a).toString(16).padStart(2, '0');
  }
  return out;
}

// ---- urls (port of CricfyUrls) ----

function cricfyIsFullUrl(value) {
  const lower = value.trim().toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

function cricfyTrimLeadingSlash(value) {
  let i = 0;
  while (i < value.length && value[i] === '/') i++;
  return value.slice(i);
}

function cricfyLastPartLooksLikeFile(value) {
  const slash = value.lastIndexOf('/');
  const last = slash < 0 ? value : value.slice(slash + 1);
  return last.indexOf('.') !== -1;
}

function cricfyJoinUrl(base, path) {
  if (base.length === 0) return path;
  if (path.length === 0) return base;
  const left = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${left}/${cricfyTrimLeadingSlash(path)}`;
}

function cricfyNormalizeHost(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !cricfyIsFullUrl(trimmed)) return '';
  if (trimmed.endsWith('/')) return trimmed;
  if (cricfyLastPartLooksLikeFile(trimmed)) {
    const slash = trimmed.lastIndexOf('/');
    return slash < 0 ? `${trimmed}/` : trimmed.slice(0, slash + 1);
  }
  return `${trimmed}/`;
}

function cricfyStripV2Host(value) {
  return value.toLowerCase().endsWith('/v2/') ? value.slice(0, -3) : value;
}

function cricfyApplyPathPrefix(path, prefix) {
  const cleanPath = cricfyTrimLeadingSlash(path);
  let cleanPrefix = cricfyTrimLeadingSlash(prefix);
  if (cleanPrefix.length === 0) return cleanPath;
  if (!cleanPrefix.endsWith('/')) cleanPrefix += '/';
  if (cleanPath.startsWith(cleanPrefix)) return cleanPath;
  return `${cleanPrefix}${cleanPath}`;
}

function cricfyBuildSignedUrl({ base, endpoint, path, prefix, token, nowMillis }) {
  const host_ = cricfyNormalizeHost(cricfyStripV2Host(base));
  const fullPath = cricfyApplyPathPrefix(path, prefix);
  const millis = nowMillis != null ? nowMillis : Date.now();
  const key = cricfyXorHex(fullPath);
  const hmac = cricfyXorHex(`${millis}|${token}`);
  return `${cricfyJoinUrl(host_, endpoint)}?key=${key}&hmac=${hmac}`;
}

// Minimal `http(s)://host[:port]/path` parser — QuickJS has no `URL` global,
// and this client only ever needs host+path out of an absolute URL.
function cricfyParseUrl(value) {
  const m = /^https?:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(value);
  if (!m) return null;
  return { host: m[1], path: m[2] || '/' };
}

function cricfyRelativeToBase(url, base) {
  const host_ = cricfyNormalizeHost(cricfyStripV2Host(base));
  if (host_.length > 0 && url.startsWith(host_)) {
    return cricfyTrimLeadingSlash(url.slice(host_.length));
  }
  const parsed = cricfyParseUrl(url);
  const baseParsed = cricfyParseUrl(host_);
  if (!parsed || !baseParsed) return '';
  if (parsed.host !== baseParsed.host) return '';
  let path = cricfyTrimLeadingSlash(parsed.path);
  const basePath = cricfyTrimLeadingSlash(baseParsed.path);
  if (basePath.length > 0 && path.startsWith(basePath)) {
    path = cricfyTrimLeadingSlash(path.slice(basePath.length));
  }
  return path;
}

// Some links arrive with the `url|Header=value` separator percent-encoded as
// `%7C`. Splitting on the literal pipe alone leaves `%7CReferer=...` glued to
// the query string *and* drops the header the origin requires, so the fetch
// comes back 403 on a link that is otherwise fine. Only an encoded pipe that
// introduces a header assignment is treated as a separator — an encoded pipe
// inside an ordinary query value stays part of the URL.
const CRICFY_ENCODED_PIPE = /%7c(?=[A-Za-z][A-Za-z0-9-]*=)/gi;

function cricfySplitLinkAndHeaders(value) {
  value = value.replace(CRICFY_ENCODED_PIPE, '|');
  if (value.indexOf('|') === -1) return { url: value.trim(), headers: {} };
  const parts = value.split('|');
  const headers = {};
  for (let i = 1; i < parts.length; i++) {
    Object.assign(headers, cricfyParseHeaderQuery(parts[i]));
  }
  return { url: parts[0].trim(), headers };
}

function cricfyParseHeaderQuery(value) {
  const headers = {};
  if (value.trim().length === 0) return headers;
  for (const pair of value.split('&')) {
    if (pair.trim().length === 0) continue;
    const sep = pair.indexOf('=');
    if (sep <= 0) continue;
    const name = pair.slice(0, sep).trim();
    const val = pair.slice(sep + 1).trim();
    if (name.length === 0 || val.length === 0 || val === 'null') continue;
    headers[name] = val;
  }
  return headers;
}

// Later layer wins, case-insensitively by name — same rationale as Dart's:
// HTTP header names are case-insensitive, but a plain JS object compares keys
// verbatim, so a naive merge would send both `User-Agent` and `user-agent`.
function cricfyMergeHeaders(layers) {
  const result = {};
  const keyByLower = {};
  for (const layer of layers) {
    for (const name of Object.keys(layer)) {
      const lower = name.toLowerCase();
      const previousKey = keyByLower[lower];
      if (previousKey !== undefined) delete result[previousKey];
      result[name] = layer[name];
      keyByLower[lower] = name;
    }
  }
  return result;
}

// Hex -> base64url, no padding — matches `CricfyUrls.hexToBase64Url`. Tolerant
// of invalid hex (returns null), unlike the host primitive it's built on.
function cricfyHexToBase64Url(hex) {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const b64 = host.codec.hexToBase64(hex);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function cricfyToClearKeyJson(api) {
  const value = api.trim();
  if (value.length === 0 || cricfyIsFullUrl(value)) return null;
  const entries = [];

  if (value.startsWith('{')) {
    let decoded;
    try {
      decoded = JSON.parse(value);
    } catch (_) {
      return null;
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      return null;
    }
    const keys = decoded.keys;
    if (!Array.isArray(keys)) return null;
    for (const item of keys) {
      if (typeof item !== 'object' || item === null) continue;
      const kid = String(item.kid ?? '').replace(/\n/g, '');
      const key = String(item.k ?? '').replace(/\n/g, '');
      if (kid.length === 0 || key.length === 0) continue;
      entries.push(`{"kty":"oct","k":"${key}","kid":"${kid}"}`);
    }
  } else if (value.indexOf(':') !== -1) {
    for (const pair of value.split(',')) {
      const parts = pair.split(':');
      if (parts.length !== 2) continue;
      const kid = cricfyHexToBase64Url(parts[0].trim());
      const key = cricfyHexToBase64Url(parts[1].trim());
      if (kid === null || key === null) continue;
      entries.push(`{"kty":"oct","k":"${key}","kid":"${kid}"}`);
    }
  }

  if (entries.length === 0) return null;
  return `{"keys":[${entries.join(',')}],"type":"temporary"}`;
}

// ---- models ----

// CricfyJson equivalent: reads a field at the top level, falling back to a
// nested container for the server's newer nested shape.
const CRICFY_JSON_FALLBACKS = {
  teamAName: ['teamA', 'name'],
  teamBName: ['teamB', 'name'],
  teamALogo: ['teamA', 'logo'],
  teamBLogo: ['teamB', 'logo'],
  category: ['eventDetails', 'category'],
  eventName: ['eventDetails', 'eventName'],
  eventLogo: ['eventDetails', 'eventLogo'],
};

function cricfyJsonClean(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text.trim().toLowerCase() === 'null' ? '' : text;
}

function cricfyJsonNested(json, container, innerKey) {
  const child = json[container];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return '';
  return cricfyJsonClean(child[innerKey]);
}

function cricfyJsonString(json, key) {
  const direct = cricfyJsonClean(json[key]);
  if (direct.length > 0) return direct;
  const fallback = CRICFY_JSON_FALLBACKS[key];
  if (!fallback) return '';
  return cricfyJsonNested(json, fallback[0], fallback[1]);
}

// Missing counts as visible (`true`) — the server only hides an entry by
// explicitly setting `false`, same contract as Dart's `CricfyJson.boolean`.
function cricfyJsonBoolean(json, key) {
  const value = json[key];
  if (value === null || value === undefined) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (text.length === 0 || text === 'null') return true;
  return text !== 'false' && text !== '0' && text !== 'no';
}

function cricfyDrmSchemeFromCode(code) {
  if (code === 0) return 'clearKey';
  if (code === 1) return 'widevine';
  return 'playReady';
}

function cricfyLinkFromJson(json) {
  const rawAudio = json.audio;
  const audio = typeof rawAudio === 'string' && rawAudio !== 'pronull' ? rawAudio : '';
  const rawScheme = json.scheme;
  const scheme =
    typeof rawScheme === 'number' ? rawScheme : parseInt(String(rawScheme), 10) || 0;
  return {
    name: String(json.name ?? ''),
    link: String(json.link ?? ''),
    drmApi: typeof json.api === 'string' ? json.api : '',
    tokenApi: typeof json.tokenApi === 'string' ? json.tokenApi : '',
    audio,
    scheme: cricfyDrmSchemeFromCode(scheme),
    secureDecoder: json.secure_decoder === true,
  };
}

function cricfyLinksFromList(items) {
  const links = [];
  for (const item of items) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      links.push(cricfyLinkFromJson(item));
    }
  }
  return links;
}

// A `links` field arrives as either a path to fetch later, or an embedded
// JSON array (sometimes itself encoded as a JSON *string*).
function cricfyParseLinksField(raw) {
  if (Array.isArray(raw)) return { path: '', embedded: cricfyLinksFromList(raw) };
  if (typeof raw !== 'string') return { path: '', embedded: [] };
  const value = raw.trim();
  if (value.length === 0) return { path: '', embedded: [] };
  if (!value.startsWith('[')) return { path: value, embedded: [] };
  let decoded;
  try {
    decoded = JSON.parse(value);
  } catch (_) {
    return { path: '', embedded: [] };
  }
  if (Array.isArray(decoded)) return { path: '', embedded: cricfyLinksFromList(decoded) };
  return { path: '', embedded: [] };
}

function cricfyEventFromJson(json) {
  const linksField = cricfyParseLinksField(json.links);
  const rawNames = json.link_names;
  const rawPriority = json.priority;
  return {
    eventName: cricfyJsonString(json, 'eventName'),
    category: cricfyJsonString(json, 'category'),
    linksPath: linksField.path,
    embeddedLinks: linksField.embedded,
    teamAName: cricfyJsonString(json, 'teamAName'),
    teamBName: cricfyJsonString(json, 'teamBName'),
    teamALogo: cricfyJsonString(json, 'teamALogo'),
    teamBLogo: cricfyJsonString(json, 'teamBLogo'),
    eventLogo: cricfyJsonString(json, 'eventLogo'),
    date: cricfyJsonString(json, 'date'),
    time: cricfyJsonString(json, 'time'),
    endDate: cricfyJsonString(json, 'end_date'),
    endTime: cricfyJsonString(json, 'end_time'),
    linkNames: Array.isArray(rawNames) ? rawNames.map((e) => String(e)) : [],
    priority:
      typeof rawPriority === 'number'
        ? Math.trunc(rawPriority)
        : parseInt(String(rawPriority), 10) || 0,
    visible: cricfyJsonBoolean(json, 'visible'),
  };
}

// Parses `dd/MM/yyyy` + `HH:mm:ss` as GMT via `Date.UTC`, which — like
// Dart's `DateTime.utc` — normalizes an out-of-range component rather than
// throwing; not spec-critical here since the server's dates are always
// well-formed, but it keeps the two implementations' edge-case behavior
// aligned rather than accidentally diverging.
function cricfyParseEventDateTime(date, time) {
  const parts = date.trim().split('/');
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  const clock = time.trim().split(':');
  const hour = clock.length > 0 ? parseInt(clock[0], 10) || 0 : 0;
  const minute = clock.length > 1 ? parseInt(clock[1], 10) || 0 : 0;
  const second = clock.length > 2 ? parseInt(clock[2], 10) || 0 : 0;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return isNaN(ms) ? null : new Date(ms);
}

function cricfyEventStatusAt(event, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const end = cricfyParseEventDateTime(event.endDate, event.endTime);
  if (end !== null && now >= end.getTime()) return 'ended';
  const start = cricfyParseEventDateTime(event.date, event.time);
  if (start !== null && now >= start.getTime()) return 'live';
  return 'upcoming';
}

function cricfyStreamFormatFromUrl(url) {
  const lower = url.toLowerCase();
  if (lower.indexOf('.mpd') !== -1) return 'dash';
  if (lower.indexOf('.m3u8') !== -1) return 'hls';
  return 'other';
}

// Validate the manifest before handing it to the native player. Upstream
// mirrors sometimes return an HTML/502 body at a URL that still looks like a
// playlist; letting that body reach the player produces a misleading
// "missing #EXTM3U" parser error and can make a bad source look playable.
async function cricfyValidatePlaybackManifest(url, { headers, format }) {
  if (format === 'other') return;
  const response = await fetch(url, { headers });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Playback manifest request failed: ${response.status}`);
  }
  const body = response.body.trim();
  if (format === 'hls' && !body.startsWith('#EXTM3U')) {
    throw new Error('Playback response is not an HLS playlist');
  }
  if (format === 'dash' && !/<MPD(?:\s|>)/i.test(body)) {
    throw new Error('Playback response is not a DASH manifest');
  }
}

// ---- client (port of CricfyClient) ----

let cricfyConfigCache = null;

async function cricfyGetText(url, headers, timeoutMs) {
  const response = await fetch(url, { headers, timeoutMs: timeoutMs || null });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Cricfy request failed: ${response.status}`);
  }
  return response.body;
}

async function cricfyPostText(url, { headers, body, isJson }) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: isJson ? JSON.stringify(body) : String(body),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Cricfy request failed: ${response.status}`);
  }
  return response.body;
}

function cricfyDefaultHeaders() {
  return { 'User-Agent': CRICFY_DEFAULT_UA, Accept: 'application/json, text/plain, */*' };
}

function cricfyFallbackConfig() {
  return { Mode: 'GenZ', api_url: CRICFY_API_BASE_URL, enabled: true };
}

async function cricfyConfig() {
  if (cricfyConfigCache !== null) return cricfyConfigCache;
  for (const mirror of CRICFY_CONFIG_MIRRORS) {
    try {
      const body = await cricfyGetText(mirror, {
        'User-Agent': CRICFY_CONFIG_UA,
        Accept: 'application/json, text/plain, */*',
      });
      const decoded = decodeCricfyConfigPayload(body);
      const json = JSON.parse(decoded);
      if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
        cricfyConfigCache = json;
        return json;
      }
    } catch (_) {
      continue;
    }
  }
  cricfyConfigCache = cricfyFallbackConfig();
  return cricfyConfigCache;
}

function cricfyConfigString(cfg, key) {
  const value = cfg[key];
  return typeof value === 'string' ? value.trim() : '';
}

function cricfyConfigFirstNonEmpty(cfg, keys) {
  for (const key of keys) {
    const value = cricfyConfigString(cfg, key);
    if (value.length > 0) return value;
  }
  return '';
}

function cricfyConfigMode(cfg) {
  const value = cricfyConfigString(cfg, 'Mode');
  return value.length === 0 ? 'genz' : value;
}

function cricfyConfigIsSignedApi(cfg) {
  const normalized = cricfyConfigMode(cfg).toLowerCase();
  if (normalized === 'genz' || normalized === 'chilli') return true;
  for (const key of ['getdata_enabled', 'get_data_enabled', 'signed_api_enabled']) {
    const value = cfg[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.length > 0) return value.toLowerCase() === 'true';
  }
  return true;
}

function cricfyConfigApiUrl(cfg) {
  const value = cricfyConfigFirstNonEmpty(cfg, ['api_url', 'api2', 'api3', 'api_host']);
  return value.length === 0 ? CRICFY_API_BASE_URL : value;
}

function cricfyConfigSignedBaseUrl(cfg) {
  const value = cricfyConfigFirstNonEmpty(cfg, [
    'getdata_base_url',
    'get_data_base_url',
    'signed_api_base_url',
  ]);
  return value.length === 0 ? cricfyConfigApiUrl(cfg) : value;
}

function cricfyConfigSignedEndpoint(cfg) {
  const value = cricfyConfigString(cfg, 'getdata_endpoint');
  return value.length === 0 ? CRICFY_GETDATA_ENDPOINT : value;
}

function cricfyConfigSignedPathPrefix(cfg) {
  const value = cfg['getdata_path_prefix'];
  return typeof value === 'string' ? value : CRICFY_GETDATA_PATH_PREFIX;
}

function cricfyConfigSignedToken(cfg) {
  const value = cricfyConfigFirstNonEmpty(cfg, [
    'getdata_token',
    'get_data_token',
    'signed_api_token',
  ]);
  return value.length === 0 ? CRICFY_GETDATA_TOKEN : value;
}

function cricfyConfigEventsUrl(cfg) {
  return cricfyConfigFirstNonEmpty(cfg, ['events_url', 'events_path']);
}

function cricfyConfigChannelsBaseUrl(cfg) {
  return cricfyConfigFirstNonEmpty(cfg, ['channels_base_url', 'sports_base_url']);
}

function cricfyConfigEventLinksBaseUrl(cfg) {
  return cricfyConfigFirstNonEmpty(cfg, ['event_links_base_url', 'links_base_url']);
}

function cricfyConfigContentBaseUrl(cfg) {
  return cricfyConfigString(cfg, 'content_base_url');
}

function cricfySignedUri(cfg, base, path) {
  return cricfyBuildSignedUrl({
    base,
    endpoint: cricfyConfigSignedEndpoint(cfg),
    path,
    prefix: cricfyConfigSignedPathPrefix(cfg),
    token: cricfyConfigSignedToken(cfg),
  });
}

// `contentOverrideUrl` equivalent — only applies outside GenZ mode.
function cricfyOverrideUrl(cfg, path) {
  if (cricfyConfigMode(cfg).toLowerCase() === 'genz') return '';
  const clean = cricfyTrimLeadingSlash(path);
  const hostUrl = cricfyNormalizeHost(cricfyConfigApiUrl(cfg));
  const resolve = (override) => {
    if (override.length === 0) return '';
    return cricfyIsFullUrl(override) ? override : cricfyJoinUrl(hostUrl, override);
  };
  if (clean === CRICFY_EVENTS_PATH) return resolve(cricfyConfigEventsUrl(cfg));
  if (clean.startsWith('channels/')) {
    const base = cricfyConfigChannelsBaseUrl(cfg);
    return base.length > 0 ? cricfyJoinUrl(base, clean) : '';
  }
  if (clean.startsWith(CRICFY_EVENT_LINKS_PREFIX)) {
    const base = cricfyConfigEventLinksBaseUrl(cfg);
    return base.length > 0 ? cricfyJoinUrl(base, clean) : '';
  }
  const contentBase = cricfyConfigContentBaseUrl(cfg);
  if (contentBase.length > 0) return cricfyJoinUrl(contentBase, clean);
  return '';
}

function cricfyContentUri(cfg, path) {
  const base = cricfyConfigSignedBaseUrl(cfg);
  if (cricfyIsFullUrl(path)) {
    if (!cricfyConfigIsSignedApi(cfg)) return path;
    const relative = cricfyRelativeToBase(path, base);
    if (relative.length === 0) return path;
    return cricfySignedUri(cfg, base, relative);
  }
  const override = cricfyOverrideUrl(cfg, path);
  if (override.length > 0) return override;
  if (cricfyConfigIsSignedApi(cfg)) return cricfySignedUri(cfg, base, path);
  const hostUrl = cricfyNormalizeHost(cricfyConfigApiUrl(cfg));
  return cricfyJoinUrl(hostUrl, path);
}

async function cricfyFetchContent(path) {
  const cfg = await cricfyConfig();
  const fallback = cricfyFallbackConfig();
  const configs = [cfg];
  const configuredUri = cricfyContentUri(cfg, path);
  const fallbackUri = cricfyContentUri(fallback, path);
  if (fallbackUri !== configuredUri) configs.push(fallback);

  let lastError = null;
  for (const candidate of configs) {
    const uri = cricfyContentUri(candidate, path);
    try {
      const body = await cricfyGetText(
        uri,
        cricfyDefaultHeaders(),
        CRICFY_CONTENT_TIMEOUT_MS,
      );
      return decodeCricfyResponse(body);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Cricfy content request failed: ${path}`);
}

// Fetches a list from a file whose every element wraps a JSON string, shape
// `[{"event":"{…}"}, …]` — the wrapper key varies (`event`, `cat`, `channel`).
async function cricfyFetchWrappedList(path, wrapperKey) {
  const text = await cricfyFetchContent(path);
  if (text.trim().length === 0) return [];
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (_) {
    throw new Error(`Response for ${path} is not valid JSON`);
  }
  if (!Array.isArray(decoded)) throw new Error(`Response for ${path} is not a JSON array`);

  const items = [];
  for (const entry of decoded) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const inner = entry[wrapperKey];
    if (typeof inner === 'string' && inner.trim().length > 0) {
      let innerJson;
      try {
        innerJson = JSON.parse(inner);
      } catch (_) {
        innerJson = null;
      }
      if (typeof innerJson === 'object' && innerJson !== null && !Array.isArray(innerJson)) {
        items.push(innerJson);
      }
    } else if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
      items.push(inner);
    } else {
      items.push(entry);
    }
  }
  return items;
}

async function cricfyEvents() {
  const cfg = await cricfyConfig();
  const path = cricfyConfigEventsUrl(cfg) || CRICFY_EVENTS_PATH;
  const items = await cricfyFetchWrappedList(path, 'event');
  const parsed = items.map(cricfyEventFromJson).filter((e) => e.visible);
  cricfyCacheEvents(parsed);
  parsed.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const left = cricfyParseEventDateTime(a.date, a.time);
    const right = cricfyParseEventDateTime(b.date, b.time);
    if (!left || !right) return 0;
    return left.getTime() - right.getTime();
  });
  return parsed;
}

function cricfyApplyNames(links, names) {
  if (names.length === 0) return links;
  return links.map((link, i) =>
    i < names.length && names[i].trim().length > 0
      ? Object.assign({}, link, { name: names[i] })
      : link,
  );
}

async function cricfyLinksFor(path, embedded, names) {
  if (embedded.length > 0) return cricfyApplyNames(embedded, names);
  if (path.trim().length === 0) return [];

  const text = await cricfyFetchContent(path);
  if (text.trim().length === 0) return [];
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (_) {
    throw new Error(`Link list for ${path} is not valid JSON`);
  }
  const links = [];
  if (Array.isArray(decoded)) {
    for (const item of decoded) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        links.push(cricfyLinkFromJson(item));
      }
    }
  } else if (typeof decoded === 'object' && decoded !== null) {
    links.push(cricfyLinkFromJson(decoded));
  }
  return cricfyApplyNames(links, names);
}

async function cricfyEventLinks(event) {
  return cricfyLinksFor(event.linksPath, event.embeddedLinks, event.linkNames);
}

const CRICFY_MAX_RESOLVE_DEPTH = 4;

async function cricfyNeedsExchange(url) {
  if (!cricfyIsFullUrl(url)) return true;
  const cfg = await cricfyConfig();
  const base = cricfyConfigSignedBaseUrl(cfg);
  return cricfyRelativeToBase(url, base).length > 0;
}

// Exchanges an API path/URL for a link object carrying the real stream URL.
// A nested `playlist` field means one more level of descent is needed.
async function cricfyExchange(path, source) {
  const text = await cricfyFetchContent(path);
  if (text.trim().length === 0) throw new Error(`Server returned no link for ${path}`);
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (_) {
    throw new Error(`Link response for ${path} is not JSON`);
  }
  const entries = Array.isArray(decoded) ? decoded : [decoded];
  if (entries.length === 0) throw new Error(`Empty link list for ${path}`);
  const first = entries[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    throw new Error(`Unrecognized link shape for ${path}`);
  }

  const playlist = first.playlist;
  if (playlist !== undefined && playlist !== null) {
    if (typeof playlist === 'string' && playlist.trim().length > 0) {
      return {
        name: source.name,
        link: playlist,
        drmApi: '',
        tokenApi: '',
        audio: '',
        scheme: 'clearKey',
        secureDecoder: false,
      };
    }
    if (Array.isArray(playlist) && playlist.length > 0) {
      const item = playlist[0];
      if (typeof item === 'object' && item !== null) return cricfyLinkFromJson(item);
    }
    throw new Error(`Empty playlist for ${path}`);
  }
  return cricfyLinkFromJson(first);
}

function cricfyExtractKey(payload, key) {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const direct = payload[key];
    if (typeof direct === 'string' && direct.length > 0) return direct;
    for (const value of Object.values(payload)) {
      const nested = cricfyExtractKey(value, key);
      if (nested !== null) return nested;
    }
  } else if (Array.isArray(payload)) {
    for (const value of payload) {
      const nested = cricfyExtractKey(value, key);
      if (nested !== null) return nested;
    }
  }
  return null;
}

// ---- `tokenApi` type "embed" ----
//
// An embed entry carries no `url`; its target is `api`, an HTML page rather
// than the JSON the plain token flow expects. The page is a wrapper whose
// iframe holds a Clappr player, and the player's `source:` is the playback
// URL under `window.atob`. Two hops, both plain HTML:
//
//   api (stream-N.php)  ->  <iframe src="…/daddy.php?id=N">
//   iframe              ->  source: window.atob('<base64 m3u8 URL>')
//
// The signed URL 403s without the iframe's `Referer`/`Origin`, so those ride
// back on the returned string in the usual `url|Header=value` form and reach
// the player through the caller's existing header merge.

const CRICFY_EMBED_IFRAME = /<iframe[^>]+src=["']([^"']+)["']/i;
const CRICFY_EMBED_SOURCE = /source\s*:\s*(?:window\.)?atob\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/i;

function cricfyEmbedOrigin(url) {
  const match = /^(https?:\/\/[^/?#]+)/i.exec(url.trim());
  return match ? match[1] : '';
}

// `//host/path` is protocol-relative, not a path — resolve it against the
// page's own scheme rather than treating it as relative to the origin.
function cricfyEmbedAbsolute(candidate, baseUrl) {
  const value = candidate.trim();
  if (/^https?:\/\//i.test(value)) return value;
  const origin = cricfyEmbedOrigin(baseUrl);
  if (origin.length === 0) return '';
  if (value.startsWith('//')) return `${origin.split('://')[0]}:${value}`;
  if (value.startsWith('/')) return origin + value;
  return `${origin}/${value}`;
}

async function cricfyResolveEmbedUrl(apiUrl) {
  const target = apiUrl.trim();
  if (target.length === 0) throw new Error('embed tokenApi has no api url');

  const wrapper = await cricfyGetText(target, {
    'User-Agent': CRICFY_DEFAULT_UA,
  });
  const iframeMatch = CRICFY_EMBED_IFRAME.exec(wrapper);
  if (iframeMatch === null) throw new Error('embed page has no iframe');
  const iframeUrl = cricfyEmbedAbsolute(iframeMatch[1], target);
  if (iframeUrl.length === 0) throw new Error('embed iframe url is not absolute');

  const origin = cricfyEmbedOrigin(target);
  const player = await cricfyGetText(iframeUrl, {
    'User-Agent': CRICFY_DEFAULT_UA,
    Referer: origin.length === 0 ? target : `${origin}/`,
  });
  const sourceMatch = CRICFY_EMBED_SOURCE.exec(player);
  if (sourceMatch === null) throw new Error('embed player has no source');

  let playbackUrl;
  try {
    playbackUrl = host.codec.base64ToText(sourceMatch[1]).trim();
  } catch (_) {
    throw new Error('embed source is not valid base64');
  }
  if (!cricfyIsFullUrl(playbackUrl)) {
    throw new Error('embed source did not decode to a url');
  }

  // Without these the signed playlist answers 403.
  const iframeOrigin = cricfyEmbedOrigin(iframeUrl);
  if (iframeOrigin.length === 0) return playbackUrl;
  return `${playbackUrl}|Referer=${iframeOrigin}/&Origin=${iframeOrigin}`;
}

// Runs the `tokenApi` flow and returns the playback URL. No real captured
// fixture exists for this path (the Dart client's own test suite has none
// either) — the JS unit tests build one from the exact shape this function
// (and its Dart original) expect, using `CricfyCodec.encodePayload`, the
// same wire encoding used by the captured fixture helpers.
async function cricfyResolveTokenUrl(blob) {
  const decoded = decodeCricfyPayload(blob);
  let json;
  try {
    json = JSON.parse(decoded);
  } catch (_) {
    throw new Error('tokenApi blob is not a JSON object');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('tokenApi blob is not a JSON object');
  }

  const type = String(json.type ?? 'token').toLowerCase();
  if (type === 'daddy') {
    throw new Error('tokenApi type "daddy" is not supported by this client');
  }
  if (type === 'embed') return cricfyResolveEmbedUrl(String(json.api ?? ''));

  const split = cricfySplitLinkAndHeaders(String(json.url ?? ''));
  if (split.url.length === 0) throw new Error('tokenApi did not include a url');

  const headers = cricfyMergeHeaders([
    { 'User-Agent': CRICFY_DEFAULT_UA },
    cricfyParseHeaderQuery(String(json.api ?? '')),
    split.headers,
  ]);
  const linkKey = String(json.link_key ?? 'playback_url');
  const requestType = String(json.request_type ?? 'get').toLowerCase();
  const bodyType = String(json.request_body_type ?? 'normal').toLowerCase();
  const requestBody = String(json.request_body ?? '');
  const isJson = bodyType === 'json';

  const responseText =
    requestType === 'post'
      ? await cricfyPostText(split.url, {
          headers,
          body: isJson && requestBody.length > 0 ? JSON.parse(requestBody) : requestBody,
          isJson,
        })
      : await cricfyGetText(split.url, headers);

  const payload = JSON.parse(decodeCricfyPayload(responseText));
  const extracted = cricfyExtractKey(payload, linkKey);
  if (extracted === null || extracted.length === 0) {
    throw new Error(`tokenApi did not return "${linkKey}"`);
  }
  return extracted;
}

function cricfyBuildDrm(link) {
  const api = link.drmApi.trim();
  if (api.length === 0) return null;
  if (cricfyIsFullUrl(api)) return { scheme: link.scheme, licenseUrl: api };
  const clearKey = cricfyToClearKeyJson(api);
  if (clearKey === null) return null;
  return { scheme: 'clearKey', clearKeyJson: clearKey };
}

// Turns a `CricfyLink` into a ready-to-play stream. Handles three cases: a
// link that's already a stream URL, one that needs exchanging through the
// signed endpoint first, and one that needs a `tokenApi` call.
async function cricfyResolveStreamAt(link, depth) {
  if (depth > CRICFY_MAX_RESOLVE_DEPTH) throw new Error('Link resolution looped too deep');

  const split = cricfySplitLinkAndHeaders(link.link);
  const hasTokenApi = link.tokenApi.trim().length > 0;
  // A link that carries only a `tokenApi` is normal, not malformed: the
  // playback URL is what that call returns. Only a link with neither is empty.
  if (split.url.length === 0 && !hasTokenApi) throw new Error('Empty link');

  if (split.url.length > 0 && (await cricfyNeedsExchange(split.url))) {
    const resolved = await cricfyExchange(split.url, link);
    return cricfyResolveStreamAt(resolved, depth + 1);
  }

  let finalUrl = split.url;
  if (hasTokenApi) {
    finalUrl = await cricfyResolveTokenUrl(link.tokenApi);
  }

  const finalSplit = cricfySplitLinkAndHeaders(finalUrl);
  const merged = cricfyMergeHeaders([
    { 'User-Agent': CRICFY_DEFAULT_UA },
    split.headers,
    finalSplit.headers,
  ]);
  const format = cricfyStreamFormatFromUrl(finalSplit.url);
  await cricfyValidatePlaybackManifest(finalSplit.url, {
    headers: merged,
    format,
  });

  return {
    url: finalSplit.url,
    headers: merged,
    format,
    drm: cricfyBuildDrm(link),
    audioUrl: link.audio.length === 0 ? null : link.audio,
    label: link.name,
  };
}

function cricfyResolveStream(link) {
  return cricfyResolveStreamAt(link, 0);
}

// ---- CricfyBroadcastSource equivalent ----

function cricfyIsLiveOrUpcoming(event) {
  const status = cricfyEventStatusAt(event);
  return status === 'live' || status === 'upcoming';
}

// Live-or-upcoming candidates are kept broad because source resolution is
// driven by the selected item's participants and kickoff. Non-matching
// events are discarded by the matcher.
function cricfyCandidatesFrom(events) {
  const out = [];
  for (const event of events) {
    if (cricfyIsLiveOrUpcoming(event)) {
      const start = cricfyParseEventDateTime(event.date, event.time);
      out.push({
        teamA: event.teamAName,
        teamB: event.teamBName,
        startsAt: start ? start.toISOString() : null,
        event,
      });
    }
  }
  return out;
}

// ---- the schedule, cached across launches ----
//
// `host.storage` is a cache an extension may use, never one it may rely on:
// an older host has no storage at all, a value can be dropped between
// launches, and a write can be refused for being too big. Every path here
// therefore treats a miss as ordinary and falls through to the network.

function cricfyStorage() {
  return typeof host === 'object' && host !== null && host.storage
    ? host.storage
    : null;
}

function cricfyCacheEvents(events) {
  const storage = cricfyStorage();
  if (storage === null) return;
  try {
    storage.write(
      CRICFY_EVENTS_CACHE_KEY,
      JSON.stringify(events),
      CRICFY_EVENTS_CACHE_TTL_MS,
    );
  } catch (_) {
    // A cache that won't take the value changes nothing about this session.
  }
}

// Returns the stored schedule, or null when there isn't a usable one. The
// events were written as already-parsed objects, so nothing here repeats the
// decode — that is most of what makes reading them cheap.
function cricfyCachedEvents() {
  const storage = cricfyStorage();
  if (storage === null) return null;
  let raw;
  try {
    raw = storage.read(CRICFY_EVENTS_CACHE_KEY);
  } catch (_) {
    return null;
  }
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let decoded;
  try {
    decoded = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length === 0) return null;
  for (const event of decoded) {
    if (typeof event !== 'object' || event === null) return null;
    if (typeof event.date !== 'string' || typeof event.time !== 'string') {
      return null;
    }
  }
  return decoded;
}

// Events list is a forward schedule, same shape as fixtures.js's own TV
// guide memo — cached for CRICFY_EVENTS_TTL_MS, not the engine's whole
// lifetime. A plain never-expiring memo (the original shape here) meant a
// fixture added to Cricfy's events.txt after the first fetch of a session
// never appeared — no source, and never showing under the "live" category —
// no matter how many times the app was refreshed, since the catalog protocol
// has no refresh signal for an extension to key off. Cleared on failure so a
// later call can retry rather than being stuck with a rejected promise.
const CRICFY_EVENTS_TTL_MS = 15 * 60 * 1000;
let cricfyEventsMemo = null;

function cricfyFetchEventsMemo(nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  if (cricfyEventsMemo === null) {
    const cached = cricfyCachedEvents();
    if (cached !== null) {
      // Serve last launch's schedule now and fetch behind it. The cached
      // copy is dated by the statuses derived from each event's own kickoff,
      // not by when it was stored, so a few hours old still answers "what is
      // live right now" correctly for everything already on it — and what it
      // can't know about (an event added since) arrives with the refresh,
      // rather than holding up every source lookup until it does.
      cricfyEventsMemo = { promise: Promise.resolve(cached), fetchedAt: now };
      cricfyRefreshEventsInBackground();
      return cricfyEventsMemo.promise;
    }
  }
  if (
    cricfyEventsMemo === null ||
    now - cricfyEventsMemo.fetchedAt >= CRICFY_EVENTS_TTL_MS
  ) {
    const promise = cricfyEvents().catch((e) => {
      cricfyEventsMemo = null;
      throw e;
    });
    cricfyEventsMemo = { promise, fetchedAt: now };
  }
  return cricfyEventsMemo.promise;
}

// Replaces a cache-seeded memo once the real list lands. Deliberately not
// awaited by anyone: the caller already has an answer, and this one is only
// worth having if it arrives. At most one runs at a time, and a failure
// leaves the seeded memo in place — the cached schedule is still better than
// nothing, and the normal TTL will try again.
let cricfyBackgroundRefresh = null;

function cricfyRefreshEventsInBackground() {
  if (cricfyBackgroundRefresh !== null) return;
  cricfyBackgroundRefresh = cricfyEvents().then(
    (events) => {
      cricfyBackgroundRefresh = null;
      cricfyEventsMemo = {
        promise: Promise.resolve(events),
        fetchedAt: Date.now(),
      };
    },
    () => {
      cricfyBackgroundRefresh = null;
    },
  );
}

// Resolved links are cached by a stable link key so repeated discovery can
// replace the same source instead of making the picker show it twice. The
// cache is capped so a long session can't grow it forever.
let cricfyLinkCache = {};
const CRICFY_MAX_LINK_CACHE_ENTRIES = 500;

function cricfyTrimLinkCache() {
  const keys = Object.keys(cricfyLinkCache);
  const overflow = keys.length - CRICFY_MAX_LINK_CACHE_ENTRIES;
  if (overflow <= 0) return;
  for (const key of keys.slice(0, overflow)) delete cricfyLinkCache[key];
}

function cricfyLinkHost(link) {
  const candidates = [link.link, link.tokenApi, link.drmApi, link.audio];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim().split('|')[0];
    const match = /^https?:\/\/([^/?#]+)/i.exec(value);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

function cricfySourceIdentity(link) {
  const name = String(link.name ?? '').trim().toLowerCase();
  const hostName = cricfyLinkHost(link);
  if (name.length > 0 && hostName.length > 0) return `${name}@${hostName}`;
  if (name.length > 0) return `name:${name}`;
  if (hostName.length > 0) return `host:${hostName}`;

  const path = String(link.link ?? '').trim().split(/[|?#]/)[0].toLowerCase();
  return path.length > 0 ? `path:${path}` : 'unknown';
}

function cricfyEventSourceKey(event) {
  const path = String(event.linksPath ?? '').trim().toLowerCase();
  if (path.length > 0) return `path:${path}`;
  return [
    event.eventName,
    event.teamAName,
    event.teamBName,
    event.date,
    event.time,
  ]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .join('|');
}

function cricfySourceCacheKey(event, link) {
  const stable = {
    event: cricfyEventSourceKey(event),
    name: String(link.name ?? '').trim().toLowerCase(),
    link: String(link.link ?? '').trim().split(/[|?#]/)[0].toLowerCase(),
    tokenApi: String(link.tokenApi ?? '').trim().split(/[|?#]/)[0].toLowerCase(),
    drmApi: String(link.drmApi ?? '').trim().split(/[|?#]/)[0].toLowerCase(),
    audio: String(link.audio ?? '').trim().split(/[|?#]/)[0].toLowerCase(),
  };
  return host.codec
    .textToBase64(JSON.stringify(stable))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function cricfySourcesForEvent(event) {
  const links = await cricfyEventLinks(event);
  const sources = [];
  for (let i = 0; i < links.length; i++) {
    const id = cricfySourceCacheKey(event, links[i]);
    const identity = cricfySourceIdentity(links[i]);
    const label = sourceAliasWithQuality(
      `${CRICFY_PROVIDER_KEY}:${identity}`,
      null,
      links[i].name || `Cricfy Link ${i + 1}`,
    );
    cricfyLinkCache[id] = { ...links[i], name: label };
    sources.push({
      id: `${CRICFY_PROVIDER_KEY}:${id}`,
      label,
      provider: 'Nimora',
      providerId: 'nimora.cricfy',
    });
  }
  cricfyTrimLinkCache();
  return sources;
}

function cricfyMapDrm(drm) {
  if (!drm) return null;
  if (drm.scheme === 'clearKey') return { scheme: 'clearKey', clearKeyJson: drm.clearKeyJson };
  if (drm.scheme === 'widevine') return { scheme: 'widevine', licenseUrl: drm.licenseUrl };
  // PlayReady isn't supported on this app's players — mapped to
  // "unsupported" so the UI shows an honest message instead of trying to
  // play and failing, same as CricfyBroadcastSource._mapDrm.
  return { scheme: 'unsupported' };
}

async function resolveCricfySource(sourceId) {
  const prefix = `${CRICFY_PROVIDER_KEY}:`;
  const inner = sourceId.startsWith(prefix) ? sourceId.slice(prefix.length) : sourceId;
  const link = cricfyLinkCache[inner];
  if (!link) throw new Error(`Cricfy source expired: ${sourceId}`);
  const stream = await cricfyResolveStream(link);
  return {
    url: stream.url,
    headers: stream.headers,
    format: stream.format,
    drm: cricfyMapDrm(stream.drm),
    audioUrl: stream.audioUrl,
    label: stream.label,
  };
}

async function cricfySources(args) {
  const item = args.item;
  const enabled = args.enabledProviders;
  if (enabled != null && enabled.indexOf(CRICFY_PROVIDER_ID) === -1) return { sources: [] };

  let events;
  try {
    events = await cricfyFetchEventsMemo();
  } catch (_) {
    return { sources: [] };
  }

  const catalogPrefix = 'cricfy:';
  const itemId = item.ref && String(item.ref.id || '');
  if (itemId.startsWith(catalogPrefix)) {
    const linksPath = itemId.slice(catalogPrefix.length);
    const event = events.find((candidate) => candidate.linksPath === linksPath);
    if (!event) return { sources: [] };
    try {
      return { sources: await cricfySourcesForEvent(event) };
    } catch (_) {
      return { sources: [] };
    }
  }

  if (!item.participants || item.participants.length !== 2) return { sources: [] };
  const candidates = cricfyCandidatesFrom(events);
  if (candidates.length === 0) return { sources: [] };

  // FOOTBALL_PROFILE: declared in kora.js, reused here — see this file's
  // header comment for why that's the right call, not an oversight.
  const result = host.match.resolve(
    {
      teamA: item.participants[0].name,
      teamB: item.participants[1].name,
      teamAShort: item.participants[0].shortName || null,
      teamBShort: item.participants[1].shortName || null,
      kickoff: item.schedule ? item.schedule.startsAt : null,
    },
    candidates.map((c) => ({ teamA: c.teamA, teamB: c.teamB, startsAt: c.startsAt })),
    { profile: FOOTBALL_PROFILE },
  );
  if (!result) return { sources: [] };

  try {
    return { sources: await cricfySourcesForEvent(candidates[result.index].event) };
  } catch (_) {
    return { sources: [] };
  }
}

// ---- registration — see kora.js's tail for the shared aggregator ----

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: CRICFY_PROVIDER_KEY,
  sources: cricfySources,
  resolve: (sourceId) => resolveCricfySource(sourceId),
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.sources) {
  globalThis.__extension.sources = async (args) => {
    const calls = globalThis.__streamProviders.map((p) =>
      Promise.resolve()
        .then(() => p.sources(args))
        .catch(() => ({ sources: [] })),
    );
    if (args.fast !== true) {
      const perProvider = await Promise.all(calls);
      return { sources: perProvider.flatMap((r) => r.sources) };
    }
    return new Promise((resolve) => {
      let remaining = calls.length;
      let returned = false;
      for (const call of calls) {
        call.then((result) => {
          if (returned) return;
          const sources = Array.isArray(result.sources) ? result.sources : [];
          if (sources.length > 0) {
            returned = true;
            resolve({ sources });
            return;
          }
          remaining -= 1;
          if (remaining === 0) resolve({ sources: [] });
        });
      }
    });
  };
  globalThis.__extension.resolve = async (args) => {
    const sourceId = args.sourceId;
    const separator = sourceId.indexOf(':');
    if (separator < 0) throw new Error(`Malformed source id: ${sourceId}`);
    const providerKey = sourceId.slice(0, separator);
    const provider = globalThis.__streamProviders.find((p) => p.providerKey === providerKey);
    if (!provider) throw new Error(`No stream provider registered for "${providerKey}"`);
    return provider.resolve(sourceId);
  };
}

// MeteGol's football stream provider.
//
// It keeps FotMob/Nimora's catalog as the source of truth: these agendas are
// only candidate lists used to add streams to an existing football fixture.
// The embed URL is carried in the opaque source id and the final playback URL
// is extracted fresh in resolve, because the player URLs are tokenized.

const METEGOL_PROVIDER_KEY = 'metegol';
const METEGOL_PROVIDER_ID = 'nimora.metegol';
const METEGOL_AGENDA18_URL =
  globalThis.__metegolAgendaUrl || 'https://agenda18.com/agenda.json?v=1.1';
const METEGOL_ALANGULO_URL =
  globalThis.__metegolAlAnguloUrl || 'https://alangulotv.cx/agenda.php';
const METEGOL_FUTBOLIBRE_URL =
  globalThis.__metegolFutbolLibreUrl || 'https://futbollibretv.sx/eventos.js';
const METEGOL_DEPORFLIX_SEARCH_URL =
  globalThis.__metegolDeporflixSearchUrl ||
  'https://deporflix.pe/wp-json/wp/v2/search?search=vs&per_page=20&_embed=1';
const METEGOL_DEPORFLIX_AJAX_URL =
  globalThis.__metegolDeporflixAjaxUrl ||
  'https://deporflix.pe/wp-admin/admin-ajax.php';
const METEGOL_AGENDA18_REFERER = 'https://agenda18.com/';
const METEGOL_ALANGULO_REFERER = 'https://alangulotv.cx/';
const METEGOL_FUTBOLIBRE_REFERER = 'https://futbollibretv.sx/';
const METEGOL_DEPORFLIX_REFERER = 'https://deporflix.pe/';
const METEGOL_CACHE_KEY = 'metegol.events.v2';
const METEGOL_LEGACY_CACHE_KEY = 'metegol.agenda18.events.v1';
const METEGOL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const METEGOL_EVENTS_TTL_MS = 15 * 60 * 1000;
const METEGOL_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; Pixel 3 XL) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';

function metegolStorage() {
  return typeof host === 'object' && host !== null && host.storage
    ? host.storage
    : null;
}

function metegolText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function metegolNormalizeTitle(value) {
  return metegolText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[:\u2013\u2014_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function metegolToStartUtc(dateText, timeText) {
  const time = metegolText(timeText);
  const date = metegolText(dateText);
  const timeParts = time.split(':').map(Number);
  const dateParts = date.split('-').map(Number);
  if (
    dateParts.length !== 3 ||
    timeParts.length < 2 ||
    dateParts.some((value) => Number.isNaN(value)) ||
    timeParts.slice(0, 2).some((value) => Number.isNaN(value))
  ) {
    return null;
  }
  return new Date(
    Date.UTC(
      dateParts[0],
      dateParts[1] - 1,
      dateParts[2],
      timeParts[0] + 5,
      timeParts[1],
      Number.isNaN(timeParts[2]) ? 0 : timeParts[2],
    ),
  ).toISOString();
}

function metegolDecodeBase64(value) {
  let token = metegolText(value).replace(/-/g, '+').replace(/_/g, '/');
  const remainder = token.length % 4;
  if (remainder !== 0) token += '='.repeat(4 - remainder);
  try {
    return host.codec.base64ToText(token);
  } catch (_) {
    return null;
  }
}

function metegolDecodeHref(href) {
  const match = /[?&]r=([A-Za-z0-9+/_=-]+)/.exec(metegolText(href));
  return match === null ? null : metegolDecodeBase64(match[1]);
}

function metegolTeamNames(title) {
  let value = metegolText(title).split('|')[0];
  const colon = value.indexOf(':');
  if (colon >= 0 && colon < value.length - 1) value = value.slice(colon + 1);
  return value
    .split(/\s+v(?:s|s\.)?\.?\s+|\s+@\s+|\s+[–—-]\s+/i)
    .map((team) => team.trim())
    .filter((team) => team.length > 0)
    .slice(0, 2);
}

function metegolSameTeams(left, right) {
  const a = metegolTeamNames(left).map(metegolNormalizeTitle);
  const b = metegolTeamNames(right).map(metegolNormalizeTitle);
  if (a.length !== 2 || b.length !== 2) return false;
  const contains = (x, y) => x.includes(y) || y.includes(x);
  return (
    (contains(a[0], b[0]) && contains(a[1], b[1])) ||
    (contains(a[0], b[1]) && contains(a[1], b[0]))
  );
}

function metegolIsFootball(category) {
  const value = metegolText(category).toLowerCase();
  return value === 'futbol' || value === 'football' || value.includes('futbol');
}

function metegolLabel(attributes, prefix) {
  const name = metegolText(attributes.embed_name) || 'Agenda18';
  const language = metegolText(attributes.idioma);
  const label = language.length === 0 ? name : `${name} · ${language}`;
  return prefix ? `${prefix} · ${label}` : label;
}

function metegolParseAgenda(json) {
  const rows = json && Array.isArray(json.data) ? json.data : [];
  const seen = {};
  const events = [];
  for (const row of rows) {
    const attributes = row && row.attributes ? row.attributes : {};
    if (!metegolIsFootball(attributes.deportes)) continue;
    const title = metegolText(attributes.diary_description);
    if (title.length === 0) continue;

    const embeds =
      attributes.embeds && Array.isArray(attributes.embeds.data)
        ? attributes.embeds.data
        : [];
    const streams = [];
    for (const embed of embeds) {
      const embedAttributes = embed && embed.attributes ? embed.attributes : {};
      const url = metegolDecodeHref(embedAttributes.embed_iframe);
      if (url === null || url.length === 0) continue;
      if (/\.mpd(?:\?|$)/i.test(url) || /drm\.php/i.test(url)) continue;
      if (/tarjetarojita|proveseat|la10tv|la10\.com/i.test(url)) continue;
      streams.push({
        url,
        label: metegolLabel(embedAttributes),
        source: 'agenda18',
        referer: METEGOL_AGENDA18_REFERER,
      });
    }
    if (streams.length === 0) continue;

    const key = title.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    events.push({
      title,
      date: metegolText(attributes.date_diary),
      time: metegolText(attributes.diary_hour).slice(0, 8),
      startUtc: metegolToStartUtc(
        attributes.date_diary,
        attributes.diary_hour,
      ),
      streams,
    });
  }
  return events;
}

function metegolParseAlAngulo(html) {
  const events = [];
  const liRe =
    /<li class="([A-Z0-9\s]+)"><a href="#">([\s\S]*?)<\/a>\s*<ul>([\s\S]*?)<\/ul>\s*<\/li>/g;
  let match;
  while ((match = liRe.exec(html)) !== null) {
    const body = match[2];
    const streamsHtml = match[3];
    const title = body
      .split('<span class="t">')[0]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/:\s*$/, '')
      .trim();
    if (title.length === 0) continue;

    const streams = [];
    const streamRe =
      /<li class="([^"]+)"><a href="[^"?]*\?r=([A-Za-z0-9+/=]+)"[^>]*>([\s\S]*?)<\/a><\/li>/g;
    let streamMatch;
    while ((streamMatch = streamRe.exec(streamsHtml)) !== null) {
      const url = metegolDecodeBase64(streamMatch[2]);
      if (url === null || url.length === 0) continue;
      // The site prints "Calidad 720p" inside a <span> on every single
      // channel, HD or not — it is a template constant, not a measurement,
      // so keeping it would put a specific claim on the label the site
      // itself does not back up. Drop the span and keep the channel name.
      const label = streamMatch[3]
        .replace(/<span[\s\S]*?<\/span>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      streams.push({
        source: 'alangulo',
        referer: METEGOL_ALANGULO_REFERER,
        label: label || 'Stream',
        url,
      });
    }
    if (streams.length === 0) continue;
    events.push({ title, streams, sport: metegolText(match[1]) });
  }
  return events;
}

function metegolParseFutbolLibre(body) {
  const match = /EVENTOS_DATA\s*=\s*(\[[\s\S]*\])\s*;?\s*$/.exec(body);
  if (match === null) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const events = [];
  const seen = {};
  for (const row of data) {
    if (!row || !row.titulo || !Array.isArray(row.canales)) continue;
    const streams = [];
    for (const channel of row.canales) {
      const url = metegolDecodeHref(channel && channel.url);
      if (url === null || url.length === 0) continue;
      const name = metegolText(channel && channel.nombre) || 'Stream';
      // `calidad` reads "720p" on every channel in this feed regardless of
      // what actually plays — a fixed field, not a real measurement — so
      // appending it would put a specific claim on the label the source
      // does not back up.
      streams.push({
        source: 'futbollibre',
        referer: METEGOL_FUTBOLIBRE_REFERER,
        label: name,
        url,
      });
    }
    if (streams.length === 0) continue;
    const title = metegolText(row.titulo);
    const key = metegolNormalizeTitle(title);
    if (seen[key]) continue;
    seen[key] = true;
    events.push({ title, streams, sport: metegolText(row.clase) });
  }
  return events;
}

async function metegolFetchDeporflixEvents() {
  const searchResponse = await fetch(METEGOL_DEPORFLIX_SEARCH_URL, {
    headers: {
      'User-Agent': METEGOL_USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      Referer: METEGOL_DEPORFLIX_REFERER,
    },
    timeoutMs: 12000,
  });
  if (searchResponse.status < 200 || searchResponse.status >= 300) {
    throw new Error(`MeteGol Deporflix search failed: ${searchResponse.status}`);
  }
  let results;
  try {
    results = JSON.parse(searchResponse.body);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(results)) return [];

  const matches = results.filter(
    (row) =>
      row &&
      row.id &&
      row.title &&
      /\s+vs\s+/i.test(row.title) &&
      typeof row.url === 'string' &&
      /\/canales\//.test(row.url),
  );
  const events = await Promise.all(
    matches.map(async (row) => {
      try {
        const response = await fetch(METEGOL_DEPORFLIX_AJAX_URL, {
          method: 'POST',
          headers: {
            'User-Agent': METEGOL_USER_AGENT,
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: row.url,
          },
          body:
            `action=doo_player_ajax&post=${encodeURIComponent(row.id)}` +
            '&nume=1&type=movie',
          timeoutMs: 10000,
        });
        if (response.status < 200 || response.status >= 300) return null;
        const payload = JSON.parse(response.body);
        if (!payload || typeof payload.embed_url !== 'string') return null;
        return {
          title: metegolText(row.title),
          streams: [
            {
              source: 'deporflix',
              referer: row.url,
              label: 'Deporflix',
              url: payload.embed_url,
            },
          ],
        };
      } catch (_) {
        return null;
      }
    }),
  );
  return events.filter((event) => event !== null);
}

async function metegolFetchText(url, headers, timeoutMs) {
  const response = await fetch(url, {
    headers,
    timeoutMs: timeoutMs || null,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`MeteGol request failed: ${response.status}`);
  }
  return response.body;
}

function metegolMergeStreams(left, right) {
  const streams = [...(left || [])];
  const urls = {};
  for (const stream of streams) urls[stream.url] = true;
  for (const stream of right || []) {
    if (!stream || !stream.url || urls[stream.url]) continue;
    urls[stream.url] = true;
    streams.push(stream);
  }
  return streams;
}

function metegolMergeEvents(...lists) {
  const events = [];
  for (const list of lists) {
    for (const event of list || []) {
      const key = metegolNormalizeTitle(event.title);
      if (key.length === 0) continue;
      const existing = events.find(
        (candidate) =>
          metegolNormalizeTitle(candidate.title) === key ||
          metegolSameTeams(candidate.title, event.title),
      );
      if (existing) {
        existing.streams = metegolMergeStreams(existing.streams, event.streams);
        if (!existing.startUtc && event.startUtc) existing.startUtc = event.startUtc;
      } else {
        const copy = {
          ...event,
          streams: metegolMergeStreams([], event.streams),
        };
        events.push(copy);
      }
    }
  }
  return events;
}

function metegolAddDeporflixStreams(events, extras) {
  for (const extra of extras || []) {
    const exact = metegolNormalizeTitle(extra.title);
    const target = events.find(
      (event) =>
        metegolNormalizeTitle(event.title) === exact ||
        metegolSameTeams(event.title, extra.title),
    );
    if (target) target.streams = metegolMergeStreams(target.streams, extra.streams);
  }
  return events;
}

async function metegolFetchEvents() {
  // Deporflix disabled for now: unlike the other three, it needs two chained
  // requests (search, then an ajax lookup per match) and matches events by a
  // loose " vs " title filter — the most likely of the four to time out or
  // hang a wrong stream on an event. Commented out, not deleted; uncomment
  // both blocks below to bring it back.
  //
  // FutbolLibre disabled too: it draws from the same channel pool as
  // AlAngulo (la18hd.su, streamtp-golden1.click) but covers fewer matches
  // and fewer streams per match, so it mostly just relabels AlAngulo's own
  // channels under a second near-identical name. Uncomment to bring it back.
  const [alangulo, /* futbolibre, */ agenda18 /* , deporflix */] = await Promise.allSettled([
    metegolFetchText(
      METEGOL_ALANGULO_URL,
      {
        'User-Agent': METEGOL_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        Referer: METEGOL_ALANGULO_REFERER,
      },
      12000,
    ).then(metegolParseAlAngulo),
    // metegolFetchText(
    //   METEGOL_FUTBOLIBRE_URL,
    //   {
    //     'User-Agent': METEGOL_USER_AGENT,
    //     Accept: 'application/javascript, text/plain, */*',
    //     Referer: METEGOL_FUTBOLIBRE_REFERER,
    //   },
    //   12000,
    // ).then(metegolParseFutbolLibre),
    metegolFetchText(
      METEGOL_AGENDA18_URL,
      {
        'User-Agent': METEGOL_USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        Referer: METEGOL_AGENDA18_REFERER,
      },
      15000,
    ).then((body) => metegolParseAgenda(JSON.parse(body))),
    // metegolFetchDeporflixEvents(),
  ]);
  const events = metegolMergeEvents(
    alangulo.status === 'fulfilled' ? alangulo.value : [],
    // futbolibre.status === 'fulfilled' ? futbolibre.value : [],
    agenda18.status === 'fulfilled' ? agenda18.value : [],
  );
  // metegolAddDeporflixStreams(
  //   events,
  //   deporflix.status === 'fulfilled' ? deporflix.value : [],
  // );
  const storage = metegolStorage();
  if (storage !== null) {
    try {
      storage.write(
        METEGOL_CACHE_KEY,
        JSON.stringify(events),
        METEGOL_CACHE_TTL_MS,
      );
    } catch (_) {
      // Storage is an optional cache; a refused write must not fail discovery.
    }
  }
  return events;
}

function metegolCachedEvents() {
  const storage = metegolStorage();
  if (storage === null) return null;
  for (const key of [METEGOL_CACHE_KEY, METEGOL_LEGACY_CACHE_KEY]) {
    let raw;
    try {
      raw = storage.read(key);
    } catch (_) {
      continue;
    }
    if (typeof raw !== 'string' || raw.length === 0) continue;
    try {
      const events = JSON.parse(raw);
      if (!Array.isArray(events) || events.length === 0) continue;
      const valid = events.every(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          typeof event.title === 'string' &&
          Array.isArray(event.streams),
      );
      if (valid) return events;
    } catch (_) {
      continue;
    }
  }
  return null;
}

let metegolEventsMemo = null;
let metegolBackgroundRefresh = null;

function metegolRefreshInBackground() {
  if (metegolBackgroundRefresh !== null) return;
  metegolBackgroundRefresh = metegolFetchEvents().then(
    (events) => {
      metegolBackgroundRefresh = null;
      metegolEventsMemo = {
        promise: Promise.resolve(events),
        fetchedAt: Date.now(),
      };
    },
    () => {
      metegolBackgroundRefresh = null;
    },
  );
}

function metegolFetchEventsMemo(nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  if (metegolEventsMemo === null) {
    const cached = metegolCachedEvents();
    if (cached !== null) {
      metegolEventsMemo = {
        promise: Promise.resolve(cached),
        fetchedAt: now,
      };
      metegolRefreshInBackground();
      return metegolEventsMemo.promise;
    }
  }
  if (
    metegolEventsMemo === null ||
    now - metegolEventsMemo.fetchedAt >= METEGOL_EVENTS_TTL_MS
  ) {
    const promise = metegolFetchEvents().catch((error) => {
      metegolEventsMemo = null;
      throw error;
    });
    metegolEventsMemo = { promise, fetchedAt: now };
  }
  return metegolEventsMemo.promise;
}

function metegolCandidatesFrom(events) {
  const candidates = [];
  for (const event of events) {
    const teams = metegolTeamNames(event.title);
    if (teams.length !== 2) continue;
    candidates.push({
      teamA: teams[0],
      teamB: teams[1],
      startsAt: event.startUtc || null,
      event,
    });
  }
  return candidates;
}

function metegolEncodeSourceId(stream) {
  const json = JSON.stringify({
    u: stream.url,
    l: stream.label,
    s: stream.source || 'agenda18',
    r: stream.referer || METEGOL_AGENDA18_REFERER,
  });
  return host.codec
    .textToBase64(json)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function metegolDecodeSourceId(encoded) {
  const json = metegolDecodeBase64(encoded);
  if (json === null) throw new Error('Malformed MeteGol source id');
  const payload = JSON.parse(json);
  if (!payload || typeof payload.u !== 'string' || payload.u.length === 0) {
    throw new Error('MeteGol source id has no embed URL');
  }
  return payload;
}

// The four upstream sites pull from overlapping channel pools, so the same
// channel (e.g. "Disney+", "Universo") often shows up once per site under a
// slightly different URL and survives `metegolMergeStreams`' exact-URL dedupe
// as separate entries. Tagging the label with its real origin site — not a
// made-up quality — is the only way to tell those apart in the list.
const METEGOL_SOURCE_NAMES = {
  agenda18: 'Agenda18',
  alangulo: 'AlAngulo',
  futbollibre: 'FutbolLibre',
  deporflix: 'Deporflix',
};

function metegolSourcesForEvent(event) {
  return event.streams.map((stream) => {
    const label = metegolText(stream.label) || 'Stream';
    const siteName = METEGOL_SOURCE_NAMES[stream.source] || null;
    const taggedLabel =
      siteName === null || label.toLowerCase().includes(siteName.toLowerCase())
        ? label
        : `${label} · ${siteName}`;
    return {
      id: `${METEGOL_PROVIDER_KEY}:${metegolEncodeSourceId(stream)}`,
      label: taggedLabel,
      provider: 'Nimora',
      providerId: METEGOL_PROVIDER_ID,
    };
  });
}

function metegolExtractObfuscatedPlaybackUrl(html) {
  const pairs = [];
  const pairsRe = /\[(\d+),"([A-Za-z0-9+/=]+)"\]/g;
  let match;
  while ((match = pairsRe.exec(html)) !== null) {
    pairs.push([Number(match[1]), match[2]]);
  }
  if (pairs.length === 0) return null;
  const keyMatch =
    /var\s+k\s*=\s*(\w+)\(\)\s*\+\s*(\w+)\(\);[\s\S]*?function\s+\1\(\)\s*\{\s*return\s+(\d+);\}[\s\S]*?function\s+\2\(\)\s*\{\s*return\s+(\d+);\}/.exec(
      html,
    );
  if (keyMatch === null) return null;
  const key = Number(keyMatch[3]) + Number(keyMatch[4]);
  pairs.sort((left, right) => left[0] - right[0]);
  let url = '';
  for (const pair of pairs) {
    const decoded = metegolDecodeBase64(pair[1]);
    if (decoded === null) return null;
    const digits = decoded.replace(/\D/g, '');
    if (digits.length > 0) url += String.fromCharCode(Number(digits) - key);
  }
  return url.length === 0 ? null : url;
}

function metegolExtractPlaybackUrl(html) {
  const direct =
    /(?:playbackURL|playbackUrl|playback_url|playbackurl|var\s+url)\s*=\s*"([^"]+)"/i.exec(
      html,
    );
  if (direct !== null && direct[1]) {
    return direct[1].replace(/\\\//g, '/').replace(/\\/g, '');
  }
  const obfuscated = metegolExtractObfuscatedPlaybackUrl(html);
  if (obfuscated !== null) return obfuscated;
  const m3u8 = /https?:\\?\/\\?\/[^"'\s\\]+\.m3u8[^"'\s]*/i.exec(html);
  return m3u8 === null ? null : m3u8[0].replace(/\\\//g, '/');
}

async function metegolResolveSource(sourceId) {
  const prefix = `${METEGOL_PROVIDER_KEY}:`;
  const encoded = sourceId.startsWith(prefix)
    ? sourceId.slice(prefix.length)
    : sourceId;
  const payload = metegolDecodeSourceId(encoded);
  const html = await metegolFetchText(payload.u, {
    'User-Agent': METEGOL_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: payload.r || METEGOL_AGENDA18_REFERER,
  });
  const url = metegolExtractPlaybackUrl(html);
  if (url === null || url.length === 0) {
    throw new Error('MeteGol embed has no playback URL');
  }
  return {
    url,
    headers: { Referer: payload.r || METEGOL_AGENDA18_REFERER },
    format: 'hls',
    label: payload.l || 'Agenda18',
  };
}

async function metegolSources(args) {
  const enabled = args.enabledProviders;
  if (
    enabled !== null &&
    enabled !== undefined &&
    enabled.indexOf(METEGOL_PROVIDER_ID) === -1
  ) {
    return { sources: [] };
  }
  const item = args.item || {};
  if (!Array.isArray(item.participants) || item.participants.length !== 2) {
    return { sources: [] };
  }

  let events;
  try {
    events = await metegolFetchEventsMemo();
  } catch (_) {
    return { sources: [] };
  }
  const candidates = metegolCandidatesFrom(events);
  if (candidates.length === 0) return { sources: [] };

  const result = host.match.resolve(
    {
      teamA: item.participants[0].name,
      teamB: item.participants[1].name,
      teamAShort: item.participants[0].shortName || null,
      teamBShort: item.participants[1].shortName || null,
      kickoff: item.schedule ? item.schedule.startsAt : null,
    },
    candidates.map((candidate) => ({
      teamA: candidate.teamA,
      teamB: candidate.teamB,
      startsAt: candidate.startsAt,
    })),
    { profile: FOOTBALL_PROFILE },
  );
  if (!result) return { sources: [] };
  return { sources: metegolSourcesForEvent(candidates[result.index].event) };
}

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: METEGOL_PROVIDER_KEY,
  sources: metegolSources,
  resolve: (sourceId) => metegolResolveSource(sourceId),
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.sources) {
  globalThis.__extension.sources = async (args) => {
    const calls = globalThis.__streamProviders.map((provider) =>
      Promise.resolve()
        .then(() => provider.sources(args))
        .catch(() => ({ sources: [] })),
    );
    if (args.fast !== true) {
      const perProvider = await Promise.all(calls);
      return { sources: perProvider.flatMap((result) => result.sources) };
    }
    return new Promise((resolve) => {
      let remaining = calls.length;
      let returned = false;
      for (const call of calls) {
        call.then((result) => {
          if (returned) return;
          const sources = Array.isArray(result.sources) ? result.sources : [];
          if (sources.length > 0) {
            returned = true;
            resolve({ sources });
            return;
          }
          remaining -= 1;
          if (remaining === 0) resolve({ sources: [] });
        });
      }
    });
  };
  globalThis.__extension.resolve = async (args) => {
    const sourceId = args.sourceId;
    const separator = sourceId.indexOf(':');
    if (separator < 0) throw new Error(`Malformed source id: ${sourceId}`);
    const providerKey = sourceId.slice(0, separator);
    const provider = globalThis.__streamProviders.find(
      (candidate) => candidate.providerKey === providerKey,
    );
    if (!provider) {
      throw new Error(`No stream provider registered for "${providerKey}"`);
    }
    return provider.resolve(sourceId);
  };
}

// TMDB + shegu.st curated-lists catalog, as a JS extension — Movies and TV.
//
// Talks to TMDB and lists.shegu.st directly. Items use stable
// `movie:<tmdbId>` / `series:<tmdbId>` references; see tmdbRefId below.
//
// Registers into `globalThis.__catalogProviders`/`__metaProviders` rather
// than assigning `__extension.catalog`/`__extension.meta` directly, so this
// can coexist with the fixtures catalog without either clobbering the other.
//
// Reuses `EXTENSION_ID` from fixtures.js (build_bundle.dart loads that first).

const TMDB_BASE = globalThis.__tmdbBaseUrl || 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const SHEGU_LISTS_BASE = globalThis.__sheguListsBaseUrl || 'https://lists.shegu.st/joy';
const SHEGU_TRAILER_BASE = globalThis.__sheguTrailerBaseUrl || 'https://trailer.shegu.st';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';

const TMDB_PROVIDER_ID = 'nimora.tmdb';
const TMDB_CATALOG_ID = 'discover';
const TMDB_MOVIE_CATEGORY = 'movie';
const TMDB_TV_CATEGORY = 'tv';
const TMDB_WATCH_REGION = globalThis.__tmdbWatchRegion || 'US';
// Popular Today follows TMDB's paid streaming tab. Rent and purchase offers
// are separate categories on TMDB and are intentionally not included here.
const TMDB_STREAMING_TYPES = 'flatrate';

// --- fetch helpers ---

function tmdbUrl(path, query) {
  const params = Object.entries({ api_key: TMDB_API_KEY, language: 'en-US', ...query })
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${TMDB_BASE}${path}?${params}`;
}

async function tmdbGetJson(path, query) {
  const response = await fetch(tmdbUrl(path, query));
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Request to ${path} failed: ${response.status}`);
  }
  return JSON.parse(response.body);
}

async function sheguGetJson(slug, limit) {
  const url = `${SHEGU_LISTS_BASE}/${slug}?limit=${limit}`;
  const response = await fetch(url);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Request to ${slug} failed: ${response.status}`);
  }
  return JSON.parse(response.body);
}

function sheguVideoTrailerFromResponse(data) {
  if (data == null || typeof data !== 'object') return null;
  const url = typeof data.url === 'string' ? data.url.trim() : '';
  const mimeType = typeof data.mime === 'string' ? data.mime.trim() : '';
  if ((!url.startsWith('http://') && !url.startsWith('https://')) ||
      !mimeType.toLowerCase().startsWith('video/')) return null;
  return {
    title: 'Trailer',
    url,
    site: data.source || null,
    mimeType,
  };
}

async function sheguVideoTrailer(tmdbId, type) {
  try {
    const url = `${SHEGU_TRAILER_BASE}/trailer?tmdb=${encodeURIComponent(tmdbId)}&type=${encodeURIComponent(type)}`;
    const response = await fetch(url);
    if (response.status < 200 || response.status >= 300) return null;
    return sheguVideoTrailerFromResponse(JSON.parse(response.body));
  } catch (_) {
    // Trailer previews are optional; a provider outage must not hide metadata.
    return null;
  }
}

function sheguPreviewWithThumbnail(preview, trailers) {
  if (preview == null) return null;
  const thumbnail = trailers.find((trailer) => trailer.thumbnail)?.thumbnail;
  return thumbnail == null ? preview : { ...preview, thumbnail };
}

// --- ref id ---

function tmdbRefId(mediaType, id) {
  return `${mediaType === 'movie' ? 'movie' : 'series'}:${id}`;
}

function parseTmdbRef(refId) {
  if (typeof refId !== 'string') return null;
  const separator = refId.indexOf(':');
  if (separator < 0) return null;
  const kind = refId.slice(0, separator);
  const tmdbId = refId.slice(separator + 1);
  if ((kind !== 'movie' && kind !== 'series') || tmdbId.length === 0) {
    return null;
  }
  return { kind, tmdbId };
}

// --- mapping ---

// Works for both a search-result-shaped object (trending/top_rated/discover
// `results[]`) and a detail-shaped one (`/movie/{id}`, `/tv/{id}`) — the
// fields this reads are the same in both.
function tmdbToMediaItem(result, mediaType) {
  const kind = mediaType === 'movie' ? 'video' : 'series';
  const title = result.title || result.name || 'Untitled';
  const dateStr = result.release_date || result.first_air_date;
  const releaseYear = dateStr ? parseInt(dateStr.slice(0, 4), 10) : null;
  const rating =
    typeof result.vote_average === 'number' && result.vote_average > 0
      ? result.vote_average
      : null;
  const mediaItem = {
    ref: {
      extensionId: EXTENSION_ID,
      providerId: TMDB_PROVIDER_ID,
      id: tmdbRefId(mediaType, result.id),
    },
    kind,
    title,
  };
  if (Number.isInteger(releaseYear) && releaseYear > 0) {
    mediaItem.releaseYear = releaseYear;
  }
  const releaseDate = tmdbReleaseDateIso(dateStr);
  if (releaseDate) mediaItem.releaseDate = releaseDate;
  if (rating != null) mediaItem.rating = rating;
  const artwork = {};
  if (result.poster_path) artwork.portrait = { url: `${TMDB_IMAGE_BASE}/w500${result.poster_path}` };
  if (result.backdrop_path) artwork.landscape = { url: `${TMDB_IMAGE_BASE}/w780${result.backdrop_path}` };
  const titleLogo = tmdbTitleLogo(result.images);
  if (titleLogo) artwork.logo = { url: `${TMDB_IMAGE_BASE}/w300${titleLogo.file_path}` };
  if (Object.keys(artwork).length > 0) mediaItem.artwork = artwork;
  return mediaItem;
}

// TMDB dates are plain calendar days (no timezone); the app requires a full
// ISO-8601 UTC instant, so anchor them at midnight UTC.
function tmdbReleaseDateIso(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  return `${dateStr}T00:00:00Z`;
}

// TMDB returns logos in popularity order. Prefer an English title treatment,
// then an untagged one that can work across locales.
function tmdbTitleLogo(images) {
  const logos = images && Array.isArray(images.logos) ? images.logos : [];
  return logos.find((logo) => logo.file_path && logo.iso_639_1 === 'en')
    || logos.find((logo) => logo.file_path && logo.iso_639_1 == null)
    || null;
}

function tmdbTrailerUrl(video) {
  const site = String(video.site || '').toLowerCase();
  const key = String(video.key || '').trim();
  if (key.length === 0) return null;
  if (site === 'youtube') {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(key)}`;
  }
  if (site === 'vimeo') return `https://vimeo.com/${encodeURIComponent(key)}`;
  return null;
}

// Keep only preview videos the app can open externally. Official trailers are
// preferred, then teasers, while the upstream publication date breaks ties.
function tmdbTrailers(data) {
  const videos = data && data.videos && Array.isArray(data.videos.results)
    ? data.videos.results
    : [];
  const typeRank = { Trailer: 0, Teaser: 1, Clip: 2, Featurette: 3 };
  return videos
    .map((video, index) => ({ video, index, url: tmdbTrailerUrl(video) }))
    .filter(({ video, url }) =>
      url != null && Object.prototype.hasOwnProperty.call(typeRank, video.type),
    )
    .sort((a, b) => {
      const aOfficial = a.video.official === true ? 0 : 1;
      const bOfficial = b.video.official === true ? 0 : 1;
      if (aOfficial !== bOfficial) return aOfficial - bOfficial;
      const aType = typeRank[a.video.type];
      const bType = typeRank[b.video.type];
      if (aType !== bType) return aType - bType;
      const aDate = Date.parse(a.video.published_at || '') || 0;
      const bDate = Date.parse(b.video.published_at || '') || 0;
      if (aDate !== bDate) return bDate - aDate;
      return a.index - b.index;
    })
    .slice(0, 3)
    .map(({ video, url }) => ({
      title: video.name || video.type || 'Trailer',
      url,
      site: video.site,
      ...(String(video.site || '').toLowerCase() === 'youtube' && video.key
        ? { thumbnail: { url: `https://img.youtube.com/vi/${encodeURIComponent(video.key)}/mqdefault.jpg` } }
        : {}),
    }));
}

// shegu.st's own `ratings.tmdb` is `{value, votes, scale, url}`. Normalize
// it to the 0–10 scale used by the TMDB catalog before exposing it as rating.
function sheguRating(item) {
  const tmdbRating = item.ratings && item.ratings.tmdb;
  if (tmdbRating == null || typeof tmdbRating.value !== 'number') return null;
  const scale =
    typeof tmdbRating.scale === 'number' && tmdbRating.scale > 0 ? tmdbRating.scale : 100;
  const normalized = (tmdbRating.value / scale) * 10;
  return normalized > 0 ? Math.round(normalized * 10) / 10 : null;
}

// shegu.st's `/joy/<slug>` lists (oscar-nominees-best-picture,
// cannes-film-festival) are movie-only, and `poster` is already a full
// image.tmdb.org URL (confirmed against the live API) — unlike TMDB's own
// bare `poster_path`.
function sheguToMediaItem(item, group) {
  if (item.type !== 'movie') return null;
  const tmdbId = item.ids && item.ids.tmdb;
  if (tmdbId == null) return null;
  const mediaItem = {
    ref: {
      extensionId: EXTENSION_ID,
      providerId: TMDB_PROVIDER_ID,
      id: tmdbRefId('movie', tmdbId),
    },
    kind: 'video',
    title: item.title || 'Untitled',
  };
  const releaseYear = Number(item.year);
  const rating = sheguRating(item);
  if (Number.isInteger(releaseYear) && releaseYear > 0) {
    mediaItem.releaseYear = releaseYear;
  }
  if (rating != null) mediaItem.rating = rating;
  if (item.poster) mediaItem.artwork = { portrait: { url: item.poster } };
  return mediaItem;
}

// --- section fetches (each returns MediaItems with no group set yet —
// fetchGroup below tags them) ---

// TMDB has no anime genre, so Japanese animation is the closest honest test:
// genre 16 plus a Japanese origin. Both signals are required — genre 16 alone
// sweeps up Western cartoons, and Japanese origin alone sweeps up live action.
function tmdbIsAnime(result) {
  const genres = Array.isArray(result && result.genre_ids) ? result.genre_ids : [];
  if (genres.indexOf(16) === -1) return false;
  const origin = Array.isArray(result.origin_country) ? result.origin_country : [];
  return result.original_language === 'ja' || origin.indexOf('JP') !== -1;
}

async function fetchTrending(mediaType) {
  const data = await tmdbGetJson(`/trending/${mediaType}/day`, { include_adult: 'false' });
  // Anime has its own row now, from a database that counts cours the way the
  // streaming sites do. Leaving it here as well would put the same title on
  // Home twice, under two ids that resolve through different providers.
  const results = (Array.isArray(data.results) ? data.results : [])
    .filter((result) => !tmdbIsAnime(result));
  const items = results.map((r) => tmdbToMediaItem(r, mediaType));
  if (results.length === 0) return items;

  // Only the editorial lead is enriched because it is the featured candidate.
  // Fetching images for every card would turn one catalog request into N+1.
  try {
    const images = await tmdbGetJson(`/${mediaType}/${results[0].id}/images`, {
      include_image_language: 'en,null',
    });
    const logo = tmdbTitleLogo(images);
    if (logo) {
      items[0].artwork = {
        ...(items[0].artwork || {}),
        logo: { url: `${TMDB_IMAGE_BASE}/w300${logo.file_path}` },
      };
    }
  } catch (e) {
    // Artwork enrichment is optional; the catalog remains usable with text.
  }
  return items;
}

// A future-dated result isn't guaranteed to actually be one — TMDB's flat
// `release_date`/`first_air_date` field can carry a stale, long-past date
// (region rerelease quirks and the like) even when a feed calls the title
// "upcoming". Trust our own read of that date, not the endpoint's label.
function tmdbIsNotYetReleased(item) {
  return typeof item.releaseDate === 'string' && Date.parse(item.releaseDate) > Date.now();
}

// TMDB's own `/movie/upcoming` only covers the near-term theatrical window
// (the next month or two) and misses tentpoles releasing further out — a
// Dune or Avengers sequel a year away won't be in it. Discover every title
// with a future primary release date instead. Popularity, kept alongside
// each item rather than baked into the API's own ordering, is what
// `fetchComingSoon` below uses to pick winners once movies and TV are merged
// — sorting this single list by release date and cutting it to 25 would
// otherwise let a page of near-term small releases bury a tentpole that's
// simply further out (this happened: Dune/Avengers sequels dropped off).
async function fetchUpcomingMovies() {
  const today = new Date().toISOString().slice(0, 10);
  const data = await tmdbGetJson('/discover/movie', {
    page: 1,
    include_adult: 'false',
    'primary_release_date.gte': today,
    sort_by: 'popularity.desc',
  });
  const results = (Array.isArray(data.results) ? data.results : [])
    .filter((result) => !tmdbIsAnime(result));
  return results
    .map((r) => ({ item: tmdbToMediaItem(r, 'movie'), popularity: typeof r.popularity === 'number' ? r.popularity : 0 }))
    .filter((entry) => tmdbIsNotYetReleased(entry.item));
}

// TMDB has no dedicated "upcoming" endpoint for TV at all — discover series
// whose first air date hasn't happened yet, same popularity ranking as movies.
async function fetchUpcomingTv() {
  const today = new Date().toISOString().slice(0, 10);
  const data = await tmdbGetJson('/discover/tv', {
    page: 1,
    include_adult: 'false',
    'first_air_date.gte': today,
    sort_by: 'popularity.desc',
  });
  const results = (Array.isArray(data.results) ? data.results : [])
    .filter((result) => !tmdbIsAnime(result));
  return results
    .map((r) => ({ item: tmdbToMediaItem(r, 'tv'), popularity: typeof r.popularity === 'number' ? r.popularity : 0 }))
    .filter((entry) => tmdbIsNotYetReleased(entry.item));
}

// Movie and TV releases not out yet, combined into one shelf and ranked by
// popularity — not by how soon each one releases. A tentpole several months
// out (Dune, an Avengers sequel) is exactly the kind of title this shelf
// should lead with; sorting by nearest date instead buries it under an
// entire page of small/indie titles that just happen to release sooner.
async function fetchComingSoon() {
  const [movies, series] = await Promise.all([
    fetchUpcomingMovies().catch(() => []),
    fetchUpcomingTv().catch(() => []),
  ]);
  return [...movies, ...series]
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 25)
    .map((entry) => entry.item);
}

function tmdbRequestedPage(page) {
  const parsed = Number(page);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

async function fetchTopRatedPage(mediaType, page) {
  const requestedPage = tmdbRequestedPage(page);
  const data = await tmdbGetJson(`/${mediaType}/top_rated`, {
    page: requestedPage,
    include_adult: 'false',
  });
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    items: results.map((r) => tmdbToMediaItem(r, mediaType)),
    page: typeof data.page === 'number' ? data.page : requestedPage,
    totalPages: typeof data.total_pages === 'number' ? data.total_pages : requestedPage,
  };
}

async function fetchTopRated(mediaType) {
  const page = await fetchTopRatedPage(mediaType, 1);
  return page.items;
}

// A minimum vote count keeps a tiny number of perfect scores from defining
// the all-time shelves. This is deliberately higher than the country shelves
// because these lists promise a broad, established ranking.
const TMDB_ALL_TIME_MIN_VOTE_COUNT = 1000;

async function fetchTopRatedAllTimePage(mediaType, page) {
  return fetchDiscoverPage(mediaType, {
    sort_by: 'vote_average.desc',
    'vote_count.gte': TMDB_ALL_TIME_MIN_VOTE_COUNT,
  }, tmdbRequestedPage(page));
}

async function fetchTopRatedAllTime(mediaType) {
  const page = await fetchTopRatedAllTimePage(mediaType, 1);
  return page.items;
}

async function fetchPopularPage(mediaType, page) {
  const requestedPage = tmdbRequestedPage(page);
  const data = await tmdbGetJson(`/${mediaType}/popular`, {
    page: requestedPage,
    include_adult: 'false',
  });
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    items: results.map((r) => tmdbToMediaItem(r, mediaType)),
    page: typeof data.page === 'number' ? data.page : requestedPage,
    totalPages: typeof data.total_pages === 'number' ? data.total_pages : requestedPage,
  };
}

async function fetchPopular(mediaType) {
  const page = await fetchPopularPage(mediaType, 1);
  return page.items;
}

// TMDB does not expose a dedicated "popular by country" list. Keep the
// country-specific values in data so adding another country only needs one
// entry here. Shelf titles intentionally follow `Popular <Country> Series &
// Movies`, which the app can match with /^Popular (.+) Series & Movies$/i.
const POPULAR_COUNTRY_SHELVES = [
  { id: 'korean', label: 'Korean', originCountry: 'KR', originalLanguage: 'ko' },
  { id: 'indonesian', label: 'Indonesian', originCountry: 'ID', originalLanguage: 'id' },
];

function popularCountryTitle(country) {
  return `Popular ${country.label} Series & Movies`;
}

async function fetchPopularCountryMediaTypePage(country, mediaType, page) {
  const requestedPage = tmdbRequestedPage(page);
  const data = await tmdbGetJson(`/discover/${mediaType}`, {
    page: requestedPage,
    include_adult: 'false',
    with_origin_country: country.originCountry,
    with_original_language: country.originalLanguage,
    sort_by: 'popularity.desc',
    'vote_count.gte': 5,
  });
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    entries: results.map((result) => ({
      item: tmdbToMediaItem(result, mediaType),
      popularity: typeof result.popularity === 'number' ? result.popularity : 0,
      voteCount: typeof result.vote_count === 'number' ? result.vote_count : 0,
    })),
    page: typeof data.page === 'number' ? data.page : requestedPage,
    totalPages: typeof data.total_pages === 'number' ? data.total_pages : requestedPage,
  };
}

async function fetchPopularCountryMediaType(country, mediaType) {
  const page = await fetchPopularCountryMediaTypePage(country, mediaType, 1);
  return page.entries;
}

function popularCountryItems(movies, series) {
  return [...movies, ...series]
    .sort((a, b) => b.popularity - a.popularity || b.voteCount - a.voteCount)
    .slice(0, 25)
    .map((entry) => entry.item);
}

async function fetchPopularCountryPage(country, page) {
  const requestedPage = tmdbRequestedPage(page);
  const [movies, series] = await Promise.all([
    fetchPopularCountryMediaTypePage(country, 'movie', requestedPage),
    fetchPopularCountryMediaTypePage(country, 'tv', requestedPage),
  ]);
  const nextPage = movies.page < movies.totalPages || series.page < series.totalPages
    ? String(requestedPage + 1)
    : null;
  return {
    items: popularCountryItems(movies.entries, series.entries),
    nextPage,
  };
}

async function fetchPopularCountry(country) {
  const page = await fetchPopularCountryPage(country, 1);
  return page.items;
}

async function fetchSheguList(slug) {
  const data = await sheguGetJson(slug, 25);
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((item) => sheguToMediaItem(item, null)).filter((item) => item != null);
}

async function fetchDiscoverPage(mediaType, extraParams, page) {
  const data = await tmdbGetJson(`/discover/${mediaType}`, {
    include_adult: 'false',
    watch_region: 'US',
    sort_by: 'popularity.desc',
    page,
    ...extraParams,
  });
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    items: results.map((r) => tmdbToMediaItem(r, mediaType, null)),
    page: typeof data.page === 'number' ? data.page : page,
    totalPages: typeof data.total_pages === 'number' ? data.total_pages : page,
  };
}

async function fetchDiscover(mediaType, page) {
  return fetchDiscoverPage(mediaType, {}, page);
}

async function fetchPopularStreamingMediaTypePage(mediaType, page) {
  try {
    const requestedPage = tmdbRequestedPage(page);
    const data = await tmdbGetJson(`/discover/${mediaType}`, {
      include_adult: 'false',
      watch_region: TMDB_WATCH_REGION,
      with_watch_monetization_types: TMDB_STREAMING_TYPES,
      sort_by: 'popularity.desc',
      page: requestedPage,
    });
    const results = Array.isArray(data.results) ? data.results : [];
    return {
      entries: results.map((result) => ({
        item: tmdbToMediaItem(result, mediaType),
        popularity: typeof result.popularity === 'number' ? result.popularity : 0,
      })),
      page: typeof data.page === 'number' ? data.page : requestedPage,
      totalPages: typeof data.total_pages === 'number' ? data.total_pages : requestedPage,
    };
  } catch (_) {
    return { entries: [], page: 1, totalPages: 1 };
  }
}

async function fetchPopularStreamingMediaType(mediaType) {
  const page = await fetchPopularStreamingMediaTypePage(mediaType, 1);
  return page.entries;
}

// Combine paid movie and TV streaming results into one shelf. The public API
// exposes the availability filter, while the website's private panel owns its
// own ranking and may therefore show a different order.
async function fetchPopularStreaming() {
  const page = await fetchPopularStreamingPage(1);
  return page.items;
}

async function fetchPopularStreamingPage(page) {
  const requestedPage = tmdbRequestedPage(page);
  const [movies, tv] = await Promise.all([
    fetchPopularStreamingMediaTypePage('movie', requestedPage),
    fetchPopularStreamingMediaTypePage('tv', requestedPage),
  ]);
  const items = [...movies.entries, ...tv.entries]
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 25)
    .map((entry) => entry.item);
  const nextPage = movies.page < movies.totalPages || tv.page < tv.totalPages
    ? String(requestedPage + 1)
    : null;
  return { items, nextPage };
}

// TMDB's `watch_providers` catalog ids — stable across regions, used with
// `with_watch_providers` to narrow discover to one streamer's US catalog.
const WATCH_PROVIDER = {
  netflix: 8,
  hulu: 15,
  disneyPlus: 337,
  primeVideo: 9,
  hbo: 1899,
  appleTv: 350,
};

async function fetchWatchProvider(mediaType, providerId) {
  const page = await fetchDiscoverPage(mediaType, { with_watch_providers: providerId }, 1);
  return page.items;
}

async function fetchWatchProviderPage(mediaType, providerId, page) {
  const discover = await fetchDiscoverPage(
    mediaType,
    { with_watch_providers: providerId },
    tmdbRequestedPage(page),
  );
  return {
    items: discover.items,
    nextPage: discover.page < discover.totalPages ? String(discover.page + 1) : null,
  };
}

// Try/catch wrapper so one upstream outage drops just its own section
// instead of failing the whole shelf.
async function fetchGroup(label, fetchFn) {
  try {
    const items = await fetchFn();
  return items;
  } catch (e) {
    return [];
  }
}

async function fetchGroupPage(label, fetchFn, page) {
  try {
    const result = await fetchFn(page);
    return result && Array.isArray(result.items) ? result : { items: [] };
  } catch (e) {
    return { items: [] };
  }
}

// --- "highlights" catalog: the `all` category — horizontal-row
// sections, movie and tv mixed, exactly the shape originally asked for.
// Separate from the `movie`/`tv` grid catalog below: same provider, second
// catalog, own catalogId, so it can keep `display: "row"` while the other
// one is `"grid"` (CatalogDecl.display is one value per catalog, not per
// category — see manifest.json).

const HIGHLIGHTS_CATALOG_ID = 'highlights';
const TMDB_ALL_CATEGORY = 'all';

async function fetchTimesoccerHighlights() {
  const loader = globalThis.__timesoccerHighlightPage;
  if (typeof loader !== 'function') return [];
  try {
    const page = await loader(null);
    return page && Array.isArray(page.items) ? page.items : [];
  } catch (_) {
    return [];
  }
}

async function fetchTimesoccerHighlightsPage(page) {
  const loader = globalThis.__timesoccerHighlightPage;
  if (typeof loader !== 'function') return { items: [] };
  try {
    const result = await loader(page);
    return result && Array.isArray(result.items) ? result : { items: [] };
  } catch (_) {
    return { items: [] };
  }
}

const HIGHLIGHT_GROUPS = [
  { id: 'trending_movie', name: 'Trending Movie', fetch: () => fetchTrending('movie') },
  { id: 'trending_tv', name: 'Trending TV', fetch: () => fetchTrending('tv') },
  {
    id: 'popular_today',
    name: 'Popular Today',
    fetch: fetchPopularStreaming,
    fetchPage: fetchPopularStreamingPage,
  },
  { id: 'football_highlights', name: 'Football Highlights', fetch: fetchTimesoccerHighlights },
  { id: 'coming_soon', name: 'Coming Soon', fetch: () => fetchComingSoon() },
  { id: 'trending_anime', name: 'Trending Anime', fetch: () => anilistHighlightItems() },
  { id: 'popular_anime_season', name: 'Popular Anime This Season', fetch: () => anilistPopularSeasonItems() },
  {
    id: 'top_rated_movie',
    name: 'Top Rated Movie',
    fetch: () => fetchTopRated('movie'),
    fetchPage: async (page) => {
      const result = await fetchTopRatedPage('movie', page);
      return {
        items: result.items,
        nextPage: result.page < result.totalPages ? String(result.page + 1) : null,
      };
    },
  },
  {
    id: 'top_rated_tv',
    name: 'Top Rated TV',
    fetch: () => fetchTopRated('tv'),
    fetchPage: async (page) => {
      const result = await fetchTopRatedPage('tv', page);
      return {
        items: result.items,
        nextPage: result.page < result.totalPages ? String(result.page + 1) : null,
      };
    },
  },
  {
    id: 'top_movie_all_time',
    name: 'Top Movies All Time',
    fetch: () => fetchTopRatedAllTime('movie'),
    fetchPage: async (page) => {
      const result = await fetchTopRatedAllTimePage('movie', page);
      return {
        items: result.items,
        nextPage: result.page < result.totalPages ? String(result.page + 1) : null,
      };
    },
  },
  {
    id: 'top_tv_all_time',
    name: 'Top Series All Time',
    fetch: () => fetchTopRatedAllTime('tv'),
    fetchPage: async (page) => {
      const result = await fetchTopRatedAllTimePage('tv', page);
      return {
        items: result.items,
        nextPage: result.page < result.totalPages ? String(result.page + 1) : null,
      };
    },
  },
  { id: 'oscar_nominees', name: 'Oscar Nominees', fetch: () => fetchSheguList('oscar-nominees-best-picture') },
  { id: 'cannes', name: 'Cannes Film Festival', fetch: () => fetchSheguList('cannes-film-festival') },
  {
    id: 'netflix_movies',
    name: 'Movies on Netflix',
    fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.netflix),
    fetchPage: (page) => fetchWatchProviderPage('movie', WATCH_PROVIDER.netflix, page),
  },
  {
    id: 'hulu_movies',
    name: 'Movies on Hulu',
    fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.hulu),
    fetchPage: (page) => fetchWatchProviderPage('movie', WATCH_PROVIDER.hulu, page),
  },
  {
    id: 'disney_movies',
    name: 'Movies on Disney+',
    fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.disneyPlus),
    fetchPage: (page) => fetchWatchProviderPage('movie', WATCH_PROVIDER.disneyPlus, page),
  },
  {
    id: 'prime_movies',
    name: 'Movies on Prime Video',
    fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.primeVideo),
    fetchPage: (page) => fetchWatchProviderPage('movie', WATCH_PROVIDER.primeVideo, page),
  },
  {
    id: 'hbo_movies',
    name: 'Movies on HBO',
    fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.hbo),
    fetchPage: (page) => fetchWatchProviderPage('movie', WATCH_PROVIDER.hbo, page),
  },
  {
    id: 'appletv_movies',
    name: 'Movies on Apple TV',
    fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.appleTv),
    fetchPage: (page) => fetchWatchProviderPage('movie', WATCH_PROVIDER.appleTv, page),
  },
  {
    id: 'netflix_tv',
    name: 'TV Series on Netflix',
    fetch: () => fetchWatchProvider('tv', WATCH_PROVIDER.netflix),
    fetchPage: (page) => fetchWatchProviderPage('tv', WATCH_PROVIDER.netflix, page),
  },
  {
    id: 'disney_tv',
    name: 'TV Series on Disney+',
    fetch: () => fetchWatchProvider('tv', WATCH_PROVIDER.disneyPlus),
    fetchPage: (page) => fetchWatchProviderPage('tv', WATCH_PROVIDER.disneyPlus, page),
  },
  {
    id: 'appletv_tv',
    name: 'TV Series on Apple TV',
    fetch: () => fetchWatchProvider('tv', WATCH_PROVIDER.appleTv),
    fetchPage: (page) => fetchWatchProviderPage('tv', WATCH_PROVIDER.appleTv, page),
  },
  {
    id: 'prime_tv',
    name: 'TV Series on Prime',
    fetch: () => fetchWatchProvider('tv', WATCH_PROVIDER.primeVideo),
    fetchPage: (page) => fetchWatchProviderPage('tv', WATCH_PROVIDER.primeVideo, page),
  },
  {
    id: 'hbo_tv',
    name: 'TV Series on HBO',
    fetch: () => fetchWatchProvider('tv', WATCH_PROVIDER.hbo),
    fetchPage: (page) => fetchWatchProviderPage('tv', WATCH_PROVIDER.hbo, page),
  },
  ...POPULAR_COUNTRY_SHELVES.map((country) => ({
    id: `popular_${country.id}`,
    name: popularCountryTitle(country),
    fetch: () => fetchPopularCountry(country),
    fetchPage: (page) => fetchPopularCountryPage(country, page),
  })),
  { id: 'rotten_tomatoes_best', name: 'Rotten Tomatoes Best of All Time', fetch: () => fetchSheguList('rotten-tomatoes-best-of-all-time') },
  { id: 'based_on_true_story', name: 'Based On True Story', fetch: () => fetchSheguList('based-on-a-true-story') },
];

// Highlights declare `subCategories` — one per group, id-matched to the name
// each group is tagged with. Groups backed by a paginated TMDB endpoint also
// expose `nextPage`, allowing the app's See more grid to load more on scroll.
// Non-paginated editorial lists remain single-page, but *do*
// declare `subCategories` — one per group, id-matched to the name each
// group is tagged with — so "See more" on any one of them narrows to just
// that section instead of falling back to the whole unnarrowed catalog
// (the app only narrows when it finds a subCategory whose name matches the
// section heading it came from; with none declared, every "See more" here
// used to reopen everything, unfiltered, under a mismatched title).
async function tmdbHighlightsCatalog(query) {
  if (query.category !== TMDB_ALL_CATEGORY) return { sections: [] };
  const subCategories = HIGHLIGHT_GROUPS.map((g) => ({ id: g.id, name: g.name }));

  if (query.subCategory != null) {
    const matched = HIGHLIGHT_GROUPS.find((g) => g.id === query.subCategory);
    if (matched == null) return { sections: [], subCategories };
    if (matched.id === 'football_highlights') {
      const page = await fetchTimesoccerHighlightsPage(query.page);
      const result = {
        sections: [{ id: matched.id, title: matched.name, items: page.items }],
        subCategories,
      };
      if (page.nextPage != null) result.nextPage = page.nextPage;
      return result;
    }
    if (typeof matched.fetchPage === 'function') {
      const page = await fetchGroupPage(matched.name, matched.fetchPage, query.page);
      const result = {
        sections: [{ id: matched.id, title: matched.name, items: page.items }],
        subCategories,
      };
      if (page.nextPage != null) result.nextPage = page.nextPage;
      return result;
    }
    const items = await fetchGroup(matched.name, matched.fetch);
    return { sections: [{ id: matched.id, title: matched.name, items }], subCategories };
  }

  const itemGroups = await Promise.all(
    HIGHLIGHT_GROUPS.map((g) => fetchGroup(g.name, g.fetch)),
  );
  return {
    sections: HIGHLIGHT_GROUPS.map((group, index) => ({
      id: group.id,
      title: group.name,
      items: itemGroups[index],
    })).filter((section) => section.items.length > 0),
    subCategories,
  };
}

// --- catalog: no sections, no subCategories — just the popularity-sorted
// discover feed, straight from the API, paginated for infinite scroll. Named
// curated lists (Trending/Top Rated/Oscar Nominees/Cannes) live only on the
// `highlights` (`all`) catalog above; `movie`/`tv` is deliberately a single
// flat, ungrouped list so nothing renders a section heading between pages.

async function tmdbCatalog(query) {
  const mediaType =
    query.category === TMDB_MOVIE_CATEGORY
      ? 'movie'
      : query.category === TMDB_TV_CATEGORY
        ? 'tv'
        : null;
  if (mediaType == null) return { sections: [] };

  const page = query.page ? Number(query.page) : 1;
  const discover = await fetchDiscover(mediaType, page);
  const result = { sections: [{ id: 'discover', items: discover.items }] };
  if (discover.page < discover.totalPages) result.nextPage = String(discover.page + 1);
  return result;
}

// --- "previews" catalog: the Shorts feed producer — Coming Soon interleaved
// with released Trending Movie/TV, de-duplicated by MediaRef. This is a
// preview-surface catalog (`categories: []` in manifest.json), so it never
// appears as a Home shelf; the app discovers it only through the Shorts
// registry lookup. The merge policy is entirely ours — the app renders the
// declared order and does not re-sort it.

const PREVIEW_CATALOG_ID = 'previews';
const PREVIEW_TRAILER_TTL_MS = 60 * 60 * 1000;

function mediaRefKey(ref) {
  return `${ref.extensionId}/${ref.providerId}/${ref.id}`;
}

// Alternates movie/tv within one pool so a run of same-kind candidates
// doesn't dominate a stretch of the feed, while preserving each kind's own
// relative order (popularity for Coming Soon, trending rank for Trending).
function alternateByKind(items) {
  const movies = items.filter((item) => item.kind === 'video');
  const series = items.filter((item) => item.kind === 'series');
  const merged = [];
  for (let i = 0; i < movies.length || i < series.length; i++) {
    if (i < movies.length) merged.push(movies[i]);
    if (i < series.length) merged.push(series[i]);
  }
  return merged;
}

// Trending's "day" window can surface a title whose release date is still
// ahead of it (an early trailer spike) — Coming Soon already owns that case,
// so this pool is filtered down to what's actually out.
async function fetchReleasedTrending() {
  const [movies, tv] = await Promise.all([
    fetchTrending('movie').catch(() => []),
    fetchTrending('tv').catch(() => []),
  ]);
  return alternateByKind([...movies, ...tv]).filter(
    (item) => !tmdbIsNotYetReleased(item),
  );
}

// Interleaves two Coming Soon candidates with one released Trending
// candidate, then de-duplicates by MediaRef, keeping the first occurrence —
// upcoming discovery leads the feed while every few items stay useful for
// the Watch action right away.
function interleavePreviewFeed(comingSoon, trending) {
  const merged = [];
  let ci = 0;
  let ti = 0;
  while (ci < comingSoon.length || ti < trending.length) {
    for (let n = 0; n < 2 && ci < comingSoon.length; n++) merged.push(comingSoon[ci++]);
    if (ti < trending.length) merged.push(trending[ti++]);
  }
  const seen = new Set();
  return merged.filter((item) => {
    const key = mediaRefKey(item.ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function tmdbPreviewCatalog() {
  const [comingSoonRaw, trending] = await Promise.all([
    fetchComingSoon().catch(() => []),
    fetchReleasedTrending().catch(() => []),
  ]);
  const candidates = interleavePreviewFeed(alternateByKind(comingSoonRaw), trending);
  const items = await filterToItemsWithTrailer(candidates);
  return { sections: [{ id: 'previews', items }] };
}

// --- meta (detail page fetch) ---

const TMDB_MAX_CAST = 15;

function tmdbCreditsOf(data) {
  const cast = data.credits && Array.isArray(data.credits.cast) ? data.credits.cast : [];
  return cast.slice(0, TMDB_MAX_CAST).map((person) => {
    const member = { name: person.name || 'Unknown' };
    if (person.character) member.role = person.character;
    if (person.profile_path) {
      member.image = { url: `${TMDB_IMAGE_BASE}/w185${person.profile_path}` };
    }
    return member;
  });
}

function tmdbUsCertification(movieData) {
  const results =
    movieData.release_dates && Array.isArray(movieData.release_dates.results)
      ? movieData.release_dates.results
      : [];
  const us = results.find((r) => r.iso_3166_1 === 'US');
  if (us == null || !Array.isArray(us.release_dates)) return null;
  const withCert = us.release_dates.find((d) => d.certification);
  return withCert ? withCert.certification : null;
}

function tmdbUsContentRating(tvData) {
  const results =
    tvData.content_ratings && Array.isArray(tvData.content_ratings.results)
      ? tvData.content_ratings.results
      : [];
  const us = results.find((r) => r.iso_3166_1 === 'US');
  return us && us.rating ? us.rating : null;
}

function tmdbGenresOf(data) {
  return Array.isArray(data.genres) ? data.genres.map((g) => g.name).filter((n) => !!n) : [];
}

function tmdbFact(facts, label, value) {
  if (typeof value === 'string' && value.trim().length > 0) {
    facts.push({ label, value });
  }
}

function tmdbNames(values) {
  if (!Array.isArray(values)) return null;
  const names = values
    .map((value) => value && typeof value.name === 'string' ? value.name : null)
    .filter((value) => value != null);
  return names.length > 0 ? names.join(', ') : null;
}

function tmdbMovieFacts(data) {
  const facts = [];
  if (typeof data.runtime === 'number' && data.runtime > 0) {
    tmdbFact(facts, 'Runtime', `${data.runtime} min`);
  }
  tmdbFact(facts, 'Release date', data.release_date);
  tmdbFact(facts, 'Certification', tmdbUsCertification(data));
  tmdbFact(facts, 'Status', data.status);
  tmdbFact(facts, 'Original language', data.original_language);
  tmdbFact(facts, 'Languages', tmdbNames(data.spoken_languages));
  tmdbFact(facts, 'Production countries', tmdbNames(data.production_countries));
  return facts;
}

function tmdbTvFacts(data) {
  const facts = [];
  if (Array.isArray(data.episode_run_time) && data.episode_run_time.length > 0) {
    tmdbFact(facts, 'Episode runtime', `${data.episode_run_time[0]} min`);
  }
  tmdbFact(facts, 'First aired', data.first_air_date);
  tmdbFact(facts, 'Certification', tmdbUsContentRating(data));
  tmdbFact(facts, 'Status', data.status);
  if (typeof data.number_of_seasons === 'number' && data.number_of_seasons > 0) {
    tmdbFact(facts, 'Seasons', String(data.number_of_seasons));
  }
  if (typeof data.number_of_episodes === 'number' && data.number_of_episodes > 0) {
    tmdbFact(facts, 'Episodes', String(data.number_of_episodes));
  }
  tmdbFact(facts, 'Original language', data.original_language);
  tmdbFact(facts, 'Networks', tmdbNames(data.networks));
  return facts;
}

function tmdbEpisodeRef(tvId, seasonNumber, episodeNumber) {
  return {
    extensionId: EXTENSION_ID,
    providerId: TMDB_PROVIDER_ID,
    id: `series:${tvId}:season:${seasonNumber}:episode:${episodeNumber}`,
  };
}

function tmdbEpisodeOf(tvId, seasonNumber, episode) {
  const mapped = {
    ref: tmdbEpisodeRef(tvId, seasonNumber, episode.episode_number),
    title: episode.name || 'Untitled',
    position: episode.episode_number,
  };
  if (episode.overview) mapped.description = episode.overview;
  if (episode.still_path) {
    mapped.artwork = { landscape: { url: `${TMDB_IMAGE_BASE}/w300${episode.still_path}` } };
  }
  if (typeof episode.runtime === 'number' && episode.runtime > 0) {
    mapped.durationSeconds = episode.runtime * 60;
  }
  // `air_date` is a bare `"YYYY-MM-DD"` — pinned to UTC midnight explicitly
  // rather than left for the app's date parser to assume a timezone, which
  // could roll it into the wrong day depending on the device's own.
  if (episode.air_date) mapped.availableAt = `${episode.air_date}T00:00:00Z`;
  return mapped;
}

// TMDB's `/tv/{id}` only gives season counts, not episodes — fetch each
// season's episodes in parallel (SeriesSeason.episodes is expected eagerly,
// not lazily, per media_item.dart).
async function tmdbSeasonsOf(tvId, showData) {
  const seasons = Array.isArray(showData.seasons) ? showData.seasons : [];
  return Promise.all(
    seasons.map(async (season) => {
      const detail = await tmdbGetJson(`/tv/${tvId}/season/${season.season_number}`, {});
      const episodes = Array.isArray(detail.episodes) ? detail.episodes : [];
      return {
        id: `season:${season.season_number}`,
        title: season.name || `Season ${season.season_number}`,
        episodes: episodes.map((episode) =>
          tmdbEpisodeOf(tvId, season.season_number, episode)),
      };
    }),
  );
}

async function tmdbRelatedPage(tmdbId, mediaType, relation) {
  try {
    const data = await tmdbGetJson(`/${mediaType}/${tmdbId}/${relation}`, {
      page: 1,
      include_adult: 'false',
    });
    const results = Array.isArray(data.results) ? data.results : [];
    const currentRef = tmdbRefId(mediaType, tmdbId);
    return results
      .map((result) => tmdbToMediaItem(result, mediaType))
      .filter((item) => item.ref.id !== currentRef)
      .slice(0, 10);
  } catch (_) {
    return [];
  }
}

async function tmdbCollectionOf(collectionId) {
  if (collectionId == null) return null;
  try {
    const data = await tmdbGetJson(`/collection/${collectionId}`, {
      include_adult: 'false',
    });
    const parts = Array.isArray(data.parts) ? data.parts : [];
    const items = parts
      .filter((part) => part && part.id != null)
      .map((part) => tmdbToMediaItem(part, 'movie'));
    if (items.length === 0) return null;
    return {
      id: String(data.id || collectionId),
      name: data.name || 'Collection',
      items,
    };
  } catch (_) {
    return null;
  }
}

// Recommendations are the primary detail shelf. Similar is only a fallback:
// TMDB's similar endpoint is based on genres and keywords and can be loose.
async function tmdbRecommendationsOf(tmdbId, mediaType) {
  const recommendations = await tmdbRelatedPage(tmdbId, mediaType, 'recommendations');
  return recommendations.length > 0
    ? recommendations
    : tmdbRelatedPage(tmdbId, mediaType, 'similar');
}

async function tmdbMovieMeta(tmdbId) {
  const data = await tmdbGetJson(`/movie/${tmdbId}`, {
    append_to_response: 'credits,release_dates,images,videos',
    include_image_language: 'en,null',
    include_video_language: 'en,null',
  });
  const detail = { item: tmdbToMediaItem(data, 'movie') };
  if (data.overview) detail.description = data.overview;
  const genres = tmdbGenresOf(data);
  if (genres.length > 0) detail.tags = genres;
  const facts = tmdbMovieFacts(data);
  if (facts.length > 0) detail.facts = facts;
  const credits = tmdbCreditsOf(data);
  if (credits.length > 0) detail.credits = credits;
  const trailers = tmdbTrailers(data);
  const collectionId = data.belongs_to_collection && data.belongs_to_collection.id;
  const [previewResponse, recommendations, collection] = await Promise.all([
    sheguVideoTrailer(tmdbId, 'movie'),
    tmdbRecommendationsOf(tmdbId, 'movie'),
    tmdbCollectionOf(collectionId),
  ]);
  const preview = sheguPreviewWithThumbnail(previewResponse, trailers);
  if (preview != null) trailers.unshift(preview);
  if (trailers.length > 0) detail.trailers = trailers;
  if (collection != null) detail.collection = collection;
  if (recommendations.length > 0) detail.recommendations = recommendations;
  return detail;
}

async function tmdbTvMeta(tmdbId) {
  const data = await tmdbGetJson(`/tv/${tmdbId}`, {
    append_to_response: 'credits,content_ratings,images,videos',
    include_image_language: 'en,null',
    include_video_language: 'en,null',
  });
  const detail = { item: tmdbToMediaItem(data, 'tv') };
  if (data.overview) detail.description = data.overview;
  const genres = tmdbGenresOf(data);
  if (genres.length > 0) detail.tags = genres;
  const facts = tmdbTvFacts(data);
  if (facts.length > 0) detail.facts = facts;
  const credits = tmdbCreditsOf(data);
  if (credits.length > 0) detail.credits = credits;
  const trailers = tmdbTrailers(data);
  const [previewResponse, recommendations] = await Promise.all([
    sheguVideoTrailer(tmdbId, 'tv'),
    tmdbRecommendationsOf(tmdbId, 'tv'),
  ]);
  const preview = sheguPreviewWithThumbnail(previewResponse, trailers);
  if (preview != null) trailers.unshift(preview);
  if (trailers.length > 0) detail.trailers = trailers;
  if (recommendations.length > 0) detail.recommendations = recommendations;
  const seasons = await tmdbSeasonsOf(tmdbId, data);
  if (seasons.length > 0) {
    detail.episodeGuide = { groups: seasons };
  }
  // `last_episode_to_air` is TMDB's own answer to "what's actually aired so
  // far" — `seasons` above lists every episode announced, aired or not, so
  // this is what tells the app's Play button where to default a series that
  // has never been played, instead of walking the full episode list live
  // to find out (see latestAvailableEpisodeTarget in the app).
  const lastAired = data.last_episode_to_air;
  if (
    lastAired &&
    typeof lastAired.season_number === 'number' &&
    typeof lastAired.episode_number === 'number'
  ) {
    const defaultRef = tmdbEpisodeRef(
      tmdbId,
      lastAired.season_number,
      lastAired.episode_number,
    );
    if (seasons.some((group) => group.episodes.some((episode) =>
      episode.ref.id === defaultRef.id))) {
      detail.episodeGuide.defaultEpisodeRef = defaultRef;
    }
  }
  return detail;
}

async function tmdbMeta(args) {
  const parsed = parseTmdbRef(args.ref && args.ref.id);
  if (parsed === null) {
    throw new Error(`Not a TMDB ref id: ${args.ref && args.ref.id}`);
  }
  return parsed.kind === 'series' ? tmdbTvMeta(parsed.tmdbId) : tmdbMovieMeta(parsed.tmdbId);
}

// --- preview (Shorts feed catalog filter + just-in-time resolver) ---
//
// Deliberately its own lightweight fetch, not a slice of `tmdbMovieMeta`/
// `tmdbTvMeta`'s `append_to_response`: those pull credits, release dates and
// images on top of videos, which would turn "does this candidate have a
// trailer" into a full detail fetch per candidate.

async function tmdbVideosOnly(mediaType, tmdbId) {
  const data = await tmdbGetJson(`/${mediaType}/${tmdbId}/videos`, {
    include_video_language: 'en,null',
  });
  return Array.isArray(data.results) ? data.results : [];
}

function newestByPublishDate(videos) {
  if (videos.length === 0) return null;
  return videos
    .slice()
    .sort((a, b) => (Date.parse(b.published_at || '') || 0) - (Date.parse(a.published_at || '') || 0))[0];
}

// Official Trailer, then official Teaser, then a non-official Trailer,
// falling back to whatever YouTube video was published most recently. Only
// YouTube is considered: the app resolves the returned key as a YouTube
// embed, never a raw watch URL.
function tmdbPreviewVideoKey(videos) {
  const youtubeVideos = videos.filter(
    (v) => v && String(v.site || '').toLowerCase() === 'youtube'
      && typeof v.key === 'string' && v.key.trim().length > 0,
  );
  const officialTrailers = youtubeVideos.filter((v) => v.type === 'Trailer' && v.official === true);
  const officialTeasers = youtubeVideos.filter((v) => v.type === 'Teaser' && v.official === true);
  const nonOfficialTrailers = youtubeVideos.filter((v) => v.type === 'Trailer' && v.official !== true);
  const chosen =
    newestByPublishDate(officialTrailers)
    || newestByPublishDate(officialTeasers)
    || newestByPublishDate(nonOfficialTrailers)
    || newestByPublishDate(youtubeVideos);
  return chosen ? chosen.key.trim() : null;
}

// Resolved trailer keys (or `null` for "checked, no trailer"), keyed by
// `mediaType:tmdbId` — bridges `filterToItemsWithTrailer`'s catalog-build
// check and the Shorts workflow's later per-item `preview()` call for the
// same title so it isn't the exact same TMDB videos fetch twice. Entries are
// session-only and expire so newly published trailers can be discovered.
const _previewTrailerCache = new Map();

async function trailerKeyFor(item) {
  const parsed = item && item.ref ? parseTmdbRef(item.ref.id) : null;
  if (parsed === null) return null;
  const mediaType = parsed.kind === 'series' ? 'tv' : 'movie';
  const cacheKey = `${mediaType}:${parsed.tmdbId}`;
  const nowMs = Date.now();
  const cached = _previewTrailerCache.get(cacheKey);
  if (cached != null && nowMs - cached.fetchedAt < PREVIEW_TRAILER_TTL_MS) {
    return cached.key;
  }
  const videos = await tmdbVideosOnly(mediaType, parsed.tmdbId);
  const key = tmdbPreviewVideoKey(videos);
  _previewTrailerCache.set(cacheKey, { key, fetchedAt: nowMs });
  return key;
}

// A candidate with no resolvable YouTube trailer is a dead end in the
// Shorts feed — the viewer would swipe to it and get skipped immediately.
// Checking every candidate here, once per catalog load, keeps it out of
// the list entirely rather than relying on the client's own lazy skip.
async function filterToItemsWithTrailer(items) {
  const keys = await Promise.all(items.map((item) => trailerKeyFor(item).catch(() => null)));
  return items.filter((_, i) => keys[i] != null);
}

// Nothing here is persisted, and the short TTL above lets a caller re-resolve
// an item's preview after an upstream trailer update.
async function tmdbPreview(args) {
  const item = args && args.item;
  let key;
  try {
    key = await trailerKeyFor(item);
  } catch (_) {
    // An upstream hiccup on one item must not look different from that
    // item simply having no trailer.
    return { sources: [] };
  }
  if (key == null) return { sources: [] };
  return {
    sources: [{ id: `yt:${key}`, type: 'embedded', provider: 'youtube', mediaId: key }],
  };
}

// --- search ---
//
// The app fans a free-text query out to every extension's own `search`
// once, unpaged, and merges the results (see `ExtensionRegistry.search`) —
// no per-media-type split on the app side, so both `/search/movie` and
// `/search/tv` are queried here and merged into one list, newest-relevance
// first by TMDB's own `popularity` (each endpoint only ranks within its own
// kind, so this is what makes a single combined ordering out of the two).
//
// One endpoint failing (network blip on just movie or just tv) doesn't
// blank the other's results — same tolerance `fetchGroup` gives catalog
// sections.
async function tmdbSearchType(mediaType, query, page, extraParams) {
  try {
    const data = await tmdbGetJson(`/search/${mediaType}`, {
      query,
      page,
      include_adult: 'false',
      ...extraParams,
    });
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((result) => ({ result, mediaType }));
  } catch (e) {
    return [];
  }
}

// TMDB backs the film and television scopes and nothing else here: anime has
// its own catalog, counted the way the streaming sites count, and NSFW is
// Indomax's. Answering those scopes would put the wrong database in front of
// a user who just told us which one they wanted. An unscoped search still
// searches both of TMDB's kinds, as it always has.
const TMDB_SEARCH_CATEGORIES = ['movie', 'tv'];

async function tmdbSearch(args) {
  const query = args.query;
  if (!query) return { sections: [] };
  const category = args.category;
  if (category != null && TMDB_SEARCH_CATEGORIES.indexOf(category) === -1) {
    return { sections: [] };
  }
  const page = args.page ? Number(args.page) : 1;
  const [movies, tv] = await Promise.all([
    category === 'tv'
      ? []
      : tmdbSearchType('movie', query, page, { region: 'US' }),
    category === 'movie' ? [] : tmdbSearchType('tv', query, page),
  ]);
  const merged = [...movies, ...tv].sort(
    (a, b) => (b.result.popularity || 0) - (a.result.popularity || 0),
  );
  return {
    sections: [{
      id: 'results',
      items: merged.map((entry) => tmdbToMediaItem(entry.result, entry.mediaType)),
    }],
  };
}

// --- provider registry ---

globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: TMDB_CATALOG_ID,
  catalog: tmdbCatalog,
});
globalThis.__catalogProviders.push({
  catalogId: HIGHLIGHTS_CATALOG_ID,
  catalog: tmdbHighlightsCatalog,
});
globalThis.__catalogProviders.push({
  catalogId: PREVIEW_CATALOG_ID,
  catalog: tmdbPreviewCatalog,
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.catalog) {
  globalThis.__extension.catalog = async (query) => {
    const provider = globalThis.__catalogProviders.find(
      (p) => p.catalogId === query.catalogId,
    );
    if (!provider) {
      throw new Error(`No catalog provider registered for "${query.catalogId}"`);
    }
    return provider.catalog(query);
  };
}

globalThis.__metaProviders = globalThis.__metaProviders || [];
globalThis.__metaProviders.push({
  providerId: TMDB_PROVIDER_ID,
  meta: tmdbMeta,
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.meta) {
  globalThis.__extension.meta = async (args) => {
    const provider = globalThis.__metaProviders.find(
      (p) => p.providerId === args.ref.providerId,
    );
    if (!provider) {
      throw new Error(`No meta provider registered for "${args.ref.providerId}"`);
    }
    return provider.meta(args);
  };
}

globalThis.__previewProviders = globalThis.__previewProviders || [];
globalThis.__previewProviders.push({
  providerId: TMDB_PROVIDER_ID,
  preview: tmdbPreview,
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.preview) {
  globalThis.__extension.preview = async (args) => {
    const providerId = args && args.item && args.item.ref ? args.item.ref.providerId : null;
    const provider = globalThis.__previewProviders.find((p) => p.providerId === providerId);
    if (!provider) {
      throw new Error(`No preview provider registered for "${providerId}"`);
    }
    return provider.preview(args);
  };
}

// Unlike catalog/meta, `search` is called once per *extension*, not routed
// by a provider or catalog id (see `ExtensionRegistry.search`) — so there's
// nothing to dispatch on, and no other provider in this extension needs the
// slot. A plain guarded assignment is enough.
globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.search) {
  globalThis.__extension.search = tmdbSearch;
}

// shegu.st subtitle lookup, in JS on the host `fetch` API.
//
// A Stremio-shaped subtitle addon: one GET, keyed by TMDB id, returns a flat
// list of {language, url, type, display, source}. No cipher, no auth — the
// simplest upstream this bundle talks to.

const SHEGU_BASE = globalThis.__sheguBaseUrl || 'https://subtitles.shegu.st';

async function fetchMovieSubtitles(tmdbId, season, episode) {
  let url = `${SHEGU_BASE}/subtitles?type=movie&tmdb=${encodeURIComponent(tmdbId)}`;
  if (season != null && episode != null) {
    url = `${SHEGU_BASE}/subtitles?type=tv&tmdb=${encodeURIComponent(tmdbId)}&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`;
  }

  let response;
  try {
    response = await fetch(url);
  } catch (_) {
    return [];
  }
  if (response.status < 200 || response.status >= 300) return [];

  let data;
  try {
    data = JSON.parse(response.body);
  } catch (_) {
    return [];
  }
  const list = Array.isArray(data.subtitles) ? data.subtitles : [];

  const tracks = [];
  for (const entry of list) {
    const language = entry && entry.language;
    const trackUrl = entry && entry.url;
    if (!language || !trackUrl) continue;
    tracks.push({ language, url: trackUrl, label: entry.display || '' });
  }
  return tracks;
}

globalThis.sheguSubtitles = { fetchMovieSubtitles };

// ---- externalSubtitles role — a manual lookup, independent of any source ----
//
// The player's "fetch external subtitles" button asks for this role directly,
// keyed only on the item's `movie:<tmdbId>` /
// `series:<tmdbId>` ref, same convention every other provider file in this
// bundle re-parses for itself — see e.g. vaplayer.js's parseVaplayerRef).
function parseSheguRef(refId) {
  if (typeof refId !== 'string') return null;
  const episode = /^series:([^:]+):season:([^:]+):episode:([^:]+)$/.exec(refId);
  if (episode != null) {
    return {
      kind: 'series',
      tmdbId: episode[1],
      season: episode[2],
      episode: episode[3],
    };
  }
  const separator = refId.indexOf(':');
  if (separator < 0) return null;
  const kind = refId.slice(0, separator);
  const tmdbId = refId.slice(separator + 1);
  if ((kind !== 'movie' && kind !== 'series') || tmdbId.length === 0) {
    return null;
  }
  return { kind, tmdbId, season: null, episode: null };
}

function parseSheguAnilistEpisode(refId, item) {
  if (typeof refId !== 'string') return null;
  const match = /^anilist:episode:(\d+):(\d+)$/.exec(refId);
  if (match == null) return null;

  const groupId = item && item.episode && typeof item.episode.groupId === 'string'
    ? item.episode.groupId
    : '';
  const seasonMatch = /(?:^|:)season:(\d+)/i.exec(groupId);
  return {
    anilistId: match[1],
    episode: match[2],
    season: seasonMatch == null ? '1' : seasonMatch[1],
  };
}

async function sheguExternalSubtitles(args) {
  const item = args.item || {};
  const refId = (item.ref && item.ref.id) || item.id || '';
  const parsed = parseSheguRef(refId);
  if (!parsed) {
    const anilistEpisode = parseSheguAnilistEpisode(refId, item);
    if (
      anilistEpisode == null ||
      typeof flystreamResolveAnilistIdentity !== 'function'
    ) {
      return { subtitles: [] };
    }
    let identity;
    try {
      identity = await flystreamResolveAnilistIdentity(anilistEpisode, item);
    } catch (_) {
      return { subtitles: [] };
    }
    if (identity == null || typeof identity.tmdbId !== 'string') {
      return { subtitles: [] };
    }
    const tracks = await fetchMovieSubtitles(
      identity.tmdbId,
      identity.season || anilistEpisode.season,
      anilistEpisode.episode,
    );
    return { subtitles: tracks };
  }

  const isSeries = parsed.kind === 'series';
  if (isSeries && (parsed.season == null || parsed.episode == null)) {
    return { subtitles: [] };
  }

  const tracks = await fetchMovieSubtitles(
    parsed.tmdbId,
    isSeries ? parsed.season : null,
    isSeries ? parsed.episode : null,
  );
  return { subtitles: tracks };
}

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.subtitles) {
  globalThis.__extension.subtitles = sheguExternalSubtitles;
}

// Sokuja anime streams, exposed as a stream provider for Nimora's VOD items.
//
// Sokuja's CloudStream implementation delegates mirror extraction to the
// CloudStream extractor framework. The app has no extractor runtime, so this
// provider follows Sokuja's own JSON mirror endpoint and only returns mirrors
// that already contain a direct media URL.

// Sokuja rotates its streaming domain every few weeks. Two landing hosts
// announce the current one and have stayed put across rotations: sokuja.net
// 302s straight to the live mirror, and sokuja.id links it behind its primary
// button. A mirror pinned in the bundle means the provider dies silently on
// every rotation, so the base is discovered at runtime and the pin below is
// only the last resort.
const SOKUJA_FALLBACK_BASE = 'https://x6.sokuja.uk';
const SOKUJA_LANDING_URLS =
  Array.isArray(globalThis.__sokujaLandingUrls) &&
    globalThis.__sokujaLandingUrls.length > 0
    ? globalThis.__sokujaLandingUrls.map(String)
    : ['https://sokuja.net/', 'https://sokuja.id/'];
// Links the landing page carries that are never the mirror.
const SOKUJA_LINK_DENYLIST = [
  't.me',
  'telegram.me',
  'telegram.org',
  'facebook.com',
  'youtube.com',
  'youtu.be',
  'instagram.com',
  'twitter.com',
  'x.com',
  'discord.gg',
  'discord.com',
  'schema.org',
];
// An explicit base opts out of discovery entirely, with no request spent on
// it: that is what the tests pin, and what a host override would mean.
const SOKUJA_BASE_OVERRIDE =
  typeof globalThis.__sokujaBaseUrl === 'string' && globalThis.__sokujaBaseUrl
    ? globalThis.__sokujaBaseUrl
    : null;
let sokujaActiveBase = SOKUJA_BASE_OVERRIDE || SOKUJA_FALLBACK_BASE;
let sokujaBasePending = null;
// Distinguishes "the mirror did not answer" from "the mirror has no such
// anime". Only the former is worth re-running discovery for.
const SOKUJA_UNREACHABLE = { unreachable: true };
const SOKUJA_TMDB_BASE =
  globalThis.__sokujaTmdbBaseUrl || 'https://api.themoviedb.org/3';
const SOKUJA_TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const SOKUJA_PROVIDER_KEY = 'sokuja';
const SOKUJA_PROVIDER_ID = 'nimora.sokuja';
const SOKUJA_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

function sokujaHeaders(referer) {
  return {
    Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    Referer: referer || `${sokujaActiveBase}/`,
    'User-Agent': SOKUJA_USER_AGENT,
  };
}

function sokujaUrl(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith('/')) return `${sokujaActiveBase}${path}`;
  return `${sokujaActiveBase}/${path}`;
}

function sokujaDecodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function sokujaAttribute(attributes, name) {
  const pattern = new RegExp(
    `${name}\\s*=\\s*[\\\"']([^\\\"']+)[\\\"']`,
    'i',
  );
  const match = pattern.exec(attributes || '');
  return match == null ? null : match[1];
}

function sokujaTagText(html, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html);
  return match == null ? '' : sokujaDecodeHtml(match[1]);
}

function sokujaNormalizeTitle(title) {
  return String(title || '')
    .replace(/\s*subtitle\s+indonesia\s*$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function sokujaSeasonTitleMatch(title, wanted, season) {
  if (!Number.isInteger(season) || season < 1) return false;
  const normalized = sokujaNormalizeTitle(title);
  const base = sokujaNormalizeTitle(wanted);
  return normalized === `${base} season ${season}` ||
    normalized === `${base} s${season}`;
}

function sokujaSearchResults(html) {
  const results = [];
  const cardPattern =
    /<a\b([^>]*class\s*=\s*[\"'][^\"']*\bgroup\b[^\"']*[\"'][^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = cardPattern.exec(html || '')) != null) {
    const href = sokujaUrl(sokujaAttribute(match[1], 'href'));
    if (href == null) continue;
    const card = match[2];
    const title = sokujaTagText(card, 'h3') || sokujaTagText(card, 'p');
    if (!title) continue;
    const imageTag = /<img\b([^>]*)>/i.exec(card);
    const poster = imageTag == null
      ? null
      : sokujaUrl(
          sokujaAttribute(imageTag[1], 'src') ||
            sokujaAttribute(imageTag[1], 'data-src'),
        );
    results.push({ title, url: href, poster });
  }
  return results;
}

function sokujaSearchCandidates(results, title, season) {
  const wanted = sokujaNormalizeTitle(title);
  if (!wanted) return [];
  const candidates = results
    .map((result, index) => {
      const normalized = sokujaNormalizeTitle(result.title);
      if (!normalized) return null;
      const exact = normalized === wanted;
      const seasonExact = sokujaSeasonTitleMatch(result.title, wanted, season);
      const startsWith = normalized.startsWith(wanted);
      if (!exact && !startsWith) return null;
      const seasonMatch = season != null &&
        new RegExp(`(?:season\\s*${season}|\\bs${season}\\b)`, 'i')
          .test(result.title);
      return {
        result,
        score: (seasonExact ? -4 : exact ? 0 : 10) +
          (seasonMatch ? -2 : 0) + index / 1000,
        seasonExact,
      };
    })
    .filter((entry) => entry != null)
    .sort((a, b) => a.score - b.score);
  return candidates;
}

function sokujaSearchPick(results, title, season) {
  const candidates = sokujaSearchCandidates(results, title, season);
  return candidates.length === 0 ? null : candidates[0].result;
}

function sokujaDateKey(value) {
  const match = /(?:^|[^0-9])(\d{4}-\d{2}-\d{2})(?:[^0-9]|$)/.exec(
    String(value || ''),
  );
  return match == null ? null : match[1];
}

async function sokujaGet(url, options) {
  try {
    const response = await fetch(url, options);
    if (response.status < 200 || response.status >= 300) return null;
    return response;
  } catch (_) {
    return null;
  }
}

function sokujaHostOf(url) {
  const match = /^https?:\/\/([^/?#]+)/i.exec(String(url || ''));
  if (match == null) return null;
  const host = match[1].toLowerCase().replace(/:\d+$/, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

function sokujaOriginOf(url) {
  const match = /^(https?:\/\/[^/?#]+)/i.exec(String(url || ''));
  return match == null ? null : match[1];
}

// A landing host names the mirror; it is never the mirror itself, and neither
// is any of the social links it sits next to. Excluding by origin rather than
// by host keeps the check honest when two origins share a host.
function sokujaIsMirrorOrigin(origin) {
  if (origin == null) return false;
  if (SOKUJA_LANDING_URLS.some((url) => sokujaOriginOf(url) === origin)) {
    return false;
  }
  const host = sokujaHostOf(origin);
  if (host == null || host.indexOf('.') === -1) return false;
  return !SOKUJA_LINK_DENYLIST.some(
    (denied) => host === denied || host.endsWith(`.${denied}`),
  );
}

// The landing page marks the mirror with `button-default` and every other
// button is a social link. Falling back to the first non-social absolute link
// keeps this working if that class is renamed, which is the part of the page
// most likely to change.
function sokujaMirrorLink(html) {
  const anchors = /<a\b([^>]*)>/gi;
  let fallback = null;
  let match;
  while ((match = anchors.exec(html || '')) != null) {
    const origin = sokujaOriginOf(sokujaAttribute(match[1], 'href'));
    if (!sokujaIsMirrorOrigin(origin)) continue;
    if (/button-default/i.test(match[1])) return origin;
    if (fallback == null) fallback = origin;
  }
  return fallback;
}

async function sokujaProbeLanding(landingUrl) {
  const response = await sokujaGet(
    landingUrl,
    { headers: sokujaHeaders(landingUrl) },
  );
  if (response == null) return null;
  // `fetch` follows the Location chain itself and reports where it landed, so
  // a redirecting landing host has already named the mirror.
  const redirected = sokujaOriginOf(response.url);
  if (sokujaIsMirrorOrigin(redirected)) return redirected;
  return sokujaMirrorLink(response.body);
}

async function sokujaResolveBase() {
  for (const landing of SOKUJA_LANDING_URLS) {
    const base = await sokujaProbeLanding(landing);
    if (base != null) {
      sokujaActiveBase = base;
      return base;
    }
  }
  // Both landing hosts unreachable — an outage, or an ISP block on them
  // specifically. Keep the base we already have rather than giving up: it is
  // stale at worst, and often still serving.
  return sokujaActiveBase;
}

// Memoised on the promise rather than the value: one `sources()` fan-out can
// issue several Sokuja lookups at once, and they must share one discovery.
function sokujaEnsureBase() {
  if (SOKUJA_BASE_OVERRIDE != null) return Promise.resolve(SOKUJA_BASE_OVERRIDE);
  if (sokujaBasePending == null) {
    sokujaBasePending = sokujaResolveBase().catch(() => sokujaActiveBase);
  }
  return sokujaBasePending;
}

function sokujaForgetBase() {
  if (SOKUJA_BASE_OVERRIDE == null) sokujaBasePending = null;
}

async function sokujaFindAnime(title, season, availableAt) {
  const searchUrl =
    `${sokujaActiveBase}/?s=${encodeURIComponent(title)}&page=1`;
  const response = await sokujaGet(searchUrl, { headers: sokujaHeaders(searchUrl) });
  if (response == null) return SOKUJA_UNREACHABLE;
  const candidates = sokujaSearchCandidates(
    sokujaSearchResults(response.body),
    title,
    season,
  );
  if (candidates.length === 0) return null;
  const wanted = sokujaNormalizeTitle(title);
  const wantedDate = sokujaDateKey(availableAt);
  if (wantedDate != null) {
    let exactMatch = null;
    for (const candidate of candidates) {
      const detail = await sokujaGet(
        candidate.result.url,
        { headers: sokujaHeaders(searchUrl) },
      );
      if (detail == null) continue;
      const episode = sokujaEpisodes(detail.body).find(
        (entry) => sokujaDateKey(entry && entry.createdAt) === wantedDate,
      );
      if (episode != null && typeof episode.slug === 'string') {
        return {
          result: candidate.result,
          detailBody: detail.body,
          episodeNumber: Number(episode.episodeNumber),
          matchedByDate: true,
        };
      }
      if (exactMatch == null &&
          (sokujaNormalizeTitle(candidate.result.title) === wanted ||
            candidate.seasonExact)) {
        exactMatch = { result: candidate.result, detailBody: detail.body };
      }
    }
    // `createdAt` is when Sokuja uploaded the episode, not when it aired, so a
    // series it posted years after broadcast can never match by date — One
    // Piece episode 1 aired in 1999 and was uploaded in 2017. Only a loose
    // title match is a split-cour risk worth refusing; an exact one is the
    // series itself, and falls back to matching by episode number.
    return exactMatch;
  }
  const selected = candidates[0];
  const detail = await sokujaGet(
    selected.result.url,
    { headers: sokujaHeaders(searchUrl) },
  );
  if (detail == null) return null;
  // A loose title match with dated episodes is a split-cour candidate. Without
  // an aired date, refusing it is safer than silently playing another cour.
  // A title qualified with the requested season is not loose: Sokuja uses that
  // form for the exact AniList cour when AniList does not provide an episode
  // air date.
  const hasDatedEpisodes = sokujaEpisodes(detail.body).some(
    (entry) => sokujaDateKey(entry && entry.createdAt) != null,
  );
  const exact = sokujaNormalizeTitle(selected.result.title) === wanted;
  if (!exact && !selected.seasonExact && hasDatedEpisodes) return null;
  return { result: selected.result, detailBody: detail.body };
}

// Next.js renders the episode list inside an escaped JSON payload. The same
// shape is also present in the older HTML used by the original extension.
function sokujaEpisodes(html) {
  const normalized = String(html || '')
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, '&');
  const match = /"episodes"\s*:\s*\[([\s\S]*?)\]\s*,\s*"episodesTotal"/.exec(normalized);
  if (match == null) return [];
  try {
    const episodes = JSON.parse(`[${match[1]}]`);
    return Array.isArray(episodes) ? episodes : [];
  } catch (_) {
    return [];
  }
}

function sokujaEpisodeUrl(html, episodeNumber, availableAt) {
  const wanted = Number(episodeNumber);
  if (!Number.isInteger(wanted) || wanted < 1) return null;
  const episodes = sokujaEpisodes(html);
  const airedDate = sokujaDateKey(availableAt);
  const datedEpisodes = episodes.filter(
    (entry) => sokujaDateKey(entry && entry.createdAt) != null,
  );
  const dateMatch = airedDate == null
    ? null
    : datedEpisodes.find((entry) => sokujaDateKey(entry && entry.createdAt) === airedDate);
  // A numbered fallback is unsafe when Sokuja exposes dated episodes: a
  // partial title match can otherwise play episode 1 from another split-cour.
  if (airedDate != null && datedEpisodes.length > 0) {
    return dateMatch && typeof dateMatch.slug === 'string'
      ? sokujaUrl(`/${dateMatch.slug}/`)
      : null;
  }
  const numberMatch = episodes.find(
    (entry) => Number(entry && entry.episodeNumber) === wanted,
  );
  const episode = dateMatch || numberMatch;
  if (episode && typeof episode.slug === 'string') return sokujaUrl(`/${episode.slug}/`);

  const pattern = new RegExp(
    `href=[\"']([^\"']*episode-${wanted}[^\"']*)[\"']`,
    'i',
  );
  const fallback = pattern.exec(html || '');
  return fallback == null ? null : sokujaUrl(fallback[1]);
}

function sokujaHighestEpisodeNumber(html) {
  return sokujaEpisodes(html).reduce((highest, entry) => {
    const number = Number(entry && entry.episodeNumber);
    return Number.isInteger(number) && number > highest ? number : highest;
  }, 0);
}

// TMDB splits a long-running anime into arc-sized seasons while Sokuja numbers
// the whole run straight through: One Piece season 2 episode 1 is episode 62
// there. Asking such a page for episode 1 would quietly play the wrong episode
// — worse than offering no source — so the season-relative number is used only
// for entries whose own list never reaches the absolute one. Those are the
// per-cour pages, which start counting from 1 again.
async function sokujaNumberedEpisodeUrl(item, query, detailBody) {
  const relative = sokujaEpisodeUrl(detailBody, query.episode, null);
  if (!Number.isInteger(query.season) || query.season <= 1) return relative;
  const absolute = await sokujaAbsoluteEpisode(item, query.season, query.episode);
  if (absolute == null) return null;
  if (sokujaHighestEpisodeNumber(detailBody) < absolute) return relative;
  return sokujaEpisodeUrl(detailBody, absolute, null);
}

function sokujaMovieUrl(html) {
  const pattern = /href=[\"']([^\"']+)[\"']/gi;
  let match;
  while ((match = pattern.exec(html || '')) != null) {
    if (/episode-/i.test(match[1])) return sokujaUrl(match[1]);
  }
  return null;
}

function sokujaEpisodeId(html) {
  const normalized = String(html || '').replace(/\\"/g, '"');
  const match = /episodeId"\s*:\s*(\d+)/i.exec(normalized);
  return match == null ? null : match[1];
}

function encodeSokujaSource(payload) {
  return host.codec.textToBase64(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeSokujaSource(encoded) {
  let base64 = String(encoded || '').replace(/-/g, '+').replace(/_/g, '/');
  const remainder = base64.length % 4;
  if (remainder !== 0) base64 += '='.repeat(4 - remainder);
  try {
    return JSON.parse(host.codec.base64ToText(base64));
  } catch (_) {
    return null;
  }
}

function sokujaTmdbEpisodeRef(item) {
  const refId = item && item.ref && item.ref.id;
  if (typeof refId !== 'string') return null;
  const match = /^(?:v1-episode:)?series:([^:]+):season:([^:]+):episode:([^:]+)$/.exec(
    refId,
  );
  return match == null
    ? null
    : { tmdbId: match[1], season: match[2], episode: match[3] };
}

async function sokujaEpisodeAvailableAt(item) {
  const direct = item && item.availableAt;
  const directDate = sokujaDateKey(direct);
  if (directDate != null) return directDate;

  const parsed = sokujaTmdbEpisodeRef(item);
  if (parsed == null) return null;

  const query = [
    `api_key=${encodeURIComponent(SOKUJA_TMDB_API_KEY)}`,
    'language=en-US',
  ].join('&');
  const response = await sokujaGet(
    `${SOKUJA_TMDB_BASE}/tv/${encodeURIComponent(parsed.tmdbId)}` +
      `/season/${encodeURIComponent(parsed.season)}` +
      `/episode/${encodeURIComponent(parsed.episode)}?${query}`,
    { headers: sokujaHeaders(SOKUJA_TMDB_BASE) },
  );
  if (response == null) return null;
  try {
    const payload = JSON.parse(response.body);
    return sokujaDateKey(payload && payload.air_date);
  } catch (_) {
    return null;
  }
}

// Counts the episodes TMDB places before [season] to turn a season-relative
// number into the absolute one Sokuja indexes by.
async function sokujaAbsoluteEpisode(item, season, episode) {
  if (!Number.isInteger(episode) || episode < 1) return null;
  const parsed = sokujaTmdbEpisodeRef(item);
  if (parsed == null) return null;

  const query = [
    `api_key=${encodeURIComponent(SOKUJA_TMDB_API_KEY)}`,
    'language=en-US',
  ].join('&');
  const response = await sokujaGet(
    `${SOKUJA_TMDB_BASE}/tv/${encodeURIComponent(parsed.tmdbId)}?${query}`,
    { headers: sokujaHeaders(SOKUJA_TMDB_BASE) },
  );
  if (response == null) return null;
  let seasons;
  try {
    const payload = JSON.parse(response.body);
    seasons = Array.isArray(payload && payload.seasons) ? payload.seasons : [];
  } catch (_) {
    return null;
  }

  let offset = 0;
  for (const entry of seasons) {
    const number = Number(entry && entry.season_number);
    // Season 0 is specials: not part of the run Sokuja numbers through.
    if (!Number.isInteger(number) || number < 1 || number >= season) continue;
    const count = Number(entry && entry.episode_count);
    // One unknown count makes the whole sum wrong, so refuse rather than guess.
    if (!Number.isInteger(count) || count < 1) return null;
    offset += count;
  }
  return offset === 0 ? null : offset + episode;
}

function sokujaItemQuery(item) {
  const extra = item && item.extra && typeof item.extra === 'object'
    ? item.extra
    : {};
  const v2Episode = item && item.episode && typeof item.episode === 'object'
    ? item.episode
    : null;
  const groupId = v2Episode && typeof v2Episode.groupId === 'string'
    ? v2Episode.groupId
    : '';
  const seasonMatch = /(?:^|:)season:(\d+)/i.exec(groupId);
  const v2Season = seasonMatch == null ? null : Number(seasonMatch[1]);
  const v2EpisodeNumber = v2Episode && Number.isInteger(v2Episode.position)
    ? v2Episode.position
    : null;
  const v2SeriesTitle = item && typeof item.subtitle === 'string'
    ? item.subtitle.trim()
    : '';
  let title = '';
  if (typeof extra.seriesTitle === 'string' && extra.seriesTitle.trim()) {
    title = extra.seriesTitle;
  } else if (v2SeriesTitle) {
    title = v2SeriesTitle;
  } else if (item && typeof item.title === 'string') {
    title = item.title;
  }
  const season = Number.isInteger(extra.season) ? extra.season : v2Season;
  const episode = Number.isInteger(extra.episode) ? extra.episode : v2EpisodeNumber;
  return { title, season, episode, isEpisode: item && item.kind === 'episode' };
}

async function sokujaSources(args) {
  const enabled = args && args.enabledProviders;
  if (enabled != null && enabled.indexOf(SOKUJA_PROVIDER_ID) === -1) {
    return { sources: [] };
  }
  const item = args && args.item;
  if (!item || (item.kind !== 'episode' && item.kind !== 'video')) {
    return { sources: [] };
  }

  const query = sokujaItemQuery(item);
  if (!query.title) return { sources: [] };
  await sokujaEnsureBase();
  const availableAt = await sokujaEpisodeAvailableAt(item);
  let found = await sokujaFindAnime(query.title, query.season, availableAt);
  if (found === SOKUJA_UNREACHABLE) {
    // A mirror that stops answering mid-session is the usual sign it rotated.
    // Re-run discovery once and retry, but only if it named a different host:
    // otherwise this is an outage and the second request buys nothing.
    const stale = sokujaActiveBase;
    sokujaForgetBase();
    const refreshed = await sokujaEnsureBase();
    found = refreshed === stale
      ? null
      : await sokujaFindAnime(query.title, query.season, availableAt);
  }
  if (found == null || found === SOKUJA_UNREACHABLE) return { sources: [] };
  const result = found.result;

  const detailBody = found.detailBody || (await sokujaGet(
    result.url,
    { headers: sokujaHeaders(`${sokujaActiveBase}/`) },
  ))?.body;
  if (detailBody == null) return { sources: [] };
  let watchUrl;
  if (!query.isEpisode) {
    watchUrl = sokujaMovieUrl(detailBody) || result.url;
  } else if (found.matchedByDate) {
    watchUrl = sokujaEpisodeUrl(
      detailBody,
      found.episodeNumber || query.episode,
      availableAt,
    );
  } else {
    watchUrl = await sokujaNumberedEpisodeUrl(item, query, detailBody);
  }
  if (watchUrl == null) return { sources: [] };

  const episodeResponse = await sokujaGet(
    watchUrl,
    { headers: sokujaHeaders(result.url) },
  );
  if (episodeResponse == null) return { sources: [] };
  const episodeId = sokujaEpisodeId(episodeResponse.body);
  if (episodeId == null) return { sources: [] };

  const mirrorsUrl = `${sokujaActiveBase}/api/video-mirrors/?e=${encodeURIComponent(episodeId)}`;
  const mirrorsResponse = await sokujaGet(
    mirrorsUrl,
    { headers: sokujaHeaders(watchUrl) },
  );
  if (mirrorsResponse == null) return { sources: [] };
  let mirrors;
  try {
    const data = JSON.parse(mirrorsResponse.body);
    mirrors = Array.isArray(data.mirrors) ? data.mirrors : [];
  } catch (_) {
    return { sources: [] };
  }

  return {
    sources: mirrors
      .filter((mirror) => mirror && typeof mirror.embedUrl === 'string')
      .filter((mirror) => /^https?:\/\//i.test(mirror.embedUrl))
      .map((mirror, index) => {
        const id = `${SOKUJA_PROVIDER_KEY}:${encodeSokujaSource({
          u: mirror.embedUrl,
          q: mirror.quality || '',
          s: index,
        })}`;
        return {
          id,
          label: sourceAliasWithQuality(
            id,
            index,
            mirror.quality || `Sokuja Mirror ${index + 1}`,
          ),
          provider: 'Nimora',
          providerId: SOKUJA_PROVIDER_ID,
        };
      }),
  };
}

async function sokujaResolveSource(sourceId) {
  const prefix = `${SOKUJA_PROVIDER_KEY}:`;
  if (typeof sourceId !== 'string' || !sourceId.startsWith(prefix)) {
    throw new Error(`Invalid Sokuja sourceId: ${sourceId}`);
  }
  const payload = decodeSokujaSource(sourceId.slice(prefix.length));
  if (!payload || typeof payload.u !== 'string' || !/^https?:\/\//i.test(payload.u)) {
    throw new Error('Malformed Sokuja source id');
  }
  // Playback can resume from a stored source id in a session where nothing
  // searched Sokuja yet, so the Referer needs its own guarantee of a base.
  await sokujaEnsureBase();
  const format = /\.m3u8(?:$|\?)/i.test(payload.u) ? 'hls' : 'other';
  return {
    url: payload.u,
    format,
    headers: sokujaHeaders(`${sokujaActiveBase}/`),
    ...(payload.q ? { label: `Sokuja ${payload.q}` } : {}),
  };
}

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: SOKUJA_PROVIDER_KEY,
  sources: sokujaSources,
  resolve: (sourceId) => sokujaResolveSource(sourceId),
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.sources) {
  globalThis.__extension.sources = async (args) => {
    const calls = globalThis.__streamProviders.map((provider) =>
      Promise.resolve()
        .then(() => provider.sources(args))
        .catch(() => ({ sources: [] })),
    );
    if (args.fast !== true) {
      const perProvider = await Promise.all(calls);
      return { sources: perProvider.flatMap((result) => result.sources) };
    }
    return new Promise((resolve) => {
      let remaining = calls.length;
      let returned = false;
      for (const call of calls) {
        call.then((result) => {
          if (returned) return;
          const sources = Array.isArray(result.sources) ? result.sources : [];
          if (sources.length > 0) {
            returned = true;
            resolve({ sources });
            return;
          }
          remaining -= 1;
          if (remaining === 0) resolve({ sources: [] });
        });
      }
    });
  };
  globalThis.__extension.resolve = async (args) => {
    const sourceId = args.sourceId;
    const separator = sourceId.indexOf(':');
    if (separator < 0) throw new Error(`Malformed source id: ${sourceId}`);
    const providerKey = sourceId.slice(0, separator);
    const provider = globalThis.__streamProviders.find(
      (entry) => entry.providerKey === providerKey,
    );
    if (!provider) throw new Error(`No stream provider registered for "${providerKey}"`);
    return provider.resolve(sourceId);
  };
}

// Indomax VOD streams.  Indomax is a WordPress catalogue whose active domain
// is published in CloudX's Website.json.  Its player pages hand off to
// ImaxStreams; this file owns both the discovery path and that extractor.

const INDOMAX_DEFAULT_BASE = 'https://idmxl.ink';
const INDOMAX_DIRECTORY =
  globalThis.__indomaxDirectoryUrl ||
  'https://raw.githubusercontent.com/Asm0d3usX/CloudX/builds/Website.json';
const INDOMAX_PROVIDER_KEY = 'indomax';
const INDOMAX_PROVIDER_ID = 'nimora.indomax';
const INDOMAX_FIRE_BASE =
  globalThis.__indomaxFireBaseUrl || 'https://embedpyrox.xyz';
const INDOMAX_NSFW_CATALOG_ID = 'nsfw';
const INDOMAX_NSFW_SUBCATEGORIES = [
  { id: 'jav', name: 'JAV' },
  { id: 'asia-m', name: 'Asia M' },
  { id: 'vivamax', name: 'Vivamax' },
  { id: 'kelas-bintang', name: 'Kelas Bintang' },
  { id: 'hentai', name: 'Hentai' },
  { id: 'semi-barat', name: 'Semi Barat' },
  { id: 'bokep-indo', name: 'Bokep Indo' },
  { id: 'bokep-vietnam', name: 'Bokep Vietnam' },
];
const IMAX_BASE = globalThis.__imaxStreamsBaseUrl || 'https://imaxstreams.net';
const INDOMAX_UA =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

let indomaxBase = globalThis.__indomaxBaseUrl || null;

function indomaxHeaders(referer) {
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: referer || `${indomaxBase || INDOMAX_DEFAULT_BASE}/`,
    'User-Agent': INDOMAX_UA,
  };
}

function imaxHeaders(base) {
  const playerBase = base || IMAX_BASE;
  return {
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    Origin: playerBase,
    Referer: `${playerBase}/`,
    'User-Agent': INDOMAX_UA,
  };
}

function indomaxUrl(path, base) {
  if (typeof path !== 'string' || !path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const root = (base || indomaxBase || INDOMAX_DEFAULT_BASE).replace(/\/$/, '');
  return path.startsWith('/') ? `${root}${path}` : `${root}/${path}`;
}

function indomaxText(value) {
  const namedEntities = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '…',
    lt: '<',
    mdash: '—',
    nbsp: ' ',
    ndash: '–',
    quot: '"',
  };
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (match, value) => {
      const codePoint = value[0].toLowerCase() === 'x'
        ? parseInt(value.slice(1), 16)
        : parseInt(value, 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&([a-z]+);/gi, (match, name) => {
      const decoded = namedEntities[name.toLowerCase()];
      return decoded == null ? match : decoded;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function indomaxNormalize(value) {
  return indomaxText(value)
    .replace(/\s*(subtitle\s+indonesia|indo)\s*$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function indomaxAttribute(attributes, name) {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i')
    .exec(attributes || '');
  return match == null ? null : match[1];
}

function indomaxMetaContent(html, name) {
  const tag = new RegExp(
    `<meta\\b[^>]*(?:name|property)\\s*=\\s*["']${name}["'][^>]*>`,
    'i',
  ).exec(html || '');
  return tag == null ? null : indomaxAttribute(tag[0], 'content');
}

function indomaxDivBlocks(html, classPattern) {
  const blocks = [];
  const stack = [];
  const tags = /<div\b([^>]*)>|<\/div\s*>/gi;
  let match;
  while ((match = tags.exec(html || '')) != null) {
    if (match[1] != null) {
      stack.push({
        start: tags.lastIndex,
        matched: classPattern.test(indomaxAttribute(match[1], 'class') || ''),
      });
      continue;
    }
    const block = stack.pop();
    if (block != null && block.matched) {
      blocks.push((html || '').slice(block.start, match.index));
    }
  }
  return blocks;
}

function indomaxMetaRows(html) {
  return indomaxDivBlocks(html, /\bgmr-moviedata\b/i)
    .map((row) => ({ html: row, text: indomaxText(row) }));
}

function indomaxMetaRow(html, pattern) {
  return indomaxMetaRows(html).find((row) => pattern.test(row.text)) || null;
}

function indomaxRowLinks(row) {
  if (row == null) return [];
  const values = [];
  const links = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = links.exec(row.html || '')) != null) {
    const value = indomaxText(match[1]);
    if (value) values.push(value);
  }
  return values.filter((value, index) => values.indexOf(value) === index);
}

function indomaxDetailDescription(html) {
  const block = /<div\b[^>]*\bitemprop\s*=\s*["']description["'][^>]*>([\s\S]*?)<\/div>/i.exec(html || '');
  if (block != null) {
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block[1]);
    const value = indomaxText(paragraph == null ? block[1] : paragraph[1]);
    if (value) return value;
  }
  const description = indomaxMetaContent(html, 'description');
  return description ? indomaxText(description) : null;
}

function indomaxDetailRating(html) {
  const bar = /<div\b[^>]*\bgmr-rating-bar\b[^>]*>([\s\S]*?)<\/div>/i.exec(html || '');
  const width = bar == null
    ? null
    : /style\s*=\s*["'][^"']*width\s*:\s*([0-9.]+)%/i.exec(bar[1]);
  if (width != null) {
    const value = Number(width[1]) / 10;
    if (Number.isFinite(value)) return value;
  }
  const ratingMatch = /itemprop\s*=\s*["']ratingValue["'][^>]*content\s*=\s*["']([^"']+)/i.exec(html || '')
    || /gmr-rating-item\b[^>]*>([\s\S]*?)<\/div>/i.exec(html || '');
  if (ratingMatch == null) return null;
  const value = Number(/\d+(?:\.\d+)?/.exec(indomaxText(ratingMatch[1]))?.[0]);
  return Number.isFinite(value) ? value : null;
}

function indomaxDetailActors(html) {
  const actors = [];
  const blocks = /<span\b[^>]*\bitemprop\s*=\s*["']actors?["'][^>]*>([\s\S]*?)<\/span>/gi;
  let block;
  while ((block = blocks.exec(html || '')) != null) {
    const links = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    let link;
    while ((link = links.exec(block[1])) != null) {
      const name = indomaxText(link[1]);
      if (name) actors.push(name);
    }
  }
  return actors.filter((name, index) => actors.indexOf(name) === index);
}

function indomaxDetailTrailer(html) {
  const match = /<a\b([^>]*\bgmr-trailer-popup\b[^>]*)>/i.exec(html || '');
  const url = match == null ? null : indomaxUrl(indomaxAttribute(match[1], 'href'));
  if (!url) return null;
  const site = /(?:youtube\.com|youtu\.be)/i.test(url) ? 'YouTube' : null;
  return { title: 'Trailer', url, ...(site ? { site } : {}) };
}

async function indomaxTmdbRecommendations(title, detailUrl) {
  if (typeof tmdbSearchType !== 'function' || typeof tmdbRecommendationsOf !== 'function') return [];
  const mediaType = /\/tv\//i.test(detailUrl) ? 'tv' : 'movie';
  const extraParams = mediaType === 'movie' ? { region: 'US' } : {};
  const searchResults = await tmdbSearchType(mediaType, title, 1, extraParams);
  const wanted = indomaxNormalize(title);
  const matches = searchResults
    .map((entry, index) => {
      const result = entry && entry.result;
      const candidate = indomaxNormalize(result && (result.title || result.name));
      if (!result || result.id == null || !candidate) return null;
      const exact = candidate === wanted;
      const overlap = candidate.includes(wanted) || wanted.includes(candidate);
      if (!exact && !overlap) return null;
      return {
        id: result.id,
        score: (exact ? 0 : 10) - Number(result.popularity || 0) / 100000 + index / 1000000,
      };
    })
    .filter((entry) => entry != null)
    .sort((a, b) => a.score - b.score);
  if (matches.length === 0) return [];
  return tmdbRecommendationsOf(String(matches[0].id), mediaType);
}

function indomaxSeasonNumber(value) {
  const text = indomaxText(value);
  const compact = /\bs(\d{1,2})e\d+\b/i.exec(text);
  if (compact != null) return Number(compact[1]);
  const named = /\b(?:season|musim)\s*[-_: ]*([0-9]{1,2})\b/i.exec(text);
  return named == null ? null : Number(named[1]);
}

function indomaxEpisodeNumber(value) {
  const text = indomaxText(value);
  const compact = /\bs\d{1,2}e(\d+)\b/i.exec(text);
  if (compact != null) return Number(compact[1]);
  const named = /\bepisode\s*(\d+)\b/i.exec(text);
  if (named != null) return Number(named[1]);
  const short = /\be\s*(\d+)\b/i.exec(text);
  if (short != null) return Number(short[1]);
  const last = /(?:^|\D)(\d+)(?:\D|$)/.exec(text);
  return last == null ? null : Number(last[1]);
}

function indomaxEpisodeRef(parentRef, url, position, season) {
  return {
    extensionId: parentRef.extensionId,
    providerId: parentRef.providerId,
    id: `${INDOMAX_PROVIDER_KEY}:episode:${encodeIndomaxSource({
      u: url,
      p: parentRef.id,
      e: position,
      s: season,
    })}`,
  };
}

function indomaxDetailEpisodeGroups(html, parentRef, poster, base) {
  const groups = new Map();
  const containers = indomaxDivBlocks(html, /\b(?:vid-episodes|gmr-listseries)\b/i);
  containers.forEach((container, containerIndex) => {
    const containerSeason = indomaxSeasonNumber(container) || containerIndex + 1;
    const groupId = `season:${containerSeason}`;
    const group = groups.get(groupId) || {
      id: groupId,
      title: `Season ${containerSeason}`,
      episodes: [],
    };
    const links = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let link;
    while ((link = links.exec(container)) != null) {
      const url = indomaxUrl(indomaxAttribute(link[1], 'href'), base);
      if (!url) continue;
      const rawTitle = indomaxAttribute(link[1], 'title') || indomaxText(link[2]);
      const cleanTitle = indomaxText(rawTitle).replace(/^Permalink ke\s*/i, '').trim();
      const season = indomaxSeasonNumber(cleanTitle) || containerSeason;
      const position = indomaxEpisodeNumber(cleanTitle);
      if (!Number.isInteger(position) || position < 1) continue;
      const episodeGroupId = `season:${season}`;
      const episodeGroup = groups.get(episodeGroupId) || {
        id: episodeGroupId,
        title: `Season ${season}`,
        episodes: [],
      };
      episodeGroup.episodes.push({
        ref: indomaxEpisodeRef(parentRef, url, position, season),
        title: `Episode ${position}`,
        position,
        ...(poster ? { artwork: { portrait: { url: poster } } } : {}),
      });
      groups.set(episodeGroupId, episodeGroup);
    }
    if (!groups.has(groupId)) groups.set(groupId, group);
  });
  return [...groups.values()]
    .map((group) => ({
      ...group,
      episodes: group.episodes
        .filter((episode, index, entries) => entries.findIndex((other) => other.ref.id === episode.ref.id) === index)
        .sort((a, b) => a.position - b.position),
    }))
    .filter((group) => group.episodes.length > 0)
    .sort((a, b) => Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]));
}

async function indomaxGet(url, referer) {
  try {
    const response = await fetch(url, { headers: indomaxHeaders(referer) });
    return response.status >= 200 && response.status < 300 ? response : null;
  } catch (_) {
    return null;
  }
}

async function indomaxActiveBase() {
  if (indomaxBase) return indomaxBase;
  const response = await indomaxGet(INDOMAX_DIRECTORY, INDOMAX_DEFAULT_BASE);
  if (response != null) {
    try {
      const urls = JSON.parse(response.body).indomax;
      if (Array.isArray(urls) && typeof urls[0] === 'string' && /^https?:\/\//i.test(urls[0])) {
        indomaxBase = urls[0].replace(/\/$/, '');
      }
    } catch (_) {}
  }
  return indomaxBase || INDOMAX_DEFAULT_BASE;
}

function indomaxSearchResults(html, base) {
  const results = [];
  const article = /<article\b([^>]*\bclass\s*=\s*["'][^"']*\bitem-infinite\b[^"']*["'][^>]*)>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = article.exec(html || '')) != null) {
    const titleMatch = /<h2\b[^>]*\bentry-title\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(match[2]);
    if (titleMatch == null) continue;
    const url = indomaxUrl(indomaxAttribute(titleMatch[1], 'href'), base);
    const title = indomaxText(titleMatch[2]);
    const imageMatch = /<img\b([^>]*)>/i.exec(match[2]);
    const poster = imageMatch == null
      ? null
      : indomaxAttribute(imageMatch[1], 'src');
    const ratingMatch = /<div\b[^>]*\bgmr-rating-item\b[^>]*>([\s\S]*?)<\/div>/i.exec(match[2]);
    const ratingValue = ratingMatch == null
      ? null
      : Number(/\d+(?:\.\d+)?/.exec(indomaxText(ratingMatch[1]))?.[0]);
    if (url && title) {
      const season = indomaxSeasonNumber(title);
      const hasEpisodeLabel = /\b(?:s\d{1,2}e\d+|episode\s*\d+|eps?\s*\d+|e\s*\d+)\b/i.test(title);
      const episode = hasEpisodeLabel ? indomaxEpisodeNumber(title) : null;
      results.push({
        title,
        url,
        ...(Number.isInteger(season) ? { season } : {}),
        ...(Number.isInteger(episode) ? { episode } : {}),
        ...(poster ? { poster: indomaxUrl(poster, base) } : {}),
        ...(Number.isFinite(ratingValue) ? { rating: ratingValue } : {}),
      });
    }
  }
  return results;
}

function indomaxNsfwCategory(categoryId) {
  return INDOMAX_NSFW_SUBCATEGORIES.find((category) => category.id === categoryId)
    || INDOMAX_NSFW_SUBCATEGORIES[0];
}

function indomaxCategoryUrl(base, categoryId, page) {
  const path = `/category/${indomaxNsfwCategory(categoryId).id}/`;
  return page > 1 ? `${base}${path}page/${page}/` : `${base}${path}`;
}

function indomaxHasNextPage(html) {
  return /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bnext\b[^"']*["'][^>]*>/i.test(html || '');
}

function indomaxCatalogItem(result, categoryId) {
  const item = {
    ref: {
      extensionId: 'nimora',
      providerId: INDOMAX_PROVIDER_ID,
      id: `${INDOMAX_PROVIDER_KEY}:catalog:${encodeIndomaxSource({
        u: result.url,
        c: categoryId,
      })}`,
    },
    kind: /\/tv\//i.test(result.url) ? 'series' : 'video',
    title: result.title,
  };
  if (result.poster) item.artwork = { portrait: { url: result.poster } };
  if (Number.isFinite(result.rating)) item.rating = result.rating;
  return item;
}

async function indomaxCategoryCatalog(query, categoryId, title, subCategories) {
  const base = await indomaxActiveBase();
  const selectedCategoryId = categoryId === INDOMAX_NSFW_CATALOG_ID
    ? indomaxNsfwCategory(query && query.subCategory).id
    : categoryId;
  const requestedPage = Number(query && query.page);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const url = indomaxCategoryUrl(base, selectedCategoryId, page);
  const response = await indomaxGet(url, `${base}/`);
  if (response == null) {
    return { sections: [], subCategories };
  }
  const results = indomaxSearchResults(response.body, base);
  const result = {
    sections: [{
      id: selectedCategoryId,
      title,
      items: results.map((item) => indomaxCatalogItem(item, selectedCategoryId)),
    }],
    subCategories,
  };
  if (indomaxHasNextPage(response.body)) result.nextPage = String(page + 1);
  return result;
}

async function indomaxNsfwCatalog(query) {
  const requestedSubCategory = query && query.subCategory;
  if (typeof requestedSubCategory === 'string' && requestedSubCategory) {
    const category = indomaxNsfwCategory(requestedSubCategory);
    return indomaxCategoryCatalog(
      query,
      INDOMAX_NSFW_CATALOG_ID,
      category.name,
      INDOMAX_NSFW_SUBCATEGORIES,
    );
  }

  const request = query && typeof query === 'object' ? query : {};
  const pages = await Promise.all(
    INDOMAX_NSFW_SUBCATEGORIES.map((category) => indomaxCategoryCatalog(
      { ...request, subCategory: category.id },
      INDOMAX_NSFW_CATALOG_ID,
      category.name,
      [],
    )),
  );
  const sections = pages
    .flatMap((page) => Array.isArray(page.sections) ? page.sections : [])
    .filter((section) => Array.isArray(section.items) && section.items.length > 0);
  const result = {
    sections,
    subCategories: INDOMAX_NSFW_SUBCATEGORIES,
  };
  if (pages.some((page) => page.nextPage != null)) {
    result.nextPage = String(Number(request.page || 1) + 1);
  }
  return result;
}

function indomaxSearchItem(result) {
  const yearMatch = /^(.*?)(?:\s*\((\d{4})\))?$/.exec(result.title);
  const title = (yearMatch == null ? result.title : yearMatch[1]).trim();
  const year = yearMatch == null || yearMatch[2] == null ? null : Number(yearMatch[2]);
  return {
    ref: {
      extensionId: 'nimora',
      providerId: INDOMAX_PROVIDER_ID,
      id: `${INDOMAX_PROVIDER_KEY}:search:${encodeIndomaxSource({ u: result.url })}`,
    },
    kind: /\/tv\//i.test(result.url) ? 'series' : 'video',
    title: title || result.title,
    ...(Number.isInteger(year) ? { releaseYear: year } : {}),
  };
}

function indomaxRefPayload(ref) {
  const id = ref && typeof ref.id === 'string' ? ref.id : '';
  const prefix = `${INDOMAX_PROVIDER_KEY}:`;
  if (!id.startsWith(prefix)) return null;
  const encoded = id.slice(prefix.length).replace(/^(?:catalog|search|detail|episode):/, '');
  return decodeIndomaxSource(encoded);
}

function indomaxDetailItem(ref, html) {
  const titleMatch = /<h1\b[^>]*\bentry-title\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html || '');
  const title = indomaxText(
    titleMatch == null
      ? indomaxMetaContent(html, 'og:title') || 'Indomax video'
      : titleMatch[1],
  ).replace(/\s+Subtitle Indonesia(?:\s*-\s*INDOMAX21)?$/i, '').trim();
  const image = indomaxMetaContent(html, 'og:image');
  const yearRow = indomaxMetaRow(html, /(?:^|\s)(?:tahun|release)\s*:/i);
  const yearMatch = yearRow == null ? null : /\b(\d{4})\b/.exec(yearRow.text);
  const year = yearMatch == null ? null : Number(yearMatch[1]);
  const rating = indomaxDetailRating(html);
  const item = {
    ref,
    kind: /\/tv\//i.test(indomaxRefPayload(ref)?.u || '') ? 'series' : 'video',
    title,
  };
  if (image) item.artwork = { portrait: { url: indomaxUrl(image) } };
  if (Number.isInteger(year)) item.releaseYear = year;
  if (Number.isFinite(rating)) item.rating = rating;
  return item;
}

async function indomaxMeta(args) {
  const ref = args && args.ref;
  const payload = indomaxRefPayload(ref);
  if (!payload || typeof payload.u !== 'string') {
    throw new Error('Malformed Indomax media ref');
  }
  const base = await indomaxActiveBase();
  const response = await indomaxGet(payload.u, `${base}/`);
  if (response == null) throw new Error('Indomax detail request failed');
  const detail = { item: indomaxDetailItem(ref, response.body) };
  const description = indomaxDetailDescription(response.body);
  if (description) detail.description = indomaxText(description);
  const genreRow = indomaxMetaRow(response.body, /(?:^|\s)genre\s*:/i);
  const tags = indomaxRowLinks(genreRow);
  if (tags.length > 0) detail.tags = tags;
  const yearRow = indomaxMetaRow(response.body, /(?:^|\s)(?:tahun|release)\s*:/i);
  const year = yearRow == null ? null : /\b(\d{4})\b/.exec(yearRow.text)?.[1];
  const durationRow = indomaxMetaRow(response.body, /(?:^|\s)(?:durasi|duration)\s*:/i);
  const duration = durationRow == null ? null : /\b(\d+)\s*(?:min|minutes?)?\b/i.exec(durationRow.text)?.[1];
  const facts = [];
  if (year) facts.push({ label: 'Year', value: year });
  if (duration) facts.push({ label: 'Duration', value: `${duration} min` });
  if (facts.length > 0) detail.facts = facts;
  const actors = indomaxDetailActors(response.body);
  if (actors.length > 0) detail.credits = actors.map((name) => ({ name, role: 'Actor' }));
  const trailer = indomaxDetailTrailer(response.body);
  if (trailer != null) detail.trailers = [trailer];
  const recommendations = await indomaxTmdbRecommendations(detail.item.title, payload.u);
  if (recommendations.length > 0) detail.recommendations = recommendations;
  if (/\/tv\//i.test(payload.u)) {
    const poster = detail.item.artwork?.portrait?.url || null;
    const groups = indomaxDetailEpisodeGroups(response.body, ref, poster, base);
    if (groups.length > 0) {
      const lastGroup = groups[groups.length - 1];
      const defaultEpisodeRef = lastGroup.episodes[lastGroup.episodes.length - 1].ref;
      detail.episodeGuide = {
        groups,
        defaultEpisodeRef,
      };
    }
  }
  return detail;
}

async function indomaxSearch(args) {
  const query = String(args && args.query || '').trim();
  if (!query) return { sections: [] };
  const base = await indomaxActiveBase();
  const searchUrl = `${base}/?s=${encodeURIComponent(query)}&post_type[]=post&post_type[]=tv`;
  const response = await indomaxGet(searchUrl, `${base}/`);
  if (response == null) return { sections: [] };
  const items = indomaxSearchResults(response.body, base).map(indomaxSearchItem);
  return { sections: [{ id: 'indomax-results', items }] };
}

function indomaxPickResult(results, title) {
  const wanted = indomaxNormalize(title);
  if (!wanted) return null;
  const scored = results.map((result, index) => {
    const candidate = indomaxNormalize(result.title);
    if (!candidate) return null;
    const exact = candidate === wanted;
    const overlap = candidate.includes(wanted) || wanted.includes(candidate);
    return !exact && !overlap ? null : { result, score: (exact ? 0 : 10) + index / 1000 };
  }).filter((entry) => entry != null).sort((a, b) => a.score - b.score);
  return scored.length ? scored[0].result : null;
}

function indomaxSearchTitleVariants(title) {
  const original = String(title || '').trim();
  const withoutYear = original
    .replace(/[([]\s*(?:19|20)\d{2}\s*[)\]]/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [original, withoutYear]
    .filter((value, index, values) => value && values.indexOf(value) === index);
}

async function indomaxFindResult(title, base) {
  for (const searchTitle of indomaxSearchTitleVariants(title)) {
    const searchUrl = `${base}/?s=${encodeURIComponent(searchTitle)}&post_type[]=post&post_type[]=tv`;
    const search = await indomaxGet(searchUrl, `${base}/`);
    if (search == null) continue;
    const results = indomaxSearchResults(search.body, base);
    const result = indomaxPickResult(results, searchTitle);
    if (result != null) return { result, results, searchUrl };
  }
  return null;
}

function indomaxItemQuery(item) {
  const extra = item && item.extra && typeof item.extra === 'object' ? item.extra : {};
  const episode = item && item.episode && typeof item.episode === 'object' ? item.episode : null;
  const group = episode && typeof episode.groupId === 'string' ? episode.groupId : '';
  const season = /(?:^|:)season:(\d+)/i.exec(group);
  return {
    title: String(extra.seriesTitle || (episode && item.subtitle) || (item && item.title) || '').trim(),
    episode: Number.isInteger(extra.episode) ? extra.episode : (episode && Number.isInteger(episode.position) ? episode.position : null),
    season: Number.isInteger(extra.season) ? extra.season : (season == null ? null : Number(season[1])),
    isEpisode: item && item.kind === 'episode',
  };
}

function indomaxSearchEpisodeUrl(results, title, season, episode) {
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return null;
  const wanted = indomaxNormalize(title);
  const candidates = results
    .filter((result) => result.season != null && result.episode != null)
    .filter((result) => {
      const candidate = indomaxNormalize(result.title);
      return candidate.includes(wanted) || wanted.includes(candidate);
    });
  const exact = candidates.find(
    (result) => result.season === season && result.episode === episode,
  );
  if (exact != null) return exact.url;

  // When a provider starts a new season/cour, its episode number often resets
  // while TMDB continues the season. Infer that transition from the nearest
  // known episode on each side instead of baking a provider-specific offset.
  const previous = candidates
    .filter((result) => result.season === season && result.episode < episode)
    .sort((a, b) => b.episode - a.episode)[0];
  if (previous == null) return null;
  const providerEpisode = episode - previous.episode;
  const next = candidates.find(
    (result) => result.season > season && result.episode === providerEpisode,
  );
  if (next != null) return next.url;

  // If the desired episode is newer than the search page, retain the same
  // provider URL shape as the first episode of the new group and let the
  // normal HTTP check decide whether that episode is published.
  const groupStart = candidates.find(
    (result) => result.season > season && result.episode === 1,
  );
  if (groupStart == null) return null;
  return groupStart.url.replace(
    new RegExp(`(episode[-_]?)${groupStart.episode}(?=[/?#]|$)`, 'i'),
    (_, prefix) => `${prefix}${providerEpisode}`,
  );
}

function indomaxEpisodeUrl(html, wanted, base, season) {
  if (!Number.isInteger(wanted) || wanted < 1) return null;
  const containers = indomaxDivBlocks(html, /\b(?:vid-episodes|gmr-listseries)\b/i);
  if (containers.length > 0) {
    for (const [containerIndex, container] of containers.entries()) {
      const containerSeason = indomaxSeasonNumber(container) || containerIndex + 1;
      if (Number.isInteger(season) && containerSeason !== season) continue;
      const links = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = links.exec(container)) != null) {
        const href = indomaxAttribute(match[1], 'href');
        if (!href) continue;
        const label = `${indomaxAttribute(match[1], 'title') || ''} ${indomaxText(match[2])}`;
        const number = /episode\s*(\d+)/i.exec(label) || /(?:^|\D)(\d+)(?:\D|$)/.exec(label);
        if (number != null && Number(number[1]) === wanted) return indomaxUrl(href, base);
      }
    }
    // Do not fall through to another season when the detail page exposes
    // explicit episode groups but the requested season is unavailable.
    return null;
  }
  const links = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = links.exec(html || '')) != null) {
    const href = indomaxAttribute(match[1], 'href');
    if (!href) continue;
    const label = `${indomaxAttribute(match[1], 'title') || ''} ${indomaxText(match[2])}`;
    const number = /episode\s*(\d+)/i.exec(label) || /(?:^|\D)(\d+)(?:\D|$)/.exec(label);
    if (number != null && Number(number[1]) === wanted) return indomaxUrl(href, base);
  }
  return null;
}

function indomaxImaxSourceUrl(value, base) {
  const url = indomaxUrl(value, base);
  if (!url) return null;
  if (/^https?:\/\/embedpyrox\.xyz\/video\//i.test(url)) return url;
  const configuredBase = String(base || IMAX_BASE).replace(/\/$/, '');
  const isImaxHost = url.startsWith(configuredBase) ||
    /^https?:\/\/(?:[^./]+\.)?imaxstreams\.(?:net|com)(?:\/|$)/i.test(url);
  return isImaxHost && /\/(?:d|download|file|f|embed)\//i.test(url) ? url : null;
}

function indomaxPlayerUrls(html, base) {
  const urls = [];
  const iframe = /<iframe\b([^>]*)>/gi;
  let match;
  while ((match = iframe.exec(html || '')) != null) {
    const url = indomaxImaxSourceUrl(
      indomaxAttribute(match[1], 'data-litespeed-src') || indomaxAttribute(match[1], 'src'),
      base,
    );
    if (url) urls.push(url);
  }
  const anchor = /<a\b([^>]*)>/gi;
  while ((match = anchor.exec(html || '')) != null) {
    const url = indomaxImaxSourceUrl(indomaxAttribute(match[1], 'href'), base);
    if (url) urls.push(url);
  }
  return urls.filter((url, index) => urls.indexOf(url) === index);
}

function encodeIndomaxSource(payload) {
  return host.codec.textToBase64(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeIndomaxSource(value) {
  let base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const remaining = base64.length % 4;
  if (remaining) base64 += '='.repeat(4 - remaining);
  try { return JSON.parse(host.codec.base64ToText(base64)); } catch (_) { return null; }
}

async function indomaxSources(args) {
  const enabled = args && args.enabledProviders;
  if (enabled != null && enabled.indexOf(INDOMAX_PROVIDER_ID) === -1) return { sources: [] };
  const item = args && args.item;
  if (!item || (item.kind !== 'video' && item.kind !== 'episode')) return { sources: [] };
  const query = indomaxItemQuery(item);
  if (!query.title || (query.isEpisode && !query.episode)) return { sources: [] };
  const base = await indomaxActiveBase();
  const searchUrl = `${base}/?s=${encodeURIComponent(query.title)}&post_type[]=post&post_type[]=tv`;
  const refPayload = indomaxRefPayload(item.ref);
  const directEpisodeUrl = query.isEpisode && refPayload && Number(refPayload.e) === query.episode &&
      (query.season == null || refPayload.s == null || Number(refPayload.s) === query.season)
    ? refPayload.u
    : null;
  let result = refPayload && typeof refPayload.u === 'string'
    ? { title: query.title, url: refPayload.u }
    : null;
  let detailReferer = searchUrl;
  if (result == null) {
    const found = await indomaxFindResult(query.title, base);
    if (found == null) return { sources: [] };
    result = found.result;
    detailReferer = found.searchUrl;
    if (query.isEpisode) {
      const searchedEpisodeUrl = indomaxSearchEpisodeUrl(
        found.results || [],
        query.title,
        query.season,
        query.episode,
      );
      if (searchedEpisodeUrl != null) {
        const searchedEpisode = await indomaxGet(searchedEpisodeUrl, result.url);
        if (searchedEpisode == null) return { sources: [] };
        return {
          sources: indomaxPlayerUrls(searchedEpisode.body, base).map((url, index) => {
            const id = `${INDOMAX_PROVIDER_KEY}:${encodeIndomaxSource({ u: url, r: searchedEpisodeUrl })}`;
            return { id, label: `ImaxStreams ${index + 1}`, provider: 'Nimora', providerId: INDOMAX_PROVIDER_ID };
          }),
        };
      }
    }
  } else {
    detailReferer = `${base}/`;
  }
  const detail = await indomaxGet(result.url, detailReferer);
  if (detail == null) return { sources: [] };
  const watchUrl = query.isEpisode
    ? directEpisodeUrl || indomaxEpisodeUrl(detail.body, query.episode, base, query.season)
    : result.url;
  if (watchUrl == null) return { sources: [] };
  const watch = watchUrl === result.url ? detail : await indomaxGet(watchUrl, result.url);
  if (watch == null) return { sources: [] };
  return {
    sources: indomaxPlayerUrls(watch.body, base).map((url, index) => {
      const id = `${INDOMAX_PROVIDER_KEY}:${encodeIndomaxSource({ u: url, r: watchUrl })}`;
      return { id, label: `ImaxStreams ${index + 1}`, provider: 'Nimora', providerId: INDOMAX_PROVIDER_ID };
    }),
  };
}

function imaxEmbedUrl(url) {
  if (/\/embed\//i.test(url)) return url;
  const playerPath = /imaxstreams\.com/i.test(url) ? '/embed/' : '/e/';
  return url.replace(/\/(?:d|download|file|f)\//i, playerPath);
}

function imaxBaseUrl(url) {
  return /imaxstreams\.com/i.test(url) ? 'https://imaxstreams.com' : IMAX_BASE;
}

function indomaxFireId(url) {
  const match = /^https?:\/\/embedpyrox\.xyz\/video\/([^/?#]+)/i.exec(url || '');
  return match == null ? null : match[1];
}

async function indomaxFirePlaylists(url, referer) {
  const id = indomaxFireId(url);
  if (id == null) return null;
  const endpoint = `${INDOMAX_FIRE_BASE}/player/index.php?data=${encodeURIComponent(id)}&do=getVideo`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...indomaxHeaders(referer),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: `hash=${encodeURIComponent(id)}&r=${encodeURIComponent(referer || url)}`,
    });
  } catch (_) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;
  try {
    const data = JSON.parse(response.body);
    const playlists = [];
    const addPlaylist = (candidate) => {
      if (typeof candidate !== 'string') return;
      const normalized = candidate.replace(/\\\//g, '/');
      if (!/\.m3u8(?:[?#]|$)/i.test(normalized)) return;
      const resolved = indomaxUrl(normalized, INDOMAX_FIRE_BASE);
      if (resolved && playlists.indexOf(resolved) === -1) playlists.push(resolved);
    };
    const directLinks = [data.securedLink, data.videoSource];
    directLinks.forEach(addPlaylist);
    const candidates = Array.isArray(data.videoSources) ? data.videoSources : [];
    for (const candidate of candidates) {
      addPlaylist(candidate && candidate.file);
    }
    return playlists;
  } catch (_) {}
  return [];
}

function imaxPlaylistUrls(script) {
  const urls = [];
  const regex = /:\s*["']([^"']*\.m3u8[^"']*)["']/gi;
  let match;
  while ((match = regex.exec(script || '')) != null) urls.push(match[1].replace(/\\\//g, '/'));
  return urls.filter((url, index) => urls.indexOf(url) === index);
}

function indomaxResolveRelativeUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || typeof base !== 'string') return null;
  const raw = value.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const baseMatch = /^(https?:\/\/[^/]+)(\/[^?#]*)?(?:[?#].*)?$/i.exec(base);
  if (baseMatch == null) return null;
  if (raw.startsWith('//')) return `${baseMatch[1].split(':')[0]}:${raw}`;
  const suffixIndex = raw.search(/[?#]/);
  const rawPath = suffixIndex === -1 ? raw : raw.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : raw.slice(suffixIndex);
  const basePath = baseMatch[2] || '/';
  let path;
  if (rawPath.startsWith('/')) {
    path = rawPath;
  } else if (!rawPath) {
    path = basePath;
  } else {
    const directory = basePath.slice(0, basePath.lastIndexOf('/') + 1);
    path = `${directory}${rawPath}`;
  }
  const parts = path.split('/');
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (normalized.length > 0) normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return `${baseMatch[1]}/${normalized.join('/')}${suffix}`;
}

function indomaxResponseHeader(response, name) {
  const headers = response && response.headers;
  if (headers == null || typeof headers !== 'object') return '';
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return String(headers[key] || '');
  }
  return '';
}

function indomaxPlaylistFirstUri(body) {
  const lines = String(body || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const value = line.trim();
    if (value && !value.startsWith('#')) return value;
  }
  return null;
}

function indomaxRejectMediaUri(url) {
  return /(?:(?:^|[./_-])ad-site(?:[./_-]|$)|\.image(?:[?#]|$)|(?:^|[./_-])advert(?:isement)?(?:[./_-]|$))/i.test(url || '');
}

function indomaxMediaResponseIsPlayable(response, url) {
  if (response == null || response.status < 200 || response.status >= 300) return false;
  if (indomaxRejectMediaUri(url)) return false;
  const body = String(response.body || '');
  if (!body) return false;
  if (/^GIF8|^\u0000?PNG/i.test(body)) return false;
  // Some valid FirePlayer segments are mislabeled as .js/.css. A transport
  // signature is stronger evidence than the extension or content type.
  if (body.charCodeAt(0) === 0x47 || body.slice(4, 8) === 'ftyp' || body.indexOf('moof') === 4) return true;
  const contentType = indomaxResponseHeader(response, 'content-type').toLowerCase();
  if (!contentType || /(?:text\/html|text\/css|javascript|font\/|image\/|application\/json)/i.test(contentType)) return false;
  return /(?:^|\/)(?:video|audio)\//i.test(contentType) ||
    /(?:mpeg|mp4|octet-stream|x-mpegurl|vnd\.apple\.mpegurl)/i.test(contentType);
}

async function indomaxHlsHasPlayableMedia(url, headers) {
  let response;
  try {
    response = await fetch(url, { headers });
  } catch (_) {
    return false;
  }
  if (response.status < 200 || response.status >= 300) return false;
  const masterBody = String(response.body || '').replace(/^\uFEFF/, '').trimStart();
  if (!masterBody.startsWith('#EXTM3U')) return false;
  let playlistUrl = url;
  let playlistBody = masterBody;
  if (/#EXT-X-STREAM-INF\b/i.test(playlistBody)) {
    const variant = indomaxPlaylistFirstUri(playlistBody);
    playlistUrl = indomaxResolveRelativeUrl(variant, playlistUrl);
    if (!playlistUrl || indomaxRejectMediaUri(playlistUrl)) return false;
    try {
      response = await fetch(playlistUrl, { headers });
    } catch (_) {
      return false;
    }
    if (response.status < 200 || response.status >= 300) return false;
    playlistBody = String(response.body || '').replace(/^\uFEFF/, '').trimStart();
    if (!playlistBody.startsWith('#EXTM3U')) return false;
  }
  const mediaUri = indomaxPlaylistFirstUri(playlistBody);
  const mediaUrl = indomaxResolveRelativeUrl(mediaUri, playlistUrl);
  if (!mediaUrl || indomaxRejectMediaUri(mediaUrl)) return false;
  try {
    const media = await fetch(mediaUrl, { headers });
    return indomaxMediaResponseIsPlayable(media, mediaUrl);
  } catch (_) {
    return false;
  }
}

// ImaxStreams commonly wraps `var links` in Dean Edwards' P.A.C.K.E.R.
// This decodes only that data substitution format; it never evaluates the
// upstream script. Plain `sources:` pages continue through unchanged.
function imaxUnpack(script) {
  const packed = /}\(\s*'((?:\\.|[^'])*)'\s*,\s*(\d+)\s*,\s*\d+\s*,\s*'((?:\\.|[^'])*)'\.split\('\|'\)/i.exec(script || '');
  if (packed == null) return String(script || '');
  const payload = packed[1]
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
  const radix = Number(packed[2]);
  const words = packed[3].replace(/\\'/g, "'").split('|');
  if (!Number.isInteger(radix) || radix < 2 || words.length === 0) return String(script || '');
  const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const token = (index) => {
    if (radix <= 36) return index.toString(radix);
    let value = index;
    let result = '';
    do {
      result = digits[value % radix] + result;
      value = Math.floor(value / radix);
    } while (value > 0);
    return result;
  };
  let unpacked = payload;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (!words[index]) continue;
    const escapedToken = token(index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    unpacked = unpacked.replace(
      new RegExp(`\\b${escapedToken}\\b`, 'g'),
      words[index],
    );
  }
  return unpacked;
}

async function indomaxResolveSource(sourceId) {
  const prefix = `${INDOMAX_PROVIDER_KEY}:`;
  if (typeof sourceId !== 'string' || !sourceId.startsWith(prefix)) throw new Error('Invalid Indomax source id');
  const payload = decodeIndomaxSource(sourceId.slice(prefix.length));
  if (!payload || typeof payload.u !== 'string' || !/^https?:\/\//i.test(payload.u)) throw new Error('Malformed Indomax source id');
  const firePlaylists = await indomaxFirePlaylists(payload.u, payload.r);
  if (firePlaylists != null) {
    const fireHeaders = {
      ...indomaxHeaders(payload.r || INDOMAX_FIRE_BASE),
      Origin: INDOMAX_FIRE_BASE,
    };
    for (const firePlaylist of firePlaylists) {
      if (await indomaxHlsHasPlayableMedia(firePlaylist, fireHeaders)) {
        return { url: firePlaylist, format: 'hls', headers: fireHeaders };
      }
    }
    throw new Error('ImaxStreams playlist has no playable media');
  }
  const embed = imaxEmbedUrl(payload.u);
  const playerBase = imaxBaseUrl(payload.u);
  let response;
  try { response = await fetch(embed, { headers: indomaxHeaders(payload.r) }); } catch (_) { throw new Error('ImaxStreams embed request failed'); }
  if (response.status < 200 || response.status >= 300) throw new Error(`ImaxStreams returned HTTP ${response.status}`);
  const playlistCandidates = [
    ...imaxPlaylistUrls(response.body),
    ...imaxPlaylistUrls(imaxUnpack(response.body)),
  ].filter((url, index, entries) => entries.indexOf(url) === index);
  const playbackHeaders = imaxHeaders(playerBase);
  for (const playlist of playlistCandidates) {
    const playlistUrl = indomaxResolveRelativeUrl(playlist, embed) || indomaxUrl(playlist, playerBase);
    if (playlistUrl && await indomaxHlsHasPlayableMedia(playlistUrl, playbackHeaders)) {
      return { url: playlistUrl, format: 'hls', headers: playbackHeaders };
    }
  }
  if (playlistCandidates.length === 0) throw new Error('No HLS playlist in ImaxStreams embed');
  throw new Error('ImaxStreams playlist has no playable media');
}

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: INDOMAX_PROVIDER_KEY,
  sources: indomaxSources,
  resolve: (sourceId) => indomaxResolveSource(sourceId),
});

globalThis.__metaProviders = globalThis.__metaProviders || [];
globalThis.__metaProviders.push({
  providerId: INDOMAX_PROVIDER_ID,
  meta: indomaxMeta,
});

globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: INDOMAX_NSFW_CATALOG_ID,
  catalog: indomaxNsfwCatalog,
});

globalThis.__extension = globalThis.__extension || {};
const indomaxPreviousSearch = globalThis.__extension.search;
globalThis.__extension.search = async (args) => {
  let existing = { sections: [] };
  try {
    if (typeof indomaxPreviousSearch === 'function') {
      existing = await indomaxPreviousSearch(args);
    }
  } catch (_) {}
  const existingSections = Array.isArray(existing.sections) ? existing.sections : [];
  const hasExistingItems = existingSections.some(
    (section) => section != null && Array.isArray(section.items) && section.items.length > 0,
  );
  if (hasExistingItems) return existing;

  let indomax = { sections: [] };
  try {
    indomax = await indomaxSearch(args);
  } catch (_) {}
  const indomaxSections = Array.isArray(indomax.sections) ? indomax.sections : [];
  const hasIndomaxItems = indomaxSections.some(
    (section) => section != null && Array.isArray(section.items) && section.items.length > 0,
  );
  return hasIndomaxItems ? indomax : existing;
};

// KlikXXi Dracin episode shorts. The catalogue is a WordPress archive; each
// series detail page exposes its episode links, and the episode page exposes
// several player tabs through the Muvipro AJAX endpoint.

const KLIKXXI_DEFAULT_BASE = 'https://klikxxi.shop';
const KLIKXXI_DIRECTORY =
  globalThis.__klikxxiDirectoryUrl ||
  'https://raw.githubusercontent.com/Asm0d3usX/CloudX/builds/Website.json';
const KLIKXXI_PROVIDER_ID = 'nimora.klikxxi';
const KLIKXXI_PROVIDER_KEY = 'klikxxi';
const KLIKXXI_CATALOG_ID = 'dracin_shorts';
const KLIKXXI_HEXLOAD_BASE =
  globalThis.__klikxxiHexloadBaseUrl || 'https://hexload.com';
const KLIKXXI_UA =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';
const KLIKXXI_MAX_SERIES_PER_PAGE = 12;
const KLIKXXI_EPISODES_PER_SERIES = 3;

let klikxxiBase = globalThis.__klikxxiBaseUrl || null;

function klikxxiHeaders(referer) {
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: referer || `${klikxxiBase || KLIKXXI_DEFAULT_BASE}/`,
    'User-Agent': KLIKXXI_UA,
  };
}

function klikxxiUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  let url = raw;
  if (raw.startsWith('//')) url = `https:${raw}`;
  else if (!/^https?:\/\//i.test(raw)) {
    const root = (base || klikxxiBase || KLIKXXI_DEFAULT_BASE).replace(/\/$/, '');
    url = raw.startsWith('/') ? `${root}${raw}` : `${root}/${raw}`;
  }
  try { return encodeURI(url); } catch (_) { return url.replace(/ /g, '%20'); }
}

function klikxxiText(value) {
  const entities = {
    amp: '&', apos: "'", gt: '>', hellip: '…', lt: '<', mdash: '—',
    nbsp: ' ', ndash: '–', quot: '"',
  };
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (match, code) => {
      const value = code[0].toLowerCase() === 'x'
        ? parseInt(code.slice(1), 16)
        : parseInt(code, 10);
      return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : match;
    })
    .replace(/&([a-z]+);/gi, (match, name) => entities[name.toLowerCase()] || match)
    .replace(/\s+/g, ' ')
    .trim();
}

function klikxxiAttr(attributes, name) {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)`, 'i').exec(attributes || '');
  return match == null ? null : match[1];
}

function klikxxiDivBlocks(html, classPattern) {
  const blocks = [];
  const stack = [];
  const tags = /<div\b([^>]*)>|<\/div\s*>/gi;
  let match;
  while ((match = tags.exec(html || '')) != null) {
    if (match[1] != null) {
      stack.push({
        start: tags.lastIndex,
        matched: classPattern.test(klikxxiAttr(match[1], 'class') || ''),
      });
      continue;
    }
    const block = stack.pop();
    if (block != null && block.matched) {
      blocks.push((html || '').slice(block.start, match.index));
    }
  }
  return blocks;
}

async function klikxxiGet(url, referer) {
  try {
    const response = await fetch(url, { headers: klikxxiHeaders(referer) });
    return response.status >= 200 && response.status < 300 ? response : null;
  } catch (_) {
    return null;
  }
}

async function klikxxiPost(url, body, referer) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...klikxxiHeaders(referer),
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body,
    });
    return response.status >= 200 && response.status < 300 ? response : null;
  } catch (_) {
    return null;
  }
}

async function klikxxiActiveBase() {
  if (klikxxiBase) return klikxxiBase;
  const response = await klikxxiGet(KLIKXXI_DIRECTORY, KLIKXXI_DEFAULT_BASE);
  if (response != null) {
    try {
      const urls = JSON.parse(response.body).klikxxi;
      if (Array.isArray(urls) && typeof urls[0] === 'string' && /^https?:\/\//i.test(urls[0])) {
        klikxxiBase = urls[0].replace(/\/$/, '');
      }
    } catch (_) {}
  }
  return klikxxiBase || KLIKXXI_DEFAULT_BASE;
}

function klikxxiPoster(article, base) {
  const image = /<img\b([^>]*)>/i.exec(article || '');
  if (image == null) return null;
  const attributes = image[1];
  const srcset = klikxxiAttr(attributes, 'data-lazy-srcset') ||
    klikxxiAttr(attributes, 'data-srcset') || klikxxiAttr(attributes, 'srcset');
  const candidate = srcset
    ? srcset.split(',')[0].trim().split(/\s+/)[0]
    : klikxxiAttr(attributes, 'data-lazy-src') ||
      klikxxiAttr(attributes, 'data-src') || klikxxiAttr(attributes, 'src');
  if (!candidate || candidate.startsWith('data:image')) return null;
  return klikxxiUrl(candidate, base);
}

function klikxxiCategoryResults(html, base) {
  const results = [];
  const articles = /<article\b([^>]*\bitem-infinite\b[^>]*)>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = articles.exec(html || '')) != null) {
    const content = match[2];
    const titleMatch = /<h2\b[^>]*\bentry-title\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(content);
    const hrefMatch = /<div\b[^>]*\bcontent-thumbnail\b[^>]*>[\s\S]*?<a\b([^>]*)>/i.exec(content);
    if (titleMatch == null || hrefMatch == null) continue;
    const title = klikxxiText(titleMatch[2]);
    const url = klikxxiUrl(klikxxiAttr(hrefMatch[1], 'href'), base);
    if (!title || !url || !/\/tv\//i.test(url)) continue;
    const episodeMatch = /<div\b[^>]*\bgmr-numbeps\b[^>]*>[\s\S]*?<span[^>]*>(\d+)/i.exec(content);
    results.push({
      title,
      url,
      poster: klikxxiPoster(content, base),
      episodeCount: episodeMatch == null ? null : Number(episodeMatch[1]),
    });
  }
  return results;
}

function klikxxiHasNextPage(html) {
  return /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bnext\b[^"']*["'][^>]*>/i.test(html || '');
}

function klikxxiCategoryUrl(base, page) {
  const path = '/category/dracin/';
  return page > 1 ? `${base}${path}page/${page}/` : `${base}${path}`;
}

function klikxxiEpisodeNumber(value) {
  const text = klikxxiText(value);
  const explicit = /\bS\s*(\d+)\s*E(?:ps|pisode)?\s*(\d+)\b/i.exec(text);
  if (explicit != null) return { season: Number(explicit[1]), episode: Number(explicit[2]) };
  const episode = /\bE(?:ps|pisode)?\s*(\d+)\b/i.exec(text);
  return episode == null ? null : { season: null, episode: Number(episode[1]) };
}

function klikxxiEpisodeGroups(html, base) {
  const groups = [];
  const containers = klikxxiDivBlocks(html, /\bgmr-season-block\b/i);
  containers.forEach((container, index) => {
    const titleMatch = /<h[2-4]\b[^>]*\bseason-title\b[^>]*>([\s\S]*?)<\/h[2-4]>/i.exec(container);
    const season = Number(/\d+/.exec(klikxxiText(titleMatch == null ? '' : titleMatch[1]))?.[0]) || index + 1;
    const episodes = [];
    const links = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let link;
    while ((link = links.exec(container)) != null) {
      const parsed = klikxxiEpisodeNumber(`${klikxxiAttr(link[1], 'title') || ''} ${link[2]}`);
      const url = klikxxiUrl(klikxxiAttr(link[1], 'href'), base);
      if (parsed == null || url == null || !Number.isInteger(parsed.episode) || parsed.episode < 1) continue;
      episodes.push({ url, season, episode: parsed.episode });
    }
    const unique = episodes.filter((episode, itemIndex, entries) =>
      entries.findIndex((other) => other.url === episode.url) === itemIndex,
    ).sort((a, b) => a.episode - b.episode);
    if (unique.length > 0) groups.push({ season, episodes: unique });
  });
  return groups.sort((a, b) => a.season - b.season);
}

function klikxxiEncode(payload) {
  return host.codec.textToBase64(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function klikxxiDecode(value) {
  let encoded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const remainder = encoded.length % 4;
  if (remainder) encoded += '='.repeat(4 - remainder);
  try { return JSON.parse(host.codec.base64ToText(encoded)); } catch (_) { return null; }
}

function klikxxiSeriesRef(series) {
  return {
    extensionId: 'nimora',
    providerId: KLIKXXI_PROVIDER_ID,
    id: `${KLIKXXI_PROVIDER_KEY}:series:${klikxxiEncode({ u: series.url })}`,
  };
}

function klikxxiEpisodeItem(series, episode) {
  const payload = {
    u: episode.url,
    p: series.url,
    t: series.title,
    s: episode.season,
    e: episode.episode,
  };
  const item = {
    ref: {
      extensionId: 'nimora',
      providerId: KLIKXXI_PROVIDER_ID,
      id: `${KLIKXXI_PROVIDER_KEY}:${klikxxiEncode(payload)}`,
    },
    kind: 'episode',
    title: `${series.title} · Episode ${episode.episode}`,
    subtitle: `Season ${episode.season} · Episode ${episode.episode}`,
    episode: {
      parentRef: klikxxiSeriesRef(series),
      groupId: `season:${episode.season}`,
      position: episode.episode,
    },
  };
  if (series.poster) item.artwork = { portrait: { url: series.poster } };
  return item;
}

async function klikxxiLatestEpisodes(series) {
  const response = await klikxxiGet(series.url, `${klikxxiBase}/`);
  if (response == null) return [];
  const groups = klikxxiEpisodeGroups(response.body, klikxxiBase);
  const latest = groups[groups.length - 1];
  if (latest == null) return [];
  return latest.episodes
    .slice(-KLIKXXI_EPISODES_PER_SERIES)
    .reverse()
    .map((episode) => klikxxiEpisodeItem(series, episode));
}

async function klikxxiShortsCatalog(query) {
  const base = await klikxxiActiveBase();
  const requested = Number(query && query.page);
  const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
  const response = await klikxxiGet(klikxxiCategoryUrl(base, page), `${base}/`);
  if (response == null) return { sections: [{ id: 'dracin', title: 'Dracin', items: [] }] };
  const series = klikxxiCategoryResults(response.body, base).slice(0, KLIKXXI_MAX_SERIES_PER_PAGE);
  const itemGroups = await Promise.all(series.map((entry) => klikxxiLatestEpisodes(entry).catch(() => [])));
  const items = itemGroups.flat();
  const result = { sections: [{ id: 'dracin', title: 'Dracin Shorts', items }] };
  if (klikxxiHasNextPage(response.body)) result.nextPage = String(page + 1);
  return result;
}

function klikxxiIframeUrls(html) {
  const urls = [];
  const frames = /<iframe\b([^>]*)>/gi;
  let match;
  while ((match = frames.exec(html || '')) != null) {
    const value = klikxxiAttr(match[1], 'data-litespeed-src') || klikxxiAttr(match[1], 'src');
    const url = klikxxiUrl(value, klikxxiBase);
    if (url && urls.indexOf(url) === -1) urls.push(url);
  }
  return urls;
}

async function klikxxiPlayerFrames(episodeUrl) {
  const page = await klikxxiGet(episodeUrl, `${klikxxiBase}/`);
  if (page == null) return [];
  let postId = null;
  const divs = /<div\b([^>]*)>/gi;
  let div;
  while ((div = divs.exec(page.body)) != null) {
    if (klikxxiAttr(div[1], 'id') !== 'muvipro_player_content_id') continue;
    postId = klikxxiAttr(div[1], 'data-id');
    break;
  }
  if (!postId) return klikxxiIframeUrls(page.body);
  const tabs = [];
  const tabBlocks = /<div\b([^>]*\btab-content-ajax\b[^>]*)>/gi;
  let tab;
  while ((tab = tabBlocks.exec(page.body)) != null) {
    const id = klikxxiAttr(tab[1], 'id');
    if (id && tabs.indexOf(id) === -1) tabs.push(id);
  }
  if (tabs.length === 0) return klikxxiIframeUrls(page.body);
  const urls = [];
  for (const tabId of tabs) {
    const response = await klikxxiPost(
      `${klikxxiBase}/wp-admin/admin-ajax.php`,
      `action=muvipro_player_content&tab=${encodeURIComponent(tabId)}&post_id=${encodeURIComponent(postId)}`,
      episodeUrl,
    );
    if (response == null) continue;
    for (const url of klikxxiIframeUrls(response.body)) {
      if (urls.indexOf(url) === -1) urls.push(url);
    }
  }
  return urls;
}

function klikxxiHexloadId(url) {
  const configuredBase = KLIKXXI_HEXLOAD_BASE.replace(/\/$/, '');
  if (configuredBase !== 'https://hexload.com') {
    const prefix = `${configuredBase}/embed-`;
    if (!String(url || '').startsWith(prefix)) return null;
    const value = String(url).slice(prefix.length).replace(/\.html\/?$/, '').replace(/\/?$/, '');
    return value && !/[/?#]/.test(value) ? value : null;
  }
  const match = /^https?:\/\/(?:www\.)?hexload\.com\/embed-([^/?#]+?)(?:\.html)?\/?$/i.exec(url || '');
  return match == null ? null : match[1];
}

function klikxxiStreamHeaders(referer) {
  return {
    Referer: referer || `${KLIKXXI_HEXLOAD_BASE}/`,
    'User-Agent': KLIKXXI_UA,
  };
}

async function klikxxiResolveHexload(url, referer) {
  const id = klikxxiHexloadId(url);
  if (id == null) return null;
  const page = await klikxxiGet(url, referer);
  if (page == null) return null;
  const response = await klikxxiPost(
    `${KLIKXXI_HEXLOAD_BASE}/download`,
    `op=download3&id=${encodeURIComponent(id)}&ajax=1&method_free=1&dataType=json`,
    url,
  );
  if (response == null) return null;
  try {
    const data = JSON.parse(response.body);
    const result = data && data.result;
    const rawUrl = result && result.url;
    if (data.msg !== 'OK' || typeof rawUrl !== 'string' || !/^https?:\/\//i.test(rawUrl)) return null;
    const streamUrl = klikxxiUrl(rawUrl);
    if (streamUrl == null) return null;
    return {
      url: streamUrl,
      format: /\.m3u8(?:[?#]|$)/i.test(streamUrl) ? 'hls' : 'other',
      headers: klikxxiStreamHeaders(url),
      label: result.content_type === 'video/mp4' ? 'KlikXXi MP4' : 'KlikXXi',
    };
  } catch (_) {
    return null;
  }
}

function klikxxiPayloadFromRef(ref) {
  const id = ref && typeof ref.id === 'string' ? ref.id : '';
  const prefix = `${KLIKXXI_PROVIDER_KEY}:`;
  return id.startsWith(prefix) ? klikxxiDecode(id.slice(prefix.length)) : null;
}

async function klikxxiSources(args) {
  const enabled = args && args.enabledProviders;
  if (enabled != null && enabled.indexOf(KLIKXXI_PROVIDER_ID) === -1) return { sources: [] };
  const item = args && args.item;
  if (!item || item.ref?.providerId !== KLIKXXI_PROVIDER_ID || item.kind !== 'episode') return { sources: [] };
  const payload = klikxxiPayloadFromRef(item.ref);
  if (!payload || typeof payload.u !== 'string') return { sources: [] };
  const frames = await klikxxiPlayerFrames(payload.u);
  return {
    sources: frames
      .filter((url) => klikxxiHexloadId(url) != null)
      .map((url, index) => ({
        id: `${KLIKXXI_PROVIDER_KEY}:${klikxxiEncode({ u: url, r: payload.u })}`,
        label: `KlikXXi ${index + 1}`,
        provider: 'Nimora',
        providerId: KLIKXXI_PROVIDER_ID,
      })),
  };
}

async function klikxxiResolveSource(sourceId) {
  const prefix = `${KLIKXXI_PROVIDER_KEY}:`;
  if (typeof sourceId !== 'string' || !sourceId.startsWith(prefix)) throw new Error('Invalid KlikXXi source id');
  const payload = klikxxiDecode(sourceId.slice(prefix.length));
  if (!payload || typeof payload.u !== 'string') throw new Error('Malformed KlikXXi source id');
  const stream = await klikxxiResolveHexload(payload.u, payload.r);
  if (stream == null) throw new Error('KlikXXi Hexload returned no playable stream');
  return stream;
}

async function klikxxiPreview(args) {
  const item = args && args.item;
  const payload = klikxxiPayloadFromRef(item && item.ref);
  if (!payload || typeof payload.u !== 'string') return { sources: [] };
  const frames = await klikxxiPlayerFrames(payload.u);
  for (const frame of frames) {
    const stream = await klikxxiResolveHexload(frame, payload.u);
    if (stream == null) continue;
    return {
      sources: [{
        id: `preview:${KLIKXXI_PROVIDER_KEY}:${klikxxiEncode({ u: frame, r: payload.u })}`,
        type: 'direct',
        stream,
      }],
    };
  }
  return { sources: [] };
}

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: KLIKXXI_PROVIDER_KEY,
  sources: klikxxiSources,
  resolve: klikxxiResolveSource,
});

globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: KLIKXXI_CATALOG_ID,
  catalog: klikxxiShortsCatalog,
});

globalThis.__previewProviders = globalThis.__previewProviders || [];
globalThis.__previewProviders.push({
  providerId: KLIKXXI_PROVIDER_ID,
  preview: klikxxiPreview,
});

// AniList anime catalog, search, and meta.
//
// TMDB backs everything else here, and deliberately does not back anime. The
// two databases disagree about what an anime *is*: TMDB folds Bleach's four
// Thousand-Year Blood War cours into one 50-episode "Season 2", while AniList
// lists each cour as its own entry numbered from 1 — which is exactly how
// Sokuja and Indomax list them. Matching a catalog item to a stream is a
// title-and-number game, so the catalog that counts the way the sources count
// wins more sources.
//
// The cost is deliberate and worth stating: an AniList ref carries no TMDB id,
// so the tmdbId-keyed providers (Vidrock, Videasy, MovieBox, and Shegu
// subtitles) cannot serve these items. Anime plays from the providers that
// match on title — which are the ones that carry Indonesian subtitles anyway.

const ANILIST_API_URL = globalThis.__anilistApiUrl || 'https://graphql.anilist.co';
const ANILIST_PROVIDER_ID = 'nimora.anilist';
const ANILIST_CATALOG_ID = 'anilist';
const ANILIST_CATEGORY = 'anime';
const ANILIST_PER_PAGE = 30;
// One page of aired episodes is enough to date a running cour, which is the
// case that needs dates at all: a stream provider stamps its uploads with the
// broadcast day. A long-runner's early episodes fall outside this window and
// carry no date, and are matched by number instead.
const ANILIST_SCHEDULE_PER_PAGE = 100;

const ANILIST_MEDIA_FIELDS = `
  id
  format
  status
  episodes
  averageScore
  startDate { year }
  title { romaji english }
  coverImage { extraLarge large }
  bannerImage
`;

const ANILIST_LIST_QUERY = `
  query ($page: Int, $perPage: Int, $sort: [MediaSort], $status: MediaStatus, $search: String, $season: MediaSeason, $seasonYear: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { currentPage hasNextPage }
      media(type: ANIME, isAdult: false, sort: $sort, status: $status, search: $search, season: $season, seasonYear: $seasonYear) {
        ${ANILIST_MEDIA_FIELDS}
      }
    }
  }
`;

const ANILIST_MEDIA_QUERY = `
  query ($id: Int, $schedulePerPage: Int) {
    Media(id: $id, type: ANIME) {
      ${ANILIST_MEDIA_FIELDS}
      genres
      description(asHtml: false)
      nextAiringEpisode { episode }
      airingSchedule(notYetAired: false, page: 1, perPage: $schedulePerPage) {
        nodes { episode airingAt }
      }
    }
  }
`;

// Sorted shelves rather than genre shelves: AniList's genre list is long and
// uneven, while these four answer the questions a browsing user actually has.
const ANILIST_SHELVES = [
  { id: 'trending', name: 'Trending', sort: ['TRENDING_DESC'] },
  { id: 'popular', name: 'Popular', sort: ['POPULARITY_DESC'] },
  { id: 'airing', name: 'Airing Now', sort: ['POPULARITY_DESC'], status: 'RELEASING' },
  { id: 'top', name: 'Top Rated', sort: ['SCORE_DESC'] },
];

async function anilistQuery(query, variables) {
  try {
    const response = await fetch(ANILIST_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (response.status < 200 || response.status >= 300) return null;
    const payload = JSON.parse(response.body);
    // GraphQL reports failure in the body with a 200, so a present `data` is
    // the only signal worth trusting.
    return payload && payload.data ? payload.data : null;
  } catch (_) {
    return null;
  }
}

// Romaji first, not English: the Indonesian fansub sites this catalog feeds
// list titles in romaji, and the item's title is what the stream providers
// match on.
function anilistTitle(media) {
  const title = media && media.title ? media.title : {};
  return title.romaji || title.english || 'Untitled';
}

function anilistRefId(mediaId) {
  return `anilist:media:${mediaId}`;
}

function anilistEpisodeRefId(mediaId, episode) {
  return `anilist:episode:${mediaId}:${episode}`;
}

function anilistParseRefId(refId) {
  const match = /^anilist:media:(\d+)$/.exec(String(refId || ''));
  return match == null ? null : match[1];
}

function anilistToMediaItem(media) {
  const item = {
    ref: {
      extensionId: EXTENSION_ID,
      providerId: ANILIST_PROVIDER_ID,
      id: anilistRefId(media.id),
    },
    kind: media.format === 'MOVIE' ? 'video' : 'series',
    title: anilistTitle(media),
  };
  const year = media.startDate && media.startDate.year;
  if (Number.isInteger(year) && year > 0) item.releaseYear = year;
  // AniList scores out of 100; the protocol's rating is the 0–10 scale the
  // rest of the catalog uses.
  if (Number.isFinite(media.averageScore) && media.averageScore > 0) {
    item.rating = media.averageScore / 10;
  }
  const artwork = {};
  const cover = media.coverImage || {};
  const portrait = cover.extraLarge || cover.large;
  if (portrait) artwork.portrait = { url: portrait };
  if (media.bannerImage) artwork.landscape = { url: media.bannerImage };
  if (Object.keys(artwork).length > 0) item.artwork = artwork;
  return item;
}

function anilistItemsOf(data) {
  const page = data && data.Page;
  const media = page && Array.isArray(page.media) ? page.media : [];
  return media.filter((entry) => entry != null).map(anilistToMediaItem);
}

function anilistShelf(subCategory) {
  if (subCategory == null) return ANILIST_SHELVES[0];
  return ANILIST_SHELVES.find((shelf) => shelf.id === subCategory) || null;
}

async function anilistCatalog(query) {
  if (query.category !== ANILIST_CATEGORY) return { sections: [] };
  const subCategories = ANILIST_SHELVES.map((shelf) => ({
    id: shelf.id,
    name: shelf.name,
  }));
  const shelf = anilistShelf(query.subCategory);
  if (shelf == null) return { sections: [], subCategories };

  const requested = Number(query.page);
  const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
  const data = await anilistQuery(ANILIST_LIST_QUERY, {
    page,
    perPage: ANILIST_PER_PAGE,
    sort: shelf.sort,
    status: shelf.status,
  });
  if (data == null) return { sections: [], subCategories };

  // No section title: the shelf is chosen by chip and the grid is one flat,
  // paginated list, so a heading would name what the chip already says and put
  // it between pages as the user scrolls.
  const result = {
    sections: [{ id: shelf.id, items: anilistItemsOf(data) }],
    subCategories,
  };
  const pageInfo = data.Page && data.Page.pageInfo;
  if (pageInfo && pageInfo.hasNextPage) result.nextPage = String(page + 1);
  return result;
}

// The Home "Trending Anime" row. It lives in the TMDB-backed highlights
// catalog with the other rows, but its data comes from here: TMDB has no
// anime genre, and narrowing `discover` to Japanese animation on one
// streamer's licence returned barely thirty titles.
const ANILIST_HIGHLIGHT_LIMIT = 25;

function anilistSeasonForDate(date) {
  const month = date.getUTCMonth() + 1;
  let season;
  if (month <= 3) {
    season = 'WINTER';
  } else if (month <= 6) {
    season = 'SPRING';
  } else if (month <= 9) {
    season = 'SUMMER';
  } else {
    season = 'FALL';
  }
  return { season, seasonYear: date.getUTCFullYear() };
}

async function anilistHighlightItems() {
  const data = await anilistQuery(ANILIST_LIST_QUERY, {
    page: 1,
    perPage: ANILIST_HIGHLIGHT_LIMIT,
    sort: ['TRENDING_DESC'],
  });
  return data == null ? [] : anilistItemsOf(data);
}

async function anilistPopularSeasonItems(now) {
  const current = anilistSeasonForDate(now || new Date());
  const data = await anilistQuery(ANILIST_LIST_QUERY, {
    page: 1,
    perPage: ANILIST_HIGHLIGHT_LIMIT,
    sort: ['POPULARITY_DESC'],
    season: current.season,
    seasonYear: current.seasonYear,
  });
  return data == null ? [] : anilistItemsOf(data);
}

async function anilistSearch(args) {
  const search = args && args.query;
  if (!search) return { sections: [] };
  const requested = Number(args.page);
  const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
  const data = await anilistQuery(ANILIST_LIST_QUERY, {
    page,
    perPage: ANILIST_PER_PAGE,
    search,
    sort: ['SEARCH_MATCH'],
  });
  if (data == null) return { sections: [] };
  const result = { sections: [{ id: 'anilist-results', items: anilistItemsOf(data) }] };
  const pageInfo = data.Page && data.Page.pageInfo;
  if (pageInfo && pageInfo.hasNextPage) result.nextPage = String(page + 1);
  return result;
}

// AniList's plain-text description still carries the site's own line breaks
// and the occasional inline tag.
function anilistDescription(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function anilistHighestScheduled(schedule) {
  let highest = 0;
  for (const episode of schedule.keys()) {
    if (episode > highest) highest = episode;
  }
  return highest;
}

// The guide lists every episode announced, aired or not — the app hides the
// unaired ones by their date. `episodes` is null while a series is running,
// so an announced total is not always available and the schedule stands in.
function anilistEpisodeCount(media, schedule) {
  if (Number.isInteger(media.episodes) && media.episodes > 0) {
    return media.episodes;
  }
  return Math.max(anilistLastAired(media, schedule), anilistHighestScheduled(schedule));
}

// Where a series that has never been played should start. Not the last
// episode in the guide: a running cour announces its full episode count from
// the first week, so the guide's tail is months away from airing.
function anilistLastAired(media, schedule) {
  const next = media.nextAiringEpisode && media.nextAiringEpisode.episode;
  if (Number.isInteger(next) && next > 0) return next - 1;
  const scheduled = anilistHighestScheduled(schedule);
  if (scheduled > 0) return scheduled;
  // Nothing airing and nothing scheduled: a finished series, all of it out.
  return Number.isInteger(media.episodes) && media.episodes > 0
    ? media.episodes
    : 0;
}

function anilistSchedule(media) {
  const nodes = media.airingSchedule && Array.isArray(media.airingSchedule.nodes)
    ? media.airingSchedule.nodes
    : [];
  const byEpisode = new Map();
  for (const node of nodes) {
    const episode = node && Number(node.episode);
    const airingAt = node && Number(node.airingAt);
    if (!Number.isInteger(episode) || !Number.isFinite(airingAt)) continue;
    byEpisode.set(episode, new Date(airingAt * 1000).toISOString());
  }
  return byEpisode;
}

// One group, always: an AniList entry *is* one cour, numbered from 1, so a
// season axis on top of it would be invented. The id still says `season:1`
// because stream providers read the season out of it.
function anilistEpisodeGuide(media, schedule, total) {
  if (total < 1) return null;
  const episodes = [];
  for (let position = 1; position <= total; position++) {
    const episode = {
      ref: {
        extensionId: EXTENSION_ID,
        providerId: ANILIST_PROVIDER_ID,
        id: anilistEpisodeRefId(media.id, position),
      },
      title: `Episode ${position}`,
      position,
    };
    const availableAt = schedule.get(position);
    if (availableAt != null) episode.availableAt = availableAt;
    episodes.push(episode);
  }
  return { groups: [{ id: 'season:1', title: 'Episodes', episodes }] };
}

async function anilistMeta(args) {
  const mediaId = anilistParseRefId(args && args.ref && args.ref.id);
  if (mediaId == null) {
    throw new Error(`Not an AniList ref id: ${args && args.ref && args.ref.id}`);
  }
  const data = await anilistQuery(ANILIST_MEDIA_QUERY, {
    id: Number(mediaId),
    schedulePerPage: ANILIST_SCHEDULE_PER_PAGE,
  });
  const media = data && data.Media;
  if (media == null) throw new Error(`AniList has no media ${mediaId}`);

  const detail = { item: anilistToMediaItem(media) };
  const description = anilistDescription(media.description);
  if (description) detail.description = description;
  if (Array.isArray(media.genres) && media.genres.length > 0) {
    detail.tags = media.genres.filter((genre) => typeof genre === 'string');
  }
  if (media.format === 'MOVIE') return detail;

  const schedule = anilistSchedule(media);
  const total = anilistEpisodeCount(media, schedule);
  const guide = anilistEpisodeGuide(media, schedule, total);
  if (guide != null) {
    detail.episodeGuide = guide;
    const lastAired = Math.min(anilistLastAired(media, schedule), total);
    if (lastAired >= 1) {
      detail.episodeGuide.defaultEpisodeRef = {
        extensionId: EXTENSION_ID,
        providerId: ANILIST_PROVIDER_ID,
        id: anilistEpisodeRefId(media.id, lastAired),
      };
    }
  }
  return detail;
}

globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: ANILIST_CATALOG_ID,
  catalog: anilistCatalog,
});

globalThis.__metaProviders = globalThis.__metaProviders || [];
globalThis.__metaProviders.push({
  providerId: ANILIST_PROVIDER_ID,
  meta: anilistMeta,
});

// Search is one call per extension, so the providers in this bundle form a
// chain rather than a fan-out. AniList takes the `anime` scope outright and
// hands everything else — including an unscoped search, where TMDB's results
// would only be duplicated — to whoever was already installed.
globalThis.__extension = globalThis.__extension || {};
const anilistPreviousSearch = globalThis.__extension.search;
globalThis.__extension.search = async (args) => {
  if (args && args.category === ANILIST_CATEGORY) return anilistSearch(args);
  if (typeof anilistPreviousSearch !== 'function') return { sections: [] };
  return anilistPreviousSearch(args);
};

// Optional playback-segment lookup for episode items.
//
// IntroDB keys its timestamps by the show's IMDb id. AniSkip keys anime by
// MyAnimeList id, so AniList items are resolved to MAL before querying it.
// This role is deliberately best-effort: missing IDs, an upstream 404, or a
// provider outage must leave playback usable with no segments.

const SKIP_INTRO_PROVIDER_ID = 'nimora.skipintro';
const SKIP_INTRO_TMDB_BASE =
  globalThis.__tmdbBaseUrl || 'https://api.themoviedb.org/3';
const SKIP_INTRO_TMDB_API_KEY =
  globalThis.__tmdbApiKey || '8476a7ab80ad76f0936744df0430e67c';
const SKIP_INTRO_ANILIST_BASE =
  globalThis.__anilistApiUrl || 'https://graphql.anilist.co';
const SKIP_INTRO_INTRODB_BASE =
  globalThis.__introDbBaseUrl || 'https://api.introdb.app';
const SKIP_INTRO_ANISKIP_BASE =
  globalThis.__aniSkipBaseUrl || 'https://api.aniskip.com/v2';

const skipIntroTmdbImdbMemo = new Map();
const skipIntroAniListMalMemo = new Map();

function skipIntroPositiveInteger(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function skipIntroMilliseconds(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function skipIntroSecondsToMilliseconds(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1000)
    : null;
}

function skipIntroInterval(type, startMs, endMs) {
  const start = skipIntroMilliseconds(startMs);
  const end = skipIntroMilliseconds(endMs);
  if (start == null || end == null || end <= start) return null;
  return { type, startMs: start, endMs: end };
}

function skipIntroResponseInterval(type, segment) {
  if (segment == null || typeof segment !== 'object') return null;
  const start = segment.start_ms == null
    ? skipIntroSecondsToMilliseconds(segment.start_sec)
    : skipIntroMilliseconds(segment.start_ms);
  const end = segment.end_ms == null
    ? skipIntroSecondsToMilliseconds(segment.end_sec)
    : skipIntroMilliseconds(segment.end_ms);
  return skipIntroInterval(type, start, end);
}

function skipIntroMapAniSkipType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'op' || type === 'opening' || type === 'mixed-op' || type === 'intro') {
    return 'intro';
  }
  if (type === 'recap') return 'recap';
  if (
    type === 'ed' ||
    type === 'ending' ||
    type === 'mixed-ed' ||
    type === 'outro' ||
    type === 'credits'
  ) {
    return 'outro';
  }
  return null;
}

function skipIntroEpisodeContext(item) {
  if (item == null || typeof item !== 'object' || item.kind !== 'episode') {
    return null;
  }
  const ref = item.ref;
  const episode = item.episode;
  const parentRef = episode && episode.parentRef;
  const seasonMatch = /^season:(\d+)$/.exec(String(episode && episode.groupId || ''));
  const season = seasonMatch == null ? 1 : Number(seasonMatch[1]);
  const episodeNumber = skipIntroPositiveInteger(episode && episode.position);
  if (
    ref == null ||
    typeof ref.providerId !== 'string' ||
    parentRef == null ||
    typeof parentRef.id !== 'string' ||
    episodeNumber == null ||
    !Number.isInteger(season) ||
    season <= 0
  ) {
    return null;
  }

  if (ref.providerId === 'nimora.tmdb') {
    const match = /^series:(\d+)$/.exec(parentRef.id);
    if (match == null) return null;
    return {
      kind: 'tmdb',
      tmdbId: match[1],
      season,
      episode: episodeNumber,
    };
  }

  if (ref.providerId === 'nimora.anilist') {
    const match = /^anilist:media:(\d+)$/.exec(parentRef.id);
    if (match == null) return null;
    return {
      kind: 'anilist',
      anilistId: match[1],
      season,
      episode: episodeNumber,
    };
  }
  return null;
}

async function skipIntroFetchJson(url, options) {
  const response = await fetch(url, options);
  if (response.status < 200 || response.status >= 300) return null;
  try {
    return JSON.parse(response.body);
  } catch (_) {
    return null;
  }
}

function skipIntroQuery(params) {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

async function skipIntroTmdbImdbId(tmdbId) {
  if (skipIntroTmdbImdbMemo.has(tmdbId)) {
    return skipIntroTmdbImdbMemo.get(tmdbId);
  }
  const promise = (async () => {
    const params = skipIntroQuery({
      api_key: SKIP_INTRO_TMDB_API_KEY,
      language: 'en-US',
    });
    const data = await skipIntroFetchJson(
      `${SKIP_INTRO_TMDB_BASE}/tv/${encodeURIComponent(tmdbId)}/external_ids?${params}`,
    );
    const imdbId = data && typeof data.imdb_id === 'string'
      ? data.imdb_id.trim()
      : '';
    return imdbId.startsWith('tt') ? imdbId : null;
  })().catch(() => null);
  skipIntroTmdbImdbMemo.set(tmdbId, promise);
  return promise;
}

async function skipIntroIntroDb(context) {
  const imdbId = await skipIntroTmdbImdbId(context.tmdbId);
  if (imdbId == null) return [];
  const params = skipIntroQuery({
    imdb_id: imdbId,
    season: String(context.season),
    episode: String(context.episode),
  });
  const data = await skipIntroFetchJson(
    `${SKIP_INTRO_INTRODB_BASE}/segments?${params}`,
  );
  if (data == null || typeof data !== 'object') return [];
  return [
    skipIntroResponseInterval('intro', data.intro),
    skipIntroResponseInterval('recap', data.recap),
    skipIntroResponseInterval('outro', data.outro),
  ].filter((segment) => segment != null);
}

async function skipIntroAniListMalId(anilistId) {
  if (skipIntroAniListMalMemo.has(anilistId)) {
    return skipIntroAniListMalMemo.get(anilistId);
  }
  const promise = (async () => {
    const data = await skipIntroFetchJson(SKIP_INTRO_ANILIST_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: 'query ($id: Int) { Media(id: $id, type: ANIME) { idMal } }',
        variables: { id: Number(anilistId) },
      }),
    });
    const idMal = data && data.data && data.data.Media && data.data.Media.idMal;
    return skipIntroPositiveInteger(idMal);
  })().catch(() => null);
  skipIntroAniListMalMemo.set(anilistId, promise);
  return promise;
}

async function skipIntroAniSkip(context) {
  const malId = await skipIntroAniListMalId(context.anilistId);
  if (malId == null) return [];
  const params = [
    ['types[]', 'op'],
    ['types[]', 'ed'],
    ['types[]', 'mixed-op'],
    ['types[]', 'mixed-ed'],
    ['types[]', 'recap'],
    ['episodeLength', '0'],
  ];
  const query = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const data = await skipIntroFetchJson(
    `${SKIP_INTRO_ANISKIP_BASE}/skip-times/${encodeURIComponent(malId)}/${encodeURIComponent(context.episode)}?${query}`,
  );
  const results = data && Array.isArray(data.results) ? data.results : [];
  return results
    .map((result) => {
      const type = skipIntroMapAniSkipType(result && result.skipType);
      const interval = result && result.interval;
      if (type == null || interval == null) return null;
      return skipIntroInterval(
        type,
        skipIntroSecondsToMilliseconds(interval.startTime),
        skipIntroSecondsToMilliseconds(interval.endTime),
      );
    })
    .filter((segment) => segment != null);
}

function skipIntroOverlap(a, b) {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

// Sources disagree, and one source disagrees with itself: AniSkip carries
// several community submissions per episode, so One Piece and Frieren each
// come back with two intros overlapping by half their length, and Attack on
// Titan adds an "outro" sitting in its first two minutes.
//
// Dropping only exact duplicates left all of them standing, and the player
// showed it: skipping to the end of the first intro lands inside the second,
// which still covers that moment and offers the button again — the double
// skip a viewer sees.
//
// Overlap is the tell, so overlap resolves it. Same-type segments that touch
// keep the earliest, since that is where a viewer pressing skip wants to
// leave from. An outro overlapping an intro is dropped outright: a closing
// sequence cannot sit inside an opening one, and mislabelling it that way
// would have the player treat the first minutes as the end of the episode.
function skipIntroMergeSegments(segmentLists) {
  const candidates = segmentLists
    .flat()
    .filter(
      (segment) =>
        segment != null &&
        Number.isFinite(segment.startMs) &&
        Number.isFinite(segment.endMs) &&
        segment.startMs >= 0 &&
        segment.endMs > segment.startMs,
    )
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const kept = [];
  const keepUnlessOverlapping = (segment) => {
    if (kept.some((other) => other.type === segment.type && skipIntroOverlap(other, segment))) {
      return;
    }
    kept.push(segment);
  };

  // Openings and recaps first, so an outro is judged against every intro that
  // survived rather than against whichever happened to be read first.
  for (const segment of candidates) {
    if (segment.type !== 'outro') keepUnlessOverlapping(segment);
  }
  for (const segment of candidates) {
    if (segment.type !== 'outro') continue;
    if (kept.some((other) => other.type === 'intro' && skipIntroOverlap(other, segment))) {
      continue;
    }
    keepUnlessOverlapping(segment);
  }

  kept.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return kept;
}

async function skipIntroSegments(args) {
  const context = skipIntroEpisodeContext(args && args.item);
  if (context == null) return { segments: [] };
  const lookups = context.kind === 'tmdb'
    ? [skipIntroIntroDb(context)]
    : [skipIntroAniSkip(context)];
  const settled = await Promise.all(lookups.map((lookup) => lookup.catch(() => [])));
  return { segments: skipIntroMergeSegments(settled) };
}

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.segments) {
  globalThis.__extension.segments = skipIntroSegments;
}

// Time Soccer TV football highlights catalog and Videa HLS resolver.
//
// The public homepage is a WordPress page whose video cards come from the
// `Video` category. The REST API gives us the same post stream without
// depending on the theme's generated HTML layout. Each post contains a Videa
// iframe; the iframe page carries the actual CDN master playlist.

const TIMESOCCER_BASE =
  globalThis.__timesoccerBaseUrl || 'https://timesoccertv.com';
const TIMESOCCER_PROVIDER_ID = 'nimora.timesoccer';
const TIMESOCCER_PROVIDER_KEY = 'timesoccer';
const TIMESOCCER_CATALOG_ID = 'timesoccer';
const TIMESOCCER_VIDEO_CATEGORY = 4;
const TIMESOCCER_PAGE_SIZE = 20;
const TIMESOCCER_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

function timesoccerWithQuery(url, query) {
  const parts = Object.entries(query).map(
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
  );
  return parts.length > 0 ? `${url}?${parts.join('&')}` : url;
}

function timesoccerDecodeHtml(value) {
  return String(value || '')
    .replace(/&amp;|&#038;/gi, '&')
    .replace(/&quot;|&#034;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&#8211;|&#x2013;/gi, '-')
    .replace(/&#8212;|&#x2014;/gi, '-')
    .replace(/&#([0-9]+);/g, (_, decimal) =>
      String.fromCharCode(Number(decimal)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function timesoccerCleanTitle(value) {
  return timesoccerDecodeHtml(value)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function timesoccerContentOf(post) {
  if (post == null || typeof post !== 'object') return '';
  const content = post.content;
  if (typeof content === 'string') return content;
  if (content != null && typeof content === 'object') {
    return String(content.rendered || content.raw || '');
  }
  return '';
}

function timesoccerEmbedUrlFromHtml(html) {
  const frames = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/ig;
  let match;
  while ((match = frames.exec(html || '')) != null) {
    const url = timesoccerDecodeHtml(match[1]).trim();
    if (/^https?:\/\/[^/]+\/embed\/media\/[A-Za-z0-9-]+(?:[/?#]|$)/i.test(url)) {
      return url;
    }
  }
  return null;
}

function timesoccerHasVideaEmbed(post) {
  return timesoccerEmbedUrlFromHtml(timesoccerContentOf(post)) != null;
}

function timesoccerHlsUrlFromEmbed(html) {
  const decoded = timesoccerDecodeHtml(html);
  const matches = decoded.match(
    /https?:\/\/[^"'<>\\\s]+\.m3u8(?:\?[^"'<>\\\s]*)?/ig,
  );
  if (!matches || matches.length === 0) return null;
  const url = matches[0].trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

function timesoccerArtworkUrl(post) {
  if (post == null || typeof post !== 'object') return null;
  const embedded = post._embedded;
  const media = embedded && embedded['wp:featuredmedia'];
  const sourceUrl = Array.isArray(media) && media[0] && media[0].source_url;
  if (typeof sourceUrl === 'string' && /^https?:\/\//i.test(sourceUrl)) {
    return sourceUrl;
  }
  return null;
}

function timesoccerPostToItem(post) {
  if (post == null || post.id == null) return null;
  if (!timesoccerHasVideaEmbed(post)) return null;
  const title = timesoccerCleanTitle(
    post.title && typeof post.title === 'object'
      ? post.title.rendered
      : post.title,
  );
  if (title.length === 0) return null;

  const item = {
    ref: {
      extensionId: EXTENSION_ID,
      providerId: TIMESOCCER_PROVIDER_ID,
      id: `post:${String(post.id)}`,
    },
    kind: 'video',
    title,
    subtitle: 'Football Highlights',
  };
  const artworkUrl = timesoccerArtworkUrl(post);
  if (artworkUrl != null) item.artwork = { portrait: { url: artworkUrl } };
  return item;
}

function timesoccerPostsToItems(posts) {
  if (!Array.isArray(posts)) return [];
  const seen = new Set();
  const items = [];
  for (const post of posts) {
    const item = timesoccerPostToItem(post);
    if (item == null || seen.has(item.ref.id)) continue;
    seen.add(item.ref.id);
    items.push(item);
  }
  return items;
}

async function timesoccerFetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': TIMESOCCER_USER_AGENT,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Time Soccer request failed: ${response.status}`);
  }
  const data = JSON.parse(response.body);
  if (data == null || typeof data !== 'object') {
    throw new Error('Time Soccer response is not an object');
  }
  return { data, headers: response.headers || {} };
}

function timesoccerResponseHeader(response, name) {
  const headers = response && response.headers;
  if (headers == null || typeof headers !== 'object') return '';
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return String(headers[key] || '');
  }
  return '';
}

function timesoccerHasNextPage(response, page, rawPosts) {
  const totalPages = Number(timesoccerResponseHeader(response, 'x-wp-totalpages'));
  if (Number.isInteger(totalPages) && totalPages > 0) {
    return page < totalPages;
  }
  // WordPress normally sends X-WP-TotalPages. If an intermediary strips it,
  // a full page is still a safe signal to request one more batch; the first
  // short page ends the nested load.
  return Array.isArray(rawPosts) && rawPosts.length >= TIMESOCCER_PAGE_SIZE;
}

async function timesoccerCatalog(query) {
  if (query.category !== 'all' && query.category !== 'sport') {
    return { sections: [] };
  }
  const requestedPage = query.page == null ? 1 : Number(query.page);
  const page = Number.isFinite(requestedPage) && requestedPage > 0
    ? Math.floor(requestedPage)
    : 1;
  const url = timesoccerWithQuery(
    `${TIMESOCCER_BASE}/wp-json/wp/v2/posts`,
    {
      categories: String(TIMESOCCER_VIDEO_CATEGORY),
      per_page: String(TIMESOCCER_PAGE_SIZE),
      page: String(page),
      orderby: 'date',
      order: 'desc',
      _embed: '1',
      _fields: 'id,date,modified,slug,link,title,content,featured_media,_embedded,_links',
    },
  );

  let posts;
  let response;
  try {
    response = await timesoccerFetchJson(url);
    posts = response.data;
  } catch (_) {
    return { sections: [] };
  }
  const items = timesoccerPostsToItems(posts);
  const result = {
    sections: items.length === 0
      ? []
      : [{ id: 'timesoccer-latest', title: 'Football Highlights', items }],
  };
  if (timesoccerHasNextPage(response, page, posts)) {
    result.nextPage = String(page + 1);
  }
  return result;
}

async function timesoccerSources(args) {
  const item = args.item;
  const enabled = args.enabledProviders;
  if (enabled != null && enabled.indexOf(TIMESOCCER_PROVIDER_ID) === -1) {
    return { sources: [] };
  }
  if (item == null || item.ref == null ||
      item.ref.providerId !== TIMESOCCER_PROVIDER_ID) {
    return { sources: [] };
  }
  const itemId = String(item.ref.id || '');
  if (!/^post:\d+$/.test(itemId)) return { sources: [] };
  return {
    sources: [{
      id: `${TIMESOCCER_PROVIDER_KEY}:${itemId.slice('post:'.length)}`,
      label: 'Videa HLS',
      provider: 'Nimora',
      providerId: TIMESOCCER_PROVIDER_ID,
    }],
  };
}

function timesoccerPostIdFromSource(sourceId) {
  const prefix = `${TIMESOCCER_PROVIDER_KEY}:`;
  const value = sourceId.startsWith(prefix)
    ? sourceId.slice(prefix.length)
    : sourceId;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Malformed Time Soccer source id: ${sourceId}`);
  }
  return value;
}

async function timesoccerResolveSource(sourceId) {
  const postId = timesoccerPostIdFromSource(sourceId);
  const postUrl = timesoccerWithQuery(
    `${TIMESOCCER_BASE}/wp-json/wp/v2/posts/${encodeURIComponent(postId)}`,
    { _fields: 'content' },
  );
  const postResponse = await timesoccerFetchJson(postUrl);
  const post = postResponse.data;
  const embedUrl = timesoccerEmbedUrlFromHtml(timesoccerContentOf(post));
  if (embedUrl == null) {
    throw new Error(`Time Soccer post ${postId} has no Videa embed`);
  }

  const embedResponse = await fetch(embedUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': TIMESOCCER_USER_AGENT,
    },
  });
  if (embedResponse.status < 200 || embedResponse.status >= 300) {
    throw new Error(`Videa embed request failed: ${embedResponse.status}`);
  }
  const hlsUrl = timesoccerHlsUrlFromEmbed(embedResponse.body);
  if (hlsUrl == null) throw new Error('Videa embed has no HLS playlist');

  const playlistResponse = await fetch(hlsUrl, {
    headers: {
      Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
      'User-Agent': TIMESOCCER_USER_AGENT,
    },
  });
  if (playlistResponse.status < 200 || playlistResponse.status >= 300) {
    throw new Error(`Videa playlist request failed: ${playlistResponse.status}`);
  }
  const playlist = String(playlistResponse.body || '');
  if (!playlist.includes('#EXTM3U') ||
      !(/#EXT-X-STREAM-INF|#EXTINF/.test(playlist))) {
    throw new Error('Videa response is not a playable HLS playlist');
  }

  // The CDN sample is public and CORS-enabled; returning no forced Referer
  // keeps native iOS HLS from being pushed through an unnecessary request
  // header path. The User-Agent is still forced, though: every request up
  // to here (post, embed, playlist) used the spoofed one above, but the
  // native player's own segment fetches otherwise fall back to the
  // platform default — a mismatch a CDN that treats non-browser clients
  // differently would only start showing once real playback begins, not
  // during this validation fetch.
  return {
    url: hlsUrl,
    headers: { 'User-Agent': TIMESOCCER_USER_AGENT },
    format: 'hls',
    label: 'Videa HLS',
  };
}

globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: TIMESOCCER_CATALOG_ID,
  catalog: timesoccerCatalog,
});

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: TIMESOCCER_PROVIDER_KEY,
  sources: timesoccerSources,
  resolve: (sourceId) => timesoccerResolveSource(sourceId),
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.catalog) {
  globalThis.__extension.catalog = async (query) => {
    const provider = globalThis.__catalogProviders.find(
      (entry) => entry.catalogId === query.catalogId,
    );
    if (!provider) {
      throw new Error(`No catalog provider registered for "${query.catalogId}"`);
    }
    return provider.catalog(query);
  };
}
if (!globalThis.__extension.sources) {
  globalThis.__extension.sources = async (args) => {
    const calls = globalThis.__streamProviders.map((provider) =>
      Promise.resolve()
        .then(() => provider.sources(args))
        .catch(() => ({ sources: [] })),
    );
    if (args.fast !== true) {
      const perProvider = await Promise.all(calls);
      return { sources: perProvider.flatMap((result) => result.sources) };
    }
    return new Promise((resolve) => {
      let remaining = calls.length;
      let returned = false;
      for (const call of calls) {
        call.then((result) => {
          if (returned) return;
          const sources = Array.isArray(result.sources) ? result.sources : [];
          if (sources.length > 0) {
            returned = true;
            resolve({ sources });
            return;
          }
          remaining -= 1;
          if (remaining === 0) resolve({ sources: [] });
        });
      }
    });
  };
  globalThis.__extension.resolve = async (args) => {
    const sourceId = args.sourceId;
    const separator = sourceId.indexOf(':');
    if (separator < 0) throw new Error(`Malformed source id: ${sourceId}`);
    const providerKey = sourceId.slice(0, separator);
    const provider = globalThis.__streamProviders.find(
      (entry) => entry.providerKey === providerKey,
    );
    if (!provider) {
      throw new Error(`No stream provider registered for "${providerKey}"`);
    }
    return provider.resolve(sourceId);
  };
}
