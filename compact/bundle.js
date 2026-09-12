globalThis.__nimoraExtensionId = 'nimora.compact';
// Football fixtures catalog, as a JS extension.
//
// Sourced from FotMob's daily match feed for schedule and live status. A small
// set of provider-only contributors may add missing live events, while stream
// providers still resolve the selected event independently.
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
const FOTMOB_LEAGUE_IMAGE_BASE =
  'https://images.fotmob.com/image_resources/logo/leaguelogo/dark';
// FotMob's market list includes youth competitions but omits Saudi Pro League
// for the US market. Keep the Football catalog focused on senior competitions
// and explicitly include the requested Saudi top flight.
const CURATED_INCLUDED_LEAGUE_IDS = new Set(['536']);
const CURATED_EXCLUDED_LEAGUE_IDS = new Set(['9741']);
const CURATED_EXCLUDED_LEAGUE_NAMES = /\bUEFA Youth League\b/i;
const FOTMOB_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const TIME_ZONE = 'Asia/Jakarta';

const EXTENSION_ID = globalThis.__nimoraExtensionId || 'nimora';
const PROVIDER_ID = 'nimora.matches';

// The one catalog this extension declares, and the categories inside it.
// `live` is based on FotMob's match status; `schedule` is the daily match
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

// These durations are deliberately conservative event windows, not claims
// about the exact final whistle or checkered flag. Providers can override
// them when an upstream end time becomes available.
const EVENT_DURATION_MINUTES = [
  { match: /fighting|boxing|ufc|mma|wwe|wrestling|combat|kickboxing/i, minutes: 240 },
  { match: /motorsport|formula\s*1|motogp|nascar|wrc|racing/i, minutes: 210 },
  { match: /american football|nfl/i, minutes: 210 },
  { match: /cricket/i, minutes: 240 },
  { match: /tennis/i, minutes: 180 },
  { match: /basketball|nba|wnba/i, minutes: 150 },
  { match: /volleyball/i, minutes: 135 },
  { match: /badminton|bwf/i, minutes: 120 },
  { match: /football|soccer/i, minutes: 135 },
];
const DEFAULT_EVENT_DURATION_MINUTES = 180;

function eventDurationMinutes(sportName, title) {
  const identity = `${sportName || ''} ${title || ''}`;
  return EVENT_DURATION_MINUTES.find((entry) => entry.match.test(identity))
    ?.minutes || DEFAULT_EVENT_DURATION_MINUTES;
}

function eventSchedule(startsAt, state, sportName, title, explicitEndsAt = null) {
  const startsAtMs = startsAt instanceof Date
    ? startsAt.getTime()
    : typeof startsAt === 'number' ? startsAt : Date.parse(startsAt);
  const explicitEndMs = explicitEndsAt instanceof Date
    ? explicitEndsAt.getTime()
    : typeof explicitEndsAt === 'number'
        ? explicitEndsAt
        : Date.parse(explicitEndsAt);
  const endsAtMs = Number.isFinite(explicitEndMs) && explicitEndMs > startsAtMs
    ? explicitEndMs
    : startsAtMs + eventDurationMinutes(sportName, title) * 60 * 1000;
  return {
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(endsAtMs).toISOString(),
    state,
  };
}

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

function brandingLeagueId(match) {
  return leagueIdKey(match.primaryLeagueId) || leagueIdKey(match.leagueId);
}

function footballLeagueIds(match) {
  return [match.leagueId, match.primaryLeagueId, match.primaryId]
    .map((id) => leagueIdKey(id))
    .filter((id) => id != null);
}

function isCuratedExcludedLeague(match) {
  return footballLeagueIds(match).some((id) => CURATED_EXCLUDED_LEAGUE_IDS.has(id)) ||
    CURATED_EXCLUDED_LEAGUE_NAMES.test(`${match.leagueName || ''}`);
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
        .map((match) => brandingLeagueId(match))
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

// The daily response is `{ leagues: [{ id, primaryId, name, matches: [...] }] }`.
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
        primaryLeagueId: match.primaryLeagueId != null
          ? match.primaryLeagueId
          : (match.primaryId != null ? match.primaryId : league.primaryId),
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
      .flatMap((league) =>
        league == null ? [] : [league.id, league.primaryId],
      )
      .filter((id) => id != null)
      .map((id) => String(id)),
  );
  return matches.filter(
    (match) => {
      if (isCuratedExcludedLeague(match)) return false;
      const ids = footballLeagueIds(match);
      return ids.some((id) =>
        allowedIds.has(id) || CURATED_INCLUDED_LEAGUE_IDS.has(id),
      );
    },
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
  return `${FOTMOB_LEAGUE_IMAGE_BASE}/${key}.png`;
}

function fotmobParticipantsOf(match) {
  const home = match.home;
  const away = match.away;
  const teamName = (team) => team?.name || team?.longName || team?.shortName;
  if (home == null || away == null || teamName(home) == null || teamName(away) == null) {
    return [];
  }
  const side = (team) => {
    const p = { name: teamName(team) };
    const teamId = team.id ?? team.teamId ?? team.team?.id;
    if (teamId != null) p.logo = { url: teamLogoUrl(teamId) };
    if (team.shortName != null) p.shortName = team.shortName;
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
    schedule: eventSchedule(
      kickoffMs(match),
      isMatchLive(match, nowMs) ? 'live' : 'scheduled',
      FOOTBALL.name,
      `${home.name == null ? 'Unknown' : home.name} vs ${
        away.name == null ? 'Unknown' : away.name
      }`,
      match.endsAt || match.endTime || match.status?.endTime,
    ),
  };

  const topClubRating = topClubEditorialRating(match);
  if (topClubRating != null) item.rating = topClubRating;

  if (match.leagueName != null) item.subtitle = match.leagueName;
  const participants = fotmobParticipantsOf(match);
  if (participants.length > 0) item.participants = participants;
  const branding = brandingByLeague?.get(brandingLeagueId(match));
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
  const items = matches
    .map((match) => toMediaItem(match, nowMs, brandingByLeague))
    .filter((item) => item != null);
  return byDateItems(items, nowMs);
}

function byDateItems(items, nowMs) {
  const todayIndex = jakartaDayIndex(nowMs);
  const buckets = new Map();
  const sorted = items
    .map((item) => ({
      item,
      kickoff: Date.parse(item.schedule && item.schedule.startsAt),
    }))
    .filter((entry) => Number.isFinite(entry.kickoff))
    .sort((a, b) => a.kickoff - b.kickoff);
  for (const entry of sorted) {
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
    // The sorted item list already put these in kickoff order; the Map bucket
    // preserves that insertion order, so no second sort is needed here.
    const entries = buckets.get(dayIndex);
    if (entries.length === 0) continue;
    const offset = dayIndex - todayIndex;
    const title =
      offset === 0 ? 'Today'
      : offset === 1 ? 'Tomorrow'
      : offset === -1 ? 'Yesterday'
      : jakartaDateLabel(entries[0].kickoff);
    sections.push({
      id: `date:${dayIndex}`,
      title,
      items: entries.map((entry) => entry.item),
    });
  }
  return sections;
}

// --- catalog navigation ---

const FOOTBALL = { id: 'football', name: 'Football' };
const TENNIS = { id: 'tennis', name: 'Tennis' };
const MOTORSPORT = { id: 'motorsport', name: 'Motorsport' };
const FIGHTING = { id: 'fighting', name: 'Fighting' };
const BADMINTON = { id: 'badminton', name: 'Badminton' };
const BASKETBALL = { id: 'basketball', name: 'Basketball' };
const VOLLEYBALL = { id: 'volleyball', name: 'Volleyball' };
const OTHER_LIVE_SPORTS = {
  id: 'other-live-sports',
  name: 'Other Live Sports',
};

// Keep the Sport page predictable while allowing new upstream categories to
// arrive without creating a new shelf for every spelling or niche sport.
const SPORT_SECTION_ORDER = [
  FOOTBALL,
  TENNIS,
  MOTORSPORT,
  FIGHTING,
  BADMINTON,
  BASKETBALL,
  VOLLEYBALL,
  OTHER_LIVE_SPORTS,
];

function sportIdOf(name) {
  const value = `${name || ''}`.trim().toLowerCase();
  if (value.includes('football') || value.includes('soccer')) {
    return FOOTBALL.id;
  }
  if (value.includes('tennis') || /\batp\b|\bwta\b/.test(value)) {
    return TENNIS.id;
  }
  if (
    value.includes('fighting') ||
    value.includes('boxing') ||
    value.includes('mma') ||
    value.includes('ufc') ||
    value.includes('wwe') ||
    value.includes('wrestling') ||
    value.includes('combat') ||
    value.includes('kickboxing')
  ) {
    return FIGHTING.id;
  }
  if (
    value.includes('motorsport') ||
    value.includes('formula') ||
    value.includes('racing') ||
    value.includes('motogp') ||
    value.includes('nascar') ||
    value.includes('wrc')
  ) {
    return MOTORSPORT.id;
  }
  if (value.includes('badminton') || value.includes('bwf')) {
    return BADMINTON.id;
  }
  if (value.includes('basketball') || /\bnba\b|\bwnba\b/.test(value)) {
    return BASKETBALL.id;
  }
  if (value.includes('volleyball')) return VOLLEYBALL.id;
  return OTHER_LIVE_SPORTS.id;
}

function sportNameOf(name) {
  const id = sportIdOf(name);
  return SPORT_SECTION_ORDER.find((sport) => sport.id === id).name;
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

const FOOTBALL_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

function footballNameKey(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(fc|afc|cf|sc|ac|cd)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AMBIGUOUS_FOOTBALL_NAMES = new Set([
  'united', 'city', 'town', 'rovers', 'wanderers', 'albion', 'athletic',
  'county', 'real', 'atletico', 'sporting', 'dynamo', 'racing', 'olympique',
]);

const FOOTBALL_NAME_ALIASES = new Map([
  ['atleti', 'atletico madrid'],
  ['barca', 'barcelona'],
  ['birmingham', 'birmingham city'],
  ['derby', 'derby county'],
  ['inter', 'internazionale'],
  ['juve', 'juventus'],
  ['man city', 'manchester city'],
  ['man utd', 'manchester united'],
  ['nottm forest', 'nottingham forest'],
  ['psg', 'paris saint germain'],
  ['qpr', 'queens park rangers'],
  ['spurs', 'tottenham hotspur'],
  ['west brom', 'west bromwich albion'],
  ['west bromwich', 'west bromwich albion'],
  ['wolves', 'wolverhampton wanderers'],
]);

function footballNameMatches(first, second) {
  first = FOOTBALL_NAME_ALIASES.get(first) || first;
  second = FOOTBALL_NAME_ALIASES.get(second) || second;
  if (first === second) return true;
  const shorter = first.length <= second.length ? first : second;
  const longer = first.length <= second.length ? second : first;
  if (
    shorter.length < 5 ||
    AMBIGUOUS_FOOTBALL_NAMES.has(shorter)
  ) {
    return false;
  }
  return longer.startsWith(`${shorter} `) || longer.endsWith(` ${shorter}`);
}

function footballParticipantsMatch(first, second) {
  if (!Array.isArray(first?.participants) ||
      !Array.isArray(second?.participants) ||
      first.participants.length !== 2 ||
      second.participants.length !== 2) {
    return false;
  }
  const firstNames = first.participants.map((participant) =>
    footballNameKey(participant?.name));
  const secondNames = second.participants.map((participant) =>
    footballNameKey(participant?.name));
  return (
    footballNameMatches(firstNames[0], secondNames[0]) &&
    footballNameMatches(firstNames[1], secondNames[1])
  ) || (
    footballNameMatches(firstNames[0], secondNames[1]) &&
    footballNameMatches(firstNames[1], secondNames[0])
  );
}

function sameFootballEvent(first, second) {
  if (!footballParticipantsMatch(first, second)) return false;
  const firstKickoff = Date.parse(first.schedule?.startsAt);
  const secondKickoff = Date.parse(second.schedule?.startsAt);
  return Number.isFinite(firstKickoff) && Number.isFinite(secondKickoff) &&
    Math.abs(firstKickoff - secondKickoff) <= FOOTBALL_DEDUPE_WINDOW_MS;
}

function isFootballEntry(entry) {
  return sportIdOf(entry.sportName || entry.sportId) === FOOTBALL.id;
}

// FotMob remains the canonical metadata source. Provider-only football events
// are appended after it, and any matching provider event is discarded so the
// FotMob title, branding, participants, status, and editorial ranking win.
function footballCatalogItems(
  matches,
  entries,
  nowMs,
  brandingByLeague,
  requireProviderMatch = false,
  knownFotmobMatches = matches,
) {
  let items = matches
    .map((match) => toMediaItem(match, nowMs, brandingByLeague))
    .filter((item) => item != null);
  const knownFotmobItems = knownFotmobMatches
    .map((match) => toMediaItem(match, nowMs, brandingByLeague))
    .filter((item) => item != null);
  if (requireProviderMatch) {
    items = items.filter((item) =>
      entries.some((entry) => sameFootballEvent(item, entry.item)));
  }
  for (const entry of entries.filter(isFootballEntry)) {
    const item = entry.item;
    if (
      item == null ||
      knownFotmobItems.some((existing) => sameFootballEvent(existing, item)) ||
      items.some((existing) => sameFootballEvent(existing, item))
    ) {
      continue;
    }
    items.push(item);
  }
  return items.sort(
    (first, second) => Date.parse(first.schedule?.startsAt) -
      Date.parse(second.schedule?.startsAt),
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
    schedule: eventSchedule(
      startsAt,
      status === 'live' ? 'live' : 'scheduled',
      event.category || 'Other',
      title,
      event.endsAt || event.endTime,
    ),
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
      const sportName = sportNameOf(event.category || 'Other');
      entries.push({
        sportId: sportIdOf(event.category || 'Other'),
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

async function getFctvSportEntries(nowMs) {
  if (typeof globalThis.__fctvSportEntries !== 'function') return [];
  try {
    return await globalThis.__fctvSportEntries(nowMs);
  } catch (_) {
    return [];
  }
}

async function getRoxieSportEntries(nowMs) {
  if (typeof globalThis.__roxieSportEntries !== 'function') return [];
  try {
    return await globalThis.__roxieSportEntries(nowMs);
  } catch (_) {
    return [];
  }
}

function catalogTitleKey(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bformula one\b|\bf1\b/g, 'formula 1')
    .replace(/\bmoto gp\b/g, 'motogp')
    .trim();
}

function sameProviderEvent(first, second) {
  const firstKickoff = Date.parse(first.item?.schedule?.startsAt);
  const secondKickoff = Date.parse(second.item?.schedule?.startsAt);
  if (!Number.isFinite(firstKickoff) || !Number.isFinite(secondKickoff)) {
    return false;
  }
  const sameTeams = footballParticipantsMatch(first.item, second.item);
  const sameTitle = catalogTitleKey(first.item?.title) ===
    catalogTitleKey(second.item?.title);
  return (sameTeams || sameTitle) &&
    Math.abs(firstKickoff - secondKickoff) <= FOOTBALL_DEDUPE_WINDOW_MS;
}

function providerEntryIsLive(entry, nowMs) {
  if (entry?.live !== true) return false;
  const startsAt = Date.parse(entry.item?.schedule?.startsAt);
  // A provider may refresh its stream flag before refreshing the countdown.
  // Never expose a future item in Live when its start time is known.
  return !Number.isFinite(startsAt) || startsAt <= nowMs;
}

function providerEntryStartMs(entry) {
  const startsAt = Date.parse(entry.item?.schedule?.startsAt);
  return Number.isFinite(startsAt) ? startsAt : null;
}

function normalizeProviderEntry(entry, nowMs) {
  const live = providerEntryIsLive(entry, nowMs);
  const schedule = entry.item?.schedule;
  if (schedule == null) return { ...entry, live };
  return {
    ...entry,
    live,
    item: {
      ...entry.item,
      schedule: {
        ...schedule,
        state: live ? 'live' : 'scheduled',
      },
    },
  };
}

// Provider-backed catalog contributors are merged by event identity. The
// earliest known kickoff wins the displayed metadata, while live status is
// merged so the retained card remains current when providers refresh at
// slightly different times.
function dedupeProviderEntries(entries, nowMs = Date.now()) {
  const result = [];
  for (const entry of entries.map((value) => normalizeProviderEntry(value, nowMs))) {
    const existingIndex = result.findIndex((candidate) =>
      sameProviderEvent(candidate, entry));
    const existing = existingIndex === -1 ? null : result[existingIndex];
    if (existing == null) {
      result.push(entry);
      continue;
    }

    const existingStart = providerEntryStartMs(existing);
    const entryStart = providerEntryStartMs(entry);
    const preferEntry = entryStart != null &&
      (existingStart == null || entryStart < existingStart);
    const merged = preferEntry ? { ...entry } : { ...existing };
    merged.live = existing.live || entry.live;
    if (merged.item?.schedule != null) {
      merged.item = {
        ...merged.item,
        schedule: {
          ...merged.item.schedule,
          state: merged.live ? 'live' : 'scheduled',
        },
      };
    }
    result[existingIndex] = merged;
  }
  return result;
}

function sportsOf(matches, providerEntries) {
  const sports = [];
  const available = new Set();
  if (matches.length > 0) available.add(FOOTBALL.id);
  for (const entry of providerEntries) {
    available.add(sportIdOf(entry.sportName || entry.sportId));
  }
  for (const sport of SPORT_SECTION_ORDER) {
    if (available.has(sport.id)) sports.push(sport);
  }
  return sports;
}

function buildPage(
  query,
  matches,
  providerEntries,
  nowMs,
  brandingByLeague,
  requireLiveProviderMatches = false,
  knownFotmobMatches = matches,
) {
  providerEntries = providerEntries.map((entry) =>
    normalizeProviderEntry(entry, nowMs));
  const selected = query.subCategory == null
    ? null
    : sportIdOf(query.subCategory);
  const subCategories = sportsOf(matches, providerEntries);

  if (selected === FOOTBALL.id) {
    const requireProviderMatch = requireLiveProviderMatches &&
      (query.category === LIVE_CATEGORY || query.category === ALL_CATEGORY);
    const footballProviderEntries = query.category === ALL_CATEGORY
      ? providerEntries.filter((entry) => entry.live)
      : providerEntries;
    return {
      sections: byDateItems(
        footballCatalogItems(
          matches,
          footballProviderEntries,
          nowMs,
          brandingByLeague,
          requireProviderMatch,
          knownFotmobMatches,
        ),
        nowMs,
      ),
      subCategories,
    };
  }

  if (selected != null) {
    const entries = providerEntries.filter(
      (entry) => sportIdOf(entry.sportName || entry.sportId) === selected,
    );
    return {
      sections: entries.length === 0
        ? []
        : [{
            id: `sport:${selected}`,
            title: sportNameOf(entries[0].sportName || entries[0].sportId),
            items: entries.map((e) => e.item),
          }],
      subCategories,
    };
  }

  if (query.category === ALL_CATEGORY) {
    const liveProviderEntries = providerEntries.filter((entry) => entry.live);
    const footballItems = footballCatalogItems(
      matches,
      liveProviderEntries,
      nowMs,
      brandingByLeague,
      requireLiveProviderMatches,
      knownFotmobMatches,
    ).filter((item) => item.schedule?.state === 'live');

    const items = [
      ...footballItems,
      ...providerEntries
        .filter((entry) => entry.live && !isFootballEntry(entry))
        .map((entry) => entry.item),
    ];
    return {
      sections: items.length === 0
        ? []
        : [{ id: 'live', title: 'Live Now', items }],
      subCategories,
    };
  }

  const sections = [];
  const footballItems = footballCatalogItems(
    matches,
    providerEntries,
    nowMs,
    brandingByLeague,
    requireLiveProviderMatches && query.category === LIVE_CATEGORY,
    knownFotmobMatches,
  );
  if (footballItems.length > 0) {
    sections.push({ id: `sport:${FOOTBALL.id}`, title: FOOTBALL.name, items: footballItems });
  }
  for (const sport of subCategories) {
    if (sport.id === FOOTBALL.id) continue;
    const items = providerEntries
      .filter(
        (entry) => sportIdOf(entry.sportName || entry.sportId) === sport.id,
      )
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

  let [matches, popularLeagues, roxieEntries] = await Promise.all([
    fetchFixturesMemo(nowMs),
    fetchPopularLeaguesMemo(),
    getRoxieSportEntries(nowMs),
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
  const knownFotmobMatches = matches;
  if (live) {
    matches = matches.filter((match) => isMatchLive(match, nowMs));
  }

  const brandingByLeague = await leagueBrandingFor(matches);

  let providerEntries = await getCricfySportEntries(nowMs);
  const fctvEntries = await getFctvSportEntries(nowMs);
  providerEntries = dedupeProviderEntries([
    ...providerEntries,
    ...fctvEntries,
    ...roxieEntries,
  ], nowMs);
  if (live) {
    providerEntries = providerEntries.filter((entry) => entry.live);
  }

  return buildPage(
    query,
    matches,
    providerEntries,
    nowMs,
    brandingByLeague,
    true,
    knownFotmobMatches,
  );
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

// Cross-source anime title aliases.
//
// Catalog providers keep a stable source ref, while streaming sites often use
// a different title spelling. Harbor solves that by resolving the ref through
// Anime Relations Mapping (Yuna) and then asking Jikan for MAL's full title
// list. Keep this helper independent from any provider so every source can
// reuse the same cached aliases.

const ANIME_ALIAS_JIKAN_BASE =
  globalThis.__animeAliasJikanBaseUrl || 'https://api.jikan.moe/v4';
const ANIME_ALIAS_ARM_BASE =
  globalThis.__animeAliasArmBaseUrl || 'https://relations.yuna.moe/api/ids';
const ANIME_ALIAS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const animeAliasCache = new Map();
const animeAliasInflight = new Map();

function animeAliasSourceRef(item) {
  const id = item && item.ref && typeof item.ref.id === 'string'
    ? item.ref.id : '';
  let match = /^mal:(?:anime|episode):(\d+)(?::\d+)?$/i.exec(id);
  if (match) return {source: 'mal', id: Number(match[1])};
  match = /^anilist:(?:media|episode):(\d+)(?::\d+)?$/i.exec(id);
  if (match) return {source: 'anilist', id: Number(match[1])};
  match = /^kitsu:(?:anime|episode)?:?(\d+)$/i.exec(id);
  if (match) return {source: 'kitsu', id: Number(match[1])};
  match = /^anidb:(?:anime|episode)?:?(\d+)$/i.exec(id);
  if (match) return {source: 'anidb', id: Number(match[1])};
  return null;
}

function animeAliasBaseTitle(item) {
  const extra = item && item.extra && typeof item.extra === 'object'
    ? item.extra : {};
  const value = extra.seriesTitle || (item && item.subtitle) || (item && item.title);
  return typeof value === 'string' ? value.trim() : '';
}

async function animeAliasJson(url) {
  try {
    const controller = typeof AbortController === 'function'
      ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;
    const response = await fetch(url, controller ? {signal: controller.signal} : undefined);
    if (timer) clearTimeout(timer);
    if (response.status < 200 || response.status >= 300) return null;
    return JSON.parse(response.body);
  } catch (_) {
    return null;
  }
}

async function animeAliasMalId(source, id) {
  if (source === 'mal') return id;
  const url = `${ANIME_ALIAS_ARM_BASE}?source=${encodeURIComponent(source)}&id=${id}`;
  const data = await animeAliasJson(url);
  const mal = Number(data && data.mal);
  return Number.isInteger(mal) && mal > 0 ? mal : null;
}

async function animeAliasTitlesForMal(malId) {
  const data = await animeAliasJson(`${ANIME_ALIAS_JIKAN_BASE}/anime/${malId}`);
  const anime = data && data.data;
  if (!anime || typeof anime !== 'object') return [];
  const titles = [];
  const seen = new Set();
  const add = (value) => {
    const title = typeof value === 'string' ? value.trim() : '';
    if (title && !seen.has(title.toLowerCase())) {
      seen.add(title.toLowerCase());
      titles.push(title);
    }
  };
  add(anime.title_english);
  add(anime.title);
  add(anime.title_japanese);
  for (const entry of Array.isArray(anime.titles) ? anime.titles : []) {
    add(entry && entry.title);
  }
  return titles;
}

async function animeAliasTitles(item) {
  const ref = animeAliasSourceRef(item);
  if (!ref) return [];
  const malId = await animeAliasMalId(ref.source, ref.id);
  return malId == null ? [] : animeAliasTitlesForMal(malId);
}

async function animeTitleVariants(item) {
  const original = animeAliasBaseTitle(item);
  const key = item && item.ref && typeof item.ref.id === 'string'
    ? item.ref.id : `title:${original.toLowerCase()}`;
  const cached = animeAliasCache.get(key);
  if (cached && Date.now() - cached.t < ANIME_ALIAS_TTL_MS) {
    return cached.titles.slice();
  }
  const existing = animeAliasInflight.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const titles = [];
    const seen = new Set();
    const add = (value) => {
      const title = typeof value === 'string' ? value.trim() : '';
      if (title && !seen.has(title.toLowerCase())) {
        seen.add(title.toLowerCase());
        titles.push(title);
      }
    };
    add(original);
    try {
      for (const title of await animeAliasTitles(item)) add(title);
    } catch (_) {}
    const value = titles.length > 0 ? titles : [original];
    animeAliasCache.set(key, {titles: value, t: Date.now()});
    return value.slice();
  })();
  animeAliasInflight.set(key, pending);
  try {
    return await pending;
  } finally {
    animeAliasInflight.delete(key);
  }
}

globalThis.__animeTitleVariants = animeTitleVariants;

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
// Full bundles share this profile with Kora through the global bridge below.
// Compact intentionally omits kora.js, so keep an identical fallback here;
// Cricfy must still match football items when it is the only football source.
const CRICFY_FOOTBALL_PROFILE = globalThis.__nimoraFootballProfile || {
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
    'atl madrid': 'atletico madrid',
    'athletic club': 'athletic bilbao',
    wolves: 'wolverhampton wanderers',
    'west brom': 'west bromwich albion',
    'west bromwich': 'west bromwich albion',
    'deportivo a coruna': 'deportivo la coruna',
  },
  stopTokens: ['fc', 'afc', 'cf', 'sc', 'ac', 'cd', 'club'],
  ambiguousAlone: [
    'united', 'city', 'town', 'rovers', 'wanderers', 'albion', 'athletic',
    'county', 'real', 'atletico', 'sporting', 'dynamo', 'racing', 'olympique',
  ],
};

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

function cricfyResponseHeader(response, wanted) {
  const headers = response && response.headers;
  if (!headers || typeof headers !== 'object') return '';
  const lowerWanted = wanted.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerWanted) return String(headers[key] || '');
  }
  return '';
}

function cricfyManifestFormatFromResponse(response) {
  const contentType = cricfyResponseHeader(response, 'content-type').toLowerCase();
  const body = String(response && response.body ? response.body : '')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (
    contentType.indexOf('mpegurl') !== -1 ||
    contentType.indexOf('m3u8') !== -1 ||
    body.startsWith('#EXTM3U')
  ) {
    return 'hls';
  }
  if (contentType.indexOf('dash+xml') !== -1 || /<MPD(?:\s|>)/i.test(body)) {
    return 'dash';
  }
  return 'other';
}

// Validate the manifest before handing it to the native player. Upstream
// mirrors sometimes return an HTML/502 body at a URL that still looks like a
// playlist; letting that body reach the player produces a misleading
// "missing #EXTM3U" parser error and can make a bad source look playable.
async function cricfyValidatePlaybackManifest(url, { headers, format }) {
  // Keep ordinary extensionless media (for example MP4 endpoints) on the
  // native path. A URL that advertises itself as a playlist is cheap to probe,
  // and its response gives us the authoritative format without a provider or
  // host-specific exception.
  const shouldProbeExtensionless =
    format === 'other' && /(?:^|[\/_-])playlist(?:[\/?#_-]|$)/i.test(url);
  if (format === 'other' && !shouldProbeExtensionless) return format;
  const response = await fetch(url, { headers });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Playback manifest request failed: ${response.status}`);
  }
  const detected =
    format === 'other' ? cricfyManifestFormatFromResponse(response) : format;
  const body = String(response.body || '').trim();
  if (detected === 'hls' && !body.startsWith('#EXTM3U')) {
    throw new Error('Playback response is not an HLS playlist');
  }
  if (detected === 'dash' && !/<MPD(?:\s|>)/i.test(body)) {
    throw new Error('Playback response is not a DASH manifest');
  }
  return detected;
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
  const validatedFormat = await cricfyValidatePlaybackManifest(finalSplit.url, {
    headers: merged,
    format,
  });

  return {
    url: finalSplit.url,
    headers: merged,
    format: validatedFormat,
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

  // A shared catalog card may keep Roxie's or another provider's stable id.
  // Generic events such as Formula 1 have no participants, so recover the
  // Cricfy event by its canonical catalog title before declining the item.
  const titleKey = typeof catalogTitleKey === 'function'
    ? catalogTitleKey
    : (value) => String(value || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\bformula one\b|\bf1\b/g, 'formula 1')
        .replace(/\bmoto gp\b/g, 'motogp')
        .trim();
  const itemTitle = titleKey(item.title);
  if (itemTitle.length > 0) {
    const event = events.find((candidate) =>
      titleKey(candidate.eventName) === itemTitle);
    if (event) {
      try {
        return { sources: await cricfySourcesForEvent(event) };
      } catch (_) {
        return { sources: [] };
      }
    }
  }

  if (!item.participants || item.participants.length !== 2) return { sources: [] };
  const candidates = cricfyCandidatesFrom(events);
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
    { profile: CRICFY_FOOTBALL_PROFILE },
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

// Jikan/MAL anime catalogue helpers.
//
// The highlights catalogue owns the row layout, while this file owns the
// anime data source. Jikan is a read-only wrapper around MyAnimeList data, so
// the catalogue deliberately exposes MAL identities and does not copy any
// third-party rating into the protocol item.

const JIKAN_BASE = globalThis.__jikanBaseUrl || 'https://api.jikan.moe/v4';
const JIKAN_PROVIDER_ID = 'nimora.jikan';
const JIKAN_PER_PAGE = 25;
const JIKAN_HOME_PAGES = Number.isInteger(globalThis.__jikanHomePages)
  ? globalThis.__jikanHomePages
  : 1;
const JIKAN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const JIKAN_CACHE_STORAGE_KEY = 'nimora.jikan.catalog.v1';
const JIKAN_MIN_INTERVAL_MS = 400;
const JIKAN_MAX_ATTEMPTS = 4;

const jikanCache = new Map();
const jikanInflight = new Map();
let jikanQueue = Promise.resolve();
let jikanNextRequestAt = 0;

function jikanStorage() {
  return typeof host === 'object' && host !== null && host.storage
    ? host.storage : null;
}

function jikanRestoreCache() {
  const storage = jikanStorage();
  if (storage === null) return;
  let raw;
  try { raw = storage.read(JIKAN_CACHE_STORAGE_KEY); } catch (_) { return; }
  if (typeof raw !== 'string' || raw.length === 0) return;
  try {
    const entries = JSON.parse(raw);
    if (!entries || typeof entries !== 'object') return;
    const now = Date.now();
    for (const [url, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object' || entry.value == null) continue;
      if (!Number.isFinite(entry.t) || now - entry.t >= JIKAN_CACHE_TTL_MS) continue;
      jikanCache.set(url, {value: entry.value, t: entry.t});
    }
  } catch (_) {}
}

function jikanPersistCache() {
  const storage = jikanStorage();
  if (storage === null) return;
  const now = Date.now();
  const entries = {};
  for (const [url, entry] of jikanCache) {
    if (!entry || now - entry.t >= JIKAN_CACHE_TTL_MS) continue;
    entries[url] = entry;
  }
  try {
    storage.write(
      JIKAN_CACHE_STORAGE_KEY,
      JSON.stringify(entries),
      JIKAN_CACHE_TTL_MS,
    );
  } catch (_) {}
}

function jikanDelay(milliseconds) {
  // QuickJS hosts do not currently expose a timer primitive. Keep the queue
  // compatible there and still use real spacing on hosts that do provide one.
  if (typeof setTimeout !== 'function') return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

jikanRestoreCache();

function jikanUrl(path, query) {
  const params = Object.entries(query || {})
    .filter(([, value]) => value != null && String(value).length > 0)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${JIKAN_BASE}${path}${params ? `?${params}` : ''}`;
}

async function jikanQueuedFetch(url) {
  const previous = jikanQueue;
  let release;
  jikanQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  const wait = Math.max(0, jikanNextRequestAt - Date.now());
  if (wait > 0) await jikanDelay(wait);
  jikanNextRequestAt = Date.now() + JIKAN_MIN_INTERVAL_MS;
  try {
    return await fetch(url);
  } finally {
    release();
  }
}

async function jikanJson(path, query) {
  const url = jikanUrl(path, query);
  const cached = jikanCache.get(url);
  if (cached && Date.now() - cached.t < JIKAN_CACHE_TTL_MS) return cached.value;
  const existing = jikanInflight.get(url);
  if (existing) return existing;

  const pending = (async () => {
    for (let attempt = 0; attempt < JIKAN_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await jikanQueuedFetch(url);
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt + 1 < JIKAN_MAX_ATTEMPTS) {
          await jikanDelay(response.status === 429
            ? 1000 * (2 ** attempt)
            : 500 * (2 ** attempt));
          continue;
        }
        if (response.status < 200 || response.status >= 300) break;
        const value = JSON.parse(response.body);
        jikanCache.set(url, { value, t: Date.now() });
        jikanPersistCache();
        return value;
      } catch (_) {
        if (attempt + 1 < JIKAN_MAX_ATTEMPTS) {
          await jikanDelay(500 * (2 ** attempt));
          continue;
        }
      }
    }
    // Jikan can lose its connection to MAL while its own API remains up.
    // Keep the last successful catalogue usable instead of hiding the row.
    const stale = jikanCache.get(url);
    return stale ? stale.value : null;
  })();
  jikanInflight.set(url, pending);
  try {
    return await pending;
  } finally {
    jikanInflight.delete(url);
  }
}

function jikanTitle(anime) {
  return anime.title_english || anime.title || anime.title_japanese || 'Untitled';
}

function jikanYear(anime) {
  const direct = Number(anime.year);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const match = /^(\d{4})/.exec(String(anime.aired && anime.aired.from || ''));
  return match == null ? null : Number(match[1]);
}

function jikanPoster(anime) {
  const images = anime.images || {};
  const webp = images.webp || {};
  const jpg = images.jpg || {};
  return webp.large_image_url || jpg.large_image_url ||
    webp.image_url || jpg.image_url || null;
}

function jikanKind(anime) {
  return String(anime.type || '').toUpperCase() === 'MOVIE' ? 'video' : 'series';
}

function jikanRefId(malId) {
  return `mal:anime:${malId}`;
}

function jikanToMediaItem(anime) {
  const malId = Number(anime.mal_id);
  const item = {
    ref: {
      extensionId: EXTENSION_ID,
      providerId: JIKAN_PROVIDER_ID,
      id: jikanRefId(malId),
    },
    kind: jikanKind(anime),
    title: jikanTitle(anime),
  };
  const year = jikanYear(anime);
  if (year != null) item.releaseYear = year;
  const poster = jikanPoster(anime);
  if (poster) item.artwork = { portrait: { url: poster } };
  return item;
}

async function jikanCatalogue(path, query) {
  const out = [];
  const seen = new Set();
  const pages = Math.max(1, JIKAN_HOME_PAGES);
  for (let page = 1; page <= pages; page += 1) {
    const payload = await jikanJson(path, {
      ...query,
      page,
      limit: JIKAN_PER_PAGE,
    });
    const data = payload && Array.isArray(payload.data) ? payload.data : [];
    for (const anime of data) {
      const malId = Number(anime && anime.mal_id);
      if (!Number.isInteger(malId) || malId < 1 || seen.has(malId)) continue;
      seen.add(malId);
      out.push(jikanToMediaItem(anime));
    }
  }
  return out.slice(0, 60);
}

// These match Harbor's Home rows. Jikan has no standalone trending feed, so
// the closest stable MAL equivalent is the highest-ranked currently airing
// catalogue.
async function jikanTrendingAnime() {
  return jikanCatalogue('/top/anime', { filter: 'airing', sfw: 'true' });
}

async function jikanNewAnimeRelease() {
  return jikanCatalogue('/anime', {
    order_by: 'start_date',
    sort: 'desc',
    status: 'airing',
    min_score: 6,
    sfw: 'true',
  });
}

async function jikanPopularAnime() {
  return jikanCatalogue('/top/anime', { filter: 'bypopularity', sfw: 'true' });
}

async function jikanUpcomingAnime() {
  return jikanCatalogue('/seasons/upcoming', { sfw: 'true' });
}

function jikanAnimeId(refId) {
  const match = /^mal:anime:(\d+)$/.exec(String(refId || ''));
  return match == null ? null : Number(match[1]);
}

function jikanEpisodeRefId(malId, position) {
  return `mal:episode:${malId}:${position}`;
}

function jikanEpisodeGuide(anime) {
  const total = Number(anime.episodes);
  if (jikanKind(anime) !== 'series' || !Number.isInteger(total) || total < 1) return null;
  const episodes = [];
  for (let position = 1; position <= total; position += 1) {
    episodes.push({
      ref: {
        extensionId: EXTENSION_ID,
        providerId: JIKAN_PROVIDER_ID,
        id: jikanEpisodeRefId(anime.mal_id, position),
      },
      title: `Episode ${position}`,
      position,
    });
  }
  return { groups: [{ id: 'season:1', title: 'Episodes', episodes }] };
}

async function jikanMeta(args) {
  const malId = jikanAnimeId(args && args.ref && args.ref.id);
  if (malId == null) throw new Error(`Not a Jikan ref id: ${args && args.ref && args.ref.id}`);
  const payload = await jikanJson(`/anime/${malId}`, {});
  const anime = payload && payload.data;
  if (!anime) throw new Error(`Jikan has no anime ${malId}`);
  const detail = { item: { ...jikanToMediaItem(anime), ref: args.ref } };
  if (typeof anime.synopsis === 'string' && anime.synopsis.trim()) {
    detail.description = anime.synopsis.trim();
  }
  if (Array.isArray(anime.genres)) {
    const tags = anime.genres
      .map((genre) => genre && genre.name)
      .filter((name) => typeof name === 'string' && name.length > 0);
    if (tags.length > 0) detail.tags = tags;
  }
  const guide = jikanEpisodeGuide(anime);
  if (guide) detail.episodeGuide = guide;
  return detail;
}

globalThis.__jikanTrendingAnime = jikanTrendingAnime;
globalThis.__jikanNewAnimeRelease = jikanNewAnimeRelease;
globalThis.__jikanPopularAnime = jikanPopularAnime;
globalThis.__jikanUpcomingAnime = jikanUpcomingAnime;

globalThis.__metaProviders = globalThis.__metaProviders || [];
globalThis.__metaProviders.push({
  providerId: JIKAN_PROVIDER_ID,
  meta: jikanMeta,
});

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
const TMDB_LEAKS_BASE = globalThis.__flystreamBaseUrl || 'https://flystream.net';
const TMDB_LEAKS_TTL_MS = 15 * 60 * 1000;
const SHEGU_TRAILER_TIMEOUT_MS = 1500;

let tmdbLeaksMemo = null;
const tmdbTitleLogoMemo = new Map();
const TMDB_TITLE_LOGO_CONCURRENCY = 4;

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

// FlyStream's leak feed is metadata enrichment, not a playback source. Keep
// the fetch behind the existing FlyStream cookie/gate when the bundle has
// loaded flystream.js, and keep a direct fallback for isolated unit tests.
async function tmdbFetchLeaks() {
  const url = `${TMDB_LEAKS_BASE}/api/leaks`;
  if (typeof flystreamRequestJson === 'function') {
    return flystreamRequestJson(url);
  }
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (response.status < 200 || response.status >= 300) return null;
    return JSON.parse(response.body);
  } catch (_) {
    return null;
  }
}

const TMDB_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function tmdbDigitalDateFromBody(body, year) {
  if (typeof body !== 'string' || !Number.isInteger(year)) return null;
  const match = /\bon\s+digital\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(body);
  if (match == null) return null;
  const month = TMDB_MONTHS.findIndex(
    (value) => value.toLowerCase() === match[1].toLowerCase(),
  );
  const day = Number(match[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    iso: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    display: `${TMDB_MONTHS[month]} ${day}, ${year}`,
  };
}

function tmdbLeakKey(mediaType, tmdbId) {
  return `${mediaType}:${tmdbId}`;
}

function tmdbLeakIndexFromResponse(data) {
  if (data == null || !Array.isArray(data.items)) return null;
  const index = new Map();
  for (const entry of data.items) {
    if (entry == null || typeof entry !== 'object') continue;
    const mediaType = entry.mediaType === 'movie' || entry.mediaType === 'tv'
      ? entry.mediaType
      : null;
    const tmdbId = Number(entry.tmdbId);
    if (mediaType == null || !Number.isInteger(tmdbId) || tmdbId < 1) continue;
    const key = tmdbLeakKey(mediaType, tmdbId);
    const status = index.get(key) || {
      onDigital: false,
      leak: false,
      digitalDate: null,
    };
    const kind = typeof entry.kind === 'string' ? entry.kind.toLowerCase() : '';
    if (kind === 'digital') status.onDigital = true;
    if (kind === 'leak') status.leak = true;
    if (kind === 'upcoming') {
      const year = Number(entry.year);
      const date = tmdbDigitalDateFromBody(entry.body, year);
      if (
        date != null &&
        (status.digitalDate == null || date.iso < status.digitalDate.iso)
      ) {
        status.digitalDate = date;
      }
    }
    index.set(key, status);
  }
  return index;
}

function tmdbLeakIndex() {
  const now = Date.now();
  if (
    tmdbLeaksMemo != null &&
    now - tmdbLeaksMemo.fetchedAt < TMDB_LEAKS_TTL_MS
  ) {
    return tmdbLeaksMemo.promise;
  }
  const promise = tmdbFetchLeaks()
    .then(tmdbLeakIndexFromResponse)
    .catch(() => null);
  tmdbLeaksMemo = { fetchedAt: now, promise };
  return promise;
}

async function tmdbLeakMetadata(tmdbId, mediaType) {
  const index = await tmdbLeakIndex();
  return index == null ? null : index.get(tmdbLeakKey(mediaType, tmdbId)) || null;
}

function tmdbApplyLeakMetadata(detail, metadata) {
  if (metadata == null) return detail;
  const tags = Array.isArray(detail.tags) ? detail.tags.slice() : [];
  if (metadata.onDigital && !tags.includes('On Digital')) tags.push('On Digital');
  if (metadata.leak && !tags.includes('Leak')) tags.push('Leak');
  if (tags.length > 0) detail.tags = tags;
  if (metadata.digitalDate != null) {
    const facts = Array.isArray(detail.facts) ? detail.facts.slice() : [];
    if (!facts.some((fact) => fact && fact.label === 'Digital release')) {
      facts.push({ label: 'Digital release', value: metadata.digitalDate.display });
    }
    detail.facts = facts;
  }
  return detail;
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
  let timeoutHandle = null;
  try {
    const url = `${SHEGU_TRAILER_BASE}/trailer?tmdb=${encodeURIComponent(tmdbId)}&type=${encodeURIComponent(type)}`;
    // This is optional detail enrichment. Shegu is Cloudflare-fronted, and a
    // 503 from its unavailable upstream must not be misclassified by the
    // generic host detector as a browser challenge. The private header is
    // consumed by the JS host and is never sent to Shegu; a slow/outage
    // response is bounded as well.
    const request = fetch(url, {
      headers: { 'x-qjsr-disable-cloudflare': '1' },
    });
    const response = await Promise.race([
      request,
      new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), SHEGU_TRAILER_TIMEOUT_MS);
      }),
    ]);
    if (timeoutHandle != null) clearTimeout(timeoutHandle);
    if (response == null) return null;
    if (response.status < 200 || response.status >= 300) return null;
    return sheguVideoTrailerFromResponse(JSON.parse(response.body));
  } catch (_) {
    if (timeoutHandle != null) clearTimeout(timeoutHandle);
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
    tags: [mediaType === 'movie' ? 'movie' : 'tv'],
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

function tmdbTitleLogoRequest(mediaType, tmdbId) {
  const key = `${mediaType}:${tmdbId}`;
  const existing = tmdbTitleLogoMemo.get(key);
  if (existing != null) return existing;
  const request = tmdbGetJson(`/${mediaType}/${tmdbId}/images`, {
    include_image_language: 'en,null',
  })
    .then(tmdbTitleLogo)
    .catch(() => null);
  tmdbTitleLogoMemo.set(key, request);
  return request;
}

async function enrichTrendingTitleLogos(results, items, mediaType) {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < results.length) {
      const index = nextIndex++;
      const result = results[index];
      if (result == null || result.id == null) continue;
      const logo = await tmdbTitleLogoRequest(mediaType, result.id);
      if (logo == null) continue;
      items[index].artwork = {
        ...(items[index].artwork || {}),
        logo: { url: `${TMDB_IMAGE_BASE}/w300${logo.file_path}` },
      };
    }
  };
  const workerCount = Math.min(TMDB_TITLE_LOGO_CONCURRENCY, results.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return items;
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
    tags: ['movie'],
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

  // Every Trending item can become a Home hero candidate. Keep the fan-out
  // bounded and memoized so repeated catalog reads do not create an
  // unbounded burst of TMDB requests.
  return enrichTrendingTitleLogos(results, items, mediaType);
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

// Keep the genre set deliberately small. Each entry becomes one horizontal
// row, and a category page should not fan out to every genre TMDB exposes.
const TOP_BY_GENRE = {
  movie: [
    { id: 'action', name: 'Action', tmdbId: 28, minimumVotes: 200 },
    { id: 'comedy', name: 'Comedy', tmdbId: 35, minimumVotes: 200 },
    { id: 'drama', name: 'Drama', tmdbId: 18, minimumVotes: 200 },
    { id: 'horror', name: 'Horror', tmdbId: 27, minimumVotes: 200 },
    { id: 'science_fiction', name: 'Sci-Fi', tmdbId: 878, minimumVotes: 200 },
  ],
  tv: [
    { id: 'action_adventure', name: 'Action & Adventure', tmdbId: 10759, minimumVotes: 100 },
    { id: 'comedy', name: 'Comedy', tmdbId: 35, minimumVotes: 100 },
    { id: 'crime', name: 'Crime', tmdbId: 80, minimumVotes: 100 },
    { id: 'drama', name: 'Drama', tmdbId: 18, minimumVotes: 100 },
    { id: 'science_fiction_fantasy', name: 'Sci-Fi & Fantasy', tmdbId: 10765, minimumVotes: 100 },
  ],
};

async function fetchTopByGenrePage(mediaType, genre, page) {
  return fetchDiscoverPage(mediaType, {
    with_genres: genre.tmdbId,
    sort_by: 'vote_average.desc',
    'vote_count.gte': genre.minimumVotes,
  }, page);
}

async function fetchTopByGenre(mediaType, genre) {
  const page = await fetchTopByGenrePage(mediaType, genre, 1);
  return page.items;
}

function topByGenreGroups(mediaType) {
  const genres = TOP_BY_GENRE[mediaType] || [];
  return genres.map((genre) => ({
    id: `top_by_genre_${mediaType}_${genre.id}`,
    name: `Top By Genre · ${genre.name}`,
    fetch: () => fetchTopByGenre(mediaType, genre),
    fetchPage: async (page) => {
      const result = await fetchTopByGenrePage(mediaType, genre, page);
      return {
        items: result.items,
        nextPage: result.page < result.totalPages ? String(result.page + 1) : null,
      };
    },
  }));
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

// --- "highlights" catalog: horizontal-row sections. The `all` category is
// mixed; movie and tv reuse the same catalog with only their own sections.
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

async function fetchLayarKacaHighlight(category) {
  const page = await fetchLayarKacaHighlightPage(category, null);
  return page.items;
}

async function fetchLayarKacaHighlightPage(category, page) {
  const loader = globalThis.__layarkacaHighlightPage;
  if (typeof loader !== 'function') return {items: []};
  try {
    const result = await loader(category, page);
    return result && Array.isArray(result.items) ? result : {items: []};
  } catch (_) {
    return {items: []};
  }
}

async function fetchSokujaAnimeRanking(rank) {
  const loader = globalThis.__sokujaAnimeRankingItems;
  if (typeof loader !== 'function') return [];
  try {
    const items = await loader(rank);
    return Array.isArray(items) ? items : [];
  } catch (_) {
    return [];
  }
}

async function fetchJikanAnime(loaderName) {
  const loader = globalThis[loaderName];
  if (typeof loader !== 'function') return [];
  try {
    const items = await loader();
    return Array.isArray(items) ? items : [];
  } catch (_) {
    return [];
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
  {
    id: 'trending_anime',
    name: 'Trending Anime',
    fetch: () => fetchJikanAnime('__jikanTrendingAnime'),
  },
  {
    id: 'new_anime_release',
    name: 'New Anime Release',
    fetch: () => fetchJikanAnime('__jikanNewAnimeRelease'),
  },
  {
    id: 'popular_anime',
    name: 'Popular Anime',
    fetch: () => fetchJikanAnime('__jikanPopularAnime'),
  },
  {
    id: 'upcoming_anime',
    name: 'Upcoming Anime',
    fetch: () => fetchJikanAnime('__jikanUpcomingAnime'),
  },
  {
    id: 'top_anime_all_time',
    name: 'Top Anime All Time',
    fetch: () => fetchSokujaAnimeRanking('all'),
  },
  {
    id: 'popular_anime_week',
    name: 'Popular Anime This Week',
    fetch: () => fetchSokujaAnimeRanking('weekly'),
  },
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
    id: 'popular_movie_all_time',
    name: 'Popular Movies',
    fetch: () => fetchPopular('movie'),
    fetchPage: async (page) => {
      const result = await fetchPopularPage('movie', page);
      return {
        items: result.items,
        nextPage: result.page < result.totalPages ? String(result.page + 1) : null,
      };
    },
  },
  {
    id: 'popular_tv_all_time',
    name: 'Popular TV Series',
    fetch: () => fetchPopular('tv'),
    fetchPage: async (page) => {
      const result = await fetchPopularPage('tv', page);
      return {
        items: result.items,
        nextPage: result.page < result.totalPages ? String(result.page + 1) : null,
      };
    },
  },
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
  {
    id: 'layarkaca_movies',
    name: 'Movies on LK21',
    fetch: () => fetchLayarKacaHighlight('movie'),
    fetchPage: (page) => fetchLayarKacaHighlightPage('movie', page),
  },
  {
    id: 'layarkaca_tv',
    name: 'TV Series on LK21',
    fetch: () => fetchLayarKacaHighlight('tv'),
    fetchPage: (page) => fetchLayarKacaHighlightPage('tv', page),
  },
  ...POPULAR_COUNTRY_SHELVES.map((country) => ({
    id: `popular_${country.id}`,
    name: popularCountryTitle(country),
    fetch: () => fetchPopularCountry(country),
    fetchPage: (page) => fetchPopularCountryPage(country, page),
  })),
  { id: 'rotten_tomatoes_best', name: 'Rotten Tomatoes Best of All Time', fetch: () => fetchSheguList('rotten-tomatoes-best-of-all-time') },
  { id: 'based_on_true_story', name: 'Based On True Story', fetch: () => fetchSheguList('based-on-a-true-story') },
  { id: 'oscar_nominees', name: 'Oscar Nominees', fetch: () => fetchSheguList('oscar-nominees-best-picture') },
  { id: 'cannes', name: 'Cannes Film Festival', fetch: () => fetchSheguList('cannes-film-festival') },
];

// These are the shelves from the mixed Home catalog that have an unambiguous
// movie or TV identity. Mixed rows such as Popular Today, Coming Soon, and
// country rankings stay on `all` until they have a category-specific fetch.
const CATEGORY_HIGHLIGHT_IDS = {
  movie: [
    'trending_movie',
    'top_rated_movie',
    'popular_movie_all_time',
    'netflix_movies',
    'hulu_movies',
    'disney_movies',
    'prime_movies',
    'hbo_movies',
    'appletv_movies',
    'layarkaca_movies',
    'rotten_tomatoes_best',
    'based_on_true_story',
    'oscar_nominees',
    'cannes',
    'top_by_genre',
  ],
  tv: [
    'trending_tv',
    'top_rated_tv',
    'popular_tv_all_time',
    'netflix_tv',
    'disney_tv',
    'appletv_tv',
    'prime_tv',
    'hbo_tv',
    'layarkaca_tv',
    'top_by_genre',
  ],
};

function highlightGroupsForCategory(category) {
  if (category === TMDB_ALL_CATEGORY) return HIGHLIGHT_GROUPS;
  const ids = CATEGORY_HIGHLIGHT_IDS[category];
  if (!Array.isArray(ids)) return [];
  const groups = [];
  for (const id of ids) {
    if (id === 'top_by_genre') {
      groups.push(...topByGenreGroups(category));
      continue;
    }
    const group = HIGHLIGHT_GROUPS.find((entry) => entry.id === id);
    if (group != null) groups.push(group);
  }
  return groups;
}

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
  const groups = highlightGroupsForCategory(query.category);
  if (groups.length === 0) return { sections: [] };
  const subCategories = groups.map((g) => ({ id: g.id, name: g.name }));

  if (query.subCategory != null) {
    const matched = groups.find((g) => g.id === query.subCategory);
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
    groups.map((g) => fetchGroup(g.name, g.fetch)),
  );
  return {
    sections: groups.map((group, index) => ({
      id: group.id,
      title: group.name,
      items: itemGroups[index],
    })).filter((section) => section.items.length > 0),
    subCategories,
  };
}

// --- catalog: no sections, no subCategories — just the popularity-sorted
// discover feed, straight from the API, paginated for infinite scroll. Named
// curated lists live on the row-based `highlights` catalog above; this
// `movie`/`tv` catalog remains a single flat, ungrouped list for the grid.

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
  const [leakMetadata, previewResponse, recommendations, collection] = await Promise.all([
    tmdbLeakMetadata(tmdbId, 'movie'),
    sheguVideoTrailer(tmdbId, 'movie'),
    tmdbRecommendationsOf(tmdbId, 'movie'),
    tmdbCollectionOf(collectionId),
  ]);
  tmdbApplyLeakMetadata(detail, leakMetadata);
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
  const [leakMetadata, previewResponse, recommendations] = await Promise.all([
    tmdbLeakMetadata(tmdbId, 'tv'),
    sheguVideoTrailer(tmdbId, 'tv'),
    tmdbRecommendationsOf(tmdbId, 'tv'),
  ]);
  tmdbApplyLeakMetadata(detail, leakMetadata);
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

// UEFA Champions League Storyteller stories exposed as Shorts.
//
// Storyteller returns a story containing several pages. Only video pages are
// useful to the Shorts player, so each video page becomes one independent
// preview item while keeping the API's story/page order.

const UEFA_STORYTELLER_BASE =
  globalThis.__uefaStorytellerBaseUrl || 'https://api.usestoryteller.com';
const UEFA_STORYTELLER_API_KEY =
  globalThis.__uefaStorytellerApiKey ||
  'bcd199d7-77df-4e23-8035-e3542d56ebb4';
const UEFA_STORYTELLER_CATEGORY = 'ucl-top-stories';
const UEFA_STORYTELLER_CLIENT_VERSION = '10.13.12';
const UEFA_STORYTELLER_PROVIDER_ID = 'nimora.uefa';
const UEFA_STORYTELLER_CATALOG_ID = 'uefa_shorts';
const UEFA_STORYTELLER_CACHE_TTL_MS = 5 * 60 * 1000;
const UEFA_STORYTELLER_MAX_ITEMS = 20;
const UEFA_SITE_URL = 'https://www.uefa.com/';
const UEFA_STORYTELLER_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

let uefaStorytellerMemo = null;

function uefaStorytellerUrl() {
  const query = {
    categories: UEFA_STORYTELLER_CATEGORY,
    ClientPlatform: 'Web',
    ClientVersion: UEFA_STORYTELLER_CLIENT_VERSION,
    'userAttributes[locale]': 'en',
    'x-storyteller-api-key': UEFA_STORYTELLER_API_KEY,
  };
  const encoded = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${UEFA_STORYTELLER_BASE}/api/app/story/stories/default?${encoded}`;
}

function uefaStorytellerHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

function uefaStorytellerText(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function uefaStorytellerCleanTitle(value) {
  return uefaStorytellerText(value)
    .replace(/^UCL(?:\s+\d{4}\/\d{2})?\s*-\s*/i, '')
    .replace(/\s*-\s*EN$/i, '')
    .trim();
}

function uefaStorytellerTitleHasClip(value) {
  return /\bclips?\b/i.test(uefaStorytellerText(value));
}

function uefaStorytellerIsCuratedStory(story) {
  const title = uefaStorytellerCleanTitle(uefaStorytellerDisplayTitle(story));
  if (!title || uefaStorytellerTitleHasClip(title)) return false;
  return ![
    /\bquiz\b/i,
    /\bfantasy\b/i,
    /\bpredict(?:s|ion)?\b/i,
    /\bvot(?:e|es|ing)?\b/i,
    /\bnominees?\b/i,
    /\bjoin\b/i,
    /\baccess days?\b/i,
    /\bphotoshoot\b/i,
    /\bred carpet\b/i,
    /\bpatches?\b/i,
  ].some((pattern) => pattern.test(title));
}

function uefaStorytellerIsCuratedPage(page) {
  return !uefaStorytellerTitleHasClip(page && page.title);
}

async function uefaStorytellerStories() {
  const nowMs = Date.now();
  if (
    uefaStorytellerMemo != null &&
    nowMs - uefaStorytellerMemo.fetchedAt < UEFA_STORYTELLER_CACHE_TTL_MS
  ) {
    return uefaStorytellerMemo.promise;
  }

  const promise = (async () => {
    const response = await fetch(uefaStorytellerUrl(), {
      headers: {
        Accept: 'application/json',
        Origin: UEFA_SITE_URL,
        Referer: UEFA_SITE_URL,
        'User-Agent': UEFA_STORYTELLER_USER_AGENT,
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`UEFA Storyteller request failed: ${response.status}`);
    }
    const data = JSON.parse(response.body);
    return data != null && Array.isArray(data.stories) ? data.stories : [];
  })().catch(() => []);

  uefaStorytellerMemo = { fetchedAt: nowMs, promise };
  return promise;
}

function uefaStorytellerDisplayTitle(story) {
  const titles = story && story.titles;
  const title = titles && (
    titles.longDisplay || titles.shortDisplay || titles.internal
  );
  return uefaStorytellerText(title || (story && story.title)) ||
    'UEFA Champions League';
}

function uefaStorytellerVideoPages(story) {
  if (story == null || !Array.isArray(story.pages)) return [];
  return story.pages
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => {
      if (page == null || String(page.type || '').toLowerCase() !== 'video') {
        return false;
      }
      const background = page.background;
      return uefaStorytellerHttpUrl(page.url) != null ||
        uefaStorytellerHttpUrl(background && background.url) != null;
    });
}

function uefaStorytellerPageUrl(page) {
  const background = page && page.background;
  return uefaStorytellerHttpUrl(page && page.url) ||
    uefaStorytellerHttpUrl(background && background.url);
}

function uefaStorytellerPageThumbnail(story, page) {
  const background = page && page.background;
  const storyThumbnails = story && story.thumbnails;
  return uefaStorytellerHttpUrl(page && page.playcardUrl) ||
    uefaStorytellerHttpUrl(background && background.playcardUrl) ||
    uefaStorytellerHttpUrl(story && story.thumbnailUrl) ||
    uefaStorytellerHttpUrl(storyThumbnails && (
      storyThumbnails.medium || storyThumbnails.small || storyThumbnails.large
    ));
}

function uefaStorytellerItem(story, page, videoIndex, pageCount) {
  const storyId = story && story.id != null ? String(story.id) : '';
  const pageId = page && page.id != null ? String(page.id) : '';
  if (!uefaStorytellerIsCuratedStory(story) || !uefaStorytellerIsCuratedPage(page)) {
    return null;
  }
  const storyTitle = uefaStorytellerCleanTitle(uefaStorytellerDisplayTitle(story));
  const pageTitle = uefaStorytellerCleanTitle(page && page.title);
  const title = pageTitle || storyTitle || 'UEFA Champions League';
  const item = {
    ref: {
      extensionId: EXTENSION_ID,
      providerId: UEFA_STORYTELLER_PROVIDER_ID,
      id: `story:${storyId}:page:${pageId || videoIndex + 1}`,
    },
    kind: 'video',
    title: pageCount > 1 && !pageTitle
      ? `${title} · Highlight ${videoIndex + 1}`
      : title,
    subtitle: 'UEFA Champions League',
    tags: ['sports', 'football', 'champions-league'],
  };
  const thumbnail = uefaStorytellerPageThumbnail(story, page);
  if (thumbnail != null) item.artwork = { portrait: { url: thumbnail } };
  return item;
}

function uefaStorytellerItems(stories) {
  const seen = new Set();
  const items = [];
  for (const story of stories) {
    if (
      story == null || story.isPublished === false || story.id == null ||
      !uefaStorytellerIsCuratedStory(story)
    ) continue;
    const pages = uefaStorytellerVideoPages(story);
    for (let videoIndex = 0; videoIndex < pages.length; videoIndex++) {
      const page = pages[videoIndex].page;
      const pageId = page.id == null ? String(videoIndex + 1) : String(page.id);
      const key = `${String(story.id)}:${pageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = uefaStorytellerItem(story, page, videoIndex, pages.length);
      if (item != null) items.push(item);
      if (items.length >= UEFA_STORYTELLER_MAX_ITEMS) return items;
    }
  }
  return items;
}

function uefaStorytellerRefParts(ref) {
  const id = ref && typeof ref.id === 'string' ? ref.id : '';
  const match = /^story:([^:]+):page:(.+)$/.exec(id);
  return match == null ? null : { storyId: match[1], pageId: match[2] };
}

async function uefaStorytellerPreview(args) {
  const item = args && args.item;
  if (
    item == null || item.ref == null ||
    item.ref.providerId !== UEFA_STORYTELLER_PROVIDER_ID
  ) {
    return { sources: [] };
  }
  const parts = uefaStorytellerRefParts(item.ref);
  if (parts == null) return { sources: [] };

  const stories = await uefaStorytellerStories();
  for (const story of stories) {
    if (story == null || String(story.id) !== parts.storyId) continue;
    const videoPages = uefaStorytellerVideoPages(story);
    for (let videoIndex = 0; videoIndex < videoPages.length; videoIndex++) {
      const page = videoPages[videoIndex].page;
      const pageId = page.id == null ? String(videoIndex + 1) : String(page.id);
      if (pageId !== parts.pageId) continue;
      const url = uefaStorytellerPageUrl(page);
      if (url == null) return { sources: [] };
      return {
        sources: [{
          id: `preview:uefa:${parts.storyId}:${parts.pageId}`,
          type: 'direct',
          stream: {
            url,
            format: /\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : 'other',
            label: 'UEFA Storyteller',
          },
        }],
      };
    }
  }
  return { sources: [] };
}

async function uefaStorytellerCatalog(query) {
  const stories = await uefaStorytellerStories();
  const items = uefaStorytellerItems(stories);
  return { sections: [{ id: 'uefa', title: 'UEFA Champions League', items }] };
}

globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: UEFA_STORYTELLER_CATALOG_ID,
  catalog: uefaStorytellerCatalog,
});

globalThis.__previewProviders = globalThis.__previewProviders || [];
globalThis.__previewProviders.push({
  providerId: UEFA_STORYTELLER_PROVIDER_ID,
  preview: uefaStorytellerPreview,
});

// Premier League vertical moments from Clipro/Blaze, exposed as Shorts.
//
// The API returns one moment per result. A moment can expose several poster
// and video renditions; prefer its vertical MP4 rendition for the Shorts
// player and keep the URL resolution lazy/session-only.

const CLIPRO_BASE_URL =
  globalThis.__cliproBaseUrl ||
  'https://blazesdk-prod-cdn.clipro.tv';
const CLIPRO_API_KEY =
  globalThis.__cliproApiKey ||
  'b95c92c4952a43a5bc5f7e692c1e3636';
const CLIPRO_PROVIDER_ID = 'nimora.clipro';
const CLIPRO_CATALOG_ID = 'clipro_shorts';
const CLIPRO_FOTMOB_BASE_URL =
  globalThis.__cliproFotmobBaseUrl || 'https://www.fotmob.com';
const CLIPRO_FOTMOB_LEAGUE_ID = '47';
const CLIPRO_FOTMOB_CACHE_TTL_MS = 15 * 60 * 1000;
const CLIPRO_CACHE_TTL_MS = 5 * 60 * 1000;
const CLIPRO_MAX_ITEMS = 20;
const CLIPRO_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

let cliproMomentsMemo = null;
let cliproLabelFiltersMemo = null;

function cliproSeasonCode(value) {
  const match = /^(\d{4})\/(\d{4})$/.exec(String(value || '').trim());
  if (match == null) return null;
  return `${match[1]}${match[2].slice(-2)}`;
}

function cliproRoundNumber(value) {
  const round = Number(value);
  return Number.isInteger(round) && round > 0 ? round : null;
}

function cliproLabelFiltersFromFotmob(data) {
  const season = cliproSeasonCode(data && data.details && data.details.selectedSeason);
  if (season == null) return [];

  const fixtureInfo = data && data.fixtures && data.fixtures.fixtureInfo;
  const activeRound = cliproRoundNumber(
    fixtureInfo && fixtureInfo.activeRound && fixtureInfo.activeRound.roundId,
  );
  const matches = data && data.fixtures && Array.isArray(data.fixtures.allMatches)
    ? data.fixtures.allMatches
    : [];
  const playedRounds = matches
    .filter((match) => {
      const status = match && match.status;
      return status && (status.finished === true || status.ongoing === true);
    })
    .map((match) => cliproRoundNumber(match && match.round))
    .filter((round) => round != null);
  const latestPlayedRound = playedRounds.length === 0
    ? null
    : Math.max(...playedRounds);

  const rounds = new Set();
  if (activeRound != null) rounds.add(activeRound);
  if (latestPlayedRound != null) rounds.add(latestPlayedRound);
  // Once a round is in progress, keep the immediately previous round in the
  // feed during the transition so a sparse new round cannot hide fresh clips.
  if (activeRound != null && latestPlayedRound === activeRound && activeRound > 1) {
    rounds.add(activeRound - 1);
  }
  return [...rounds]
    .sort((a, b) => b - a)
    .map((round) => `${season}-mw${round}`);
}

async function cliproLabelFilters() {
  const nowMs = Date.now();
  if (
    cliproLabelFiltersMemo != null &&
    nowMs - cliproLabelFiltersMemo.fetchedAt < CLIPRO_FOTMOB_CACHE_TTL_MS
  ) {
    return cliproLabelFiltersMemo.promise;
  }

  const promise = (async () => {
    const response = await fetch(
      `${CLIPRO_FOTMOB_BASE_URL}/api/data/leagues?id=${CLIPRO_FOTMOB_LEAGUE_ID}`,
      {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': CLIPRO_USER_AGENT,
        },
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`FotMob Premier League request failed: ${response.status}`);
    }
    return cliproLabelFiltersFromFotmob(JSON.parse(response.body));
  })().catch(() => []);

  cliproLabelFiltersMemo = { fetchedAt: nowMs, promise };
  return promise;
}

function cliproMomentsUrl(labelFilter) {
  const query = {
    ApiKey: CLIPRO_API_KEY,
    clientPlatform: 'Web',
    labelsFilterExpression: labelFilter,
    maxItems: '100',
    labelsPriority: '[]',
  };
  const encoded = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${CLIPRO_BASE_URL}/api/blazesdk/v1.3/moments?${encoded}`;
}

function cliproHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

function cliproIsMp4(rendition) {
  if (rendition == null || typeof rendition !== 'object') return false;
  const fileType = String(rendition.fileType || '').toLowerCase();
  const url = cliproHttpUrl(rendition.url);
  return url != null && (fileType === 'mp4' || /\.mp4(?:[?#]|$)/i.test(url));
}

function cliproIsVertical(rendition) {
  if (rendition == null || typeof rendition !== 'object') return false;
  const aspect = `${rendition.aspectRatio || ''} ${rendition.aspectRatioDescription || ''}`
    .toLowerCase();
  return aspect.includes('vertical') || aspect.includes('9:16');
}

function cliproVideoRendition(moment) {
  const content = moment && moment.baseLayer && moment.baseLayer.content;
  const renditions = content && Array.isArray(content.renditions)
    ? content.renditions.filter(cliproIsMp4)
    : [];
  if (renditions.length === 0) return null;
  return renditions.slice().sort((a, b) => {
    const aVertical = cliproIsVertical(a) ? 0 : 1;
    const bVertical = cliproIsVertical(b) ? 0 : 1;
    if (aVertical !== bVertical) return aVertical - bVertical;
    return Number(b.bitRate || 0) - Number(a.bitRate || 0);
  })[0];
}

function cliproPosterUrl(moment) {
  const poster = moment && moment.poster;
  const posterRendition = poster && poster.rendition;
  const posterUrl = cliproHttpUrl(posterRendition && posterRendition.url);
  if (posterUrl != null) return posterUrl;
  const posterRenditions = poster && Array.isArray(poster.renditions)
    ? poster.renditions
    : [];
  const firstPoster = posterRenditions.find((rendition) =>
    cliproHttpUrl(rendition && rendition.url) != null,
  );
  if (firstPoster != null) return cliproHttpUrl(firstPoster.url);

  const thumbnails = moment && Array.isArray(moment.thumbnails)
    ? moment.thumbnails
    : [];
  const preferred = thumbnails.find((thumbnail) => {
    const rendition = thumbnail && thumbnail.rendition;
    return cliproIsVertical(rendition) && cliproHttpUrl(rendition.url) != null;
  }) || thumbnails.find((thumbnail) =>
    cliproHttpUrl(thumbnail && thumbnail.rendition && thumbnail.rendition.url) != null,
  );
  return preferred == null
    ? null
    : cliproHttpUrl(preferred.rendition && preferred.rendition.url);
}

async function cliproMomentsForLabel(labelFilter) {
  const response = await fetch(cliproMomentsUrl(labelFilter), {
    headers: {
      Accept: 'application/json',
      'User-Agent': CLIPRO_USER_AGENT,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Clipro moments request failed: ${response.status}`);
  }
  const data = JSON.parse(response.body);
  return data != null && Array.isArray(data.result) ? data.result : [];
}

async function cliproMoments() {
  const nowMs = Date.now();
  if (
    cliproMomentsMemo != null &&
    nowMs - cliproMomentsMemo.fetchedAt < CLIPRO_CACHE_TTL_MS
  ) {
    return cliproMomentsMemo.promise;
  }

  const promise = (async () => {
    const labels = await cliproLabelFilters();
    const batches = await Promise.all(
      labels.map((label) => cliproMomentsForLabel(label).catch(() => [])),
    );
    const momentsById = new Map();
    for (const batch of batches) {
      for (const moment of batch) {
        if (moment == null || moment.id == null) continue;
        const id = String(moment.id);
        if (!momentsById.has(id)) momentsById.set(id, moment);
      }
    }
    return [...momentsById.values()];
  })().catch(() => []);

  cliproMomentsMemo = { fetchedAt: nowMs, promise };
  return promise;
}

function cliproText(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function cliproMomentItem(moment) {
  if (moment == null || moment.id == null || cliproVideoRendition(moment) == null) {
    return null;
  }
  const title = cliproText(moment.title) || 'Premier League Moment';
  const item = {
    ref: {
      extensionId: EXTENSION_ID,
      providerId: CLIPRO_PROVIDER_ID,
      id: `moment:${String(moment.id)}`,
    },
    kind: 'video',
    title,
    subtitle: 'Premier League',
    tags: ['sports', 'football', 'premier-league'],
  };
  const poster = cliproPosterUrl(moment);
  if (poster != null) item.artwork = { portrait: { url: poster } };
  return item;
}

function cliproMomentTimestamp(moment) {
  if (moment == null) return null;
  const value = moment.createTime || moment.updateTime;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function cliproCuratedMoments(moments) {
  if (!Array.isArray(moments)) return [];
  const seen = new Set();
  const candidates = [];
  moments.forEach((moment, index) => {
    const item = cliproMomentItem(moment);
    if (item == null || seen.has(item.ref.id)) return;
    seen.add(item.ref.id);
    candidates.push({ moment, index });
  });
  candidates.sort((a, b) => {
    const aDate = cliproMomentTimestamp(a.moment);
    const bDate = cliproMomentTimestamp(b.moment);
    if (aDate != null && bDate == null) return -1;
    if (aDate == null && bDate != null) return 1;
    if (aDate != null && bDate != null && aDate !== bDate) {
      return bDate - aDate;
    }
    return a.index - b.index;
  });
  return candidates.slice(0, CLIPRO_MAX_ITEMS).map(({ moment }) => moment);
}

function cliproMomentItems(moments) {
  return cliproCuratedMoments(moments)
    .map((moment) => cliproMomentItem(moment))
    .filter((item) => item != null);
}

function cliproMomentIdFromItem(item) {
  const id = item && item.ref && item.ref.id;
  const prefix = 'moment:';
  if (
    item == null || item.ref == null ||
    item.ref.providerId !== CLIPRO_PROVIDER_ID ||
    typeof id !== 'string' || !id.startsWith(prefix)
  ) return null;
  const momentId = id.slice(prefix.length);
  return momentId.length === 0 ? null : momentId;
}

async function cliproPreview(args) {
  const item = args && args.item;
  const momentId = cliproMomentIdFromItem(item);
  if (momentId == null) return { sources: [] };

  const moments = await cliproMoments();
  const moment = moments.find((entry) =>
    entry != null && String(entry.id) === momentId,
  );
  const rendition = cliproVideoRendition(moment);
  const url = cliproHttpUrl(rendition && rendition.url);
  if (url == null) return { sources: [] };
  return {
    sources: [{
      id: `preview:clipro:${momentId}`,
      type: 'direct',
      stream: {
        url,
        format: 'other',
        label: 'Premier League Moment',
      },
    }],
  };
}

async function cliproShortsCatalog() {
  const moments = await cliproMoments();
  return {
    sections: [{
      id: 'clipro',
      title: 'Premier League Moments',
      items: cliproMomentItems(moments),
    }],
  };
}

globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: CLIPRO_CATALOG_ID,
  catalog: cliproShortsCatalog,
});

globalThis.__previewProviders = globalThis.__previewProviders || [];
globalThis.__previewProviders.push({
  providerId: CLIPRO_PROVIDER_ID,
  preview: cliproPreview,
});

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

// Sokuja anime catalog and streams. The catalog reads Sokuja's public anime
// pages and its embedded ranking payload; streams still resolve through the
// site's mirror endpoint for Nimora's VOD items.
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
const SOKUJA_CATALOG_ID = 'sokuja';
const SOKUJA_ANIME_CATEGORY = 'anime';
const SOKUJA_CATALOG_ORDERS = [
  { id: 'update', name: 'Latest Updates', order: 'update' },
  { id: 'top', name: 'Top Rated', order: 'score' },
  { id: 'popular', name: 'Most Popular', order: 'popular' },
];
const SOKUJA_CATALOG_PER_PAGE = 24;
const SOKUJA_RANKING_PATH = '/anime/?order=popular';
let sokujaRankingPending = null;
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
  return match == null ? null : sokujaDecodeHtml(match[1]);
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
    const text = sokujaDecodeHtml(card);
    const typeMatch = /\b(TV|Movie|OVA|ONA|Special)\b/i.exec(text);
    const ratingMatch = /★\s*([0-9]+(?:\.[0-9]+)?)/.exec(text);
    const yearMatch = /\b((?:19|20)\d{2})\b/.exec(text);
    results.push({
      title,
      url: href,
      poster,
      type: typeMatch == null ? null : typeMatch[1].toLowerCase(),
      rating: ratingMatch == null ? null : Number(ratingMatch[1]),
      releaseYear: yearMatch == null ? null : Number(yearMatch[1]),
    });
  }
  return results;
}

function sokujaRscArray(html, key) {
  const normalized = String(html || '').replace(/\\"/g, '"');
  const marker = `"${key}"`;
  const markerStart = normalized.lastIndexOf(marker);
  if (markerStart < 0) return [];
  const arrayStart = normalized.indexOf('[', markerStart + marker.length);
  if (arrayStart < 0) return [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = arrayStart; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(normalized.slice(arrayStart, index + 1));
          return Array.isArray(value) ? value : [];
        } catch (_) {
          return [];
        }
      }
    }
  }
  return [];
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

function sokujaMirrorEntries(mirrors) {
  const seen = new Set();
  return (Array.isArray(mirrors) ? mirrors : [])
    .map((mirror) => ({
      url: mirror && typeof mirror.embedUrl === 'string'
        ? mirror.embedUrl.trim()
        : '',
      quality: mirror && typeof mirror.quality === 'string'
        ? mirror.quality.trim()
        : '',
    }))
    .filter((mirror) => /^https?:\/\//i.test(mirror.url))
    .filter((mirror) => !seen.has(mirror.url) && seen.add(mirror.url));
}

function sokujaQualityHeight(value) {
  const match = /(?:^|[^0-9])(\d{3,4})\s*p?(?=$|[^a-z0-9])/i.exec(
    String(value || ''),
  );
  const height = match == null ? NaN : Number(match[1]);
  return Number.isInteger(height) && height > 0 ? height : null;
}

function sokujaVariantEntries(mirrors, headers) {
  const ids = new Set();
  return mirrors.map((mirror, index) => {
    const height = sokujaQualityHeight(mirror.quality);
    const base = height == null ? `mirror-${index + 1}` : `quality-${height}p`;
    let id = base;
    let suffix = 2;
    while (ids.has(id)) id = `${base}-${suffix++}`;
    ids.add(id);
    return {
      id,
      url: mirror.url,
      headers,
      format: /\.m3u8(?:$|\?)/i.test(mirror.url) ? 'hls' : 'other',
      label: mirror.quality || `Sokuja Mirror ${index + 1}`,
      ...(height == null ? {} : {height}),
    };
  });
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

function sokujaPathOf(url) {
  const origin = sokujaOriginOf(url);
  if (origin == null || typeof url !== 'string') return null;
  const path = url.slice(origin.length);
  return path || '/';
}

function sokujaCatalogRefId(result) {
  return `${SOKUJA_PROVIDER_KEY}:anime:${encodeSokujaSource({
    p: sokujaPathOf(result.url),
    t: result.title,
    k: result.type === 'movie' ? 'video' : 'series',
    r: result.rating,
    y: result.releaseYear,
    i: result.poster,
  })}`;
}

function sokujaCatalogRefPayload(refId) {
  const prefix = `${SOKUJA_PROVIDER_KEY}:anime:`;
  if (typeof refId !== 'string' || !refId.startsWith(prefix)) return null;
  const payload = decodeSokujaSource(refId.slice(prefix.length));
  return payload && typeof payload.p === 'string' ? payload : null;
}

function sokujaCatalogItem(result) {
  const item = {
    ref: {
      extensionId: EXTENSION_ID,
      providerId: SOKUJA_PROVIDER_ID,
      id: sokujaCatalogRefId(result),
    },
    kind: result.type === 'movie' ? 'video' : 'series',
    title: result.title,
  };
  if (Number.isInteger(result.releaseYear) && result.releaseYear > 0) {
    item.releaseYear = result.releaseYear;
  }
  if (Number.isFinite(result.rating) && result.rating > 0) item.rating = result.rating;
  if (typeof result.poster === 'string' && result.poster) {
    item.artwork = { portrait: { url: result.poster } };
  }
  return item;
}

function sokujaCatalogOrder(subCategory) {
  if (subCategory == null) return SOKUJA_CATALOG_ORDERS[0];
  return SOKUJA_CATALOG_ORDERS.find((entry) => entry.id === subCategory) || null;
}

function sokujaHasNextPage(html, order, page) {
  const next = Number(page) + 1;
  return new RegExp(
    `(?:page=${next}(?:&|["']|$)|page%3D${next})`,
    'i',
  ).test(html || '') || new RegExp(
    `order=${order}[^"']*page=${next}`,
    'i',
  ).test(html || '');
}

async function sokujaCatalog(query) {
  if (query.category !== SOKUJA_ANIME_CATEGORY) return { sections: [] };
  const subCategories = SOKUJA_CATALOG_ORDERS.map((entry) => ({
    id: entry.id,
    name: entry.name,
  }));
  const selected = sokujaCatalogOrder(query.subCategory);
  if (selected == null) return { sections: [], subCategories };
  const requested = Number(query.page);
  const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
  await sokujaEnsureBase();
  const params = `order=${encodeURIComponent(selected.order)}` +
    (page > 1 ? `&page=${page}` : '');
  const url = `${sokujaActiveBase}/anime/?${params}`;
  const response = await sokujaGet(url, { headers: sokujaHeaders(url) });
  if (response == null) return { sections: [], subCategories };
  const items = sokujaSearchResults(response.body)
    .slice(0, SOKUJA_CATALOG_PER_PAGE)
    .map(sokujaCatalogItem);
  const result = {
    sections: [{ id: selected.id, items }],
    subCategories,
  };
  if (sokujaHasNextPage(response.body, selected.order, page)) {
    result.nextPage = String(page + 1);
  }
  return result;
}

function sokujaDescription(html) {
  const match = /<h2\b[^>]*>\s*Sinopsis[\s\S]*?<\/h2>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(
    html || '',
  );
  return match == null ? '' : sokujaDecodeHtml(match[1]);
}

function sokujaDetailGenres(html) {
  const genres = [];
  const pattern = /<a\b[^>]*href=["'][^"']*\/genre\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html || '')) != null) {
    const genre = sokujaDecodeHtml(match[1]);
    if (genre && genres.indexOf(genre) === -1) genres.push(genre);
  }
  return genres;
}

function sokujaCatalogEpisodeRef(parentPath, episode) {
  return `${SOKUJA_PROVIDER_KEY}:episode:${encodeSokujaSource({
    p: parentPath,
    n: episode,
  })}`;
}

function sokujaCatalogEpisodeGuide(parentRef, html) {
  const entries = sokujaEpisodes(html)
    .map((entry) => ({
      number: Number(entry && entry.episodeNumber),
      slug: entry && entry.slug,
      createdAt: sokujaEpisodeGuideDate(entry && entry.createdAt),
    }))
    .filter((entry) => Number.isInteger(entry.number) && entry.number > 0)
    .filter((entry) => typeof entry.slug === 'string' && entry.slug.length > 0)
    .sort((a, b) => a.number - b.number);
  if (entries.length === 0) return null;
  const parentPath = sokujaPathOf(parentRef.url);
  const episodes = entries.map((entry) => {
    const episode = {
      ref: {
        extensionId: EXTENSION_ID,
        providerId: SOKUJA_PROVIDER_ID,
        id: sokujaCatalogEpisodeRef(parentPath, entry.number),
      },
      title: `Episode ${entry.number}`,
      position: entry.number,
    };
    if (typeof entry.createdAt === 'string' && entry.createdAt) {
      episode.availableAt = entry.createdAt;
    }
    return episode;
  });
  return {
    groups: [{ id: 'season:1', title: 'Episodes', episodes }],
    defaultEpisodeRef: episodes[episodes.length - 1].ref,
  };
}

async function sokujaItemTitleVariants(item, fallback) {
  if (typeof globalThis.__animeTitleVariants !== 'function') return [fallback];
  try {
    const variants = await globalThis.__animeTitleVariants(item);
    return Array.isArray(variants) && variants.length > 0 ? variants : [fallback];
  } catch (_) {
    return [fallback];
  }
}

function sokujaEpisodeGuideDate(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  // Next.js RSC serializes Date values with a `$D` prefix. The extension
  // protocol expects the underlying ISO-8601 UTC timestamp instead.
  const normalized = value.replace(/^\$D(?=\d{4}-)/, '');
  return /^\d{4}-\d{2}-\d{2}T.*Z$/.test(normalized) ? normalized : null;
}

async function sokujaCatalogMeta(args) {
  const payload = sokujaCatalogRefPayload(args && args.ref && args.ref.id);
  if (payload == null) {
    throw new Error(`Not a Sokuja catalog ref id: ${args && args.ref && args.ref.id}`);
  }
  await sokujaEnsureBase();
  const url = sokujaUrl(payload.p);
  const response = await sokujaGet(url, { headers: sokujaHeaders(`${sokujaActiveBase}/`) });
  if (response == null) throw new Error(`Sokuja has no anime ${payload.p}`);
  const heading = sokujaTagText(response.body, 'h1')
    .replace(/\s+subtitle\s+indonesia\s*$/i, '')
    .trim();
  const ref = args.ref;
  const item = {
    ref,
    kind: payload.k === 'video' ? 'video' : 'series',
    title: heading || payload.t || 'Untitled',
  };
  if (Number.isInteger(payload.y) && payload.y > 0) item.releaseYear = payload.y;
  if (Number.isFinite(payload.r) && payload.r > 0) item.rating = payload.r;
  if (typeof payload.i === 'string' && payload.i) {
    item.artwork = { portrait: { url: payload.i } };
  }
  const description = sokujaDescription(response.body);
  const detail = { item };
  if (description) detail.description = description;
  const genres = sokujaDetailGenres(response.body);
  if (genres.length > 0) detail.tags = genres;
  if (item.kind === 'series') {
    const guide = sokujaCatalogEpisodeGuide({ ref, url }, response.body);
    if (guide != null) detail.episodeGuide = guide;
  }
  return detail;
}

function sokujaRankingResult(entry) {
  if (!entry || typeof entry.slug !== 'string' || typeof entry.title !== 'string') {
    return null;
  }
  const poster = entry.thumbnailUrl || entry.coverUrl;
  return {
    title: entry.title.trim(),
    url: sokujaUrl(`/anime/${entry.slug}/`),
    poster: typeof poster === 'string' ? sokujaUrl(poster) : null,
    type: typeof entry.type === 'string' ? entry.type.toLowerCase() : null,
    rating: Number(entry.score),
    releaseYear: Number(entry.year),
  };
}

async function sokujaRankingPayload() {
  if (sokujaRankingPending == null) {
    sokujaRankingPending = (async () => {
      await sokujaEnsureBase();
      const url = sokujaUrl(SOKUJA_RANKING_PATH);
      const response = await sokujaGet(url, { headers: sokujaHeaders(url) });
      if (response == null) return {};
      return {
        weekly: sokujaRscArray(response.body, 'weekly'),
        all: sokujaRscArray(response.body, 'all'),
      };
    })().catch(() => ({}));
  }
  return sokujaRankingPending;
}

async function sokujaAnimeRankingItems(rank) {
  const payload = await sokujaRankingPayload();
  const entries = Array.isArray(payload[rank]) ? payload[rank] : [];
  return entries
    .map(sokujaRankingResult)
    .filter((entry) => entry != null)
    .map(sokujaCatalogItem);
}

globalThis.__sokujaAnimeRankingItems = sokujaAnimeRankingItems;

async function sokujaSearch(args) {
  if (args && args.category != null && args.category !== SOKUJA_ANIME_CATEGORY) {
    return { sections: [] };
  }
  const query = args && args.query;
  if (!query) return { sections: [] };
  const requested = Number(args.page);
  const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
  await sokujaEnsureBase();
  const url = `${sokujaActiveBase}/?s=${encodeURIComponent(query)}&page=${page}`;
  const response = await sokujaGet(url, { headers: sokujaHeaders(url) });
  if (response == null) return { sections: [] };
  const result = { sections: [{ id: 'sokuja-results', items: sokujaSearchResults(response.body).map(sokujaCatalogItem) }] };
  if (sokujaHasNextPage(response.body, '', page)) result.nextPage = String(page + 1);
  return result;
}

globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: SOKUJA_CATALOG_ID,
  catalog: sokujaCatalog,
});

globalThis.__metaProviders = globalThis.__metaProviders || [];
globalThis.__metaProviders.push({
  providerId: SOKUJA_PROVIDER_ID,
  meta: sokujaCatalogMeta,
});

globalThis.__sokujaCatalogActive = true;

globalThis.__extension = globalThis.__extension || {};
const sokujaPreviousSearch = globalThis.__extension.search;
globalThis.__extension.search = async (args) => {
  if (args && (args.category == null || args.category === SOKUJA_ANIME_CATEGORY)) {
    return sokujaSearch(args);
  }
  if (typeof sokujaPreviousSearch !== 'function') return { sections: [] };
  return sokujaPreviousSearch(args);
};

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
  const titleVariants = await sokujaItemTitleVariants(item, query.title);
  let found = null;
  for (const title of titleVariants) {
    found = await sokujaFindAnime(title, query.season, availableAt);
    if (found === SOKUJA_UNREACHABLE) {
      // A mirror that stops answering mid-session is the usual sign it rotated.
      // Re-run discovery once and retry, but only if it named a different host:
      // otherwise this is an outage and the second request buys nothing.
      const stale = sokujaActiveBase;
      sokujaForgetBase();
      const refreshed = await sokujaEnsureBase();
      found = refreshed === stale
        ? null
        : await sokujaFindAnime(title, query.season, availableAt);
    }
    if (found != null && found !== SOKUJA_UNREACHABLE) break;
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

  const entries = sokujaMirrorEntries(mirrors);
  if (entries.length === 0) return {sources: []};
  return {
    sources: [{
      id: `${SOKUJA_PROVIDER_KEY}:${encodeSokujaSource({
        m: entries.map((entry) => ({u: entry.url, q: entry.quality})),
      })}`,
      label: 'Sokuja',
      provider: 'Nimora',
      providerId: SOKUJA_PROVIDER_ID,
    }],
  };
}

async function sokujaResolveSource(sourceId) {
  const prefix = `${SOKUJA_PROVIDER_KEY}:`;
  if (typeof sourceId !== 'string' || !sourceId.startsWith(prefix)) {
    throw new Error(`Invalid Sokuja sourceId: ${sourceId}`);
  }
  const payload = decodeSokujaSource(sourceId.slice(prefix.length));
  if (!payload) {
    throw new Error('Malformed Sokuja source id');
  }
  // Playback can resume from a stored source id in a session where nothing
  // searched Sokuja yet, so the Referer needs its own guarantee of a base.
  await sokujaEnsureBase();
  const entries = Array.isArray(payload.m)
    ? sokujaMirrorEntries(payload.m.map((entry) => ({
        embedUrl: entry && entry.u,
        quality: entry && entry.q,
      })))
    : sokujaMirrorEntries([{
        embedUrl: payload.u,
        quality: payload.q,
      }]);
  if (entries.length === 0) throw new Error('Malformed Sokuja source id');
  const headers = sokujaHeaders(`${sokujaActiveBase}/`);
  const variants = sokujaVariantEntries(entries, headers);
  const primary = variants.slice().sort((a, b) =>
    (a.height || Number.MAX_SAFE_INTEGER) -
    (b.height || Number.MAX_SAFE_INTEGER),
  )[0];
  return {
    url: primary.url,
    format: primary.format,
    headers: primary.headers,
    label: 'Sokuja',
    variants,
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

// Dramadev Dracin series exposed as Shorts and native HLS sources, plus
// stream-only movie matching for TMDB-backed movie items.
//
// Dramadev's stream endpoint returns a short-lived /vmanifest token. The
// manifest is a regular HLS media playlist with relative /v/ MPEG-TS
// segments, so resolution stays lazy and every playback attempt gets a fresh
// token instead of caching a signed media URL.

const DRAMADEV_BASE_URL =
  globalThis.__dramadevBaseUrl || 'https://dramadev.my.id';
const DRAMADEV_PROVIDER_ID = 'nimora.dramadev';
const DRAMADEV_PROVIDER_KEY = 'dramadev';
const DRAMADEV_TMDB_PROVIDER_ID = 'nimora.tmdb';
const DRAMADEV_CATALOG_ID = 'dracin_shorts';
const DRAMADEV_SHORTS_PAGE_LIMIT = 5;
const DRAMADEV_COLLECTIONS = [
  { id: 'dramaverse', title: 'Dramaverse' },
  { id: 'storyreel', title: 'Storyreel' },
];
const DRAMADEV_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

function dramadevBaseUrl() {
  return DRAMADEV_BASE_URL.replace(/\/$/, '');
}

function dramadevUrl(path) {
  if (typeof path !== 'string' || path.trim() === '') return null;
  const value = path.trim();
  if (/^https?:\/\//i.test(value)) return value;
  return value.startsWith('/')
    ? `${dramadevBaseUrl()}${value}`
    : `${dramadevBaseUrl()}/${value}`;
}

function dramadevHeaders(referer) {
  return {
    Accept: 'application/json, text/plain, */*',
    Origin: dramadevBaseUrl(),
    Referer: referer || `${dramadevBaseUrl()}/`,
    'User-Agent': DRAMADEV_USER_AGENT,
  };
}

async function dramadevGet(path, referer) {
  const url = dramadevUrl(path);
  if (url == null) return null;
  try {
    const response = await fetch(url, { headers: dramadevHeaders(referer) });
    if (response.status < 200 || response.status >= 300) return null;
    return response;
  } catch (_) {
    return null;
  }
}

async function dramadevJson(path, referer) {
  const response = await dramadevGet(path, referer);
  if (response == null) return null;
  try { return JSON.parse(response.body); } catch (_) { return null; }
}

function dramadevText(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// Keep title matching conservative. Dramadev's search response does not
// expose a TMDB id or release year, so punctuation/whitespace differences
// are normalized but fuzzy matches are deliberately not accepted.
function dramadevTitleKey(value) {
  return dramadevText(value)
    .toLowerCase()
    .replace(/[\s\-_:,.!?'()[\]{}]+/g, ' ')
    .trim();
}

function dramadevTmdbMovieId(item) {
  const ref = item && item.ref;
  const id = ref && typeof ref.id === 'string' ? ref.id : '';
  const match = /^movie:([^:]+)$/.exec(id);
  if (
    item == null || item.kind !== 'video' ||
    ref == null || ref.providerId !== DRAMADEV_TMDB_PROVIDER_ID ||
    match == null
  ) return null;
  return match[1];
}

async function dramadevMovieSearch(title) {
  const data = await dramadevJson(
    `/search/lookseries?q=${encodeURIComponent(String(title || ''))}`,
    `${dramadevBaseUrl()}/`,
  );
  if (data == null || !Array.isArray(data.items)) return [];
  const wanted = dramadevTitleKey(title);
  const seen = new Set();
  return data.items.filter((item) => {
    if (
      item == null || item.id == null || seen.has(String(item.id)) ||
      dramadevTitleKey(item.title) !== wanted
    ) return false;
    seen.add(String(item.id));
    return true;
  });
}

async function dramadevLookseriesEpisodes(id) {
  const data = await dramadevJson(
    `/episodes/lookseries?id=${encodeURIComponent(String(id))}`,
    `${dramadevBaseUrl()}/`,
  );
  return data && Array.isArray(data.episodes) ? data.episodes : [];
}

function dramadevMoreSeries(data, collectionId) {
  if (data == null || !Array.isArray(data.items)) return [];
  const seen = new Set();
  return data.items.filter((item) => {
    if (item == null || item.id == null || seen.has(String(item.id))) return false;
    if (!dramadevText(item.title)) return false;
    seen.add(String(item.id));
    return true;
  }).map((item) => ({ ...item, collection: collectionId }));
}

function dramadevCollection(collectionId) {
  return DRAMADEV_COLLECTIONS.find((collection) => collection.id === collectionId) ||
    DRAMADEV_COLLECTIONS[0];
}

async function dramadevMorePage(collectionId, page) {
  const requestedPage = Number.isInteger(page) && page > 0 ? page : 1;
  const collection = dramadevCollection(collectionId);
  return dramadevJson(
    `/more/${collection.id}/foryou?page=${requestedPage}`,
    `${dramadevBaseUrl()}/more/${collection.id}/foryou?page=${requestedPage}`,
  );
}

function dramadevEpisodeNumber(episode) {
  const number = Number(episode && (episode.n || episode.ep));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function dramadevEncode(payload) {
  return encodeURIComponent(JSON.stringify(payload));
}

function dramadevDecode(value) {
  try { return JSON.parse(decodeURIComponent(String(value || ''))); } catch (_) { return null; }
}

function dramadevSeriesPayload(series) {
  return {
    id: String(series.id),
    title: dramadevText(series.title) || 'Dramaverse',
    cover: typeof series.cover === 'string' ? series.cover.trim() : '',
    collection: dramadevCollection(series.collection).id,
  };
}

function dramadevSeriesRef(series) {
  return {
    extensionId: EXTENSION_ID,
    providerId: DRAMADEV_PROVIDER_ID,
    id: `${DRAMADEV_PROVIDER_KEY}:series:${dramadevEncode(dramadevSeriesPayload(series))}`,
  };
}

function dramadevSeriesItem(series) {
  const payload = dramadevSeriesPayload(series);
  const item = {
    ref: dramadevSeriesRef(payload),
    kind: 'series',
    title: payload.title,
    subtitle: 'Dramaverse',
    tags: ['dracin', payload.collection],
  };
  if (payload.cover) item.artwork = { portrait: { url: payload.cover } };
  return item;
}

function dramadevEpisodeRef(series, episode) {
  const number = dramadevEpisodeNumber(episode);
  if (number == null) return null;
  return {
    extensionId: EXTENSION_ID,
    providerId: DRAMADEV_PROVIDER_ID,
    id: `${DRAMADEV_PROVIDER_KEY}:episode:${dramadevEncode({
      id: String(series.id),
      ep: String(episode.ep || number),
      n: number,
      collection: dramadevCollection(series.collection).id,
    })}`,
  };
}

function dramadevEpisodeSummary(series, episode) {
  const number = dramadevEpisodeNumber(episode);
  const ref = dramadevEpisodeRef(series, episode);
  if (number == null || ref == null) return null;
  const title = dramadevText(episode && episode.title) || `Episode ${number}`;
  const summary = {
    ref,
    title,
    position: number,
  };
  if (typeof series.cover === 'string' && series.cover.trim()) {
    summary.artwork = { portrait: { url: series.cover.trim() } };
  }
  return summary;
}

function dramadevEpisodePayloadFromRef(ref) {
  const id = ref && typeof ref.id === 'string' ? ref.id : '';
  const prefix = `${DRAMADEV_PROVIDER_KEY}:episode:`;
  if (
    ref == null || ref.providerId !== DRAMADEV_PROVIDER_ID ||
    !id.startsWith(prefix)
  ) return null;
  const payload = dramadevDecode(id.slice(prefix.length));
  return payload && payload.id != null && payload.ep != null && payload.n != null
    ? payload
    : null;
}

function dramadevSeriesPayloadFromRef(ref) {
  const id = ref && typeof ref.id === 'string' ? ref.id : '';
  const prefix = `${DRAMADEV_PROVIDER_KEY}:series:`;
  if (
    ref == null || ref.providerId !== DRAMADEV_PROVIDER_ID ||
    !id.startsWith(prefix)
  ) return null;
  const payload = dramadevDecode(id.slice(prefix.length));
  return payload && payload.id != null ? payload : null;
}

function dramadevSeriesFromPayload(payload) {
  return {
    id: String(payload.id),
    title: dramadevText(payload.title) || 'Dramaverse',
    cover: typeof payload.cover === 'string' ? payload.cover : '',
    collection: dramadevCollection(payload.collection).id,
  };
}

async function dramadevEpisodes(series) {
  const id = encodeURIComponent(String(series.id));
  const collection = dramadevCollection(series.collection);
  const data = await dramadevJson(
    `/episodes/${collection.id}?id=${id}`,
    `${dramadevBaseUrl()}/episodes/${collection.id}?id=${id}`,
  );
  const episodes = data && Array.isArray(data.episodes) ? data.episodes : [];
  return episodes
    .map((episode, index) => ({ episode, index, number: dramadevEpisodeNumber(episode) }))
    .filter((entry) => entry.number != null)
    .sort((a, b) => a.number - b.number || a.index - b.index)
    .map((entry) => dramadevEpisodeSummary(series, entry.episode))
    .filter((item) => item != null);
}

async function dramadevShortsCatalog(query) {
  const requestedPage = Number(query && query.page);
  const page = Number.isInteger(requestedPage) && requestedPage > 0
    ? requestedPage
    : null;
  const firstPage = page || 1;
  const lastPage = page || DRAMADEV_SHORTS_PAGE_LIMIT;
  const sections = await Promise.all(DRAMADEV_COLLECTIONS.map(async (collection) => {
    const pages = [];
    for (let currentPage = firstPage; currentPage <= lastPage; currentPage++) {
      const data = await dramadevMorePage(collection.id, currentPage);
      const series = dramadevMoreSeries(data, collection.id);
      if (series.length === 0) break;
      pages.push(...series);
      if (page != null) break;
    }

    const seen = new Set();
    const items = pages
      .filter((series) => {
        const id = String(series.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map(dramadevSeriesItem);
    return items.length === 0
      ? null
      : { id: `dracin-${collection.id}`, title: collection.title, items };
  }));
  const result = {
    sections: sections.filter((section) => section != null),
  };
  // The endpoint has no total-pages metadata. A non-empty page is the only
  // safe signal available, so direct catalog requests can continue one page
  // at a time while the Shorts preview uses a bounded initial batch above.
  if (page != null && result.sections.length > 0) {
    result.nextPage = String(page + 1);
  }
  return result;
}

function dramadevPayloadFromRef(ref) {
  return dramadevEpisodePayloadFromRef(ref);
}

async function dramadevMeta(args) {
  const payload = dramadevSeriesPayloadFromRef(args && args.ref);
  if (payload == null) throw new Error('Malformed Dramadev series ref');
  const series = dramadevSeriesFromPayload(payload);
  const episodes = await dramadevEpisodes(series);
  const defaultEpisodeRef = episodes.length > 0 ? episodes[0].ref : null;
  const detail = {
    item: dramadevSeriesItem(series),
    tags: ['dracin', series.collection],
  };
  if (episodes.length > 0) {
    detail.episodeGuide = {
      groups: [{ id: 'season:1', title: 'Episodes', episodes }],
      defaultEpisodeRef,
    };
  }
  return detail;
}

function dramadevPayloadFromSourceId(sourceId) {
  const prefix = `${DRAMADEV_PROVIDER_KEY}:`;
  if (typeof sourceId !== 'string' || !sourceId.startsWith(prefix)) return null;
  return dramadevDecode(sourceId.slice(prefix.length));
}

async function dramadevResolvePayload(payload) {
  if (payload == null || payload.id == null) return null;
  let streamPath;
  if (payload.kind === 'movie') {
    streamPath = `/stream/lookseries?id=${encodeURIComponent(String(payload.id))}` +
      '&ep=&n=1';
  } else {
    const collection = dramadevCollection(payload.collection);
    const query = `id=${encodeURIComponent(String(payload.id))}` +
      `&ep=${encodeURIComponent(String(payload.ep))}` +
      `&n=${encodeURIComponent(String(payload.n))}`;
    streamPath = `/stream/${collection.id}?${query}`;
  }
  const stream = await dramadevJson(
    streamPath,
    `${dramadevBaseUrl()}${streamPath}`,
  );
  const manifestUrl = dramadevUrl(stream && stream.video_url);
  if (manifestUrl == null) return null;

  const manifest = await dramadevGet(manifestUrl, `${dramadevBaseUrl()}/`);
  const body = String(manifest && manifest.body || '').trim();
  if (!/^#EXTM3U(?:\s|$)/.test(body) || !/#EXTINF:/i.test(body)) return null;
  if (!/(?:^|\n)\/v\/[^\s\r\n]+/i.test(body)) return null;

  return {
    url: manifestUrl,
    format: 'hls',
    headers: {
      Origin: dramadevBaseUrl(),
      Referer: `${dramadevBaseUrl()}/`,
      'User-Agent': DRAMADEV_USER_AGENT,
    },
    label: 'Dramadev HLS',
  };
}

async function dramadevSources(args) {
  const enabled = args && args.enabledProviders;
  if (enabled != null && enabled.indexOf(DRAMADEV_PROVIDER_ID) === -1) {
    return { sources: [] };
  }
  const item = args && args.item;
  const payload = dramadevPayloadFromRef(item && item.ref);
  if (payload != null && item.kind === 'episode') {
    return {
      sources: [{
        id: `${DRAMADEV_PROVIDER_KEY}:${dramadevEncode(payload)}`,
        label: 'Dramadev HLS',
        provider: 'Nimora',
        providerId: DRAMADEV_PROVIDER_ID,
      }],
    };
  }

  const tmdbId = dramadevTmdbMovieId(item);
  if (tmdbId == null) return { sources: [] };
  const title = dramadevText(item.title);
  if (!title) return { sources: [] };
  const matches = await dramadevMovieSearch(title);
  // The search response has no year/TMDB id. Never guess between duplicate
  // exact titles; offering no source is safer than playing the wrong film.
  if (matches.length !== 1) return { sources: [] };
  const match = matches[0];
  const episodes = await dramadevLookseriesEpisodes(match.id);
  // LookSeries represents a movie as a one-entry playback list. This keeps
  // the stream-only provider from accidentally claiming a TV series.
  if (episodes.length !== 1) return { sources: [] };
  const moviePayload = {
    kind: 'movie',
    id: String(match.id),
    tmdbId,
    title,
  };
  return {
    sources: [{
      id: `${DRAMADEV_PROVIDER_KEY}:${dramadevEncode(moviePayload)}`,
      label: 'Dramadev HLS',
      provider: 'Nimora',
      providerId: DRAMADEV_PROVIDER_ID,
    }],
  };
}

async function dramadevResolveSource(sourceId) {
  const payload = dramadevPayloadFromSourceId(sourceId);
  if (payload == null) throw new Error('Malformed Dramadev source id');
  const stream = await dramadevResolvePayload(payload);
  if (stream == null) throw new Error('Dramadev returned no playable HLS');
  return stream;
}

async function dramadevPreview(args) {
  const ref = args && args.item && args.item.ref;
  let payload = dramadevPayloadFromRef(ref);
  if (payload == null) {
    const seriesPayload = dramadevSeriesPayloadFromRef(ref);
    if (seriesPayload == null) return { sources: [] };
    const episodes = await dramadevEpisodes(dramadevSeriesFromPayload(seriesPayload));
    const first = episodes[0];
    if (first == null) return { sources: [] };
    const episodeParts = dramadevEpisodePayloadFromRef(first.ref);
    if (episodeParts == null) return { sources: [] };
    payload = episodeParts;
  }
  const stream = await dramadevResolvePayload(payload);
  if (stream == null) return { sources: [] };
  return {
    sources: [{
      id: `preview:${DRAMADEV_PROVIDER_KEY}:${dramadevEncode(payload)}`,
      type: 'direct',
      stream,
    }],
  };
}

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: DRAMADEV_PROVIDER_KEY,
  sources: dramadevSources,
  resolve: dramadevResolveSource,
});

globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: DRAMADEV_CATALOG_ID,
  catalog: dramadevShortsCatalog,
});

globalThis.__metaProviders = globalThis.__metaProviders || [];
globalThis.__metaProviders.push({
  providerId: DRAMADEV_PROVIDER_ID,
  meta: dramadevMeta,
});

globalThis.__previewProviders = globalThis.__previewProviders || [];
globalThis.__previewProviders.push({
  providerId: DRAMADEV_PROVIDER_ID,
  preview: dramadevPreview,
});

// LayarKaca stream discovery for TMDB-owned movie and episode items.
//
// TMDB remains Nimora's catalogue/detail source. This provider only searches
// LayarKaca at source time, refreshes the player page at resolve time, and
// follows the public CloudStream-style iframe/extractor chain.

const LAYARKACA_PROVIDER_KEY = 'layarkaca';
const LAYARKACA_PROVIDER_PREFIX = 'nimora.layarkaca';
const LAYARKACA_CATALOG_PROVIDER_ID = 'nimora.layarkaca.catalog';
const LAYARKACA_CATALOG_ID = 'layarkaca';
const LAYARKACA_SERVERS = [
  {
    key: 'hydrax',
    providerKey: 'layarkaca.hydrax',
    providerId: 'nimora.layarkaca.hydrax',
    name: 'LayarKaca · HYDRAX',
  },
  {
    key: 'p2p',
    providerKey: 'layarkaca.p2p',
    providerId: 'nimora.layarkaca.p2p',
    name: 'LayarKaca · P2P',
  },
  {
    key: 'turbovip',
    providerKey: 'layarkaca.turbovip',
    providerId: 'nimora.layarkaca.turbovip',
    name: 'LayarKaca · TURBOVIP',
  },
  {
    key: 'cast',
    providerKey: 'layarkaca.cast',
    providerId: 'nimora.layarkaca.cast',
    name: 'LayarKaca · CAST',
  },
];
const LAYARKACA_DEFAULT_BASE = 'https://tv12.lk21official.cc';
const LAYARKACA_DIRECTORY_BASE =
  globalThis.__layarkacaDirectoryBaseUrl || 'https://d21.team';
const LAYARKACA_DEFAULT_SERIES_BASE = 'https://tv9.nontondrama.my';
const LAYARKACA_DEFAULT_SEARCH_BASE = 'https://gudangvape.com';
const LAYARKACA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) ' +
  'Gecko/20100101 Firefox/150.0';
const LAYARKACA_PLAYCDN_PREFIX = globalThis.__layarkacaPlaycdnPrefix || '';
const LAYARKACA_ABYSS_PREFIX = globalThis.__layarkacaAbyssPrefix || '';
const LAYARKACA_HOWNETWORK_PREFIX = globalThis.__layarkacaHownetworkPrefix || '';
const LAYARKACA_IFRAME_PREFIX = globalThis.__layarkacaIframePrefix || '';
const LAYARKACA_EMTURBOVID_PREFIX = globalThis.__layarkacaEmturbovidPrefix || '';
const LAYARKACA_FILEMOON_PREFIX = globalThis.__layarkacaFilemoonPrefix || '';
const LAYARKACA_F16_PREFIX = globalThis.__layarkacaF16Prefix || '';
const LAYARKACA_FILESIM_PREFIX = globalThis.__layarkacaFilesimPrefix || '';
const LAYARKACA_ABYSS_BASE_OVERRIDE =
  globalThis.__layarkacaAbyssBaseUrl || null;
const LAYARKACA_ABYSS_BASE =
  LAYARKACA_ABYSS_BASE_OVERRIDE || 'https://abyssplayer.com';
const LAYARKACA_ABYSS_DECODE_URL =
  globalThis.__layarkacaAbyssDecodeUrl || 'https://enc-dec.app/api/dec-abyss';

let layarkacaBase = globalThis.__layarkacaBaseUrl || LAYARKACA_DEFAULT_BASE;
const LAYARKACA_BASE_OVERRIDE = globalThis.__layarkacaBaseUrl || null;
let layarkacaSeriesBase =
  globalThis.__layarkacaSeriesBaseUrl || LAYARKACA_DEFAULT_SERIES_BASE;
const layarkacaSearchBase =
  globalThis.__layarkacaSearchBaseUrl || LAYARKACA_DEFAULT_SEARCH_BASE;
let layarkacaDiscoveryFlight = null;
let layarkacaBaseDiscoveryFlight = null;
const LAYARKACA_WATCH_PAGE_TTL_MS = 15000;
const layarkacaDiscoveryCache = new Map();
const layarkacaWatchPageCache = new Map();
const layarkacaWatchPageFlights = new Map();

function layarkacaWatchPageKey(query, detailUrl, watchUrl) {
  // Normalize null/omitted episode fields so discovery and source-id resolve
  // share the page, while different episodes on one series never collide.
  return JSON.stringify({
    detailUrl: detailUrl || null,
    watchUrl: watchUrl || null,
    title: query && query.title ? String(query.title) : null,
    year: query && Number.isInteger(query.year) ? query.year : null,
    isEpisode: query && query.isEpisode === true,
    season: query && Number.isInteger(query.season) ? query.season : null,
    episode: query && Number.isInteger(query.episode) ? query.episode : null,
  });
}

function layarkacaContentBaseCandidate(value) {
  const url = layarkacaUrl(value, `${LAYARKACA_DIRECTORY_BASE}/`);
  if (!url) return null;
  const origin = layarkacaOrigin(url);
  const testHost = globalThis.__layarkacaDirectoryAllowedHost;
  if (!origin ||
      (origin === layarkacaOrigin(LAYARKACA_DIRECTORY_BASE) &&
        typeof testHost !== 'string')) return null;
  const host = origin.replace(/^https?:\/\//i, '').toLowerCase();
  return /(?:^|[.-])lk21(?:[.-]|$)|lk21official|layarkaca/i.test(host) ||
    (typeof testHost === 'string' &&
      host.split(':')[0] === testHost.toLowerCase())
    ? origin
    : null;
}

async function layarkacaDiscoverCurrentBase() {
  const directory = LAYARKACA_DIRECTORY_BASE.replace(/\/$/, '');
  const response = await layarkacaFetch(`${directory}/`, directory + '/');
  if (response == null) return null;
  const candidates = [];
  const links = /<a\b([^>]*)>/gi;
  let link;
  while ((link = links.exec(response.body || '')) != null) {
    const candidate = layarkacaContentBaseCandidate(
      layarkacaAttr(link[1], 'href'),
    );
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  }
  for (const candidate of candidates) {
    const probe = await layarkacaFetchManual(candidate, directory + '/');
    if (probe == null) continue;
    if (probe.status < 200 || probe.status >= 400) continue;
    const location = layarkacaHeader(probe.headers, 'location');
    const redirected = location
      ? layarkacaOrigin(layarkacaUrl(location, candidate) || location)
      : layarkacaOrigin(probe.url || candidate);
    if (redirected && redirected !== layarkacaOrigin(directory)) return redirected;
  }
  return candidates[0] || null;
}

async function layarkacaEnsureBase() {
  if (LAYARKACA_BASE_OVERRIDE) return layarkacaBase;
  if (layarkacaBaseDiscoveryFlight) return layarkacaBaseDiscoveryFlight;
  layarkacaBaseDiscoveryFlight = (async () => {
    const discovered = await layarkacaDiscoverCurrentBase();
    if (discovered) layarkacaBase = discovered;
    return layarkacaBase;
  })();
  try {
    return await layarkacaBaseDiscoveryFlight;
  } finally {
    layarkacaBaseDiscoveryFlight = null;
  }
}

function layarkacaHeaders(referer, extra) {
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: referer || `${layarkacaBase}/`,
    'User-Agent': LAYARKACA_UA,
    ...(extra || {}),
  };
}

async function layarkacaFetch(url, referer, options) {
  try {
    const requestOptions = {...(options || {})};
    const skipCloudflare = requestOptions.skipCloudflare === true;
    delete requestOptions.skipCloudflare;
    requestOptions.headers = {
      ...(requestOptions.headers || {}),
      ...(skipCloudflare ? {'X-QJSR-Disable-Cloudflare': '1'} : {}),
    };
    const response = await fetch(url, {
      ...requestOptions,
      headers: layarkacaHeaders(referer, requestOptions.headers),
    });
    if (response.status < 200 || response.status >= 300) return null;
    return response;
  } catch (_) {
    return null;
  }
}

async function layarkacaFetchManual(url, referer, options) {
  try {
    return await fetch(url, {
      redirect: 'manual',
      ...(options || {}),
      headers: layarkacaHeaders(referer, options && options.headers),
    });
  } catch (_) {
    return null;
  }
}

function layarkacaHeader(headers, name) {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return null;
}

function layarkacaOrigin(url) {
  const match = /^https?:\/\/[^/]+/i.exec(String(url || ''));
  return match == null ? null : match[0];
}

function layarkacaQueryParam(url, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`[?&]${escaped}=([^&#]*)`, 'i').exec(String(url || ''));
  if (!match) return null;
  try { return decodeURIComponent(match[1].replace(/\+/g, ' ')); } catch (_) { return match[1]; }
}

function layarkacaUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (/^https?:\/\//i.test(raw)) return layarkacaIsHttpUrl(raw) ? raw : null;
  if (raw.startsWith('//')) return `https:${raw}`;
  const root = String(base || layarkacaBase).replace(/\/$/, '');
  if (raw.startsWith('/')) return `${layarkacaOrigin(root) || root}${raw}`;
  if (raw.startsWith('?')) {
    const clean = root.split(/[?#]/)[0];
    return `${clean}${raw}`;
  }
  const clean = root.split(/[?#]/)[0];
  return `${clean.slice(0, clean.lastIndexOf('/') + 1)}${raw}`;
}

function layarkacaIsHttpUrl(value) {
  // QuickJS deliberately exposes no browser `URL` global. Keep this
  // validation dependency-free: require a non-empty authority and reject
  // placeholders such as `https://` before they enter the resolver chain.
  return /^https?:\/\/[^/?#\s]+(?:[/?#]|$)/i.test(String(value || ''));
}

// Older Abyss/Filemoon pages use Dean Edwards' P.A.C.K.E.R. around their
// JWPlayer config. Decode only the substitution table; never evaluate the
// remote script. Keep this local so the LayarKaca source also works when it is
// loaded by itself during tests, before the generated bundle adds Savefilm.
function layarkacaUnpack(script) {
  const text = String(script || '');
  const patterns = [
    /}\(\s*'((?:\\.|[^'])*)'\s*,\s*(\d+)\s*,\s*\d+\s*,\s*'((?:\\.|[^'])*)'\.split\('\|'\)/i,
    /}\(\s*"((?:\\.|[^"])*)"\s*,\s*(\d+)\s*,\s*\d+\s*,\s*"((?:\\.|[^"])*)"\.split\("\|"\)/i,
  ];
  let match;
  let quote = "'";
  for (const pattern of patterns) {
    match = pattern.exec(text);
    if (match) {
      quote = pattern === patterns[1] ? '"' : "'";
      break;
    }
  }
  if (!match) return text;
  const payload = match[1]
    .replace(quote === "'" ? /\\'/g : /\\"/g, quote)
    .replace(/\\\\/g, '\\');
  const radix = Number(match[2]);
  const words = match[3]
    .replace(quote === "'" ? /\\'/g : /\\"/g, quote)
    .split('|');
  if (!Number.isInteger(radix) || radix < 2 || words.length === 0) return text;
  const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const token = (index) => {
    let value = index;
    let result = '';
    do {
      result = digits[value % radix] + result;
      value = Math.floor(value / radix);
    } while (value > 0);
    return result;
  };
  let unpacked = payload;
  for (let index = words.length - 1; index >= 0; index--) {
    if (!words[index]) continue;
    const escaped = token(index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    unpacked = unpacked.replace(new RegExp(`\\b${escaped}\\b`, 'g'), words[index]);
  }
  return unpacked;
}

function layarkacaAttr(attributes, name) {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)`, 'i')
    .exec(attributes || '');
  return match == null ? null : layarkacaText(match[1]);
}

function layarkacaText(value) {
  const entities = {
    amp: '&', apos: "'", gt: '>', hellip: '…', lt: '<', nbsp: ' ',
    ndash: '–', mdash: '—', quot: '"', rsquo: '’', lsquo: '‘',
    ldquo: '“', rdquo: '”',
  };
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (match, code) => {
      const point = code[0].toLowerCase() === 'x'
        ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point) : match;
    })
    .replace(/&([a-z]+);/gi, (match, name) => entities[name.toLowerCase()] || match)
    .replace(/\s+/g, ' ')
    .trim();
}

function layarkacaNormalize(value) {
  return layarkacaText(value)
    .replace(/[([]\s*(?:19|20)\d{2}\s*[)\]]/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function layarkacaYear(value) {
  const match = /\b((?:19|20)\d{2})\b/.exec(String(value || ''));
  return match == null ? null : Number(match[1]);
}

function layarkacaParseSearchResults(html, base) {
  const results = [];
  const articles = /<article\b[^>]*>([\s\S]*?)<\/article>/gi;
  let article;
  while ((article = articles.exec(html || '')) != null) {
    const body = article[1];
    const link = /<a\b([^>]*\bitemprop\s*=\s*["']url["'][^>]*)>/i.exec(body) ||
      /<a\b([^>]*)>/i.exec(body);
    if (!link) continue;
    const url = layarkacaUrl(layarkacaAttr(link[1], 'href'), base);
    const titleMatch = /<h[123]\b[^>]*>([\s\S]*?)<\/h[123]>/i.exec(body);
    const title = layarkacaText(
      titleMatch == null ? layarkacaAttr(link[1], 'title') : titleMatch[1],
    );
    if (!url || !title || !/^https?:\/\//i.test(url)) continue;
    results.push({url, title, year: layarkacaYear(`${title} ${url}`)});
  }
  // Some mirrors omit <article> while retaining the schema URL marker.
  if (results.length === 0) {
    const links = /<a\b([^>]*\bitemprop\s*=\s*["']url["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let link;
    while ((link = links.exec(html || '')) != null) {
      const url = layarkacaUrl(layarkacaAttr(link[1], 'href'), base);
      const title = layarkacaText(link[2]);
      if (url && title) results.push({url, title, year: layarkacaYear(`${title} ${url}`)});
    }
  }
  return results;
}

function layarkacaCatalogPageUrl(base, category, page) {
  const path = category === 'tv' ? '/top-series-today' : '/latest';
  return page > 1 ? `${base}${path}/page/${page}` : `${base}${path}`;
}

function layarkacaCatalogTitle(value) {
  const text = layarkacaText(value);
  return text
    .replace(/\s*\(?((?:19|20)\d{2})\)?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || text;
}

function layarkacaCatalogPoster(body, base) {
  const image = /<img\b([^>]*)>/i.exec(body || '');
  if (!image) return null;
  const raw = layarkacaAttr(image[1], 'data-lazy-src') ||
    layarkacaAttr(image[1], 'data-src') ||
    layarkacaAttr(image[1], 'data-original') ||
    layarkacaAttr(image[1], 'src');
  return layarkacaUrl(raw && raw.split(',')[0].trim().split(/\s+/)[0], base);
}

function layarkacaCatalogRating(body) {
  const itempropMatch = /<[^>]*\bitemprop\s*=\s*["']ratingValue["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(body || '');
  if (itempropMatch) {
    const rating = Number(/\d+(?:\.\d+)?/.exec(layarkacaText(itempropMatch[1]))?.[0]);
    if (Number.isFinite(rating)) return rating;
  }
  const match = /(?:data-rating|ratingValue|gmr-rating-item)[^>]*[=:]\s*["']?([0-9]+(?:\.[0-9]+)?)/i.exec(body || '') ||
    /<[^>]*\b(?:rating|gmr-rating-item)\b[^>]*>([\s\S]*?)<\//i.exec(body || '');
  const rating = match == null ? NaN : Number(/\d+(?:\.\d+)?/.exec(layarkacaText(match[1]))?.[0]);
  return Number.isFinite(rating) ? rating : null;
}

function layarkacaParseCatalogResults(html, base, category) {
  const results = [];
  const articles = /<article\b[^>]*>([\s\S]*?)<\/article>/gi;
  let article;
  while ((article = articles.exec(html || '')) != null) {
    const body = article[1];
    const link = /<a\b([^>]*\bitemprop\s*=\s*["']url["'][^>]*)>/i.exec(body) ||
      /<a\b([^>]*)>/i.exec(body);
    if (!link) continue;
    const url = layarkacaUrl(layarkacaAttr(link[1], 'href'), base);
    const titleMatch = /<h[123]\b[^>]*>([\s\S]*?)<\/h[123]>/i.exec(body);
    const rawTitle = titleMatch == null
      ? layarkacaAttr(link[1], 'title') || layarkacaAttr(link[1], 'aria-label')
      : titleMatch[1];
    const title = layarkacaCatalogTitle(rawTitle);
    if (!url || !title || !/^https?:\/\//i.test(url)) continue;
    results.push({
      url,
      title,
      year: layarkacaYear(`${rawTitle || title} ${url}`),
      poster: layarkacaCatalogPoster(body, base),
      rating: layarkacaCatalogRating(body),
      category,
    });
  }
  // Some LK21 mirrors omit <article> but keep the schema.org itemprop link.
  if (results.length === 0) {
    const links = /<a\b([^>]*\bitemprop\s*=\s*["']url["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let link;
    while ((link = links.exec(html || '')) != null) {
      const url = layarkacaUrl(layarkacaAttr(link[1], 'href'), base);
      const rawTitle = layarkacaAttr(link[1], 'title') || link[2];
      const title = layarkacaCatalogTitle(rawTitle);
      if (!url || !title) continue;
      results.push({
        url,
        title,
        year: layarkacaYear(`${rawTitle} ${url}`),
        category,
      });
    }
  }
  return results;
}

function layarkacaCatalogHasNextPage(html, currentPage = 1) {
  if (/<a\b[^>]*\b(?:class\s*=\s*["'][^"']*\bnext\b|rel\s*=\s*["']next)[^>]*>/i.test(html || '')) {
    return true;
  }
  const page = Number.isInteger(Number(currentPage)) && Number(currentPage) > 0
    ? Number(currentPage) : 1;
  const links = /<a\b([^>]*)>/gi;
  let link;
  while ((link = links.exec(html || '')) != null) {
    const href = layarkacaAttr(link[1], 'href');
    const pathPage = /\/page\/(\d+)(?:[/?#]|$)/i.exec(href || '');
    const queryPage = /[?&]page=(\d+)(?:[&#]|$)/i.exec(href || '');
    const linkedPage = Number((pathPage || queryPage || [])[1]);
    if (Number.isInteger(linkedPage) && linkedPage > page) return true;
  }
  return false;
}

function layarkacaCatalogItem(result) {
  const item = {
    ref: {
      extensionId: globalThis.__nimoraExtensionId || 'nimora',
      providerId: LAYARKACA_CATALOG_PROVIDER_ID,
      id: `${LAYARKACA_PROVIDER_KEY}:catalog:${layarkacaEncode({
        u: result.url,
        k: result.category === 'tv' ? 'series' : 'video',
        t: result.title,
        y: result.year,
      })}`,
    },
    kind: result.category === 'tv' ? 'series' : 'video',
    title: result.title,
  };
  if (Number.isInteger(result.year)) item.releaseYear = result.year;
  if (Number.isFinite(result.rating)) item.rating = result.rating;
  if (result.poster) item.artwork = {portrait: {url: result.poster}};
  return item;
}

async function layarkacaCatalog(query) {
  if (!query || query.category !== 'all') return {sections: []};
  const requestedPage = Number(query && query.page);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const feeds = [
    {category: 'movie'},
    {category: 'tv'},
  ];
  const pages = await Promise.all(feeds.map((feed) =>
    layarkacaCatalogFeedPage(feed.category, page),
  ));
  const result = {
    sections: feeds.map((feed, index) => {
      const feedPage = pages[index];
      return {
        id: `${LAYARKACA_CATALOG_ID}-${feed.category}`,
        title: feed.category === 'tv' ? 'TV Series on LK21' : 'Movies on LK21',
        items: feedPage.items,
      };
    }),
  };
  if (pages.some((feedPage) => feedPage.nextPage != null)) {
    result.nextPage = String(page + 1);
  }
  return result;
}

async function layarkacaCatalogFeedPage(category, requestedPage) {
  const pageNumber = Number(requestedPage);
  const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
  await layarkacaEnsureBase();
  const base = (category === 'tv' ? layarkacaSeriesBase : layarkacaBase)
    .replace(/\/$/, '');
  const url = layarkacaCatalogPageUrl(base, category, page);
  const response = await layarkacaFetch(url, `${base}/`);
  if (response == null) return {items: []};
  const finalBase = layarkacaOrigin(response.url || url) || base;
  const results = layarkacaParseCatalogResults(response.body, finalBase, category);
  return {
    items: results.map(layarkacaCatalogItem),
    nextPage: layarkacaCatalogHasNextPage(response.body, page) ? String(page + 1) : null,
  };
}

function layarkacaParseSearchApi(body, query) {
  let data;
  try { data = JSON.parse(body || '{}'); } catch (_) { return []; }
  const entries = Array.isArray(data)
    ? data
    : (Array.isArray(data.data) ? data.data
      : (Array.isArray(data.items) ? data.items : (Array.isArray(data.results) ? data.results : [])));
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const rawUrl = entry.url || entry.href || entry.link;
    const slug = entry.slug;
    const resultBase = query.isEpisode ? layarkacaSeriesBase : layarkacaBase;
    const url = layarkacaUrl(
      typeof rawUrl === 'string' ? rawUrl : (typeof slug === 'string' ? `/${slug}` : null),
      resultBase,
    );
    const title = layarkacaText(entry.title || entry.name || entry.label);
    if (!url || !title) return null;
    return {
      url,
      title,
      year: Number.isInteger(Number(entry.year))
        ? Number(entry.year) : layarkacaYear(`${title} ${url}`),
    };
  }).filter((entry) => entry != null);
}

function layarkacaItemQuery(item) {
  const ref = item && item.ref;
  if (!ref || (ref.providerId !== 'nimora.tmdb' &&
      ref.providerId !== LAYARKACA_CATALOG_PROVIDER_ID)) return null;
  const catalogPayload = ref.providerId === LAYARKACA_CATALOG_PROVIDER_ID
    ? layarkacaCatalogRefPayload(ref) : null;
  if (ref.providerId === LAYARKACA_CATALOG_PROVIDER_ID && catalogPayload == null) return null;
  const episode = item.kind === 'episode' ? (item.episode || {}) : null;
  const group = episode && typeof episode.groupId === 'string'
    ? /season:(\d+)/i.exec(episode.groupId) : null;
  const season = Number.isInteger(episode && episode.season)
    ? episode.season : (group ? Number(group[1]) : null);
  const episodeNumber = Number.isInteger(episode && episode.position)
    ? episode.position : (Number.isInteger(episode && episode.episode) ? episode.episode : null);
  const title = catalogPayload && catalogPayload.t
    ? catalogPayload.t
    : item.kind === 'episode' && item.subtitle
      ? item.subtitle : item.title;
  const availableAtYear = typeof item.availableAt === 'string'
    ? layarkacaYear(item.availableAt) : null;
  return {
    title: layarkacaText(title),
    year: Number.isInteger(item.releaseYear)
      ? item.releaseYear : (catalogPayload && Number.isInteger(catalogPayload.y)
        ? catalogPayload.y : availableAtYear),
    isEpisode: item.kind === 'episode',
    season,
    episode: episodeNumber,
    detailUrl: catalogPayload && typeof (catalogPayload.p || catalogPayload.u) === 'string'
      ? (catalogPayload.p || catalogPayload.u) : null,
    watchUrl: catalogPayload && typeof catalogPayload.w === 'string'
      ? catalogPayload.w : (catalogPayload && item.kind === 'episode' &&
        typeof catalogPayload.u === 'string' ? catalogPayload.u : null),
  };
}

async function layarkacaItemTitleVariants(item, fallback) {
  if (typeof globalThis.__animeTitleVariants !== 'function') return [fallback];
  try {
    const variants = await globalThis.__animeTitleVariants(item);
    return Array.isArray(variants) && variants.length > 0 ? variants : [fallback];
  } catch (_) {
    return [fallback];
  }
}

function layarkacaCatalogRefPayload(ref) {
  const id = ref && typeof ref.id === 'string' ? ref.id : '';
  const prefix = `${LAYARKACA_PROVIDER_KEY}:catalog:`;
  if (!id.startsWith(prefix)) return null;
  return layarkacaDecode(id.slice(prefix.length));
}

function layarkacaSearchScore(result, query, index) {
  const wanted = layarkacaNormalize(query.title);
  const candidate = layarkacaNormalize(result.title);
  if (!wanted || !candidate) return null;
  if (
    query.year != null &&
    result.year != null &&
    query.year !== result.year
  ) return null;
  const exact = wanted === candidate;
  // A movie substring is not a safe identity match: `Dreams` must not select
  // `Train Dreams` just because the site omitted the exact title from search.
  // Episodes retain the looser series-title matching used by the dedicated
  // series mirrors.
  if (!exact && !query.isEpisode) return null;
  const overlap = candidate.includes(wanted) || wanted.includes(candidate);
  if (!exact && !overlap) return null;
  const yearDelta = query.year != null && result.year != null
    ? Math.abs(query.year - result.year) : 0;
  return (exact ? 0 : 15) + yearDelta + index / 1000;
}

function layarkacaSlug(value, year) {
  const slug = layarkacaText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return null;
  const suffix = Number.isInteger(year) && !new RegExp(`-${year}$`).test(slug)
    ? `-${year}` : '';
  return `${slug}${suffix}`;
}

async function layarkacaSlugFallback(query) {
  const titles = Array.isArray(query && query.titles) && query.titles.length > 0
    ? query.titles : [query && query.title];
  const slugs = [];
  const seen = new Set();
  for (const title of titles) {
    const slug = layarkacaSlug(title, query && query.year);
    if (!slug) continue;
    for (const candidate of [slug, slug.replace(/-(?:19|20)\d{2}$/, '')]) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        slugs.push({candidate, title});
      }
    }
  }
  if (slugs.length === 0) return null;
  const bases = query.isEpisode
    ? [layarkacaSeriesBase, layarkacaBase]
    : [layarkacaBase, layarkacaSeriesBase];
  for (const base of bases) {
    for (const entry of slugs) {
      const candidate = entry.candidate;
      const url = `${base.replace(/\/$/, '')}/${candidate}`;
      const response = await layarkacaFetch(url, `${base.replace(/\/$/, '')}/`);
      if (response == null) continue;
      const finalUrl = response.url || url;
      if (!new RegExp(`/${candidate}(?:[/?#]|$)`, 'i').test(finalUrl)) continue;
      if (!/<(?:script\b[^>]*id\s*=\s*["']season-data|h1\b|title\b)/i.test(response.body || '')) continue;
      return {url: finalUrl, title: entry.title || query.title, year: query.year};
    }
  }
  return null;
}

async function layarkacaSearch(query) {
  if (!query || !query.title) return null;
  await layarkacaEnsureBase();
  const requestedSeriesBase = layarkacaSeriesBase;
  const bases = query.isEpisode
    ? [requestedSeriesBase, layarkacaBase]
    : [layarkacaBase, layarkacaSeriesBase];
  const titleVariants = Array.isArray(query.titles) && query.titles.length > 0
    ? query.titles : [query.title];
  const variants = [];
  const seenVariants = new Set();
  for (const title of titleVariants) {
    const value = String(title || '').trim();
    const withoutYear = value.replace(/\s*\(?((?:19|20)\d{2})\)?\s*$/i, '').trim();
    for (const variant of [value, withoutYear]) {
      if (variant && !seenVariants.has(variant.toLowerCase())) {
        seenVariants.add(variant.toLowerCase());
        variants.push(variant);
      }
    }
  }
  let best = null;
  for (const base of bases) {
    for (const variant of variants) {
      const url = `${base.replace(/\/$/, '')}/search?s=${encodeURIComponent(variant)}`;
      const response = await layarkacaFetch(url, `${base.replace(/\/$/, '')}/`);
      if (response == null) continue;
      const finalOrigin = layarkacaOrigin(response.url || url);
      const results = layarkacaParseSearchResults(response.body, finalOrigin || base);
      const searchQuery = {...query, title: variant};
      results.forEach((result, index) => {
        const score = layarkacaSearchScore(result, searchQuery, index);
        if (score == null || (best != null && score >= best.score)) return;
        best = {result, score};
      });
    }
  }
  // The current site renders /search as an empty shell. Its page script calls
  // this JSON endpoint to populate the cards, so try the same contract before
  // relying on older server-rendered mirror markup.
  for (const variant of variants) {
    const apiUrl = `${layarkacaSearchBase.replace(/\/$/, '')}/search.php?s=${encodeURIComponent(variant)}&page=1`;
    const response = await layarkacaFetch(apiUrl, `${layarkacaBase}/`);
    if (response == null) continue;
    const searchQuery = {...query, title: variant};
    const results = layarkacaParseSearchApi(response.body, searchQuery);
    results.forEach((result, index) => {
      const score = layarkacaSearchScore(result, searchQuery, index);
      if (score == null || (best != null && score >= best.score)) return;
      best = {result, score};
    });
  }
  return best == null ? await layarkacaSlugFallback(query) : best.result;
}

function layarkacaSeasonData(html) {
  const match = /<script\b[^>]*\bid\s*=\s*["']season-data["'][^>]*>([\s\S]*?)<\/script>/i
    .exec(html || '');
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); } catch (_) { return null; }
}

function layarkacaEpisodeUrl(html, pageUrl, season, episode) {
  const data = layarkacaSeasonData(html);
  if (!data || !Number.isInteger(season) || !Number.isInteger(episode)) return null;
  const seasonData = data[String(season)] || data[`season-${season}`] || data[season];
  const entries = Array.isArray(seasonData)
    ? seasonData : (seasonData && Array.isArray(seasonData.episodes) ? seasonData.episodes : []);
  const wanted = entries.find((entry) => {
    const number = Number(entry && (entry.episode_no ?? entry.episodeNumber ?? entry.episode));
    return number === episode;
  });
  if (!wanted) return null;
  return layarkacaUrl(wanted.slug || wanted.url || wanted.href, pageUrl);
}

function layarkacaCatalogEpisodeGuide(html, parentRef, parentTitle, poster, pageUrl, year) {
  const data = layarkacaSeasonData(html);
  if (!data || typeof data !== 'object') return null;
  const groups = [];
  for (const key of Object.keys(data)) {
    const seasonMatch = /(?:season[-_ ]?)?(\d+)/i.exec(key);
    const season = seasonMatch ? Number(seasonMatch[1]) : Number(key);
    const rawEntries = data[key];
    const entries = Array.isArray(rawEntries)
      ? rawEntries
      : (rawEntries && Array.isArray(rawEntries.episodes) ? rawEntries.episodes : []);
    if (!Number.isInteger(season) || season < 1 || entries.length === 0) continue;
    const episodes = [];
    for (const entry of entries) {
      const position = Number(entry && (entry.episode_no ?? entry.episodeNumber ?? entry.episode));
      const url = layarkacaUrl(
        entry && (entry.slug || entry.url || entry.href), pageUrl,
      );
      if (!Number.isInteger(position) || position < 1 || !url) continue;
      const title = layarkacaText(entry.title || entry.name) || `Episode ${position}`;
      const ref = {
        extensionId: globalThis.__nimoraExtensionId || 'nimora',
        providerId: LAYARKACA_CATALOG_PROVIDER_ID,
        id: `${LAYARKACA_PROVIDER_KEY}:catalog:${layarkacaEncode({
          u: url,
          p: pageUrl,
          t: parentTitle,
          y: year,
          s: season,
          e: position,
          k: 'episode',
          r: parentRef,
        })}`,
      };
      episodes.push({
        ref,
        title,
        position,
        ...(poster ? {artwork: {portrait: {url: poster}}} : {}),
      });
    }
    if (episodes.length === 0) continue;
    groups.push({
      id: `season:${season}`,
      title: `Season ${season}`,
      episodes: episodes.sort((a, b) => a.position - b.position),
    });
  }
  if (groups.length === 0) return null;
  groups.sort((a, b) => Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]));
  const last = groups[groups.length - 1];
  return {
    groups,
    defaultEpisodeRef: last.episodes[last.episodes.length - 1].ref,
  };
}

function layarkacaCatalogDescription(html) {
  const meta = /<meta\b[^>]*(?:name|property)\s*=\s*["']description["'][^>]*>/i.exec(html || '');
  return meta ? layarkacaAttr(meta[0], 'content') : null;
}

async function layarkacaCatalogMeta(args) {
  const ref = args && args.ref;
  const payload = layarkacaCatalogRefPayload(ref);
  if (!payload || typeof payload.u !== 'string') {
    throw new Error('Malformed LayarKaca catalog ref');
  }
  const pageUrl = payload.u;
  const base = layarkacaOrigin(pageUrl) || layarkacaBase;
  const response = await layarkacaFetch(pageUrl, `${base}/`);
  if (response == null) throw new Error('LayarKaca detail request failed');
  const html = response.body || '';
  const titleMatch = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const title = layarkacaCatalogTitle(
    titleMatch ? titleMatch[1] : layarkacaAttr(
      /<meta\b[^>]*(?:property|name)\s*=\s*["']og:title["'][^>]*>/i.exec(html)?.[0],
      'content',
    ) || payload.t || 'LayarKaca video',
  );
  const item = payload.k === 'episode'
    ? {
      ref,
      kind: 'episode',
      title,
      subtitle: payload.t || null,
      episode: {
        parentRef: payload.r || ref,
        groupId: `season:${Number(payload.s) || 1}`,
        position: Number(payload.e) || 1,
      },
    }
    : {
      ref,
      kind: payload.k === 'series' ? 'series' : 'video',
      title,
    };
  const poster = layarkacaAttr(
    /<meta\b[^>]*(?:property|name)\s*=\s*["']og:image["'][^>]*>/i.exec(html)?.[0],
    'content',
  );
  if (poster) item.artwork = {portrait: {url: layarkacaUrl(poster, base)}};
  const year = Number.isInteger(payload.y) ? payload.y : layarkacaYear(`${title} ${pageUrl}`);
  if (Number.isInteger(year)) item.releaseYear = year;
  const rating = layarkacaCatalogRating(html);
  if (Number.isFinite(rating)) item.rating = rating;
  const detail = {item};
  const description = layarkacaCatalogDescription(html);
  if (description) detail.description = description;
  if (payload.k === 'series' || /season-data/i.test(html)) {
    const guide = layarkacaCatalogEpisodeGuide(
      html, ref, title, item.artwork?.portrait?.url || null,
      response.url || pageUrl, year,
    );
    if (guide) detail.episodeGuide = guide;
  }
  return detail;
}

function layarkacaPlayerUrls(html, pageUrl) {
  const urls = [];
  const add = (url, label) => {
    const absolute = layarkacaUrl(url, pageUrl);
    if (!absolute || !layarkacaIsHttpUrl(absolute) ||
        /https?:\/\/(?:www\.)?yellowishgather\.com\//i.test(absolute) ||
        /\/yellowishgather\//i.test(absolute) ||
        urls.some((item) => item.url === absolute)) return;
    urls.push({url: absolute, label: layarkacaText(label) || null});
  };
  const list = /<(?:ul|div)\b[^>]*\bid\s*=\s*["']player-list["'][^>]*>([\s\S]*?)<\/(?:ul|div)>/i
    .exec(html || '');
  const body = list == null ? html : list[1];
  const links = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let link;
  while ((link = links.exec(body || '')) != null) {
    add(
      layarkacaAttr(link[1], 'href') || layarkacaAttr(link[1], 'data-url'),
      layarkacaAttr(link[1], 'data-server') || link[2],
    );
  }
  const main = /<iframe\b([^>]*\bid\s*=\s*["']main-player["'][^>]*)>/i.exec(html || '');
  if (main) add(layarkacaAttr(main[1], 'src'), 'Main player');
  if (urls.length === 0) {
    const embedded = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bembed-container\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
      .exec(html || '');
    const iframe = embedded && /<iframe\b([^>]*)>/i.exec(embedded[1]);
    if (iframe) add(layarkacaAttr(iframe[1], 'src'), 'Player');
  }
  if (urls.length === 0) {
    const iframes = /<iframe\b([^>]*)>/gi;
    let iframe;
    while ((iframe = iframes.exec(html || '')) != null) add(layarkacaAttr(iframe[1], 'src'), 'Player');
  }
  return urls;
}

function layarkacaServerKey(label, index) {
  const key = layarkacaNormalize(label).replace(/\s+/g, '-');
  return key || `server-${index + 1}`;
}

function layarkacaEncode(value) {
  return host.codec.textToBase64(JSON.stringify(value))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function layarkacaDecode(value) {
  let encoded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const remainder = encoded.length % 4;
  if (remainder) encoded += '='.repeat(4 - remainder);
  try { return JSON.parse(host.codec.base64ToText(encoded)); } catch (_) { return null; }
}

async function layarkacaWatchPage(query, detailUrl, watchUrl) {
  const cacheKey = layarkacaWatchPageKey(query, detailUrl, watchUrl);
  const now = Date.now();
  const cached = layarkacaWatchPageCache.get(cacheKey);
  if (cached != null && now - cached.fetchedAt < LAYARKACA_WATCH_PAGE_TTL_MS) {
    return cached.page;
  }
  const inFlight = layarkacaWatchPageFlights.get(cacheKey);
  if (inFlight != null) return inFlight;

  const flight = (async () => {
    let detailResponse = detailUrl == null ? null :
      await layarkacaFetch(detailUrl, `${layarkacaBase}/`);
    let detailBody = detailResponse == null ? null : detailResponse.body;
    let resolvedDetailUrl = detailResponse == null ? detailUrl : (detailResponse.url || detailUrl);
    if (detailBody == null && query) {
      const found = await layarkacaSearch(query);
      if (found) {
        resolvedDetailUrl = found.url;
        detailResponse = await layarkacaFetch(found.url, `${layarkacaBase}/`);
        detailBody = detailResponse == null ? null : detailResponse.body;
      }
    }
    if (detailBody == null) return null;
    let resolvedWatchUrl = watchUrl || resolvedDetailUrl;
    if (query && query.isEpisode && !watchUrl) {
      resolvedWatchUrl = layarkacaEpisodeUrl(
        detailBody, resolvedDetailUrl, query.season, query.episode,
      );
      if (!resolvedWatchUrl) return null;
    }
    const page = await layarkacaFetch(resolvedWatchUrl, resolvedDetailUrl);
    if (page == null) return null;
    return {
      detailUrl: resolvedDetailUrl,
      watchUrl: page.url || resolvedWatchUrl,
      body: page.body,
      players: layarkacaPlayerUrls(page.body, page.url || resolvedWatchUrl),
    };
  })();
  layarkacaWatchPageFlights.set(cacheKey, flight);
  try {
    const page = await flight;
    if (page != null) {
      const fetchedAt = Date.now();
      const cacheEntry = {fetchedAt, page};
      layarkacaWatchPageCache.set(cacheKey, cacheEntry);
      // Discovery starts without a watch URL, while source resolution stores
      // the resolved watch URL in its restart-safe id. Reuse the fresh page
      // under both identities so resolving each server does not fetch the
      // same detail/watch document again.
      const resolvedKey = layarkacaWatchPageKey(
        query,
        page.detailUrl,
        page.watchUrl,
      );
      layarkacaWatchPageCache.set(resolvedKey, cacheEntry);
    }
    return page;
  } finally {
    if (layarkacaWatchPageFlights.get(cacheKey) === flight) {
      layarkacaWatchPageFlights.delete(cacheKey);
    }
  }
}

function layarkacaProviderEnabled(enabled, server) {
  return enabled == null ||
    enabled.indexOf(server.providerId) !== -1 ||
    enabled.indexOf(LAYARKACA_PROVIDER_PREFIX) !== -1;
}

async function layarkacaDiscover(item) {
  if (!item || (item.kind !== 'video' && item.kind !== 'episode')) return null;
  const query = layarkacaItemQuery(item);
  if (!query || (query.isEpisode && (!Number.isInteger(query.season) || !Number.isInteger(query.episode)))) {
    return null;
  }
  query.titles = await layarkacaItemTitleVariants(item, query.title);
  let found = query.detailUrl
    ? {url: query.detailUrl, title: query.title, year: query.year}
    : await layarkacaSearch(query);
  let page = found == null ? null : await layarkacaWatchPage(
    query, found.url, query.watchUrl,
  );
  // A movie mirror can return a matching redirect page for a series title.
  // Re-run the series slug on the dedicated NontonDrama base when that page
  // does not expose the requested season/episode players.
  if ((!page || page.players.length === 0) && query.isEpisode) {
    const seriesFound = await layarkacaSlugFallback(query);
    if (seriesFound && seriesFound.url !== (found && found.url)) {
      found = seriesFound;
      page = await layarkacaWatchPage(query, found.url, query.watchUrl);
    }
  }
  if (!found || !page || page.players.length === 0) return null;
  return {query, page};
}

async function layarkacaDiscoverForItem(item) {
  const key = JSON.stringify({
    ref: item && item.ref,
    kind: item && item.kind,
    title: item && item.title,
    subtitle: item && item.subtitle,
    year: item && item.year,
    episode: item && item.episode,
  });
  const now = Date.now();
  const cached = layarkacaDiscoveryCache.get(key);
  if (cached != null && now - cached.fetchedAt < LAYARKACA_WATCH_PAGE_TTL_MS) {
    return cached.value;
  }
  if (layarkacaDiscoveryFlight && layarkacaDiscoveryFlight.key === key) {
    return layarkacaDiscoveryFlight.promise;
  }
  const promise = (async () => {
    try {
      return await layarkacaDiscover(item);
    } finally {
      if (layarkacaDiscoveryFlight && layarkacaDiscoveryFlight.promise === promise) {
        layarkacaDiscoveryFlight = null;
      }
    }
  })();
  layarkacaDiscoveryFlight = {key, promise};
  try {
    const value = await promise;
    if (value != null) {
      layarkacaDiscoveryCache.set(key, {fetchedAt: Date.now(), value});
    }
    return value;
  } finally {
    if (layarkacaDiscoveryFlight && layarkacaDiscoveryFlight.promise === promise) {
      layarkacaDiscoveryFlight = null;
    }
  }
}

async function layarkacaSourcesForServer(args, server) {
  const enabled = args && args.enabledProviders;
  if (!layarkacaProviderEnabled(enabled, server)) return {sources: []};
  const discovered = await layarkacaDiscoverForItem(args && args.item);
  if (!discovered) return {sources: []};
  const {query, page} = discovered;
  const index = page.players.findIndex((player, playerIndex) =>
    layarkacaServerKey(player.label || `Player ${playerIndex + 1}`, playerIndex) === server.key);
  if (index < 0) return {sources: []};
  const player = page.players[index];
  return {
    sources: [{
      id: `${server.providerKey}:${layarkacaEncode({
        p: server.key,
        d: page.detailUrl,
        w: page.watchUrl,
        i: index,
        l: player.label,
        t: query.title,
        y: query.year,
        s: query.season,
        e: query.episode,
        k: query.isEpisode,
      })}`,
      label: server.name,
      provider: server.name,
      providerId: server.providerId,
    }],
  };
}

// Kept as an internal compatibility helper for focused resolver tests. The
// registered providers below call layarkacaSourcesForServer independently.
async function layarkacaSources(args) {
  const results = await Promise.all(
    LAYARKACA_SERVERS.map((server) => layarkacaSourcesForServer(args, server)),
  );
  return {sources: results.flatMap((result) => result.sources || [])};
}

function layarkacaMatches(url, prefix, hostPattern) {
  return (prefix && url.startsWith(prefix)) || hostPattern.test(url);
}

function layarkacaMediaFormat(url) {
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  // Abyss/Hydrax serves fixed MP4 renditions without a file extension.
  // Identifying the canonical `/sora/{size}/{token}` shape keeps it out of
  // the generic `other` bucket used for genuinely unknown media URLs.
  if (/\/sora\/\d+\/[^/?#]+(?:[?#]|$)/i.test(url)) return 'mp4';
  return 'other';
}

async function layarkacaValidateMedia(url, headers, label) {
  if (!/^https?:\/\//i.test(url)) return null;
  if (!/\.m3u8(?:[?#]|$)/i.test(url)) {
    return {url, format: layarkacaMediaFormat(url), headers: headers || {}, label};
  }
  const response = await layarkacaFetch(url, headers && headers.Referer, {headers});
  if (response == null || !/#EXTM3U/i.test(response.body || '')) return null;
  if (!/#EXT-X-(?:STREAM-INF|MEDIA|TARGETDURATION|ENDLIST)|#EXTINF/i.test(response.body || '')) return null;
  return {url, format: 'hls', headers: headers || {}, label};
}

async function layarkacaResolveIframe(
  url, referer, depth, seen, label, parentUrl,
) {
  // CloudStream's P2P extractor loads the player page through the normal
  // HTTP client first. That lets the Cloudflare layer handle a challenge and
  // exposes the nested iframe (usually /iframe3/p2p/...) to the extractor
  // chain. Skipping Cloudflare here incorrectly forced every blocked
  // Videonode page into the slower WebView path.
  const response = await layarkacaFetch(url, referer);
  if (response == null) {
    // Videonode /iframe3/ endpoints are browser-only shells. When the
    // extension still has the selected player URL, load the watch page and
    // ask the generic WebView host to select that iframe in its DOM.
    if (parentUrl && parentUrl !== url && /\/iframe3\//i.test(url)) {
      return layarkacaResolveWebViewCandidate(
        parentUrl, referer, depth, seen, label, true, url,
      );
    }
    const preferred = await layarkacaResolveWebViewCandidate(
      url, referer, depth, seen, label,
    );
    // Hydrax must stay on the Abyss chain. Falling back to the generic
    // Playcdn pattern returns a valid-looking single media playlist and
    // silently discards Hydrax's fixed quality payload.
    if (preferred || layarkacaPrefersAbyss(url, label)) return preferred;
    return layarkacaResolveWebViewCandidate(
      url, referer, depth, seen, null, false,
    );
  }
  const pageUrl = response.url || url;
  const requestedOrigin = layarkacaOrigin(url);
  const responseOrigin = layarkacaOrigin(pageUrl);
  const refererOrigin = layarkacaOrigin(referer);
  // A browser challenge can redirect a blocked player back to the parent
  // catalog homepage. That document is not the requested player and often
  // contains empty iframe placeholders such as `https://`, which must not
  // enter the resolver chain.
  if (requestedOrigin && responseOrigin && refererOrigin &&
      requestedOrigin !== refererOrigin && responseOrigin === refererOrigin) {
    return null;
  }
  // CloudStream first parses nested iframe/source URLs from the response and
  // only falls back to a browser when the document contains no usable child.
  // Do the same here: a 200 iframe3 response can already expose the Abyss
  // player, and sending it back to the parent WebView unconditionally turns a
  // playable Hydrax response into a 45-second parent-page timeout.
  const players = layarkacaPlayerUrls(response.body, pageUrl);
  for (const player of players) {
    const resolved = await layarkacaResolveUrl(
      player.url, pageUrl, depth + 1, seen, player.label || label,
    );
    if (resolved) return resolved;
  }
  // Non-P2P iframe3 servers can return a browser-only shell or a nested ad
  // wrapper whose final player is only created when the selected link is
  // clicked from the watch page. Retry through that parent before asking the
  // WebView to observe the already-detached shell; this is required by the
  // current TurboVIP -> EmTurbovid chain.
  if (parentUrl && parentUrl !== url && /\/iframe3\//i.test(url)) {
    const parentResolved = await layarkacaResolveWebViewCandidate(
      parentUrl, referer, depth, seen, label, true, url,
    );
    if (parentResolved) return parentResolved;
  }
  const preferred = await layarkacaResolveWebViewCandidate(
    pageUrl, referer, depth, seen, label,
  );
  if (preferred || layarkacaPrefersAbyss(pageUrl, label)) return preferred;
  return layarkacaResolveWebViewCandidate(
    pageUrl, referer, depth, seen, null, false,
  );
}

// The current upstream iframe is a browser-only shell: it loads a nested
// player frame and that frame later exposes the actual playlist. Capture
// both the final playlist and known nested player URLs so the normal
// extractor chain can continue in QuickJS. Capturing only m3u8 here loses the
// chain before Playcdn/Abyss gets a chance to resolve it.
const LAYARKACA_WEBVIEW_PATTERN =
  'm3u8|master\\.txt|playcdn\\.de/|emturbovid\\.com/|abyssplayer\\.com/';
const LAYARKACA_ABYSS_WEBVIEW_PATTERN =
  'abyssplayer\\.com/|abyss\\.to/|abysscdn\\.com/|hydraxcdn\\.biz/|embedplayabyss\\.top/';

function layarkacaPrefersAbyss(url, label) {
  const lowerUrl = String(url || '').toLowerCase();
  return /hydrax/i.test(String(label || '')) ||
    lowerUrl.includes('/iframe/hydrax/') ||
    lowerUrl.includes('/iframe3/hydrax/');
}

function layarkacaWebViewPattern(url, label, preferAbyss = true) {
  return preferAbyss && layarkacaPrefersAbyss(url, label)
    ? LAYARKACA_ABYSS_WEBVIEW_PATTERN
    : LAYARKACA_WEBVIEW_PATTERN;
}

async function layarkacaResolveWebViewCandidate(
  url, referer, depth, seen, label, preferAbyss = true, clickUrl,
) {
  const interceptPattern = layarkacaWebViewPattern(url, label, preferAbyss);
  try {
    const intercepted = await fetch(url, {
      headers: {
        Referer: referer || url,
        'X-QJSR-WebView-Pattern': interceptPattern,
        ...(clickUrl ? {'X-QJSR-WebView-Click-Url': clickUrl} : {}),
      },
    });
    const candidate = intercepted.url || '';
    if (intercepted.status !== 200 || !layarkacaIsHttpUrl(candidate)) return null;
    if (/(?:m3u8|master\\.txt)/i.test(candidate)) {
      return layarkacaValidateMedia(
        candidate,
        {Referer: referer || url, 'User-Agent': LAYARKACA_UA},
        'WebView',
      );
    }
    return layarkacaResolveUrl(
      candidate,
      url || referer,
      (depth || 0) + 1,
      seen || new Set(),
      label || 'WebView',
    );
  } catch (_) {
    return null;
  }
}

async function layarkacaResolveP2pApi(url, referer) {
  const id = layarkacaQueryParam(url, 'id');
  if (!id) return null;
  return layarkacaResolveP2pId(
    id,
    referer,
    layarkacaOrigin(url) || 'https://playcdn.de',
    url,
  );
}

async function layarkacaResolveP2pId(id, referer, apiOrigin, requestReferer) {
  const origin = apiOrigin || 'https://playcdn.de';
  const response = await layarkacaFetch(
    `${origin}/api2.php?id=${encodeURIComponent(id)}`,
    requestReferer || referer,
    {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: 'r=' + encodeURIComponent(referer || 'https://videonode.de/') +
      '&d=' + encodeURIComponent(origin.replace(/^https?:\/\//i, '')),
    },
  );
  if (response == null) return null;
  let data;
  try { data = JSON.parse(response.body || '{}'); } catch (_) { return null; }
  const entries = data && Array.isArray(data.data) ? data.data : [data];
  const headers = {
    Referer: `${origin}/`,
    'User-Agent': LAYARKACA_UA,
  };
  for (const entry of entries) {
    const media = entry && (entry.file || entry.link || entry.url || entry.videoSource);
    const resolved = await layarkacaValidateMedia(
      media,
      headers,
      entry && (entry.label || entry.quality || 'P2P'),
    );
    if (resolved) return resolved;
  }
  return null;
}

async function layarkacaResolveP2pIframe(url, referer) {
  const match = /\/iframe(?:3)?\/p2p\/([^/?#]+)/i.exec(String(url || ''));
  if (!match) return null;
  return layarkacaResolveP2pId(
    match[1],
    referer,
    layarkacaOrigin(LAYARKACA_PLAYCDN_PREFIX) || 'https://playcdn.de',
    url,
  );
}

async function layarkacaResolvePlaycdn(url, referer) {
  // The current Playcdn/Videonode contract uses api2.php?id=...; older
  // pages expose a token in HTML and use verify.php instead. Keep both paths
  // because LayarKaca rotates between these player generations.
  const apiResolved = await layarkacaResolveP2pApi(url, referer);
  if (apiResolved) return apiResolved;
  const response = await layarkacaFetch(url, referer);
  if (response == null) return null;
  const pageUrl = response.url || url;
  const origin = layarkacaOrigin(pageUrl) || 'https://playcdn.de';
  const dataMatch = /\bvar\s+data\s*=\s*(\{[\s\S]*?\})\s*;/i.exec(response.body || '');
  if (!dataMatch) {
    // The current Playcdn page resolves its path slug through a JSON GET
    // instead of embedding the legacy `var data` token in HTML.
    const slugMatch = /\/([^/?#]+)(?:[?#]|$)/i.exec(pageUrl);
    if (!slugMatch || !slugMatch[1] || slugMatch[1] === 'video.php') return null;
    const verified = await layarkacaFetch(
      `${origin}/verify/${encodeURIComponent(slugMatch[1])}`,
      pageUrl,
      {headers: {Referer: pageUrl, Origin: origin}},
    );
    if (verified == null) return null;
    let current;
    try { current = JSON.parse(verified.body || '{}'); } catch (_) { return null; }
    if (current.status !== 'success' || typeof current.fileUrl !== 'string') return null;
    return layarkacaValidateMedia(
      current.fileUrl,
      {Referer: pageUrl, 'User-Agent': LAYARKACA_UA},
      'P2P',
    );
  }
  let data;
  try { data = JSON.parse(dataMatch[1]); } catch (_) { return null; }
  if (!data || typeof data.token !== 'string' || !data.token) return null;
  const verified = await layarkacaFetch(`${origin}/verify.php`, pageUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Referer: pageUrl,
    },
    body: JSON.stringify({token: data.token, is_ios: false}),
  });
  if (verified == null) return null;
  let result;
  try { result = JSON.parse(verified.body || '{}'); } catch (_) { return null; }
  if (result.status !== 'success' || typeof result.fileUrl !== 'string') return null;
  return layarkacaValidateMedia(
    result.fileUrl,
    {Referer: pageUrl, 'User-Agent': LAYARKACA_UA},
    'P2P',
  );
}

function layarkacaAbyssPageUrl(url) {
  const raw = String(url || '');
  const match = /^https?:\/\/([^/]+)\/([^?#]*)/i.exec(raw);
  if (!match) return null;
  const host = match[1].toLowerCase().replace(/^www\./, '');
  const mediaId = match[2].split('/').filter(Boolean)[0];
  if (!mediaId) return null;

  // Keep the local fixture override, but use ResolveURL's host-specific
  // normalization for production Abyss/Hydrax links.
  if (LAYARKACA_ABYSS_BASE_OVERRIDE) {
    return `${LAYARKACA_ABYSS_BASE_OVERRIDE.replace(/\/$/, '')}/${match[2]}`;
  }
  if (host === 'abyss.to') return raw;
  if (host === 'short.icu' || host === 'embedplayabyss.top') {
    return `https://abysscdn.com/?v=${encodeURIComponent(mediaId)}`;
  }
  if (host === 'abyssplayer.com') {
    return `https://abyssplayer.com/${mediaId}`;
  }
  if (host === 'abysscdn.com' || host === 'hydraxcdn.biz') {
    return `https://${host}/?v=${encodeURIComponent(mediaId)}`;
  }
  return `${LAYARKACA_ABYSS_BASE.replace(/\/$/, '')}/${match[2]}`;
}

function layarkacaAbyssDatas(html) {
  const match = /(?:const|var)\s+datas\s*=\s*["']([^"']+)["']/i.exec(html || '');
  if (!match) return null;
  const encoded = match[1].replace(/\\"/g, '"').trim();
  try {
    // Decode as bytes first. The encrypted `media` value may contain bytes
    // which are not valid UTF-8; replacing those bytes before AES decryption
    // corrupts the payload.
    const hex = host.codec.base64ToHex(encoded);
    let json = '';
    for (let index = 0; index < hex.length; index += 2) {
      json += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
    }
    return JSON.parse(json);
  } catch (_) {
    try { return JSON.parse(host.codec.base64ToText(encoded)); } catch (_) { return null; }
  }
}

function layarkacaAbyssSourceUrl(value, pageUrl) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (/^(?:https?:)?\/\//i.test(raw) || raw.startsWith('/') || raw.startsWith('./') ||
      /^[^\s]+\.(?:m3u8|mp4)(?:[?#]|$)/i.test(raw)) {
    return layarkacaUrl(raw, pageUrl);
  }
  return /^https?:\/\//i.test(raw) ? raw : null;
}

function layarkacaAbyssQualityHeight(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const value = entry.height || entry.quality || entry.type || entry.label || entry.name || '';
  const match = /(?:^|[^0-9])(2160|1440|1080|720|480|360)\s*p?(?:[^0-9]|$)/i
    .exec(String(value));
  return match == null ? null : Number(match[1]);
}

function layarkacaAbyssGeneratedUrl(entry, payload, media) {
  if (!entry || !payload || payload.md5_id == null || payload.slug == null ||
      entry.res_id == null || entry.size == null || typeof entry.sub !== 'string' ||
      typeof savefilmAbyssPathToken !== 'function') return null;
  const domains = media && media.mp4 && media.mp4.domains;
  if (!Array.isArray(domains)) return null;
  const domain = domains.find((value) => String(value || '').includes(entry.sub));
  if (!domain) return null;
  const path = `/mp4/${payload.md5_id}/${entry.res_id}/${entry.size}?v=${payload.slug}`;
  const token = savefilmAbyssPathToken(path, entry.size);
  const host = String(domain).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `https://${host}/sora/${entry.size}/${token}`;
}

function layarkacaAbyssMediaEntries(media, pageUrl, payload) {
  if (!media || typeof media !== 'object') return [];
  const direct = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const generated = layarkacaAbyssGeneratedUrl(entry, payload, media);
    if (generated) return generated;
    // Hydrax's current payload keeps the media host in `url` and the actual
    // rendition path in `path`. Returning the host root looks like a valid
    // HTTP URL but cannot play; join both parts before considering shortcuts.
    if (typeof entry.path === 'string' && entry.path.trim()) {
      const host = typeof entry.url === 'string' &&
          /^https?:\/\/[^/]+\/?$/i.test(entry.url.trim())
        ? entry.url.trim().replace(/\/$/, '')
        : pageUrl;
      const path = layarkacaUrl(
        `/${entry.path.trim().replace(/^\/+/, '')}`,
        host,
      );
      if (path) return path;
    }
    for (const key of ['file', 'url', 'master', 'src', 'source']) {
      const value = layarkacaAbyssSourceUrl(entry[key], pageUrl);
      if (!value) continue;
      // A source's `url` can be just its storage origin. It is only useful
      // when no separate path was supplied, or when it already names media.
      if (key === 'url' &&
          /^https?:\/\/[^/]+\/?$/i.test(value) &&
          !(entry.file || entry.master || entry.src || entry.source)) {
        continue;
      }
      return value;
    }
    return null;
  };
  const fromSources = (entries) => {
    if (!Array.isArray(entries)) return [];
    const sorted = entries.slice().sort((a, b) => {
      const left = Number(a && (a.size || a.height || a.quality ||
        layarkacaAbyssQualityHeight(a) || 0));
      const right = Number(b && (b.size || b.height || b.quality ||
        layarkacaAbyssQualityHeight(b) || 0));
      return (Number.isFinite(right) ? right : 0) -
        (Number.isFinite(left) ? left : 0);
    });
    return sorted.map((entry) => {
      if (entry && String(entry.codec || '').toLowerCase() === 'av1') return null;
      const generated = layarkacaAbyssGeneratedUrl(entry, payload, media);
      const value = generated || direct(entry);
      if (!value) return null;
      return {
        url: value,
        format: generated ? 'mp4' : layarkacaMediaFormat(value),
        label: String(entry && (entry.label || entry.quality || '') || ''),
        width: Number.isFinite(Number(entry && entry.width))
          ? Number(entry.width) : null,
        height: layarkacaAbyssQualityHeight(entry),
        bitrate: Number.isFinite(Number(entry && entry.bitrate))
          ? Number(entry.bitrate) : null,
      };
    }).filter((entry) => entry != null);
  };

  // Hydrax can expose both fixed MP4 renditions and adaptive HLS. Fixed
  // renditions are useful when the HLS URL is only a single media playlist;
  // use them when the payload really contains multiple quality entries.
  const mp4 = media.mp4;
  const mp4Entries = fromSources(mp4 && (mp4.sources || mp4.fristDatas));
  if (mp4Entries.length > 1) return mp4Entries;

  const hls = media.hls;
  const hlsUrl = direct(hls) ||
    fromSources(hls && (hls.sources || hls.fristDatas))[0]?.url;
  if (hlsUrl) {
    return [{
      url: hlsUrl,
      format: 'hls',
      label: 'Auto',
      width: null,
      height: null,
      bitrate: null,
    }];
  }
  if (mp4Entries.length > 0) return mp4Entries;
  const fallback = direct(media);
  return fallback ? [{
    url: fallback,
    format: layarkacaMediaFormat(fallback),
    label: '',
    width: null,
    height: null,
    bitrate: null,
  }] : [];
}

function layarkacaAbyssMediaUrl(media, pageUrl) {
  return layarkacaAbyssMediaEntries(media, pageUrl)[0]?.url || null;
}

async function layarkacaValidateAbyssEntries(entries, headers, fallbackLabel) {
  const valid = [];
  for (const entry of entries || []) {
    const resolved = await layarkacaValidateMedia(
      entry.url,
      headers,
      entry.label || fallbackLabel,
    );
    if (resolved) valid.push({...resolved, ...entry});
  }
  if (valid.length === 0) return null;
  const variants = [];
  const ids = new Set();
  for (const entry of valid) {
    if (!(entry.height > 0)) continue;
    const base = `quality-${entry.height}p`;
    let id = base;
    let suffix = 2;
    while (ids.has(id)) id = `${base}-${suffix++}`;
    ids.add(id);
    variants.push({
      id,
      url: entry.url,
      headers: entry.headers || headers || {},
      format: entry.format || layarkacaMediaFormat(entry.url),
      label: entry.label || `${entry.height}p`,
      width: entry.width || null,
      height: entry.height,
      bitrate: entry.bitrate || null,
    });
  }
  // Keep the quality picker in descending order, but make the provider's
  // default URL the lowest validated rendition. The app opens stream.url when
  // Auto has no explicit preference; this avoids starting Hydrax on 1080p
  // before the player has a chance to apply a saved quality choice.
  const primary = valid[valid.length - 1];
  return {
    url: primary.url,
    format: primary.format,
    headers: primary.headers,
    label: primary.label || fallbackLabel,
    ...(variants.length > 0 ? {variants} : {}),
  };
}

function layarkacaAbyssDecryptMedia(payload) {
  if (!payload || typeof payload.media !== 'string' ||
      payload.slug == null || payload.md5_id == null || payload.user_id == null ||
      typeof savefilmAesCtrDecrypt !== 'function') return null;
  try {
    const plain = savefilmAesCtrDecrypt(
      payload.media,
      `${payload.user_id}:${payload.slug}:${payload.md5_id}`,
    );
    return JSON.parse(plain);
  } catch (_) {
    return null;
  }
}

async function layarkacaResolveAbyss(url, referer, depth, seen) {
  const path = String(url).replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
  // Cs-Karma follows the short.icu redirect before invoking its extractor.
  // Keep that live redirect as the first attempt; the canonical Abyss URL is
  // still used for hosts that do not expose a usable redirect.
  const followsShortRedirect = /^https?:\/\/(?:www\.)?short\.icu\//i.test(url);
  const updatedUrl = (followsShortRedirect ? url : layarkacaAbyssPageUrl(url)) ||
    `${LAYARKACA_ABYSS_BASE.replace(/\/$/, '')}/${path}`;
  const baseHeaders = {
    'User-Agent': LAYARKACA_UA,
    Referer: `${layarkacaOrigin(updatedUrl) || LAYARKACA_ABYSS_BASE}/`,
  };
  const firstdoc = await layarkacaFetchManual(updatedUrl, referer, {
    headers: baseHeaders,
  });
  if (firstdoc == null || firstdoc.status < 200 || firstdoc.status >= 400) return null;
  const location = layarkacaHeader(firstdoc.headers, 'location');
  const pageUrl = location ? (layarkacaUrl(location, updatedUrl) || location) : updatedUrl;
  const response = location
    ? await layarkacaFetch(pageUrl, referer, {headers: baseHeaders})
    : (firstdoc.status >= 200 && firstdoc.status < 300
      ? firstdoc : await layarkacaFetch(pageUrl, referer, {headers: baseHeaders}));
  if (response == null) return null;
  const scriptData = response.body || '';

  // Older Abyss/Filemoon pages put a JWPlayer `file` URL in a Dean Edwards
  // packed script instead of the newer `datas` envelope. Match Nuvio's
  // extractFilemoon path without evaluating remote JavaScript. The local
  // unpacker and shared media assignment parser implement the safe subset.
  const unpacked = layarkacaUnpack(scriptData);
  for (const mediaUrl of layarkacaFilesimUrls(unpacked, pageUrl)) {
    const resolved = await layarkacaValidateMedia(
      mediaUrl,
      baseHeaders,
      'Abyss',
    );
    if (resolved) return resolved;
  }

  const encryptedMatch = /(?:const|let|var)\s+datas\s*=\s*["']([^"']+)["']/i.exec(scriptData);
  if (!encryptedMatch) return null;
  const encrypted = encryptedMatch[1].replace(/\\"/g, '"');

  // Current Abyss embeds a base64-encoded JSON object in `datas`. ResolveURL
  // extracts the playable URL from this object before attempting its legacy
  // encrypted-media path. Do the same locally so no WebView or decoder API is
  // needed for the normal HLS payload.
  const payload = layarkacaAbyssDatas(scriptData);
  const media = payload && (typeof payload.media === 'object'
    ? payload.media : layarkacaAbyssDecryptMedia(payload));
  const localEntries = media && typeof media === 'object'
    ? layarkacaAbyssMediaEntries(media, pageUrl, payload) : [];
  if (localEntries.length > 0) {
    const hasGeneratedAbyssUrl = localEntries.some((entry) => /\/sora\/\d+\//i.test(entry.url));
    const abyssHeaders = hasGeneratedAbyssUrl
      ? {...baseHeaders, Referer: pageUrl}
      : baseHeaders;
    const resolved = await layarkacaValidateAbyssEntries(
      localEntries,
      abyssHeaders,
      'Abyss',
    );
    if (resolved) return resolved;
  }

  // Preserve the existing Kotlin-compatible decoder as a fallback for older
  // pages or payloads whose `media` field is still encrypted.
  const decoded = await layarkacaFetch(LAYARKACA_ABYSS_DECODE_URL, pageUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://enc-dec.app',
    },
    body: JSON.stringify({text: encrypted, agent: LAYARKACA_UA}),
  });
  if (decoded == null) return null;
  let data;
  try { data = JSON.parse(decoded.body || '{}'); } catch (_) { return null; }
  const sources = data && data.result && Array.isArray(data.result.sources)
    ? data.result.sources : [];
  const headers = {Referer: 'https://playhydrax.com/', 'User-Agent': LAYARKACA_UA};
  const fallbackEntries = sources
    .filter((source) => source && source.status !== false)
    .map((source) => {
      const sourceUrl = source.url || source.file;
      return {
        url: sourceUrl,
        format: layarkacaMediaFormat(sourceUrl),
        label: source.type || source.label || 'Abyss',
        width: null,
        height: layarkacaAbyssQualityHeight(source),
        bitrate: null,
      };
    })
    .filter((entry) => typeof entry.url === 'string');
  return layarkacaValidateAbyssEntries(fallbackEntries, headers, 'Abyss');
}

async function layarkacaResolveHownetwork(url, referer) {
  const id = layarkacaQueryParam(url, 'id');
  if (!id) return null;
  const origin = layarkacaOrigin(url) || 'https://cloud.hownetwork.xyz';
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: origin,
    'X-Requested-With': 'XMLHttpRequest',
  };
  // Cs-Karma's Hownetwork sends r="" and d=<the extractor origin> to
  // api2.php. A newer LayarKaca extractor uses playeriframe/cloud instead.
  // Try both real upstream contracts, then its legacy api.php fallback.
  const attempts = [
    {endpoint: 'api2.php', r: '', d: origin},
    {
      endpoint: 'api2.php',
      r: 'https://playeriframe.sbs/',
      d: 'cloud.hownetwork.xyz',
    },
    {
      endpoint: 'api.php',
      r: 'https://playeriframe.sbs/',
      d: 'cloud.hownetwork.xyz',
    },
  ];
  for (const attempt of attempts) {
    const body = 'r=' + encodeURIComponent(attempt.r) +
      '&d=' + encodeURIComponent(attempt.d);
    const endpoint = `${origin}/${attempt.endpoint}?id=${encodeURIComponent(id)}`;
    const response = await layarkacaFetch(endpoint, url, {
      method: 'POST', headers, body,
    });
    if (response == null) continue;
    let data;
    try { data = JSON.parse(response.body || '{}'); } catch (_) { continue; }
    const sources = data && Array.isArray(data.data) ? data.data : [data];
    for (const source of sources) {
      const media = source && (source.file || source.link);
      const resolved = await layarkacaValidateMedia(
        media,
        {
          Referer: media,
          'User-Agent': LAYARKACA_UA,
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.5',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
        source && source.label ? source.label : 'P2P',
      );
      if (resolved) return resolved;
    }
  }
  return null;
}

async function layarkacaResolveEmturbovid(url, referer) {
  const finalReferer = referer || 'https://emturbovid.com/';
  const response = await layarkacaFetch(url, finalReferer);
  if (response == null) return null;
  const match = /\bvar\s+urlPlay\s*=\s*["']([^"']+)["']/i.exec(response.body || '') ||
    /["'](.*?master\.m3u8.*?)["']/i.exec(response.body || '');
  if (!match) return null;
  return layarkacaValidateMedia(
    layarkacaUrl(match[1], response.url || url),
    {
      Referer: finalReferer,
      Origin: layarkacaOrigin(finalReferer) || 'https://emturbovid.com',
      'User-Agent': LAYARKACA_UA,
    },
    'Emturbovid',
  );
}

function layarkacaFilesimUrls(script, pageUrl) {
  const urls = [];
  const add = (value) => {
    const url = layarkacaUrl(String(value || '').replace(/\\\//g, '/'), pageUrl);
    if (url && /^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
  };
  // This is the same useful subset as JWPlayerHelper: explicit `file`
  // entries in `sources`, plus variable assignments for m3u8/master.txt.
  const file = /["']?file["']?\s*:\s*["']([^"']+)["']/gi;
  let match;
  while ((match = file.exec(script || '')) != null) add(match[1]);
  const playlist = /[:=]\s*["']([^"'\s]+(?:\.m3u8|master\.txt)[^"'\s]*)/gi;
  while ((match = playlist.exec(script || '')) != null) add(match[1]);
  return urls;
}

async function layarkacaResolveFilesim(url, referer, depth, seen) {
  const embedUrl = String(url).replace('/download/', '/e/');
  let response = await layarkacaFetch(embedUrl, referer, {skipCloudflare: true});
  if (response == null) return null;
  let pageUrl = response.url || embedUrl;
  const iframe = /<iframe\b([^>]*)>/i.exec(response.body || '');
  if (iframe) {
    const iframeUrl = layarkacaUrl(layarkacaAttr(iframe[1], 'src'), pageUrl);
    if (iframeUrl) {
      response = await layarkacaFetch(iframeUrl, pageUrl, {
        skipCloudflare: true,
        headers: {
          'Accept-Language': 'en-US,en;q=0.5',
          'Sec-Fetch-Dest': 'iframe',
        },
      });
      if (response == null) return null;
      pageUrl = response.url || iframeUrl;
    }
  }
  const raw = response.body || '';
  // Savefilm already carries a safe Dean-Edwards unpacker in the generated
  // bundle. Use it when available without evaluating the upstream script.
  const script = typeof savefilmUnpack === 'function' ? savefilmUnpack(raw) : raw;
  for (const media of layarkacaFilesimUrls(script, pageUrl)) {
    const resolved = await layarkacaValidateMedia(
      media,
      {Referer: pageUrl, 'User-Agent': LAYARKACA_UA},
      'Filesim',
    );
    if (resolved) return resolved;
  }

  return layarkacaResolveWebViewCandidate(
    pageUrl,
    referer || pageUrl,
    depth,
    seen,
  );
}

function layarkacaBase64Url(value) {
  let output = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const remainder = output.length % 4;
  if (remainder) output += '='.repeat(4 - remainder);
  return output;
}

function layarkacaRandomHex(length) {
  let value = '';
  while (value.length < length) value += Math.floor(Math.random() * 16).toString(16);
  return value;
}

async function layarkacaResolveF16(url) {
  const match = /\/e\/([^/?#]+)/i.exec(url);
  if (!match) return null;
  const videoId = match[1];
  const origin = layarkacaOrigin(url) || 'https://f16px.com';
  const pageUrl = `${origin}/e/${videoId}`;
  const viewerId = layarkacaRandomHex(32);
  const deviceId = layarkacaRandomHex(32);
  const now = Math.floor(Date.now() / 1000);
  const payload = layarkacaBase64Url(host.codec.textToBase64(JSON.stringify({
    viewer_id: viewerId, device_id: deviceId, confidence: 0.91,
    iat: now, exp: now + 600,
  }))).replace(/=+$/g, '');
  const token =
    `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.${layarkacaRandomHex(43)}`;
  const response = await layarkacaFetch(
    `${origin}/api/videos/${encodeURIComponent(videoId)}/embed/playback`, pageUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'x-embed-origin': 'playeriframe.sbs',
        'x-embed-parent': pageUrl,
        'x-embed-referer': 'https://playeriframe.sbs/',
      },
      body: JSON.stringify({
        fingerprint: {token, viewer_id: viewerId, device_id: deviceId, confidence: 0.91},
      }),
    },
  );
  if (response == null) return null;
  let playback;
  try { playback = JSON.parse(response.body || '{}').playback; } catch (_) { return null; }
  if (!playback || typeof playback.payload !== 'string' || typeof playback.iv !== 'string' ||
      !Array.isArray(playback.key_parts) || playback.key_parts.length < 2) return null;
  try {
    const keyHex = playback.key_parts.slice(0, 2)
      .map((part) => host.codec.base64ToHex(layarkacaBase64Url(part))).join('');
    const plaintext = host.crypto.aesGcmDecrypt(
      host.codec.hexToBase64(keyHex),
      layarkacaBase64Url(playback.iv),
      layarkacaBase64Url(playback.payload),
    );
    if (plaintext == null) return null;
    const decoded = JSON.parse(host.codec.base64ToText(plaintext));
    const sources = Array.isArray(decoded.sources) ? decoded.sources : [];
    for (const source of sources) {
      const resolved = await layarkacaValidateMedia(
        layarkacaUrl(source && source.url, pageUrl),
        {Referer: `${origin}/`, 'User-Agent': LAYARKACA_UA},
        source && source.label ? `CAST ${source.label}` : 'CAST',
      );
      if (resolved) return resolved;
    }
  } catch (_) {}
  return null;
}

async function layarkacaResolveUrl(
  url, referer, depth, seen, label, parentUrl,
) {
  if (!layarkacaIsHttpUrl(url) || depth > 4) return null;
  const visited = seen || new Set();
  if (visited.has(url)) return null;
  visited.add(url);
  if (/\.(?:m3u8|mp4)(?:[?#]|$)/i.test(url)) {
    return layarkacaValidateMedia(url, {Referer: referer || `${layarkacaBase}/`, 'User-Agent': LAYARKACA_UA}, label);
  }
  if (layarkacaMatches(url, LAYARKACA_PLAYCDN_PREFIX, /https?:\/\/(?:www\.)?playcdn\.de\//i)) {
    return layarkacaResolvePlaycdn(url, referer);
  }
  if (/(?:\/iframe(?:3)?\/p2p\/)/i.test(url)) {
    const p2p = await layarkacaResolveP2pIframe(url, referer);
    if (p2p) return p2p;
    // A failed P2P API can still resolve the selected player in a browser
    // context. Ask the host to select it in the parent page's DOM.
    if (parentUrl && parentUrl !== url) {
      return layarkacaResolveWebViewCandidate(
        parentUrl, referer, depth, seen, label, true, url,
      );
    }
    return layarkacaResolveWebViewCandidate(
      url, referer, depth, visited, label,
    );
  }
  if (layarkacaMatches(
    url,
    LAYARKACA_ABYSS_PREFIX,
    /https?:\/\/(?:www\.)?(?:abyssplayer\.com|abyss\.to|abysscdn\.com|hydraxcdn\.biz|short\.icu|short\.ink|embedplayabyss\.top)\//i,
  )) {
    return layarkacaResolveAbyss(url, referer, depth, visited);
  }
  if (layarkacaMatches(url, LAYARKACA_HOWNETWORK_PREFIX, /https?:\/\/(?:stream|cloud)\.hownetwork\.xyz\//i)) {
    return layarkacaResolveHownetwork(url, referer);
  }
  if (layarkacaMatches(url, LAYARKACA_EMTURBOVID_PREFIX, /https?:\/\/emturbovid\.com\//i)) {
    return layarkacaResolveEmturbovid(url, referer);
  }
  if (layarkacaMatches(
    url,
    LAYARKACA_FILESIM_PREFIX,
    /https?:\/\/(?:www\.)?(?:co4nxtrl\.com|furher\.in|723qrh1p\.fun|turbovidhls\.com)\//i,
  )) {
    return layarkacaResolveFilesim(url, referer, depth, visited);
  }
  if (layarkacaMatches(url, LAYARKACA_F16_PREFIX, /https?:\/\/(?:www\.)?f16px\.com\/e\//i)) {
    return layarkacaResolveF16(url);
  }
  if (layarkacaMatches(url, LAYARKACA_FILEMOON_PREFIX, /https?:\/\/filemoon\.sx\//i)) {
    return layarkacaResolveIframe(url, referer, depth, visited, label);
  }
  if (layarkacaMatches(url, LAYARKACA_IFRAME_PREFIX, /https?:\/\/playeriframe\.sbs\//i)) {
    return layarkacaResolveIframe(url, referer, depth, visited, label);
  }
  return layarkacaResolveIframe(
    url, referer, depth, visited, label, parentUrl,
  );
}

async function layarkacaResolveServerSource(sourceId, server) {
  const prefix = `${server.providerKey}:`;
  if (typeof sourceId !== 'string' || !sourceId.startsWith(prefix)) {
    throw new Error(`Invalid ${server.name} source id`);
  }
  const payload = layarkacaDecode(sourceId.slice(prefix.length));
  if (!payload || payload.p !== server.key || typeof payload.d !== 'string' || !Number.isInteger(payload.i)) {
    throw new Error(`Malformed ${server.name} source id`);
  }
  const query = {
    title: payload.t,
    year: Number.isInteger(payload.y) ? payload.y : null,
    isEpisode: payload.k === true,
    season: Number.isInteger(payload.s) ? payload.s : null,
    episode: Number.isInteger(payload.e) ? payload.e : null,
  };
  const page = await layarkacaWatchPage(query, payload.d, payload.w || null);
  if (!page || !page.players[payload.i]) throw new Error('LayarKaca player is unavailable');
  const player = page.players[payload.i];
  const playerReferer = page.watchUrl || page.detailUrl;
  // Match LayarKacaProvider: dispatch the selected URL through the extractor
  // chain. In particular, /iframe3/p2p/ must reach the P2P api2.php path
  // instead of being parsed as an ad-bearing HTML shell.
  let resolved = await layarkacaResolveUrl(
    player.url,
    playerReferer,
    0,
    new Set(),
    player.label || server.name,
    page.watchUrl,
  );
  // The /iframe3/ endpoint is a browser-only shell. In a real page it creates
  // a second iframe (for example an Abyss player) after the parent watch page
  // has established the embedding context. If the direct request is blocked
  // or empty, let the generic WebView resolver observe that parent navigation
  // and return the nested extractor URL. The app still knows nothing about
  // this provider-specific chain; only this extension supplies the pattern.
  if (!resolved && page.watchUrl && page.watchUrl !== player.url &&
      !/\/iframe3\//i.test(player.url)) {
    resolved = await layarkacaResolveWebViewCandidate(
      page.watchUrl,
      playerReferer,
      0,
      new Set(),
      player.label || server.name,
    );
  }
  if (!resolved) throw new Error('LayarKaca extractor returned no playable media');
  return resolved;
}

async function layarkacaResolveSource(sourceId) {
  if (typeof sourceId !== 'string') throw new Error('Invalid LayarKaca source id');
  const separator = sourceId.indexOf(':');
  const provider = LAYARKACA_SERVERS.find(
    (server) => server.providerKey === sourceId.slice(0, separator),
  );
  if (!provider) throw new Error('Invalid LayarKaca source id');
  return layarkacaResolveServerSource(sourceId, provider);
}

globalThis.__streamProviders = globalThis.__streamProviders || [];
for (const server of LAYARKACA_SERVERS) {
  globalThis.__streamProviders.push({
    providerKey: server.providerKey,
    fanoutGroup: LAYARKACA_PROVIDER_PREFIX,
    sources: (args) => layarkacaSourcesForServer(args, server),
    resolve: (sourceId) => layarkacaResolveServerSource(sourceId, server),
  });
}

globalThis.__layarkacaHighlightPage = (category, page) => {
  if (category !== 'movie' && category !== 'tv') return {items: []};
  return layarkacaCatalogFeedPage(category, page);
};

globalThis.__metaProviders = globalThis.__metaProviders || [];
globalThis.__metaProviders.push({
  providerId: LAYARKACA_CATALOG_PROVIDER_ID,
  meta: layarkacaCatalogMeta,
});

globalThis.__extension = globalThis.__extension || {};
if (!globalThis.__extension.sources) {
  globalThis.__extension.sources = async (args) => {
    const grouped = new Map();
    const calls = [];
    for (const provider of globalThis.__streamProviders) {
      const groupKey = provider.fanoutGroup || `provider:${provider.providerKey}`;
      if (!grouped.has(groupKey)) grouped.set(groupKey, []);
      grouped.get(groupKey).push(provider);
    }
    for (const providers of grouped.values()) {
      calls.push(Promise.all(providers.map((provider) =>
        Promise.resolve().then(() => provider.sources(args)).catch(() => ({sources: []})),
      )).then((results) => ({
        sources: results.flatMap((result) => result.sources || []),
      })));
    }
    if (args.fast !== true) {
      const results = await Promise.all(calls);
      return {sources: results.flatMap((result) => result.sources || [])};
    }
    return new Promise((resolve) => {
      let remaining = calls.length;
      let returned = false;
      for (const call of calls) call.then((result) => {
        if (returned) return;
        const sources = Array.isArray(result.sources) ? result.sources : [];
        if (sources.length > 0) { returned = true; resolve({sources}); return; }
        remaining -= 1;
        if (remaining === 0) resolve({sources: []});
      });
    });
  };
  globalThis.__extension.resolve = async (args) => {
    const sourceId = args.sourceId;
    const separator = sourceId.indexOf(':');
    if (separator < 0) throw new Error(`Malformed source id: ${sourceId}`);
    const provider = globalThis.__streamProviders.find(
      (entry) => entry.providerKey === sourceId.slice(0, separator));
    if (!provider) throw new Error(`No stream provider registered for "${sourceId.slice(0, separator)}"`);
    return provider.resolve(sourceId);
  };
}

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
// chain rather than a fan-out. Sokuja owns the live anime catalog when it is
// present; this keeps AniList available as a metadata/search fallback for
// isolated bundles and existing AniList refs.
globalThis.__extension = globalThis.__extension || {};
const anilistPreviousSearch = globalThis.__extension.search;
globalThis.__extension.search = async (args) => {
  if (args && args.category === ANILIST_CATEGORY &&
      !globalThis.__sokujaCatalogActive) {
    return anilistSearch(args);
  }
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

// Nimora's unified Shorts feed.
//
// Individual providers remain responsible for preview resolution. This
// catalog only combines their lightweight catalog results so the app receives
// one stable, globally ordered feed instead of one static provider block after
// another.

const NIMORA_SHORTS_PROVIDER_ID = 'nimora.shorts';
const NIMORA_SHORTS_CATALOG_ID = 'shorts';
const NIMORA_SHORTS_MAX_ITEMS = 150;
const NIMORA_SHORTS_MAX_PROVIDER_STREAK = 2;

function nimoraShortsTimestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function nimoraShortsCandidate(item, providerId, publishedAt, ordinal) {
  if (item == null || item.ref == null) return null;
  return {
    item,
    providerId,
    publishedAt: nimoraShortsTimestamp(publishedAt),
    ordinal,
  };
}

async function nimoraShortsUefaCandidates() {
  if (typeof uefaStorytellerStories !== 'function') return [];
  const stories = await uefaStorytellerStories();
  const candidates = [];
  for (const story of stories) {
    if (
      story == null || story.isPublished === false || story.id == null ||
      (typeof uefaStorytellerIsCuratedStory === 'function' &&
        !uefaStorytellerIsCuratedStory(story))
    ) continue;
    const publishedAt = story.publishAt || story.lastModificationTime || story.creationTime;
    const pages = typeof uefaStorytellerVideoPages === 'function'
      ? uefaStorytellerVideoPages(story)
      : [];
    pages.forEach(({ page }, videoIndex) => {
      if (candidates.length >= UEFA_STORYTELLER_MAX_ITEMS) return;
      const item = uefaStorytellerItem(story, page, videoIndex, pages.length);
      const candidate = nimoraShortsCandidate(
        item,
        'nimora.uefa',
        publishedAt,
        candidates.length,
      );
      if (candidate != null) candidates.push(candidate);
    });
  }
  return candidates;
}

async function nimoraShortsCliproCandidates() {
  if (typeof cliproMoments !== 'function') return [];
  const fetchedMoments = await cliproMoments();
  const moments = typeof cliproCuratedMoments === 'function'
    ? cliproCuratedMoments(fetchedMoments)
    : fetchedMoments;
  const candidates = [];
  for (const moment of moments) {
    const item = typeof cliproMomentItem === 'function'
      ? cliproMomentItem(moment)
      : null;
    const candidate = nimoraShortsCandidate(
      item,
      'nimora.clipro',
      moment && (moment.createTime || moment.updateTime),
      candidates.length,
    );
    if (candidate != null) candidates.push(candidate);
  }
  return candidates;
}

async function nimoraShortsCatalogCandidates() {
  const loaders = [];
  if (typeof nimoraShortsUefaCandidates === 'function') {
    loaders.push(nimoraShortsUefaCandidates().catch(() => []));
  }
  if (typeof nimoraShortsCliproCandidates === 'function') {
    loaders.push(nimoraShortsCliproCandidates().catch(() => []));
  }
  if (typeof tmdbPreviewCatalog === 'function') {
    loaders.push(
      tmdbPreviewCatalog()
        .then((page) => {
          const sections = page && Array.isArray(page.sections) ? page.sections : [];
          const items = sections.flatMap((section) =>
            section && Array.isArray(section.items) ? section.items : [],
          );
          return items
            .map((item, index) => nimoraShortsCandidate(
              item,
              item && item.ref && item.ref.providerId,
              null,
              index,
            ))
            .filter((candidate) => candidate != null);
        })
        .catch(() => []),
    );
  }
  if (typeof dramadevShortsCatalog === 'function') {
    loaders.push(
      dramadevShortsCatalog()
        .then((page) => {
          const sections = page && Array.isArray(page.sections) ? page.sections : [];
          const items = sections.flatMap((section) =>
            section && Array.isArray(section.items) ? section.items : [],
          );
          return items
            .map((item, index) => nimoraShortsCandidate(
              item,
              item && item.ref && item.ref.providerId,
              null,
              index,
            ))
            .filter((candidate) => candidate != null);
        })
        .catch(() => []),
    );
  }
  const groups = await Promise.all(loaders);
  return groups.flat();
}

function nimoraShortsCandidateKey(candidate) {
  const ref = candidate && candidate.item && candidate.item.ref;
  if (ref == null) return null;
  return `${ref.extensionId}/${ref.providerId}/${ref.id}`;
}

function nimoraShortsSortCandidates(candidates) {
  const deduplicated = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = nimoraShortsCandidateKey(candidate);
    if (key == null || seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(candidate);
  }
  deduplicated.sort((a, b) => {
    const aDate = a.publishedAt;
    const bDate = b.publishedAt;
    if (aDate != null && bDate == null) return -1;
    if (aDate == null && bDate != null) return 1;
    if (aDate != null && bDate != null && aDate !== bDate) return bDate - aDate;
    return a.ordinal - b.ordinal;
  });
  return deduplicated;
}

// Keep the global freshness ordering, but pull the next candidate from a
// different provider when one source would otherwise dominate the viewport.
function nimoraShortsDiversify(candidates) {
  const remaining = candidates.slice();
  const result = [];
  let lastProvider = null;
  let providerStreak = 0;
  while (remaining.length > 0 && result.length < NIMORA_SHORTS_MAX_ITEMS) {
    let index = remaining.findIndex((candidate) => {
      if (candidate.providerId !== lastProvider) return true;
      return providerStreak < NIMORA_SHORTS_MAX_PROVIDER_STREAK;
    });
    if (index < 0) index = 0;
    const [candidate] = remaining.splice(index, 1);
    if (candidate.providerId === lastProvider) {
      providerStreak++;
    } else {
      lastProvider = candidate.providerId;
      providerStreak = 1;
    }
    result.push(candidate.item);
  }
  return result;
}

async function nimoraShortsCatalog() {
  const candidates = await nimoraShortsCatalogCandidates();
  return {
    sections: [{
      id: 'shorts',
      title: 'Recommended Shorts',
      items: nimoraShortsDiversify(nimoraShortsSortCandidates(candidates)),
    }],
  };
}

globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: NIMORA_SHORTS_CATALOG_ID,
  catalog: nimoraShortsCatalog,
});

// PlayZTV live events stream provider.
//
// The upstream plugin is a callback-based SkyStream extension. Nimora keeps
// the same event/link protocol, but exposes only the v2 stream-provider
// contract. It matches against the existing FotMob catalog; it does not add
// a catalog or shelf of its own. URLs are resolved again when selected so
// signed/tokenized links never become stale source ids.

const PLAYZ_PROVIDER_ID = 'nimora.playz';
const PLAYZ_PROVIDER_KEY = 'playz';
const PLAYZ_REMOTE_CONFIG_URL =
  'https://firebaseremoteconfig.googleapis.com/v1/projects/516859456626/namespaces/firebase:fetch';
const PLAYZ_FIREBASE_API_KEY =
  'AIzaSyDKRqLlbaZBIpHzLBiQTUrJqr3gN-nDWWc';
const PLAYZ_FIREBASE_APP_ID =
  '1:516859456626:android:12a75869902c4f8a6826eb';
const PLAYZ_DEFAULT_BASE_URLS = [
  'https://tourniquest.site',
  'https://adsflw.xyz',
  'https://playztv2828.store',
];
const PLAYZ_PRIMARY_KEY = 'Yi8xam1sNW5rNHg1azdwTg==';
const PLAYZ_PRIMARY_IV = 'MTRuTWs4bU41S2w1S0w3bA==';
const PLAYZ_LEGACY_KEY = 'bTVLbDVuazR4SzFrTjdwTg==';
const PLAYZ_LEGACY_IV = 'azVLNG5NOG1LbE5MN2wxNQ==';
const PLAYZ_NATIVE_KEY = 'cz14RStkN01PVE5w';
const PLAYZ_NATIVE_IV = 'WTlEvckd2UR41sdk';
const PLAYZ_SUBSTITUTION_FROM =
  'aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ';
const PLAYZ_SUBSTITUTION_TO =
  'fFgGjJkKaApPbBmMoOzZeEnNcCdDrRqQtTvVuUxXhHiIwWyYlLsS';
const PLAYZ_REVERSE_SUBSTITUTION = {};

for (let i = 0; i < PLAYZ_SUBSTITUTION_TO.length; i++) {
  PLAYZ_REVERSE_SUBSTITUTION[PLAYZ_SUBSTITUTION_TO[i]] =
    PLAYZ_SUBSTITUTION_FROM[i];
}

const PLAYZ_UA =
  'Dalvik/2.1.0 (Linux; U; Android 10; SM-A505F)';

// Keep PlayZTV's matching independent from the full profile's Kora source.
// Compact bundles do not include kora.js, but both profiles still need to
// match PlayZTV broadcasts against FotMob's existing match items.
const PLAYZ_MATCH_PROFILE = {
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
    'athletic club': 'athletic bilbao',
    wolves: 'wolverhampton wanderers',
    'west brom': 'west bromwich albion',
    'west bromwich': 'west bromwich albion',
    'deportivo a coruna': 'deportivo la coruna',
  },
  stopTokens: ['fc', 'afc', 'cf', 'sc', 'ac', 'cd', 'club'],
  ambiguousAlone: [
    'united', 'city', 'town', 'rovers', 'wanderers', 'albion', 'athletic',
    'county', 'real', 'atletico', 'sporting', 'dynamo', 'racing', 'olympique',
  ],
};

function playzText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function playzJson(value) {
  try {
    return JSON.parse(String(value || ''));
  } catch (_) {
    return null;
  }
}

function playzInstanceId() {
  let value = '';
  while (value.length < 32) {
    value += Math.random().toString(16).slice(2);
  }
  return value.slice(0, 32);
}

function playzBase64Url(value) {
  return host.codec.textToBase64(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function playzFromBase64Url(value) {
  let base64 = playzText(value).replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return JSON.parse(host.codec.base64ToText(base64));
}

function playzAbsoluteUrl(base, value) {
  const target = playzText(value);
  if (/^https?:\/\//i.test(target)) return target;
  const originMatch = /^(https?:\/\/[^/]+)/i.exec(playzText(base));
  if (!originMatch || !target) return '';
  if (target.startsWith('//')) return `${originMatch[1].split('://')[0]}:${target}`;
  if (target.startsWith('/')) return `${originMatch[1]}${target}`;
  return `${playzText(base).replace(/\/+$/, '')}/${target.replace(/^\/+/, '')}`;
}

function playzResponseText(response) {
  return response && typeof response.body === 'string' ? response.body : '';
}

function playzDecodeSubstitution(value) {
  return [...playzText(value)].map(
    (char) => PLAYZ_REVERSE_SUBSTITUTION[char] || char,
  ).join('');
}

function playzNormalizeBase64(value) {
  let normalized = playzText(value)
    .replace(/\s/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return normalized;
}

// The primary provider payload has two Base64 layers:
// substitution(payload) -> Base64(ciphertext) -> AES-128-CBC(JSON).
function playzDecodeSubstitutionPayload(value) {
  const restored = playzDecodeSubstitution(value);
  return host.codec.base64ToText(playzNormalizeBase64(restored));
}

function playzAesJson(payload, key, iv) {
  try {
    const plain = host.crypto.aesCbcDecrypt(
      key,
      iv,
      playzNormalizeBase64(payload),
    );
    if (plain == null) return '';
    return playzText(host.codec.base64ToText(plain));
  } catch (_) {
    return '';
  }
}

function playzSwapAdjacent(value) {
  const chars = [...value];
  for (let index = 0; index + 1 < chars.length; index += 2) {
    const temp = chars[index];
    chars[index] = chars[index + 1];
    chars[index + 1] = temp;
  }
  return chars.join('');
}

// Current PlayZTV feeds use the native plugin's byte transform before AES:
// Base64 -> reverse bytes -> swap adjacent bytes -> Base64 -> AES-CBC.
function playzNativeCiphertext(value) {
  const decoded = host.codec.base64ToText(playzNormalizeBase64(value));
  return playzSwapAdjacent([...decoded].reverse().join(''));
}

// Compatibility format used by the Android provider: the ciphertext is
// reconstructed from the first/last 10 characters while IV and key are
// embedded in the middle and tail of the payload.
function playzDecodeEmbeddedEnvelope(value) {
  const raw = playzText(value).replace(/\s/g, '');
  if (raw.length < 79) return '';
  const encrypted = raw.slice(0, 10) + raw.slice(34, raw.length - 54) + raw.slice(-10);
  const iv = raw.slice(10, 34);
  const key = raw.slice(raw.length - 54, raw.length - 10);
  return playzAesJson(encrypted, key, iv);
}

function playzDecodeEncrypted(value) {
  const raw = playzText(value);
  if (!raw) return '';
  if (raw.startsWith('{') || raw.startsWith('[')) return raw;

  let native = '';
  try {
    native = playzAesJson(
      playzNativeCiphertext(raw),
      host.codec.textToBase64(PLAYZ_NATIVE_KEY),
      host.codec.textToBase64(PLAYZ_NATIVE_IV),
    );
  } catch (_) {}
  if (native.startsWith('{') || native.startsWith('[')) return native;

  const primary = playzAesJson(
    playzDecodeSubstitutionPayload(raw),
    PLAYZ_PRIMARY_KEY,
    PLAYZ_PRIMARY_IV,
  );
  if (primary.startsWith('{') || primary.startsWith('[')) return primary;

  const fallback = playzAesJson(raw, PLAYZ_LEGACY_KEY, PLAYZ_LEGACY_IV);
  if (fallback.startsWith('{') || fallback.startsWith('[')) return fallback;

  const embedded = playzDecodeEmbeddedEnvelope(raw);
  if (embedded.startsWith('{') || embedded.startsWith('[')) return embedded;

  return '';
}

async function playzFetch(url, options) {
  const response = await fetch(url, options || {});
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`PlayZTV request failed: ${response.status}`);
  }
  return response;
}

async function playzRemoteBases() {
  const override = globalThis.__playzBaseUrls;
  if (Array.isArray(override)) return override.filter((value) => playzText(value));

  try {
    const response = await playzFetch(PLAYZ_REMOTE_CONFIG_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Android-Package': 'com.playz.tv',
        'X-Goog-Api-Key': PLAYZ_FIREBASE_API_KEY,
        'User-Agent': 'okhttp/4.12.0',
      },
      body: JSON.stringify({
        appInstanceId: playzInstanceId(),
        appInstanceIdToken: '',
        appId: PLAYZ_FIREBASE_APP_ID,
        countryCode: 'US',
        languageCode: 'en-US',
        platformVersion: '30',
        timeZone: 'UTC',
        appVersion: '2.1',
        appBuild: '4',
        packageName: 'com.playz.tv',
        sdkVersion: '22.1.0',
        analyticsUserProperties: {},
      }),
    });
    const data = playzJson(playzResponseText(response));
    const configured = data && data.entries && data.entries.api_url;
    if (playzText(configured)) return [configured, ...PLAYZ_DEFAULT_BASE_URLS];
  } catch (_) {
    // The static mirrors remain useful when Remote Config is unavailable.
  }
  return PLAYZ_DEFAULT_BASE_URLS.slice();
}

let playzBasesMemo = null;
async function playzBaseUrls() {
  if (playzBasesMemo == null) {
    playzBasesMemo = playzRemoteBases().then((values) => {
      const seen = new Set();
      return values
        .map((value) => playzText(value).replace(/\/+$/, ''))
        .filter((value) => /^https?:\/\//i.test(value) && !seen.has(value) && seen.add(value));
    });
  }
  return playzBasesMemo;
}

async function playzFetchDecoded(path) {
  const target = playzText(path);
  if (!target) return '';
  const bases = await playzBaseUrls();
  for (const base of bases) {
    try {
      const response = await playzFetch(
        playzAbsoluteUrl(base, target),
        { headers: { 'User-Agent': PLAYZ_UA, Accept: '*/*' } },
      );
      const decoded = playzDecodeEncrypted(playzResponseText(response));
      if (decoded) return decoded;
    } catch (_) {
      // Continue to the next mirror.
    }
  }
  return '';
}

async function playzFetchJson(path) {
  const decoded = await playzFetchDecoded(path);
  const data = playzJson(decoded);
  return data;
}

function playzDate(date, time) {
  const dateMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(playzText(date));
  const timeMatch = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(playzText(time));
  if (!dateMatch || !timeMatch) return null;
  const ms = Date.UTC(
    Number(dateMatch[3]), Number(dateMatch[2]) - 1, Number(dateMatch[1]),
    Number(timeMatch[1]), Number(timeMatch[2]), Number(timeMatch[3] || 0),
  );
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function playzStatus(event, now) {
  const end = playzDate(event.endDate, event.endTime);
  if (end && now >= end.getTime()) return 'ended';
  const start = playzDate(event.date, event.time);
  if (start && now >= start.getTime()) return 'live';
  return 'upcoming';
}

function playzCategory(value) {
  const category = playzText(value) || 'Other';
  if (/cricket/i.test(category)) return 'Cricket';
  if (/football|soccer/i.test(category)) return 'Football';
  if (/basketball/i.test(category)) return 'Basketball';
  if (/tennis/i.test(category)) return 'Tennis';
  if (/boxing/i.test(category)) return 'Boxing';
  if (/motorsport|formula|racing/i.test(category)) return 'Motorsport';
  if (/wwe|wrestling/i.test(category)) return 'WWE';
  return category;
}

function playzEventTitle(event) {
  const home = playzText(event.teamAName);
  const away = playzText(event.teamBName);
  if (home && away && home !== away) return `${home} vs ${away}`;
  return playzText(event.eventName) || 'Live Event';
}

function playzNormalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const event = typeof raw.event === 'string' ? playzJson(raw.event) : raw;
  if (!event || event.visible === false) return null;
  const linksPath = playzText(event.links);
  if (!linksPath) return null;
  return {
    category: playzCategory(event.category),
    eventName: playzText(event.eventName),
    eventLogo: playzText(event.eventLogo),
    teamAName: playzText(event.teamAName),
    teamBName: playzText(event.teamBName),
    teamAFlag: playzText(event.teamAFlag),
    teamBFlag: playzText(event.teamBFlag),
    linksPath,
    date: playzText(event.date),
    time: playzText(event.time),
    endDate: playzText(event.end_date),
    endTime: playzText(event.end_time),
    priority: Number.isFinite(event.priority) ? event.priority : Number(event.priority || 0),
    linkNames: Array.isArray(event.link_names) ? event.link_names : [],
  };
}

function playzEvents(data) {
  if (!Array.isArray(data)) return [];
  return data.map(playzNormalizeEvent).filter((event) => event != null);
}

let playzEventsMemo = null;
async function playzLoadEvents() {
  if (playzEventsMemo == null) {
    playzEventsMemo = playzFetchJson('events.txt').then(playzEvents).catch((error) => {
      playzEventsMemo = null;
      throw error;
    });
  }
  return playzEventsMemo;
}

function playzSplit(value) {
  const parts = playzText(value).split('|');
  const headers = {};
  for (const part of parts.slice(1)) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    let headerValue = part.slice(index + 1);
    try { headerValue = decodeURIComponent(headerValue); } catch (_) {}
    headers[part.slice(0, index)] = headerValue;
  }
  return { url: parts[0], headers };
}

function playzEntries(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry === 'object');
  return value && typeof value === 'object' ? [value] : [];
}

function playzSourceId(payload) {
  return `${PLAYZ_PROVIDER_KEY}:${playzBase64Url(payload)}`;
}

async function playzSourcesForEvent(event) {
  const links = playzEntries(await playzFetchJson(event.linksPath));
  return links.map((link, index) => ({
    id: playzSourceId({ p: event.linksPath, i: index, n: event.linkNames || [] }),
    label: playzText(link.name) || playzText(event.linkNames && event.linkNames[index]) || `PlayZTV ${index + 1}`,
    provider: 'Nimora',
    providerId: PLAYZ_PROVIDER_ID,
  }));
}

async function playzSources(args) {
  if (args.enabledProviders != null && !args.enabledProviders.includes(PLAYZ_PROVIDER_ID)) {
    return { sources: [] };
  }
  const item = args.item || {};
  if (!item.ref || item.ref.providerId !== 'nimora.matches') return { sources: [] };
  if (!Array.isArray(item.participants) || item.participants.length !== 2) {
    return { sources: [] };
  }

  let events;
  try {
    events = await playzLoadEvents();
  } catch (_) {
    return { sources: [] };
  }
  const now = Date.now();
  const candidates = events
    .filter((event) => playzStatus(event, now) !== 'ended')
    .filter((event) => event.teamAName && event.teamBName)
    .map((event) => {
      const startsAt = playzDate(event.date, event.time);
      return {
        event,
        teamA: event.teamAName,
        teamB: event.teamBName,
        startsAt: startsAt ? startsAt.toISOString() : null,
      };
    });
  if (candidates.length === 0) return { sources: [] };

  let result;
  try {
    result = host.match.resolve(
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
      { profile: PLAYZ_MATCH_PROFILE },
    );
  } catch (_) {
    return { sources: [] };
  }
  if (!result || !candidates[result.index]) return { sources: [] };

  try {
    return { sources: await playzSourcesForEvent(candidates[result.index].event) };
  } catch (_) {
    return { sources: [] };
  }
}

function playzExtractUrl(text, key) {
  const body = playzText(text);
  const parsed = playzJson(body);
  const desired = playzText(key) || 'playback_url';
  if (parsed && typeof parsed === 'object' && playzText(parsed[desired])) return playzText(parsed[desired]);
  const escaped = desired.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`, 'i').exec(body);
  if (match) return match[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
  const media = /https?:\\?\/\\?\/[^"'<>\\s]+?\.(?:m3u8|mpd|mp4)(?:[^"'<>\\s]*)/i.exec(body);
  return media ? media[0].replace(/\\\//g, '/') : '';
}

async function playzToken(entry) {
  const config = playzJson(entry.tokenApi);
  if (!config || !config.api) return null;
  const request = playzSplit(config.api);
  const headers = Object.assign({ 'User-Agent': PLAYZ_UA }, request.headers);
  const options = { headers };
  if (playzText(config.request_type).toLowerCase() === 'post') {
    options.method = 'POST';
    options.body = playzText(config.request_body);
    if (!options.headers['Content-Type']) {
      options.headers['Content-Type'] = playzText(config.request_body_type).toLowerCase() === 'json'
        ? 'application/json' : 'application/x-www-form-urlencoded';
    }
  }
  const response = await playzFetch(request.url, options);
  const decoded = playzDecodeEncrypted(playzResponseText(response)) || playzResponseText(response);
  const url = playzExtractUrl(decoded, config.link_key);
  return url ? { url, headers } : null;
}

function playzFormat(url) {
  if (/\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (
    /\.m3u8?(?:[?#]|$)/i.test(url) ||
    /\/hls\//i.test(url) ||
    /\/play\.php\?/i.test(url) ||
    /[?&]e=\.m3u(?:[&#]|$)/i.test(url)
  ) return 'hls';
  return 'other';
}

function playzDrm(entry, parsed, url) {
  const raw = playzText(entry.api || parsed.drmApi);
  if (!raw) return null;
  if (/^[0-9a-f]{32,}:[0-9a-f]{32,}$/i.test(raw)) {
    const parts = raw.split(':');
    const kid = host.codec.hexToBase64(parts[0]).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const key = host.codec.hexToBase64(parts[1]).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { scheme: 'clearKey', clearKeyJson: JSON.stringify({ keys: [{ kty: 'oct', k: key, kid }], type: 'temporary' }) };
  }
  if (/^https?:\/\//i.test(raw) && playzFormat(url) === 'dash') {
    return { scheme: 'widevine', licenseUrl: raw };
  }
  return null;
}

async function playzResolve(sourceId) {
  const prefix = `${PLAYZ_PROVIDER_KEY}:`;
  if (!playzText(sourceId).startsWith(prefix)) throw new Error(`Invalid PlayZTV source id: ${sourceId}`);
  const payload = playzFromBase64Url(sourceId.slice(prefix.length));
  const links = playzEntries(await playzFetchJson(payload.p));
  const entry = links[payload.i];
  if (!entry) throw new Error('PlayZTV source is no longer offered');

  let resolved = await playzToken(entry);
  const direct = playzSplit(entry.link);
  if (!resolved) resolved = direct.url ? { url: direct.url, headers: direct.headers } : null;
  if (!resolved || !/^https?:\/\//i.test(resolved.url)) throw new Error('PlayZTV returned no playable URL');

  const headers = Object.assign({}, direct.headers, resolved.headers);
  const format = playzFormat(resolved.url);
  if (format === 'hls' || format === 'dash') {
    const manifest = await playzFetch(resolved.url, { headers });
    const body = playzText(playzResponseText(manifest));
    if ((format === 'hls' && !body.startsWith('#EXTM3U')) ||
        (format === 'dash' && !/<MPD(?:\s|>)/i.test(body))) {
      throw new Error('PlayZTV returned an invalid playback manifest');
    }
  }
  return {
    url: resolved.url,
    headers,
    format,
    drm: playzDrm(entry, direct, resolved.url),
    label: playzText(entry.name) || playzText(payload.n && payload.n[payload.i]) || `PlayZTV ${Number(payload.i) + 1}`,
  };
}

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: PLAYZ_PROVIDER_KEY,
  sources: playzSources,
  resolve: playzResolve,
});

// RoxieStreams live-event source provider.
//
// RoxieStreams publishes event pages separately from its stream host list.
// Roxie contributes missing items to the existing Nimora live-event catalog,
// but does not declare a separate user-facing catalog. Its current event page
// and domain list are fetched again when a source is resolved.

const ROXIE_PROVIDER_ID = 'nimora.roxie';
const ROXIE_PROVIDER_KEY = 'roxie';
const ROXIE_ORIGIN = 'https://roxiestreams.su';
const ROXIE_HOME_PATH = '/';
const ROXIE_INDEX_PATH = '/soccer';
const ROXIE_DOMAINS_PATH = '/domainsz74.txt';
const ROXIE_UPCOMING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ROXIE_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
// countdownfinal2.js reparses the displayed local time as Pacific daylight
// time before comparing it with Date.now(). Keep the same fixed offset here;
// the source page currently uses -07:00 for both its countdown and localized
// start-time display.
const ROXIE_COUNTDOWN_OFFSET = '-07:00';
const ROXIE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

// Keep Roxie's matching independent from the full profile's Kora source.
// Compact bundles do not include kora.js, but both profiles still need to
// match Roxie soccer broadcasts against FotMob's existing match items.
const ROXIE_MATCH_PROFILE = {
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
    'athletic club': 'athletic bilbao',
    wolves: 'wolverhampton wanderers',
    'west brom': 'west bromwich albion',
    'west bromwich': 'west bromwich albion',
    'deportivo a coruna': 'deportivo la coruna',
  },
  stopTokens: ['fc', 'afc', 'cf', 'sc', 'ac', 'cd', 'club'],
  ambiguousAlone: [
    'united', 'city', 'town', 'rovers', 'wanderers', 'albion', 'athletic',
    'county', 'real', 'atletico', 'sporting', 'dynamo', 'racing', 'olympique',
  ],
};

function roxieText(value) {
  return value == null ? '' : String(value).trim();
}

function roxieOrigin() {
  return roxieText(globalThis.__roxieOrigin) || ROXIE_ORIGIN;
}

function roxiePageUrl(path) {
  const target = roxieText(path);
  if (/^https?:\/\//i.test(target)) return target;
  return `${roxieOrigin().replace(/\/+$/, '')}/${target.replace(/^\/+/, '')}`;
}

async function roxieFetch(path, options) {
  const response = await fetch(roxiePageUrl(path), options || {});
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`RoxieStreams request failed: ${response.status}`);
  }
  return response;
}

function roxieResponseText(response) {
  return response && typeof response.body === 'string' ? response.body : '';
}

function roxieDecodeEntities(value) {
  return roxieText(value)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function roxieStripHtml(value) {
  return roxieDecodeEntities(
    roxieText(value)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' '),
  );
}

function roxieNormalize(value) {
  let text = roxieDecodeEntities(value).toLowerCase();
  try { text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  return text.replace(/[^a-z0-9]+/g, ' ').trim();
}

function roxieDate(value) {
  const text = roxieText(value);
  if (!text) return null;
  const localDate = text.match(
    /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,)?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)$/i,
  );
  // The raw Roxie table has no timezone. Append the same offset used by its
  // countdown script instead of inheriting the extension runtime timezone.
  const timestamp = Date.parse(
    localDate == null ? text : `${text}${ROXIE_COUNTDOWN_OFFSET}`,
  );
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function roxieDateInContext(body, start, end) {
  const rowStart = body.lastIndexOf('<tr', start);
  const rowClose = body.indexOf('</tr>', end);
  const context = rowStart !== -1 && rowClose !== -1
    ? body.slice(rowStart, rowClose)
    : body.slice(Math.max(0, start - 700), Math.min(body.length, end + 700));
  const text = roxieStripHtml(context);
  const dateMatch = text.match(
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,)?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\b/i,
  );
  return roxieDate(dateMatch && dateMatch[0]);
}

function roxieParseIndex(html) {
  const body = roxieText(html);
  const events = [];
  const linkPattern = /<a\b[^>]*href\s*=\s*["'](\/soccer-streams-[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(body)) != null) {
    const title = roxieStripHtml(match[2]);
    const sides = title.split(/\s+vs\.?\s+/i).map(roxieText);
    if (sides.length !== 2 || !sides[0] || !sides[1]) continue;

    events.push({
      pagePath: match[1],
      title,
      teamA: sides[0],
      teamB: sides[1],
      startsAt: roxieDateInContext(body, match.index, linkPattern.lastIndex),
    });
  }
  return events;
}

function roxieParseGenericIndex(html) {
  const body = roxieText(html);
  const events = [];
  const linkPattern = /<a\b[^>]*href\s*=\s*["'](\/(?:ppv-streams-\d+|f1|nfl|ufc|tennis-\d+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(body)) != null) {
    const title = roxieStripHtml(match[2]);
    if (!title) continue;
    events.push({
      pagePath: match[1],
      title,
      teamA: '',
      teamB: '',
      startsAt: roxieDateInContext(body, match.index, linkPattern.lastIndex),
    });
  }
  return events;
}

function roxieParseStreamPage(html) {
  const match = /getRandomStream\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/i.exec(roxieText(html));
  if (!match) return null;
  return {
    streamPath: match[1].trim(),
    subdomain: match[2].trim(),
  };
}

function roxieParseDomains(value) {
  const domains = [];
  for (const line of roxieText(value).split(/\r?\n/)) {
    const domain = line
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '');
    if (!domain || !/^[a-z0-9.-]+(?::\d+)?$/i.test(domain)) continue;
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

function roxieSourceId(payload) {
  return `${ROXIE_PROVIDER_KEY}:${host.codec.textToBase64(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')}`;
}

function roxieFromSourceId(sourceId) {
  const prefix = `${ROXIE_PROVIDER_KEY}:`;
  if (!roxieText(sourceId).startsWith(prefix)) {
    throw new Error(`Invalid RoxieStreams source id: ${sourceId}`);
  }
  let encoded = sourceId.slice(prefix.length).replace(/-/g, '+').replace(/_/g, '/');
  while (encoded.length % 4) encoded += '=';
  const payload = JSON.parse(host.codec.base64ToText(encoded));
  if (!payload || !payload.p || !payload.s || !payload.h || !payload.d) {
    throw new Error('Invalid RoxieStreams source payload');
  }
  return payload;
}

function roxieStreamUrl(subdomain, domain, streamPath) {
  const override = roxieText(globalThis.__roxieStreamBaseUrl);
  if (override) {
    return `${override.replace(/\/+$/, '')}/${roxieText(streamPath).replace(/^\/+/, '')}`;
  }
  const scheme = /^https:/i.test(roxieOrigin()) ? 'https' : 'http';
  return `${scheme}://${roxieText(subdomain)}.${roxieText(domain)}/${roxieText(streamPath).replace(/^\/+/, '')}`;
}

async function roxieLoadEvents() {
  const response = await roxieFetch(ROXIE_INDEX_PATH, {
    headers: {
      Accept: 'text/html,*/*;q=0.8',
      Referer: `${roxieOrigin().replace(/\/+$/, '')}/`,
      'User-Agent': ROXIE_UA,
    },
  });
  return roxieParseIndex(roxieResponseText(response));
}

async function roxieLoadGenericEvents() {
  const response = await roxieFetch(ROXIE_HOME_PATH, {
    headers: {
      Accept: 'text/html,*/*;q=0.8',
      Referer: `${roxieOrigin().replace(/\/+$/, '')}/`,
      'User-Agent': ROXIE_UA,
    },
  });
  return roxieParseGenericIndex(roxieResponseText(response));
}

function roxieSportName(event) {
  if (event.teamA && event.teamB) return 'Football';
  if (/\/f1(?:$|-)/i.test(event.pagePath)) return 'Motorsport';
  if (/\/tennis-/i.test(event.pagePath)) return 'Tennis';
  const identity = roxieNormalize(`${event.title} ${event.pagePath}`);
  if (
    /ppv streams|ufc|boxing|mma|wwe|wrestling|fighting|combat|kickboxing|one samurai|one championship|fight night/.test(identity)
  ) {
    return 'Fighting';
  }
  return 'Other Live Sports';
}

function roxieCatalogTitleKey(value) {
  if (typeof catalogTitleKey === 'function') return catalogTitleKey(value);
  return roxieNormalize(value)
    .replace(/\bformula one\b|\bf1\b/g, 'formula 1')
    .replace(/\bmoto gp\b/g, 'motogp');
}

function roxieEventDedupeKey(event) {
  if (!event.teamA || !event.teamB) {
    return `generic:${event.pagePath}:${roxieNormalize(event.title)}`;
  }
  return `football:${[event.teamA, event.teamB]
    .map(roxieNormalize)
    .sort()
    .join('|')}:${event.startsAt}`;
}

function roxieEventIsRelevant(event, nowMs) {
  const startsAt = Date.parse(event.startsAt);
  if (!Number.isFinite(startsAt)) return false;
  return startsAt - nowMs <= ROXIE_UPCOMING_WINDOW_MS &&
    nowMs - startsAt <= ROXIE_RECENT_WINDOW_MS;
}

function roxieCountdownState(event, nowMs) {
  const startsAt = Date.parse(event.startsAt);
  if (!Number.isFinite(startsAt)) return 'scheduled';
  return startsAt <= nowMs ? 'live' : 'scheduled';
}

function roxieCatalogId(event) {
  const payload = {
    p: event.pagePath,
    t: roxieNormalize(event.title),
    k: event.startsAt,
  };
  return `roxie:${host.codec.textToBase64(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')}`;
}

function roxieCatalogEntry(event, nowMs = Date.now()) {
  const startsAt = Date.parse(event.startsAt);
  // The event page countdown is the source of truth. A stale `live` flag from
  // an index/cache must not promote a future event into the Live catalog.
  const state = roxieCountdownState(event, nowMs);
  const live = state === 'live';
  const item = {
    ref: {
      extensionId: globalThis.__nimoraExtensionId || 'nimora',
      providerId: 'nimora.matches',
      id: roxieCatalogId(event),
    },
    kind: 'event',
    title: event.title,
    subtitle: roxieSportName(event),
    schedule: typeof eventSchedule === 'function'
      ? eventSchedule(startsAt, state, roxieSportName(event), event.title)
      : {
          startsAt: new Date(startsAt).toISOString(),
          state,
        },
  };
  if (event.teamA && event.teamB) {
    item.participants = [{ name: event.teamA }, { name: event.teamB }];
  }
  return {
    sportId: roxieSportName(event),
    sportName: roxieSportName(event),
    live,
    item,
  };
}

async function roxieSportEntries(nowMs) {
  const [soccer, generic] = await Promise.all([
    roxieLoadEvents().catch(() => []),
    roxieLoadGenericEvents().catch(() => []),
  ]);
  const seen = new Set();
  return [...soccer, ...generic]
    .filter((event) => roxieEventIsRelevant(event, nowMs))
    .filter((event) => {
      const key = roxieEventDedupeKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((event) => roxieCatalogEntry(event, nowMs));
}

async function roxieLoadStream(event) {
  const response = await roxieFetch(event.pagePath, {
    headers: {
      Accept: 'text/html,*/*;q=0.8',
      Referer: `${roxieOrigin().replace(/\/+$/, '')}${ROXIE_INDEX_PATH}`,
      'User-Agent': ROXIE_UA,
    },
  });
  const stream = roxieParseStreamPage(roxieResponseText(response));
  if (!stream || !stream.streamPath || !stream.subdomain) {
    throw new Error('RoxieStreams event has no stream');
  }
  return stream;
}

async function roxieLoadDomains(referer) {
  const response = await roxieFetch(ROXIE_DOMAINS_PATH, {
    headers: {
      Accept: 'text/plain,*/*;q=0.8',
      Referer: `${roxieOrigin().replace(/\/+$/, '')}${roxieText(referer) || ROXIE_INDEX_PATH}`,
      'User-Agent': ROXIE_UA,
    },
  });
  return roxieParseDomains(roxieResponseText(response));
}

async function roxieSources(args) {
  if (args.enabledProviders != null && !args.enabledProviders.includes(ROXIE_PROVIDER_ID)) {
    return { sources: [] };
  }
  const item = args.item || {};
  if (!item.ref || item.ref.providerId !== 'nimora.matches') return { sources: [] };
  let events;
  try {
    if (Array.isArray(item.participants) && item.participants.length === 2) {
      events = await roxieLoadEvents();
    } else if (roxieText(item.title)) {
      events = await roxieLoadGenericEvents();
    } else {
      return { sources: [] };
    }
  } catch (_) {
    return { sources: [] };
  }
  if (events.length === 0) return { sources: [] };

  let event;
  if (Array.isArray(item.participants) && item.participants.length === 2) {
    let result;
    try {
      result = host.match.resolve(
        {
          teamA: item.participants[0].name,
          teamB: item.participants[1].name,
          teamAShort: item.participants[0].shortName || null,
          teamBShort: item.participants[1].shortName || null,
          kickoff: item.schedule ? item.schedule.startsAt : null,
        },
        events.map((candidate) => ({
          teamA: candidate.teamA,
          teamB: candidate.teamB,
          startsAt: candidate.startsAt,
        })),
        { profile: ROXIE_MATCH_PROFILE },
      );
    } catch (_) {
      return { sources: [] };
    }
    event = result && events[result.index];
  } else {
    const title = roxieCatalogTitleKey(item.title);
    event = events.find((candidate) =>
      roxieCatalogTitleKey(candidate.title) === title);
  }
  if (!event) return { sources: [] };

  try {
    const stream = await roxieLoadStream(event);
    const domains = await roxieLoadDomains(event.pagePath);
    return {
      sources: domains.map((domain) => ({
        id: roxieSourceId({
          p: event.pagePath,
          s: stream.streamPath,
          h: stream.subdomain,
          d: domain,
        }),
        label: `RoxieStreams · ${domain}`,
        provider: 'Nimora',
        providerId: ROXIE_PROVIDER_ID,
      })),
    };
  } catch (_) {
    return { sources: [] };
  }
}

async function roxieResolve(sourceId) {
  const payload = roxieFromSourceId(sourceId);
  const eventResponse = await roxieFetch(payload.p, {
    headers: {
      Accept: 'text/html,*/*;q=0.8',
      Referer: `${roxieOrigin().replace(/\/+$/, '')}${ROXIE_INDEX_PATH}`,
      'User-Agent': ROXIE_UA,
    },
  });
  const stream = roxieParseStreamPage(roxieResponseText(eventResponse));
  if (!stream || stream.streamPath !== payload.s || stream.subdomain !== payload.h) {
    throw new Error('RoxieStreams event stream changed; refresh sources');
  }

  const domains = await roxieLoadDomains(payload.p);
  if (!domains.includes(payload.d)) {
    throw new Error('RoxieStreams stream domain is no longer available');
  }

  const origin = roxieOrigin().replace(/\/+$/, '');
  const headers = {
    Accept: '*/*',
    Origin: origin,
    Referer: `${origin}${payload.p}`,
    'User-Agent': ROXIE_UA,
  };
  const url = roxieStreamUrl(payload.h, payload.d, payload.s);
  const response = await fetch(url, { headers });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`RoxieStreams playback request failed: ${response.status}`);
  }
  if (!roxieResponseText(response).startsWith('#EXTM3U')) {
    throw new Error('RoxieStreams returned an invalid HLS manifest');
  }
  return {
    url,
    headers,
    format: 'hls',
    label: `RoxieStreams · ${payload.d}`,
  };
}

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__roxieSportEntries = roxieSportEntries;
globalThis.__streamProviders.push({
  providerKey: ROXIE_PROVIDER_KEY,
  sources: roxieSources,
  resolve: roxieResolve,
});

// League channel catalog.
//
// This is an editorial mapping of channel labels to the seven requested
// competitions. It is intentionally a catalog of upstream channel entries,
// not a claim about territorial broadcast rights or playback health. Source
// ids keep only provider paths and indexes; PlayZ/Cricfy links are fetched
// again when the user opens a channel.

const LEAGUE_CHANNELS_CATALOG_ID = 'league_channels';
const LEAGUE_CHANNELS_PROVIDER_ID = 'nimora.league_channels';
const LEAGUE_CHANNELS_PROVIDER_KEY = 'league_channels';
const LEAGUE_CHANNELS_CATEGORY = 'live';
const LEAGUE_CHANNELS_TTL_MS = 10 * 60 * 1000;
const LEAGUE_CHANNELS_MAX_CATEGORIES = 20;

const LEAGUE_CHANNEL_DEFINITIONS = [
  {
    id: 'premier-league',
    title: 'Premier League',
    patterns: [
      'premier league', 'sky sports premier', 'tnt sports', 'nbc sports',
      'bein sports', 'espn', 'arena sport', 'fox sports', 'dazn', 'fubo',
      'peacock', 'viaplay', 'canal+', 'super sport', 'astro',
    ],
  },
  {
    id: 'laliga',
    title: 'LaLiga',
    patterns: [
      'laliga', 'la liga', 'sky sports laliga', 'movistar', 'd sports',
      'espn', 'dazn', 'canal+', 'super sport', 'bein sports',
    ],
  },
  {
    id: 'serie-a',
    title: 'Serie A',
    patterns: [
      'serie a', 'sportitalia', 'espn', 'dazn', 'paramount', 'cbs sports',
      'bein sports', 'super sport', 'sport tv', 'arena sport', 'starzplay',
      'abu dhabi',
    ],
  },
  {
    id: 'bundesliga',
    title: 'Bundesliga',
    patterns: [
      'bundesliga', 'sky sport bundesliga', 'dazn', 'espn', 'bein sports',
      'sportdigital', 'onefootball', 'telemundo', 'peacock', 'usa network',
    ],
  },
  {
    id: 'ligue-1',
    title: 'Ligue 1',
    patterns: [
      'ligue 1', 'ligue1', 'bein sports', 'dazn', 'canal+', 'espn',
      'fox sports', 'caze', 'super sport', 'cctv', 'migu', 'ligue 1+',
    ],
  },
  {
    id: 'champions-league',
    title: 'Champions League',
    patterns: [
      'champions league', 'ucl', 'tnt', 'bein sports', 'paramount', 'dazn',
      'sky', 'canal+', 'espn', 'fox sports', 'arena sport', 'super sport',
      'stan', 'sony', 'sport tv', 'ziggo', 'viaplay', 'setanta', 'one soccer',
      'movistar',
    ],
  },
  {
    id: 'europa-league',
    title: 'Europa League',
    patterns: [
      'europa league', 'uel', 'tnt', 'bein sports', 'paramount', 'dazn',
      'sky', 'canal+', 'espn', 'fox sports', 'arena sport', 'super sport',
      'sport tv', 'ziggo', 'viaplay', 'setanta', 'one soccer', 'movistar',
    ],
  },
];

const LEAGUE_CHANNELS_PLAYZ_CATEGORY_NAMES = new Set([
  'sports', 'tnt', 'tnt sports', 'bein sports', 'tsn sports', 'premier sports',
  'fox sports', 'sportv', 'd sports', 'cbs sports', 'sportdigital',
  'sky sports', 'fubo sports', 'espn', 'dazn', 'euro sports', 'fs1',
  'arab sports', 'starzplay', 'general sports',
]);

// Collapse numbered/variant feeds into one user-facing broadcaster card. The
// match is intentionally conservative: unknown names remain separate instead
// of being merged merely because they happen to share a common word.
const LEAGUE_CHANNEL_BRANDS = [
  { key: 'sky-sports', title: 'Sky Sports', aliases: ['sky sports', 'sky sport'] },
  { key: 'tnt-sports', title: 'TNT Sports', aliases: ['tnt sports', 'tnt'] },
  { key: 'bein-sports', title: 'beIN Sports', aliases: ['bein sports', 'bein sport'] },
  { key: 'espn', title: 'ESPN', aliases: ['espn'] },
  { key: 'fox-sports', title: 'Fox Sports', aliases: ['fox sports', 'fox sport'] },
  { key: 'arena-sport', title: 'Arena Sport', aliases: ['arena sport'] },
  { key: 'dazn', title: 'DAZN', aliases: ['dazn'] },
  { key: 'movistar', title: 'Movistar', aliases: ['movistar liga de campeones', 'movistar'] },
  { key: 'paramount', title: 'Paramount+', aliases: ['paramount plus', 'paramount+'] },
  { key: 'super-sport', title: 'SuperSport', aliases: ['supersport', 'super sport'] },
  { key: 'peacock', title: 'Peacock', aliases: ['peacock'] },
  { key: 'viaplay', title: 'Viaplay', aliases: ['viaplay'] },
  { key: 'canal-plus', title: 'Canal+', aliases: ['canal plus', 'canal+'] },
  { key: 'sport-tv', title: 'Sport TV', aliases: ['sport tv'] },
  { key: 'setanta', title: 'Setanta Sports', aliases: ['setanta sports', 'setanta'] },
];

let leagueChannelsMemo = null;

function leagueChannelsText(value) {
  return value == null ? '' : String(value).trim();
}

function leagueChannelsNormalize(value) {
  return leagueChannelsText(value)
    .toLowerCase()
    .replace(/[+]/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function leagueChannelsJson(value) {
  try { return JSON.parse(String(value || '')); } catch (_) { return null; }
}

function leagueChannelsEncode(value) {
  return host.codec.textToBase64(JSON.stringify(value))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function leagueChannelsDecode(value) {
  let base64 = leagueChannelsText(value).replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  try { return JSON.parse(host.codec.base64ToText(base64)); } catch (_) { return null; }
}

function leagueChannelsUnwrap(value, key) {
  if (value == null || typeof value !== 'object') return null;
  const inner = value[key];
  if (typeof inner === 'string') return leagueChannelsJson(inner);
  return inner && typeof inner === 'object' ? inner : null;
}

function leagueChannelsCategoryName(value) {
  const parsed = leagueChannelsUnwrap(value, 'cat') || value;
  return leagueChannelsText(parsed && (parsed.name || parsed.title));
}

function leagueChannelsCategoryPath(value) {
  const parsed = leagueChannelsUnwrap(value, 'cat') || value;
  return leagueChannelsText(parsed && (parsed.api || parsed.path || parsed.url));
}

function leagueChannelsRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['channels', 'items', 'rows', 'data', 'results', 'list']) {
      if (Array.isArray(value[key])) return value[key];
    }
    return [value];
  }
  return [];
}

function leagueChannelsParseRow(value, provider, locator, index) {
  let row = value;
  if (row && typeof row === 'object' && typeof row.channel === 'string') {
    row = leagueChannelsJson(row.channel);
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const name = leagueChannelsText(row.name || row.title || row.channel_name || row.channel);
  const visible = row.visible !== false && row.enabled !== false;
  const links = row.links || row.link || row.url || row.stream || row.tokenApi;
  if (!name || !visible || !leagueChannelsText(links)) return null;
  const linkNames = Array.isArray(row.link_names) ? row.link_names.map(leagueChannelsText) : [];
  return {
    provider,
    locator,
    index,
    name,
    normalizedName: leagueChannelsNormalize(name),
    logo: leagueChannelsText(row.logo || row.image || row.poster),
    links: leagueChannelsText(links),
    linkNames,
  };
}

function leagueChannelsParseM3u(text, provider, locator) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('#EXTINF')) continue;
    const comma = line.indexOf(',');
    const name = comma < 0 ? '' : line.slice(comma + 1).trim();
    const logoMatch = line.match(/\btvg-logo\s*=\s*["']([^"']+)["']/i);
    const logo = logoMatch == null ? '' : leagueChannelsText(logoMatch[1]);
    let linkIndex = index + 1;
    while (linkIndex < lines.length && lines[linkIndex].trim().startsWith('#')) linkIndex += 1;
    const link = linkIndex < lines.length ? lines[linkIndex].trim() : '';
    if (!name || !link) continue;
    rows.push({
      provider,
      locator,
      index: rows.length,
      name,
      normalizedName: leagueChannelsNormalize(name),
      logo,
      links: link,
      linkNames: [],
      m3u: true,
    });
  }
  return rows;
}

function leagueChannelsMatches(row, definition) {
  const haystack = leagueChannelsNormalize(
    `${row.name} ${(row.linkNames || []).join(' ')}`,
  );
  return definition.patterns.some((pattern) => haystack.includes(leagueChannelsNormalize(pattern)));
}

function leagueChannelsGroup(row) {
  const haystack = leagueChannelsNormalize(
    `${row.name} ${(row.linkNames || []).join(' ')}`,
  );
  const brand = LEAGUE_CHANNEL_BRANDS.find((candidate) =>
    candidate.aliases.some((alias) => haystack.includes(leagueChannelsNormalize(alias))),
  );
  if (brand != null) return { key: brand.key, title: brand.title };
  return { key: `channel:${row.normalizedName}`, title: row.name };
}

function leagueChannelsGroups(rows, definition) {
  const groups = new Map();
  rows.filter((row) => leagueChannelsMatches(row, definition)).forEach((row) => {
    const group = leagueChannelsGroup(row);
    let value = groups.get(group.key);
    if (value == null) {
      value = { key: group.key, title: group.title, rows: [] };
      groups.set(group.key, value);
    }
    value.rows.push(row);
  });
  return Array.from(groups.values());
}

function leagueChannelsDedupe(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.provider}:${row.locator}:${row.normalizedName}:${row.links}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function leagueChannelsLoadPlayz() {
  const testFeeds = globalThis.__leagueChannelsPlayzFeeds;
  const testCategories = globalThis.__leagueChannelsPlayzCategories;
  if (testFeeds && typeof testFeeds === 'object' && testCategories === undefined) {
    return Object.keys(testFeeds).flatMap((locator) =>
      leagueChannelsRows(testFeeds[locator]).map((row, index) =>
        leagueChannelsParseRow(row, 'playz', locator, index),
      ).filter((row) => row != null),
    );
  }
  let categories;
  try {
    categories = globalThis.__leagueChannelsPlayzCategories !== undefined
      ? leagueChannelsRows(globalThis.__leagueChannelsPlayzCategories)
      : leagueChannelsRows(await playzFetchJson('sports.txt'));
  } catch (_) { return []; }
  const selected = [];
  const seen = new Set();
  for (const category of categories) {
    const name = leagueChannelsNormalize(leagueChannelsCategoryName(category));
    const locator = leagueChannelsCategoryPath(category);
    if (!locator || (!LEAGUE_CHANNELS_PLAYZ_CATEGORY_NAMES.has(name) && name !== 'sports')) continue;
    if (seen.has(locator)) continue;
    seen.add(locator);
    selected.push(locator);
  }
  const rows = [];
  for (const locator of selected.slice(0, LEAGUE_CHANNELS_MAX_CATEGORIES)) {
    try {
      const data = testFeeds && typeof testFeeds === 'object'
        ? testFeeds[locator]
        : await playzFetchJson(locator);
      leagueChannelsRows(data).forEach((row, index) => {
        const parsed = leagueChannelsParseRow(row, 'playz', locator, index);
        if (parsed != null) rows.push(parsed);
      });
    } catch (_) {}
  }
  return rows;
}

async function leagueChannelsLoadCricfy() {
  const testFeeds = globalThis.__leagueChannelsCricfyFeeds;
  if (testFeeds && typeof testFeeds === 'object') {
    return Object.keys(testFeeds).flatMap((locator) => {
      const value = testFeeds[locator];
      return typeof value === 'string'
        ? leagueChannelsParseM3u(value, 'cricfy', locator)
        : leagueChannelsRows(value).map((row, index) => leagueChannelsParseRow(row, 'cricfy', locator, index)).filter((row) => row != null);
    });
  }
  let text;
  try { text = await cricfyFetchContent('v2/categories.txt'); } catch (_) { return []; }
  const categories = leagueChannelsRows(leagueChannelsJson(text));
  const selected = categories.filter((category) => {
    const name = leagueChannelsNormalize(category && category.name);
    const api = leagueChannelsText(category && category.api);
    return api && (name.includes('sport') || name.includes('world country') || name.includes('play tv'));
  }).slice(0, 6);
  const rows = [];
  await Promise.all(selected.map(async (category) => {
    const locator = leagueChannelsText(category.api);
    try {
      const body = /^https?:\/\//i.test(locator)
        ? await cricfyGetText(locator, cricfyDefaultHeaders(), CRICFY_CONTENT_TIMEOUT_MS)
        : await cricfyFetchContent(locator);
      const trimmed = leagueChannelsText(body);
      if (trimmed.startsWith('#EXTM3U') || trimmed.includes('#EXTINF')) {
        rows.push(...leagueChannelsParseM3u(trimmed, 'cricfy', locator));
      } else {
        leagueChannelsRows(leagueChannelsJson(trimmed)).forEach((row, index) => {
          const parsed = leagueChannelsParseRow(row, 'cricfy', locator, index);
          if (parsed != null) rows.push(parsed);
        });
      }
    } catch (_) {}
  }));
  return rows;
}

async function leagueChannelsLoad() {
  if (leagueChannelsMemo != null) {
    const age = Date.now() - leagueChannelsMemo.at;
    if (age < LEAGUE_CHANNELS_TTL_MS) return leagueChannelsMemo.rows;
  }
  const [playz, cricfy] = await Promise.all([
    leagueChannelsLoadPlayz(), leagueChannelsLoadCricfy(),
  ]);
  const rows = leagueChannelsDedupe(playz.concat(cricfy));
  leagueChannelsMemo = { at: Date.now(), rows };
  return rows;
}

function leagueChannelsItem(definition, group) {
  const id = leagueChannelsEncode({
    league: definition.id,
    channel: group.key,
  });
  const item = {
    ref: {
      extensionId: globalThis.__nimoraExtensionId || 'nimora',
      providerId: LEAGUE_CHANNELS_PROVIDER_ID,
      id: `${LEAGUE_CHANNELS_PROVIDER_KEY}:${id}`,
    },
    kind: 'video',
    title: group.title,
    subtitle: definition.title,
  };
  const logo = group.rows
    .map((row) => row.logo)
    .find((value) => /^https?:\/\//i.test(value));
  if (logo != null) item.artwork = { portrait: { url: logo } };
  return item;
}

async function leagueChannelsCatalog(query) {
  if (!query || query.category !== LEAGUE_CHANNELS_CATEGORY) return { sections: [] };
  let rows;
  try { rows = await leagueChannelsLoad(); } catch (_) { return { sections: [] }; }
  return {
    sections: LEAGUE_CHANNEL_DEFINITIONS.map((definition) => ({
      id: `${LEAGUE_CHANNELS_CATALOG_ID}:${definition.id}`,
      title: definition.title,
      items: leagueChannelsGroups(rows, definition)
        .map((group) => leagueChannelsItem(definition, group)),
    })).filter((section) => section.items.length > 0),
  };
}

async function leagueChannelsSources(args) {
  const enabled = args && args.enabledProviders;
  if (enabled != null && !enabled.includes(LEAGUE_CHANNELS_PROVIDER_ID)) return { sources: [] };
  const item = args && args.item;
  if (!item || !item.ref || item.ref.providerId !== LEAGUE_CHANNELS_PROVIDER_ID) {
    return { sources: [] };
  }
  const rawId = leagueChannelsText(item.ref.id);
  const prefix = `${LEAGUE_CHANNELS_PROVIDER_KEY}:`;
  if (!rawId.startsWith(prefix)) return { sources: [] };
  const payload = leagueChannelsDecode(rawId.slice(prefix.length));
  if (!payload || !payload.league || !payload.channel) return { sources: [] };
  const definition = LEAGUE_CHANNEL_DEFINITIONS.find((entry) => entry.id === payload.league);
  if (definition == null) return { sources: [] };
  let rows;
  try { rows = await leagueChannelsLoad(); } catch (_) { return { sources: [] }; }
  const group = leagueChannelsGroups(rows, definition).find(
    (entry) => entry.key === payload.channel,
  );
  if (group == null) return { sources: [] };
  const sourceLists = await Promise.all(group.rows.map(async (row) => {
    try {
      if (row.provider === 'playz') {
        const testFeeds = globalThis.__leagueChannelsPlayzFeeds;
        const rawLinksValue = testFeeds && typeof testFeeds === 'object'
          ? testFeeds[row.links]
          : await playzFetchJson(row.links);
        return leagueChannelsRows(rawLinksValue).map((link, index) => ({
            id: `${LEAGUE_CHANNELS_PROVIDER_KEY}:${leagueChannelsEncode({
              provider: 'playz',
              links: row.links,
              index,
              names: row.linkNames,
            })}`,
            label: `PlayZTV · ${leagueChannelsText(link.name) || row.linkNames[index] || `${row.name} ${index + 1}`}`,
            provider: 'Nimora', providerId: LEAGUE_CHANNELS_PROVIDER_ID,
          }));
      } else if (row.provider === 'cricfy') {
        return [{
          id: `${LEAGUE_CHANNELS_PROVIDER_KEY}:${leagueChannelsEncode({
            provider: 'cricfy', locator: row.locator, index: row.index,
          })}`,
          label: `Cricfy · ${row.name}`,
          provider: 'Nimora', providerId: LEAGUE_CHANNELS_PROVIDER_ID,
        }];
      }
    } catch (_) {}
    return [];
  }));
  let links = sourceLists.flat();
  const seen = new Set();
  links = links.filter((link) => {
    if (seen.has(link.id)) return false;
    seen.add(link.id);
    return true;
  });
  return { sources: links };
}

async function leagueChannelsResolve(sourceId) {
  const prefix = `${LEAGUE_CHANNELS_PROVIDER_KEY}:`;
  if (!leagueChannelsText(sourceId).startsWith(prefix)) throw new Error('Invalid league channel source id');
  const payload = leagueChannelsDecode(sourceId.slice(prefix.length));
  if (!payload || !payload.provider) throw new Error('Malformed league channel source id');
  if (payload.provider === 'playz') {
    const playzId = playzSourceId({ p: payload.links, i: payload.index, n: payload.names || [] });
    return playzResolve(playzId);
  }
  if (payload.provider === 'cricfy') {
    const body = /^https?:\/\//i.test(payload.locator)
      ? await cricfyGetText(payload.locator, cricfyDefaultHeaders(), CRICFY_CONTENT_TIMEOUT_MS)
      : await cricfyFetchContent(payload.locator);
    const rows = leagueChannelsParseM3u(body, 'cricfy', payload.locator);
    const row = rows[payload.index];
    if (!row || !row.links) throw new Error('Cricfy channel is no longer offered');
    return {
      url: row.links,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      format: cricfyStreamFormatFromUrl(row.links),
      drm: null,
      audioUrl: null,
      label: row.name,
    };
  }
  throw new Error('Unsupported league channel provider');
}

globalThis.__catalogProviders = globalThis.__catalogProviders || [];
globalThis.__catalogProviders.push({
  catalogId: LEAGUE_CHANNELS_CATALOG_ID,
  catalog: leagueChannelsCatalog,
});

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: LEAGUE_CHANNELS_PROVIDER_KEY,
  sources: leagueChannelsSources,
  resolve: leagueChannelsResolve,
});
