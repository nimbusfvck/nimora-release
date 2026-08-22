// Football fixtures catalog, as a JS extension.
//
// Sourced from FotMob's TV guide plus its complete match lists for today and
// tomorrow. The guide keeps the useful forward schedule; the daily lists fill
// gaps and provide the same stable team ids used by FotMob's crest service.
// Stream providers only resolve a selected event and never create catalog
// metadata.
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
const FOTMOB_COUNTRY = 'gb';
const FOTMOB_CCODE3 = 'IDN';
const FOTMOB_IMAGE_BASE = 'https://images.fotmob.com/image_resources/logo/teamlogo';
const FOTMOB_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const TIME_ZONE = 'Asia/Jakarta';

const EXTENSION_ID = 'nimora';
const PROVIDER_ID = 'nimora.matches';

// The one catalog this extension declares, and the categories inside it.
// `live` is status-scoped (whatever is in play right now, derived from a
// kickoff time-window — see isMatchLive), `sport` is upcoming-scoped (see
// UPCOMING_WINDOW_MS) — the same items can legitimately appear under both,
// which is why one catalog serves the two. `all` (shared with the
// catalog, so it becomes one cross-vertical Home tab) needs no branch of its
// own below: it isn't `live`, so it falls into the same fetch `sport` uses.
const CATALOG_ID = 'fixtures';
const LIVE_CATEGORY = 'live';
const ALL_CATEGORY = 'all';

// Heading for a fixture whose league fotmob didn't name.
const UNGROUPED = 'Other';

// A fixture that's over has nothing left to show, and "upcoming" means
// within a week of now — fotmob's own tvguide response covers exactly a
// week forward, so this uses the whole range rather than cutting it short.
// Live is always relevant regardless of kickoff.
const UPCOMING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Editorial ranking for globally recognisable clubs. FotMob ids are the
// primary key; aliases cover alternate names returned by different daily
// feeds. This belongs to the extension because the shell must not know what
// counts as a top football club.
const TOP_CLUBS = [
  { id: '8633', aliases: ['real madrid', 'real madrid cf'] },
  { id: '8634', aliases: ['barcelona', 'fc barcelona', 'barca', 'barça'] },
  { id: '8456', aliases: ['manchester city', 'man city'] },
  { id: '8650', aliases: ['liverpool', 'liverpool fc'] },
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

// fotmob's tvguide is a forward listing, not a live tracker — `isLive` was
// `false` on every match sampled while building this, live or not, so a
// kickoff time-window is the reliable signal. ~130 minutes covers a normal
// 90 minutes plus stoppage/halftime/extra time with room to spare.
const ASSUMED_MATCH_DURATION_MS = 130 * 60 * 1000;

// --- fetch ---

async function fetchFotmobTvGuide() {
  const url =
    `${FOTMOB_BASE}/api/data/tvguide?country=${encodeURIComponent(FOTMOB_COUNTRY)}` +
    `&timezone=${encodeURIComponent(TIME_ZONE)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': FOTMOB_USER_AGENT,
      Referer: `${FOTMOB_BASE}/tv-guide/${FOTMOB_COUNTRY}`,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Request to tvguide failed: ${response.status}`);
  }
  const data = JSON.parse(response.body);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('tvguide response is not an object');
  }
  return data;
}

// Jakarta does not observe daylight saving time, so shifting the timestamp
// before reading its UTC calendar fields gives the local YYYYMMDD without
// depending on Intl support in the JS runtime.
function jakartaDateKey(nowMs, dayOffset) {
  const jakartaMs = nowMs + 7 * 60 * 60 * 1000 + dayOffset * 24 * 60 * 60 * 1000;
  const date = new Date(jakartaMs);
  const two = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`;
}

async function fetchFotmobMatches(dateKey) {
  const url =
    `${FOTMOB_BASE}/api/data/matches?date=${encodeURIComponent(dateKey)}` +
    `&timezone=${encodeURIComponent(TIME_ZONE)}` +
    `&ccode3=${encodeURIComponent(FOTMOB_CCODE3)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': FOTMOB_USER_AGENT,
      Referer: `${FOTMOB_BASE}/`,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Request to matches failed: ${response.status}`);
  }
  const data = JSON.parse(response.body);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('matches response is not an object');
  }
  return data;
}

async function fetchFotmobPopularLeagues() {
  const url =
    `${FOTMOB_BASE}/api/data/allLeagues?locale=en` +
    `&country=${encodeURIComponent(FOTMOB_CCODE3)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': FOTMOB_USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Referer: `${FOTMOB_BASE}/`,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Request to league list failed: ${response.status}`);
  }
  const data = JSON.parse(response.body);
  if (typeof data !== 'object' || data === null || !Array.isArray(data.popular)) {
    throw new Error('league list response has no popular leagues');
  }
  return data.popular;
}

// Fetched once per engine lifetime and memoized — one call already covers
// the whole week, no per-category re-fetch needed. Mirrors cricfy.js's own
// `cricfyFetchEventsMemo`, cleared on failure so a later call can retry.
let fixturesMemo = null;

function fetchFixturesMemo() {
  if (fixturesMemo === null) {
    fixturesMemo = fetchFotmobTvGuide().catch((e) => {
      fixturesMemo = null;
      throw e;
    });
  }
  return fixturesMemo;
}

let dailyMatchesMemo = null;
let popularLeaguesMemo = null;

function fetchDailyMatchesMemo(nowMs) {
  const today = jakartaDateKey(nowMs, 0);
  const tomorrow = jakartaDateKey(nowMs, 1);
  const key = `${today}:${tomorrow}`;
  if (dailyMatchesMemo === null || dailyMatchesMemo.key !== key) {
    const promise = Promise.all(
      [today, tomorrow].map((date) => fetchFotmobMatches(date).catch(() => null)),
    );
    dailyMatchesMemo = { key, promise };
  }
  return dailyMatchesMemo.promise;
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

// The response is `{ "<YYYYMMDD>": [ { leagueId, leagueName, matches: [...] }, ... ], ... }`
// — walked flat into one list, each match tagged with the league it came
// under (matches don't always carry their own leagueName/leagueId).
function flattenTvGuide(data) {
  const matches = [];
  for (const dateKey of Object.keys(data)) {
    const groups = Array.isArray(data[dateKey]) ? data[dateKey] : [];
    for (const group of groups) {
      const groupMatches = Array.isArray(group.matches) ? group.matches : [];
      for (const match of groupMatches) {
        matches.push({
          ...match,
          dateKey,
          leagueName: match.leagueName || group.leagueName,
          leagueId: match.leagueId != null ? match.leagueId : group.leagueId,
        });
      }
    }
  }
  return matches;
}

function flattenDailyMatches(responses) {
  const matches = [];
  for (const data of responses) {
    if (data == null || !Array.isArray(data.leagues)) continue;
    for (const league of data.leagues) {
      const leagueMatches = Array.isArray(league.matches) ? league.matches : [];
      for (const match of leagueMatches) {
        matches.push({
          ...match,
          utcTime: match.utcTime || (match.status && match.status.utcTime),
          isLive: match.status && match.status.started === true &&
            match.status.finished !== true,
          isFinished: match.status && match.status.finished,
          leagueName: match.leagueName || league.name,
          leagueId: match.leagueId != null ? match.leagueId : league.id,
          primaryLeagueId: league.primaryId != null ? league.primaryId : league.id,
        });
      }
    }
  }
  return matches;
}

function isFriendlyMatch(match) {
  return /friendl/i.test(`${match.leagueName || ''}`);
}

function isImportantFootballCompetition(match) {
  return /super\s+cup/i.test(`${match.leagueName || ''}`);
}

// Filtering never sorts: matches that survive retain their exact position in
// the daily matches response. Friendly fixtures remain available even though
// FotMob does not include them in its account-localized popular league list.
function filterPopularMatches(matches, popularLeagues) {
  const allowedIds = new Set(
    popularLeagues
      .filter((league) => league != null && league.id != null)
      .map((league) => String(league.id)),
  );
  return matches.filter((match) => {
    if (isFriendlyMatch(match) || isImportantFootballCompetition(match)) return true;
    const leagueId = match.primaryLeagueId != null
      ? match.primaryLeagueId
      : match.leagueId;
    return leagueId != null && allowedIds.has(String(leagueId));
  });
}

function fotmobMatchKey(match) {
  if (match.id != null) return `id:${match.id}`;
  const homeId = match.home && match.home.id;
  const awayId = match.away && match.away.id;
  return `teams:${homeId || ''}:${awayId || ''}:${match.utcTime || ''}`;
}

function mergeFotmobMatches(tvGuideMatches, dailyMatches) {
  const merged = new Map();
  for (const match of dailyMatches) merged.set(fotmobMatchKey(match), match);
  for (const match of tvGuideMatches) {
    const key = fotmobMatchKey(match);
    const daily = merged.get(key);
    merged.set(key, daily == null ? match : {
      ...daily,
      ...match,
      home: { ...(daily.home || {}), ...(match.home || {}) },
      away: { ...(daily.away || {}), ...(match.away || {}) },
      isLive: daily.isLive === true || match.isLive === true,
      isFinished: typeof daily.isFinished === 'boolean'
        ? daily.isFinished
        : match.isFinished,
    });
  }
  return Array.from(merged.values());
}

function isWomenMatch(match) {
  const womenSuffix = /\s\(W\)$/i;
  const homeName = match.home && (match.home.longName || match.home.name);
  const awayName = match.away && (match.away.longName || match.away.name);
  return womenSuffix.test(`${homeName || ''}`) || womenSuffix.test(`${awayName || ''}`);
}

function normalizedClubName(team) {
  return `${team && (team.longName || team.name) || ''}`
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
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
  if (match.isFinished === true) return false;
  const start = kickoffMs(match);
  if (start == null) return false;
  return nowMs >= start && nowMs <= start + ASSUMED_MATCH_DURATION_MS;
}

function isMatchFinished(match, nowMs) {
  if (match.isFinished === true) return true;
  if (match.isFinished === false) return false;
  if (match.isLive === true) return false;
  const start = kickoffMs(match);
  if (start == null) return false;
  return nowMs > start + ASSUMED_MATCH_DURATION_MS;
}

function isRelevantMatch(match, nowMs) {
  if (isMatchFinished(match, nowMs)) return false;
  if (isMatchLive(match, nowMs)) return true;
  const start = kickoffMs(match);
  // No kickoff to judge by — keep it rather than discard data this can't
  // evaluate.
  if (start == null) return true;
  return start - nowMs <= UPCOMING_WINDOW_MS;
}

// --- mapping ---

function fotmobRefId(matchId) {
  return `fotmob:${matchId}`;
}

function teamLogoUrl(teamId) {
  return `${FOTMOB_IMAGE_BASE}/${teamId}_xsmall.png`;
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

function toMediaItem(match, nowMs) {
  const home = match.home || {};
  const away = match.away || {};
  if (match.utcTime == null || kickoffMs(match) == null) return null;
  const item = {
    ref: {
      extensionId: EXTENSION_ID,
      providerId: PROVIDER_ID,
      id: fotmobRefId(match.id),
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

  if (match.leagueName != null) item.subtitle = match.leagueName;
  const participants = fotmobParticipantsOf(match);
  if (participants.length > 0) item.participants = participants;

  return item;
}

function byCompetition(matches, nowMs) {
  const sections = [];
  for (const match of matches) {
    const title = match.leagueName == null ? UNGROUPED : match.leagueName;
    const sectionId = `league:${match.leagueId == null ? sportIdOf(title) : match.leagueId}`;
    let section = sections.find((candidate) => candidate.id === sectionId);
    if (section == null) {
      section = { id: sectionId, title, items: [] };
      sections.push(section);
    }
    const item = toMediaItem(match, nowMs);
    if (item != null) section.items.push(item);
  }
  return sections.filter((section) => section.items.length > 0);
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

function cricfyEventItem(event, status) {
  let title = `${event.eventName || ''}`.trim();
  const teamA = `${event.teamAName || ''}`.trim();
  const teamB = `${event.teamBName || ''}`.trim();
  const versus = teamA.length > 0 && teamB.length > 0 && teamA !== teamB;
  if (versus) title = `${teamA} vs ${teamB}`;
  if (title.length === 0 || event.linksPath.length === 0) return null;

  const startsAt = cricfyParseEventDateTime(event.date, event.time);
  if (startsAt === null) return null;
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
  if (event.eventLogo) {
    item.artwork = { landscape: { url: event.eventLogo } };
  }
  if (versus) {
    item.participants = [
      {
        name: teamA,
        ...(event.teamALogo ? { logo: { url: event.teamALogo } } : {}),
      },
      {
        name: teamB,
        ...(event.teamBLogo ? { logo: { url: event.teamBLogo } } : {}),
      },
    ];
  }
  return item;
}

async function getCricfySportEntries(nowMs) {
  if (typeof cricfyFetchEventsMemo !== 'function') return [];
  try {
    const events = await cricfyFetchEventsMemo();
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

function buildPage(query, matches, cricfyEntries, nowMs) {
  const selected = query.subCategory == null ? null : query.subCategory;
  const subCategories = sportsOf(matches, cricfyEntries);

  if (selected === FOOTBALL.id) {
    return { sections: byCompetition(matches, nowMs), subCategories };
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
    const liveFootballMatches = matches.filter((match) => isMatchLive(match, nowMs));
    const footballItems = liveFootballMatches
      .map((match) => toMediaItem(match, nowMs))
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
  const footballItems = matches
    .map((match) => toMediaItem(match, nowMs))
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
  // and its cricfy-sourced counterparts are judged against the same "now".
  const nowMs = Date.now();

  const [rawGuide, rawDaily, popularLeagues] = await Promise.all([
    fetchFixturesMemo(),
    fetchDailyMatchesMemo(nowMs),
    fetchPopularLeaguesMemo(),
  ]);
  const allowedDates = new Set([
    jakartaDateKey(nowMs, -1),
    jakartaDateKey(nowMs, 0),
    jakartaDateKey(nowMs, 1),
  ]);
  const guideMatches = flattenTvGuide(rawGuide).filter(
    (match) => allowedDates.has(match.dateKey),
  );
  let matches = mergeFotmobMatches(
    guideMatches,
    flattenDailyMatches(rawDaily),
  ).filter((match) => !isWomenMatch(match) && isRelevantMatch(match, nowMs));
  matches = filterPopularMatches(matches, popularLeagues);
  matches = prioritizeTopClubMatches(matches);
  if (live) {
    matches = matches.filter((match) => isMatchLive(match, nowMs));
  }

  let cricfyEntries = await getCricfySportEntries(nowMs);
  if (live) {
    cricfyEntries = cricfyEntries.filter((entry) => entry.live);
  }

  return buildPage(query, matches, cricfyEntries, nowMs);
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

// Neutral display names for stream sources.
//
// Each provider/server source gets its own fixed, deterministic alias name
// so that the same server always carries the same name across all titles.
// This makes debugging and maintenance straightforward when a specific source has issues.

const SERVER_ALIASES = {
  // VidEasy servers
  'videasy:cdn': 'Aurora',
  'videasy:downloader2': 'Bellini',
  'videasy:m4uhd': 'Cascade',
  'videasy:hdmovie': 'Delphi',
  'videasy:lamovie': 'Everest',
  'videasy:superflix': 'Fjord',
  'videasy:neon2': 'Granada',

  // VaPlayer servers
  'vaplayer:0': 'Harbour',
  'vaplayer:1': 'Indigo',
  'vaplayer:2': 'Juniper',

  // Vidrock servers
  'vidrock:0': 'Kestrel',
  'vidrock:1': 'Lagoon',
  'vidrock:2': 'Meridian',
  'vidrock:3': 'Nimbus',

  // MovieBox servers
  'moviebox:0': 'Orchid',
  'moviebox:1': 'Pinnacle',
  'moviebox:2': 'Quarry',
};

function sourceAlias(sourceId, serverKey) {
  const identity = getSourceIdentity(sourceId, serverKey);
  if (SERVER_ALIASES[identity]) {
    return SERVER_ALIASES[identity];
  }
  return ALIAS_NAMES[aliasHash(identity) % ALIAS_NAMES.length];
}

function getSourceIdentity(sourceId, serverKey) {
  if (serverKey != null) {
    const provider = typeof sourceId === 'string' && sourceId.includes(':')
      ? sourceId.split(':')[0]
      : '';
    return provider ? `${provider}:${serverKey}` : String(serverKey);
  }
  if (!sourceId || typeof sourceId !== 'string') return '';

  const parts = sourceId.split(':');
  if (parts.length < 2) return sourceId;

  const provider = parts[0];
  const encoded = parts.slice(1).join(':');

  // Try decoding base64url payload to extract server key / index if available
  try {
    let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const rem = b64.length % 4;
    if (rem !== 0) b64 += '='.repeat(4 - rem);

    let text = '';
    if (typeof host !== 'undefined' && host && host.codec && host.codec.base64ToText) {
      text = host.codec.base64ToText(b64);
    } else if (typeof atob !== 'undefined') {
      text = atob(b64);
    }
    if (text) {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object') {
        const k = obj.s ?? obj.server ?? obj.i ?? obj.index ?? obj.subjectId;
        if (k != null) return `${provider}:${k}`;
      }
    }
  } catch (_) {}

  return sourceId;
}

// FNV-1a, 32-bit. Any stable, well-spread hash would do; this one is short
// enough to read and needs nothing from the host.
function aliasHash(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // `Math.imul` keeps the multiply in 32 bits; a plain `*` would lose the
    // low bits to float rounding once the product passes 2^53.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const ALIAS_NAMES = [
  'Aurora',
  'Bellini',
  'Cascade',
  'Delphi',
  'Everest',
  'Fjord',
  'Granada',
  'Harbour',
  'Indigo',
  'Juniper',
  'Kestrel',
  'Lagoon',
  'Meridian',
  'Nimbus',
  'Orchid',
  'Pinnacle',
  'Quarry',
  'Rialto',
  'Solstice',
  'Tundra',
  'Umbra',
  'Verona',
  'Willow',
  'Xanadu',
  'Yukon',
  'Zephyr',
];

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
    wolves: 'wolverhampton wanderers',
    'west brom': 'west bromwich albion',
    'west bromwich': 'west bromwich albion',
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
    const quality = koraStr(channel, ['quality']);
    const sourceId = `${KORA_PROVIDER_KEY}:${key}`;
    const alias = sourceAlias(sourceId, key);
    const label = quality ? `${alias} (${quality})` : alias;
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

  const edge = decoded.edges[0];
  const requestUrl = withQuery(`https://${edge}.${decoded.edgeDomain}/frame.php`, {
    ch: chParam,
    p: String(KORA_PLAYER_VALUE),
    token: koraUuidV4(),
    kt: String(Math.floor(Date.now() / 1000)),
  });
  const body = await koraGetText(requestUrl, koraFrameHeaders());
  // The player carries a browser User-Agent into the m3u8/segment requests.
  const stream = parseKoraFrame(body, { 'User-Agent': KORA_BROWSER_UA });

  return { url: stream.url, headers: stream.headers, format: 'hls', label: decoded.label };
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
    const perProvider = await Promise.all(
      globalThis.__streamProviders.map((p) =>
        p.sources(args).catch(() => ({ sources: [] })),
      ),
    );
    return { sources: perProvider.flatMap((r) => r.sources) };
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

function cricfySplitLinkAndHeaders(value) {
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

async function cricfyGetText(url, headers) {
  const response = await fetch(url, { headers });
  return response.body;
}

async function cricfyPostText(url, { headers, body, isJson }) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: isJson ? JSON.stringify(body) : String(body),
  });
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
  const uri = cricfyContentUri(cfg, path);
  const body = await cricfyGetText(uri, cricfyDefaultHeaders());
  return decodeCricfyResponse(body);
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
  if (split.url.length === 0) throw new Error('Empty link');

  if (await cricfyNeedsExchange(split.url)) {
    const resolved = await cricfyExchange(split.url, link);
    return cricfyResolveStreamAt(resolved, depth + 1);
  }

  let finalUrl = split.url;
  if (link.tokenApi.trim().length > 0) {
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

// Events fetched once per engine lifetime and memoized — mirrors
// CricfyBroadcastSource's `_eventsMemo`, cleared on failure so a later call
// can retry rather than being stuck with a rejected promise forever.
let cricfyEventsMemo = null;

function cricfyFetchEventsMemo() {
  if (cricfyEventsMemo === null) {
    cricfyEventsMemo = cricfyEvents().catch((e) => {
      cricfyEventsMemo = null;
      throw e;
    });
  }
  return cricfyEventsMemo;
}

// Resolved links cached by a per-call session token, same as Dart's
// `_linkCache`/`_sourcesSession` — two events' links (opened from a detail
// page and a bulk scan, say) never collide, and the cache is capped so a
// long session can't grow it forever.
let cricfyLinkCache = {};
let cricfySourcesSession = 0;
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

async function cricfySourcesForEvent(event) {
  const links = await cricfyEventLinks(event);
  const session = cricfySourcesSession++;
  const sources = [];
  for (let i = 0; i < links.length; i++) {
    const id = `s${session}-${i}`;
    const identity = cricfySourceIdentity(links[i]);
    const alias = sourceAlias(`${CRICFY_PROVIDER_KEY}:${identity}`);
    cricfyLinkCache[id] = { ...links[i], name: alias };
    sources.push({
      id: `${CRICFY_PROVIDER_KEY}:${id}`,
      label: alias,
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
    const perProvider = await Promise.all(
      globalThis.__streamProviders.map((p) => p.sources(args).catch(() => ({ sources: [] }))),
    );
    return { sources: perProvider.flatMap((r) => r.sources) };
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

// SportzX live-sport provider. The upstream wraps its JSON in the native
// SportzX v2 envelope: version(2), IV, AES-CBC mask, and HMAC-SHA256 tag.
// This is a byte-for-byte port of DataHelper.help in libnative-lib.so.

const SPORTZX_PROVIDER_KEY = 'sportzx';
const SPORTZX_PROVIDER_ID = 'nimora.sportzx';
const SPORTZX_API = globalThis.__sportzxApiBaseUrl || 'https://streamtvapp.top/';
const SPORTZX_CERT = '1676ec7db4771b0d826d70369b579684b182d2c0133be041bdd55f5d6d79a98b';

function sportzxTextB64(value) { return host.codec.textToBase64(value); }
function sportzxHexB64(hex) { return host.codec.hexToBase64(hex); }
function sportzxB64Hex(value) { return host.codec.base64ToHex(value); }

function sportzxUrlB64(value) {
  let out = String(value).trim().replace(/-/g, '+').replace(/_/g, '/');
  while (out.length % 4 !== 0) out += '=';
  return out;
}

function sportzxXorHex(left, right) {
  let out = '';
  for (let i = 0; i < left.length; i += 2) {
    const a = parseInt(left.slice(i, i + 2), 16);
    const b = parseInt(right.slice(i, i + 2), 16);
    out += (a ^ b).toString(16).padStart(2, '0');
  }
  return out;
}

// Host crypto intentionally exposes SHA-256 but not HMAC. HMAC is compact
// enough to express safely over its base64 byte primitives.
function sportzxHmac(keyB64, dataB64) {
  let keyHex = sportzxB64Hex(keyB64);
  if (keyHex.length > 128) keyHex = sportzxB64Hex(host.crypto.sha256(keyB64));
  keyHex = keyHex.padEnd(128, '0');
  const ipad = '36'.repeat(64);
  const opad = '5c'.repeat(64);
  const inner = host.crypto.sha256(sportzxHexB64(sportzxXorHex(keyHex, ipad) + sportzxB64Hex(dataB64)));
  return host.crypto.sha256(sportzxHexB64(sportzxXorHex(keyHex, opad) + sportzxB64Hex(inner)));
}

function sportzxBytesXorRotate(cipherB64, maskB64) {
  const cipher = sportzxB64Hex(cipherB64);
  const mask = sportzxB64Hex(maskB64);
  let out = '';
  for (let i = 0; i < mask.length; i += 2) {
    const m = parseInt(mask.slice(i, i + 2), 16);
    const c = parseInt(cipher.slice(i, i + 2), 16);
    const rotated = ((m >>> 3) | (m << 5)) & 0xff;
    out += (rotated ^ c).toString(16).padStart(2, '0');
  }
  return sportzxHexB64(out);
}

function sportzxDecodeEnvelope(raw) {
  const outer = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const wire = sportzxUrlB64(outer && outer.data ? outer.data : raw);
  const hex = sportzxB64Hex(wire);
  if (hex.length < 98 || hex.slice(0, 2) !== '02') throw new Error('Unsupported SportzX envelope');
  const iv = sportzxHexB64(hex.slice(2, 34));
  const tag = sportzxHexB64(hex.slice(-64));
  const signed = sportzxHexB64(hex.slice(0, -64));
  const cipher = sportzxHexB64(hex.slice(34, -64));
  const certificate = sportzxHexB64(SPORTZX_CERT);
  const prk = sportzxHmac(sportzxTextB64('sportzx/v2/prk'), certificate);
  const encKey = sportzxHmac(prk, sportzxTextB64('enc'));
  const macKey = sportzxHmac(prk, sportzxTextB64('mac'));
  if (sportzxHmac(macKey, signed) !== tag) throw new Error('SportzX envelope authentication failed');
  const mask = host.crypto.aesCbcDecrypt(encKey, iv, cipher);
  if (mask === null) throw new Error('SportzX envelope decryption failed');
  return host.codec.base64ToText(sportzxBytesXorRotate(cipher, mask));
}

async function sportzxFetchJson(path) {
  const response = await host.fetch(`${SPORTZX_API}${path}`, { headers: { Accept: 'application/json' } });
  return JSON.parse(sportzxDecodeEnvelope(response.body));
}

// The channel schema has changed several times. Keep field selection narrow
// but tolerant: only candidates with a concrete http(s) URL become sources.
function sportzxCollectLinks(value, out) {
  if (!value) return;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.push({ url: value, name: 'SportzX Live' });
    return;
  }
  if (Array.isArray(value)) { for (const item of value) sportzxCollectLinks(item, out); return; }
  if (typeof value !== 'object') return;
  const url = String(value.url || value.link || value.stream_url || value.stream || '').trim();
  if (/^https?:\/\//i.test(url)) out.push({ url, name: String(value.name || value.title || value.server || 'SportzX Live') });
  for (const key of ['servers', 'channels', 'sources', 'links', 'streams']) sportzxCollectLinks(value[key], out);
}

let sportzxEventsMemo = null;
async function sportzxEvents() {
  if (sportzxEventsMemo) return sportzxEventsMemo;
  sportzxEventsMemo = sportzxFetchJson('events.json');
  return sportzxEventsMemo;
}

function sportzxEventList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['events', 'data', 'matches', 'results']) if (Array.isArray(payload && payload[key])) return payload[key];
  return [];
}

function sportzxEventName(event) {
  return String(event.title || event.name || event.event_name || `${event.home_team || event.team1 || ''} ${event.away_team || event.team2 || ''}`).trim();
}

async function sportzxSources(args) {
  const enabled = args.enabledProviders;
  if (enabled != null && enabled.indexOf(SPORTZX_PROVIDER_ID) === -1) return { sources: [] };
  const item = args.item;
  const query = [item.title, item.name, ...(item.participants || []).map((p) => p.name)].filter(Boolean).join(' ').toLowerCase();
  if (!query) return { sources: [] };
  let events;
  try { events = sportzxEventList(await sportzxEvents()); } catch (_) { return { sources: [] }; }
  const event = events.find((candidate) => {
    const name = sportzxEventName(candidate).toLowerCase();
    return name && (query.includes(name) || name.split(/\s+vs?\.?\s+/).every((part) => part.length < 3 || query.includes(part)));
  });
  if (!event) return { sources: [] };
  const links = [];
  sportzxCollectLinks(event, links);
  const unique = new Map();
  for (const link of links) unique.set(`${link.name}|${link.url}`, link);
  return { sources: [...unique.values()].map((link, index) => ({
    id: `${SPORTZX_PROVIDER_KEY}:${sportzxTextB64(JSON.stringify(link)).replace(/=+$/g, '')}`,
    label: sourceAlias(`${SPORTZX_PROVIDER_KEY}:${link.name}`),
    provider: 'Nimora', providerId: SPORTZX_PROVIDER_ID,
  })) };
}

async function sportzxResolve(sourceId) {
  const value = sourceId.slice(`${SPORTZX_PROVIDER_KEY}:`.length);
  const link = JSON.parse(host.codec.base64ToText(sportzxUrlB64(value)));
  return { url: link.url, headers: {}, format: /\.mpd(?:$|\?)/i.test(link.url) ? 'dash' : 'hls', label: link.name };
}

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({ providerKey: SPORTZX_PROVIDER_KEY, sources: sportzxSources, resolve: sportzxResolve });
globalThis.sportzx = { decodeEnvelope: sportzxDecodeEnvelope, hmac: sportzxHmac };

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
  if (rating != null) mediaItem.rating = rating;
  const artwork = {};
  if (result.poster_path) artwork.portrait = { url: `${TMDB_IMAGE_BASE}/w500${result.poster_path}` };
  if (result.backdrop_path) artwork.landscape = { url: `${TMDB_IMAGE_BASE}/w780${result.backdrop_path}` };
  const titleLogo = tmdbTitleLogo(result.images);
  if (titleLogo) artwork.logo = { url: `${TMDB_IMAGE_BASE}/w300${titleLogo.file_path}` };
  if (Object.keys(artwork).length > 0) mediaItem.artwork = artwork;
  return mediaItem;
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

async function fetchTrending(mediaType) {
  const data = await tmdbGetJson(`/trending/${mediaType}/day`, { include_adult: 'false' });
  const results = Array.isArray(data.results) ? data.results : [];
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

async function fetchTopRated(mediaType) {
  const data = await tmdbGetJson(`/${mediaType}/top_rated`, { page: 1, include_adult: 'false' });
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((r) => tmdbToMediaItem(r, mediaType));
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

async function fetchPopularStreamingMediaType(mediaType) {
  try {
    const data = await tmdbGetJson(`/discover/${mediaType}`, {
      include_adult: 'false',
      watch_region: TMDB_WATCH_REGION,
      with_watch_monetization_types: TMDB_STREAMING_TYPES,
      sort_by: 'popularity.desc',
      page: 1,
    });
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((result) => ({
      item: tmdbToMediaItem(result, mediaType),
      popularity: typeof result.popularity === 'number' ? result.popularity : 0,
    }));
  } catch (_) {
    return [];
  }
}

// Combine paid movie and TV streaming results into one shelf. The public API
// exposes the availability filter, while the website's private panel owns its
// own ranking and may therefore show a different order.
async function fetchPopularStreaming() {
  const [movies, tv] = await Promise.all([
    fetchPopularStreamingMediaType('movie'),
    fetchPopularStreamingMediaType('tv'),
  ]);
  return [...movies, ...tv]
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 25)
    .map((entry) => entry.item);
}

async function fetchTopAnimeMediaType(mediaType) {
  const data = await tmdbGetJson(`/discover/${mediaType}`, {
    include_adult: 'false',
    watch_region: TMDB_WATCH_REGION,
    with_watch_providers: WATCH_PROVIDER.crunchyroll,
    with_watch_monetization_types: TMDB_STREAMING_TYPES,
    with_genres: '16',
    with_origin_country: 'JP',
    sort_by: 'popularity.desc',
    page: 1,
  });
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((result) => ({
    item: tmdbToMediaItem(result, mediaType),
    popularity: typeof result.popularity === 'number' ? result.popularity : 0,
  }));
}

// Keep anime in the same TMDB-backed catalog as the other Home shelves. The
// Japanese origin and Crunchyroll availability filters avoid mixing general
// animation into this section, while the source provider remains responsible
// for playback.
async function fetchTopAnime() {
  const [movies, tv] = await Promise.all([
    fetchTopAnimeMediaType('movie'),
    fetchTopAnimeMediaType('tv'),
  ]);
  return [...movies, ...tv]
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 25)
    .map((entry) => entry.item);
}

// TMDB's `watch_providers` catalog ids — stable across regions, used with
// `with_watch_providers` to narrow discover to one streamer's US catalog.
const WATCH_PROVIDER = {
  crunchyroll: 283,
  netflix: 8,
  hulu: 15,
  disneyPlus: 337,
  primeVideo: 9,
  hbo: 1899,
  appleTv: 350,
};

// Single page only (page 1) — these are `highlights` shelf sections, not
// something a viewer pages through further, same as the other curated lists.
async function fetchWatchProvider(mediaType, providerId) {
  const page = await fetchDiscoverPage(mediaType, { with_watch_providers: providerId }, 1);
  return page.items;
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

// --- "highlights" catalog: the `all` category — six horizontal-row
// sections, movie and tv mixed, exactly the shape originally asked for.
// Separate from the `movie`/`tv` grid catalog below: same provider, second
// catalog, own catalogId, so it can keep `display: "row"` while the other
// one is `"grid"` (CatalogDecl.display is one value per catalog, not per
// category — see manifest.json).

const HIGHLIGHTS_CATALOG_ID = 'highlights';
const TMDB_ALL_CATEGORY = 'all';

const HIGHLIGHT_GROUPS = [
  { id: 'trending_movie', name: 'Trending Movie', fetch: () => fetchTrending('movie') },
  { id: 'trending_tv', name: 'Trending TV', fetch: () => fetchTrending('tv') },
  { id: 'popular_today', name: 'Popular Today', fetch: fetchPopularStreaming },
  { id: 'top_anime', name: 'Top Anime', fetch: fetchTopAnime },
  { id: 'top_rated_movie', name: 'Top Rated Movie', fetch: () => fetchTopRated('movie') },
  { id: 'top_rated_tv', name: 'Top Rated TV', fetch: () => fetchTopRated('tv') },
  { id: 'oscar_nominees', name: 'Oscar Nominees', fetch: () => fetchSheguList('oscar-nominees-best-picture') },
  { id: 'cannes', name: 'Cannes Film Festival', fetch: () => fetchSheguList('cannes-film-festival') },
  { id: 'netflix_movies', name: 'Movies on Netflix', fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.netflix) },
  { id: 'hulu_movies', name: 'Movies on Hulu', fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.hulu) },
  { id: 'disney_movies', name: 'Movies on Disney+', fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.disneyPlus) },
  { id: 'prime_movies', name: 'Movies on Prime Video', fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.primeVideo) },
  { id: 'hbo_movies', name: 'Movies on HBO', fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.hbo) },
  { id: 'appletv_movies', name: 'Movies on Apple TV', fetch: () => fetchWatchProvider('movie', WATCH_PROVIDER.appleTv) },
  { id: 'netflix_tv', name: 'TV Series on Netflix', fetch: () => fetchWatchProvider('tv', WATCH_PROVIDER.netflix) },
  { id: 'disney_tv', name: 'TV Series on Disney+', fetch: () => fetchWatchProvider('tv', WATCH_PROVIDER.disneyPlus) },
  { id: 'appletv_tv', name: 'TV Series on Apple TV', fetch: () => fetchWatchProvider('tv', WATCH_PROVIDER.appleTv) },
  { id: 'prime_tv', name: 'TV Series on Prime', fetch: () => fetchWatchProvider('tv', WATCH_PROVIDER.primeVideo) },
  { id: 'hbo_tv', name: 'TV Series on HBO', fetch: () => fetchWatchProvider('tv', WATCH_PROVIDER.hbo) },
  { id: 'rotten_tomatoes_best', name: 'Rotten Tomatoes Best of All Time', fetch: () => fetchSheguList('rotten-tomatoes-best-of-all-time') },
  { id: 'based_on_true_story', name: 'Based On True Story', fetch: () => fetchSheguList('based-on-a-true-story') },
];

// Single page per section (no further pagination within one), but *does*
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

// Similar results are optional metadata. Keep the detail response usable when
// TMDB's recommendation endpoint is unavailable or returns an empty page.
async function tmdbSimilarOf(tmdbId, mediaType) {
  try {
    const data = await tmdbGetJson(`/${mediaType}/${tmdbId}/similar`, {
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
  const [previewResponse, recommendations] = await Promise.all([
    sheguVideoTrailer(tmdbId, 'movie'),
    tmdbSimilarOf(tmdbId, 'movie'),
  ]);
  const preview = sheguPreviewWithThumbnail(previewResponse, trailers);
  if (preview != null) trailers.unshift(preview);
  if (trailers.length > 0) detail.trailers = trailers;
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
    tmdbSimilarOf(tmdbId, 'tv'),
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

async function tmdbSearch(args) {
  const query = args.query;
  if (!query) return { sections: [] };
  const page = args.page ? Number(args.page) : 1;
  const [movies, tv] = await Promise.all([
    tmdbSearchType('movie', query, page, { region: 'US' }),
    tmdbSearchType('tv', query, page),
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

// ---- externalSubtitles role — a manual fallback, independent of any source ----
//
// vaplayer.js/vidrock.js/moviebox.js already call fetchMovieSubtitles
// themselves, but only when a source's own subtitle list comes back empty —
// so a source whose subtitles are just wrong or out of sync never gets
// this. The player's own "fetch external subtitles" button asks for it
// directly, keyed only on the item's `movie:<tmdbId>` /
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

async function sheguExternalSubtitles(args) {
  const item = args.item || {};
  const refId = (item.ref && item.ref.id) || item.id || '';
  const parsed = parseSheguRef(refId);
  if (!parsed) return { subtitles: [] };

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
// `resolve()` also attaches subtitles (shegu.js, loaded alongside this file
// — see its own header comment) to the `PlayableStream` it returns. Not
// Vidrock's own concern, but `resolve(sourceId)` is the only place in this
// protocol that both has a tmdbId (baked into the source id, see below) and
// produces the object subtitles ride on.

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
// The tmdbId rides along too, not because decrypting needs it, but because
// `resolve()` otherwise has no way back to it for the shegu.st subtitle
// lookup — `resolve(sourceId)` gets only the opaque id, never the item.

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
      const sourceId = `${VIDROCK_PROVIDER_KEY}:${id}`;
      sources.push({
        id: sourceId,
        // The dub language stays: that is about the content, not the
        // upstream. See alias.js.
        label: `${sourceAlias(sourceId, name)}${lang}`,
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
    const sourceId = `${VIDROCK_PROVIDER_KEY}:${id}`;
    sources.push({
      id: sourceId,
      // The dub language stays: that is about the content, not the
      // upstream. See alias.js.
      label: `${sourceAlias(sourceId, name)}${lang}`,
      provider: 'Nimora',
      providerId: 'nimora.vidrock',
    });
  }
  return { sources };
}

// Subtitles are shegu.st's, not Vidrock's — see shegu.js's header comment
// for why this rides inside `resolve()` rather than being a role of its
// own. Tolerant of shegu.js not being loaded at all (every js_*_test.dart
// file hand-concatenates its own subset of sources, and plenty of them load
// vidrock.js without shegu.js), and of the lookup itself failing: either way
// the stream still resolves, just without subtitles.
async function vidrockSubtitles(tmdbId, season, episode) {
  if (typeof globalThis.sheguSubtitles === 'undefined') return [];
  try {
    return await globalThis.sheguSubtitles.fetchMovieSubtitles(tmdbId, season, episode);
  } catch (_) {
    return [];
  }
}

async function resolveVidrockSource(sourceId) {
  const prefix = `${VIDROCK_PROVIDER_KEY}:`;
  const inner = sourceId.startsWith(prefix) ? sourceId.slice(prefix.length) : sourceId;
  const decoded = decodeVidrockSourceId(inner);

  const url = decryptVidrockUrl(decoded.u);
  if (url === null) throw new Error('Vidrock source failed to decrypt');

  const format = decoded.type === 'hls' || url.indexOf('.m3u8') !== -1 ? 'hls' : 'other';
  const result = { url, headers: vidrockHeaders(), format };

  const subtitles = await vidrockSubtitles(decoded.m, decoded.s, decoded.e);
  if (subtitles.length > 0) result.subtitles = subtitles;

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
    const perProvider = await Promise.all(
      globalThis.__streamProviders.map((p) => p.sources(args).catch(() => ({ sources: [] }))),
    );
    return { sources: perProvider.flatMap((r) => r.sources) };
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
    return { id, label: sourceAlias(id, srv.key), provider: 'Nimora', providerId: 'nimora.videasy' };
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

  // Attach shegu.st subtitles if none were bundled.
  let sheguTracks = [];
  if (subtitles.length === 0 && globalThis.sheguSubtitles) {
    try {
      sheguTracks = await globalThis.sheguSubtitles.fetchMovieSubtitles(
        tmdbId,
        season != null ? season : null,
        episode != null ? episode : null,
      );
    } catch (_) {
      sheguTracks = [];
    }
  }

  return {
    url: entry.url,
    // These come back as both .m3u8 and .mp4 depending on the server.
    format: entry.url.includes('.m3u8') ? 'hls' : 'other',
    headers: {
      Origin: 'https://player.videasy.to',
      Referer: 'https://player.videasy.to/',
      'User-Agent': VIDEASY_UA,
    },
    subtitles: subtitles.length > 0 ? subtitles : sheguTracks,
  };
}

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: VIDEASY_PROVIDER_KEY,
  sources: videasyListSources,
  resolve: videasyResolveSource,
});

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
      // interchangeable playlists of the same title — so the alias is the
      // whole label. See alias.js.
      return { id, label: sourceAlias(id, index), provider: 'Nimora', providerId: 'nimora.vaplayer' };
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

  // The upstream's own subtitles when it has any, shegu.st only when it
  // doesn't — asking shegu regardless would spend a request to produce a
  // second list nobody reads. It does happen: a film came back with none
  // here while shegu had 150 for the same tmdbId.
  let subtitles = vaplayerSubtitles(payload);
  if (subtitles.length === 0) {
    subtitles = await vaplayerSheguSubtitles(tmdbId, season, episode);
  }

  return {
    url: urls[index],
    format: 'hls',
    headers: {
      Referer: VAPLAYER_REFERER,
      'User-Agent': VAPLAYER_UA,
    },
    subtitles,
  };
}

// Tolerant of shegu.js not being loaded at all — the js_*_test.dart files
// hand-concatenate their own subsets — and of the lookup failing: either way
// the stream still resolves, just without subtitles. Same shape vidrock.js
// uses.
async function vaplayerSheguSubtitles(tmdbId, season, episode) {
  if (typeof globalThis.sheguSubtitles === 'undefined') return [];
  try {
    return await globalThis.sheguSubtitles.fetchMovieSubtitles(
      tmdbId,
      season != null ? season : null,
      episode != null ? episode : null,
    );
  } catch (_) {
    return [];
  }
}

// ---- registration — see kora.js's tail for the shared aggregator ----

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: VAPLAYER_PROVIDER_KEY,
  sources: vaplayerListSources,
  resolve: (sourceId) => vaplayerResolveSource(sourceId),
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
      // The dub language stays — it is about the content. See alias.js.
      const lang =
        subject.language === 'Original' ? '' : ` [${subject.language}]`;
      return {
        id,
        label: `${sourceAlias(id, subject.subjectId != null ? subject.subjectId : index)}${lang}`,
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
  // `format` comes back as "MP4"/"HLS"; anything not explicitly HLS is left
  // as `other` rather than guessed at from the URL, which carries no
  // extension here.
  const isHls =
    `${chosen.format || ''}`.toLowerCase() === 'hls' ||
    chosen.url.includes('.m3u8');

  // MovieBox's own captions when it has them, shegu.st only when it doesn't.
  let subtitles = movieboxCaptions(downloadData);
  if (subtitles.length === 0) {
    subtitles = await movieboxSheguSubtitles(tmdbId, season, episode);
  }

  return {
    url: chosen.url,
    format: isHls ? 'hls' : 'other',
    headers: {
      Origin: MOVIEBOX_PLAYER_ORIGIN,
      Referer: `${MOVIEBOX_PLAYER_ORIGIN}/`,
      'User-Agent': MOVIEBOX_UA,
    },
    subtitles,
  };
}

// shegu.st is keyed by tmdbId, which MovieBox matched nothing by — it found
// its subject on a name. The id is carried through from the item when it had
// one; without it there are no subtitles, rather than a lookup on a
// subjectId shegu would not recognize.
async function movieboxSheguSubtitles(tmdbId, season, episode) {
  if (typeof globalThis.sheguSubtitles === 'undefined') return [];
  if (!tmdbId) return [];
  try {
    return await globalThis.sheguSubtitles.fetchMovieSubtitles(
      tmdbId,
      season != null ? season : null,
      episode != null ? episode : null,
    );
  } catch (_) {
    return [];
  }
}

// ---- registration — see kora.js's tail for the shared aggregator ----

globalThis.__streamProviders = globalThis.__streamProviders || [];
globalThis.__streamProviders.push({
  providerKey: MOVIEBOX_PROVIDER_KEY,
  sources: movieboxListSources,
  resolve: (sourceId) => movieboxResolveSource(sourceId),
});

// Sokuja anime streams, exposed as a stream provider for Nimora's VOD items.
//
// Sokuja's CloudStream implementation delegates mirror extraction to the
// CloudStream extractor framework. The app has no extractor runtime, so this
// provider follows Sokuja's own JSON mirror endpoint and only returns mirrors
// that already contain a direct media URL.

const SOKUJA_BASE = globalThis.__sokujaBaseUrl || 'https://x6.sokuja.uk';
const SOKUJA_PROVIDER_KEY = 'sokuja';
const SOKUJA_PROVIDER_ID = 'nimora.sokuja';
const SOKUJA_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

function sokujaHeaders(referer) {
  return {
    Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    Referer: referer || `${SOKUJA_BASE}/`,
    'User-Agent': SOKUJA_USER_AGENT,
  };
}

function sokujaUrl(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith('/')) return `${SOKUJA_BASE}${path}`;
  return `${SOKUJA_BASE}/${path}`;
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

function sokujaSearchPick(results, title, season) {
  const wanted = sokujaNormalizeTitle(title);
  if (!wanted) return null;
  const candidates = results
    .map((result, index) => {
      const normalized = sokujaNormalizeTitle(result.title);
      if (!normalized) return null;
      const exact = normalized === wanted;
      const startsWith = normalized.startsWith(wanted);
      if (!exact && !startsWith) return null;
      const seasonMatch = season != null &&
        new RegExp(`(?:season\\s*${season}|\\bs${season}\\b)`, 'i')
          .test(result.title);
      return {
        result,
        score: (exact ? 0 : 10) + (seasonMatch ? -2 : 0) + index / 1000,
      };
    })
    .filter((entry) => entry != null)
    .sort((a, b) => a.score - b.score);
  return candidates.length === 0 ? null : candidates[0].result;
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

async function sokujaFindAnime(title, season) {
  const searchUrl =
    `${SOKUJA_BASE}/?s=${encodeURIComponent(title)}&page=1`;
  const response = await sokujaGet(searchUrl, { headers: sokujaHeaders(searchUrl) });
  if (response == null) return null;
  return sokujaSearchPick(sokujaSearchResults(response.body), title, season);
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

function sokujaEpisodeUrl(html, episodeNumber) {
  const wanted = Number(episodeNumber);
  if (!Number.isInteger(wanted) || wanted < 1) return null;
  const episodes = sokujaEpisodes(html);
  const episode = episodes.find(
    (entry) => Number(entry && entry.episodeNumber) === wanted,
  );
  if (episode && typeof episode.slug === 'string') return sokujaUrl(`/${episode.slug}/`);

  const pattern = new RegExp(
    `href=[\"']([^\"']*episode-${wanted}[^\"']*)[\"']`,
    'i',
  );
  const fallback = pattern.exec(html || '');
  return fallback == null ? null : sokujaUrl(fallback[1]);
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
  const result = await sokujaFindAnime(query.title, query.season);
  if (result == null) return { sources: [] };

  const detailResponse = await sokujaGet(
    result.url,
    { headers: sokujaHeaders(`${SOKUJA_BASE}/`) },
  );
  if (detailResponse == null) return { sources: [] };
  const watchUrl = query.isEpisode
    ? sokujaEpisodeUrl(detailResponse.body, query.episode)
    : sokujaMovieUrl(detailResponse.body) || result.url;
  if (watchUrl == null) return { sources: [] };

  const episodeResponse = await sokujaGet(
    watchUrl,
    { headers: sokujaHeaders(result.url) },
  );
  if (episodeResponse == null) return { sources: [] };
  const episodeId = sokujaEpisodeId(episodeResponse.body);
  if (episodeId == null) return { sources: [] };

  const mirrorsUrl = `${SOKUJA_BASE}/api/video-mirrors/?e=${encodeURIComponent(episodeId)}`;
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
          label: sourceAlias(id, index),
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
  const format = /\.m3u8(?:$|\?)/i.test(payload.u) ? 'hls' : 'other';
  return {
    url: payload.u,
    format,
    headers: sokujaHeaders(`${SOKUJA_BASE}/`),
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
    const perProvider = await Promise.all(
      globalThis.__streamProviders.map((provider) =>
        provider.sources(args).catch(() => ({ sources: [] })),
      ),
    );
    return { sources: perProvider.flatMap((result) => result.sources) };
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
