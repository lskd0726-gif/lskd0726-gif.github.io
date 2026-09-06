/**
 * 링크 미리보기(og 태그)를 요청 시점에 만들어 끼워 넣는 Cloudflare Pages 엣지 함수.
 *
 * ────────────────────────────────────────────────────────────────
 * 왜 필요한가
 * ────────────────────────────────────────────────────────────────
 * 카카오톡·트위터·디스코드는 링크를 붙여넣는 순간 그 주소를 한 번 긁어서
 * <head> 안의 og:title·og:description·og:image 를 읽고 미리보기 카드를 만든다.
 * 이때 자바스크립트를 실행하지 않는다. 그런데 모아니는 SPA 라서
 * 브라우저에서 JS 가 돌아야 작품 정보가 채워진다.
 * 즉 서버가 내려주는 HTML 에 미리 og 태그가 박혀 있어야 미리보기가 뜬다.
 *
 * 작품마다 다른 제목·포스터를 보여주려면 작품 수만큼 HTML 파일을 만들어 두거나
 * (작품이 늘 때마다 재배포해야 한다) 요청이 올 때 만들어야 한다.
 * 이 파일은 후자다 — /anime/<번호> 로 요청이 오면 그 자리에서 태그를 채운다.
 *
 * ────────────────────────────────────────────────────────────────
 * 하는 일
 * ────────────────────────────────────────────────────────────────
 *  1. /anime/<번호> 이면서 요청자가 미리보기 수집기(봇)일 때만 동작한다.
 *     사람이 열 때는 손대지 않는다 — AniList 왕복만큼 첫 화면이 늦어지기 때문이다.
 *  2. 작품 정보를 AniList 에서 받고, 한국어 제목은 og-data.json(빌드 때 만든다)에서 찾는다.
 *  3. 정적 index.html 을 HTMLRewriter 로 흘려보내며 <head> 의 태그만 갈아 끼운다.
 *
 * 확인용: 주소 뒤에 ?_og=1 을 붙이면 봇이 아니어도 태그가 박힌 HTML 을 볼 수 있다.
 *
 * 실행 위치: dist/_worker.js  (scripts/prepare-deploy.mjs 가 복사한다)
 */

/** 미리보기를 만들려고 들어오는 수집기들. 카카오톡은 facebookexternalhit + kakaotalk-scrap 로 온다. */
const CRAWLER = /bot|crawler|spider|facebookexternalhit|kakaotalk|kakao|slack|twitter|discord|telegram|whatsapp|line-|linespider|naver|yeti|daum|pinterest|applebot|skype|embed|preview|scrap|curl|wget|vkshare|whatsapp/i;

/** AniList 응답을 담아 둘 곳 — 같은 작품을 여러 번 긁어도 한 번만 물어본다. */
const ANILIST_TTL = 21600; // 6시간

const FORMAT_KO = {
  TV: 'TV', TV_SHORT: 'TV 단편', MOVIE: '극장판', SPECIAL: '스페셜',
  OVA: 'OVA', ONA: 'ONA', MUSIC: '뮤직비디오',
};

const GENRE_KO = {
  Action: '액션', Adventure: '모험', Comedy: '코미디', Drama: '드라마', Ecchi: '에치',
  Fantasy: '판타지', Horror: '호러', 'Mahou Shoujo': '마법소녀', Mecha: '메카',
  Music: '음악', Mystery: '미스터리', Psychological: '심리', Romance: '로맨스',
  'Sci-Fi': 'SF', 'Slice of Life': '일상', Sports: '스포츠', Supernatural: '초자연',
  Thriller: '스릴러', Hentai: '성인',
};

const HANGUL = /[가-힣]/;
const normalizeName = (v = '') => String(v).toLocaleLowerCase().replace(/[^a-z0-9가-힣]/g, '');

/* ==========================================================================
 * 진입점
 * ========================================================================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/anime\/(\d+)\/?$/);
    const forced = url.searchParams.has('_og');
    const isCrawler = CRAWLER.test(request.headers.get('user-agent') ?? '');

    if (!match || (!forced && !isCrawler)) return serveApp(request, env);

    try {
      return await renderPreview(request, env, ctx, match[1]);
    } catch (error) {
      // 미리보기를 못 만들어도 사이트는 열려야 한다.
      console.error('og 생성 실패', error);
      return serveApp(request, env);
    }
  },
};

/**
 * 정적 파일을 그대로 내보낸다. 없는 주소면 index.html 을 200 으로 돌려준다(SPA).
 *
 * _worker.js 를 쓰면 _redirects 규칙이 적용되지 않으므로 폴백을 여기서 직접 해야 한다.
 * 이걸 빼면 /anime/101922 같은 주소가 전부 404 가 된다.
 *
 * (Pages 의 정적 파일 서버가 이미 같은 폴백을 하는 경우가 많지만, 그 동작에 기대지 않는다.)
 */
async function serveApp(request, env) {
  const direct = await env.ASSETS.fetch(request);
  if (direct.status !== 404) return direct;
  return shellResponse(request, env);
}

/** 앱 껍데기 HTML(index.html)을 200 으로 가져온다. */
async function shellResponse(request, env) {
  const origin = new URL(request.url).origin;
  const shell = await env.ASSETS.fetch(new Request(`${origin}/index.html`, { headers: request.headers }));
  return new Response(shell.body, { status: 200, headers: new Headers(shell.headers) });
}

/* ==========================================================================
 * 미리보기 만들기
 * ========================================================================== */

async function renderPreview(request, env, ctx, id) {
  const origin = new URL(request.url).origin;
  const [media, dict] = await Promise.all([
    fetchMedia(id, ctx),
    loadOgData(env, origin),
  ]);

  const shell = await shellResponse(request, env);
  if (!media) return shell;

  const meta = buildMeta(media, dict, origin, id);

  return new HTMLRewriter()
    .on('title', { element: (el) => el.remove() })
    .on('meta[property^="og:"]', { element: (el) => el.remove() })
    .on('meta[name^="twitter:"]', { element: (el) => el.remove() })
    .on('meta[name="description"]', { element: (el) => el.remove() })
    .on('head', new HeadTags(meta))
    .transform(shell);
}

/** <head> 끝에 새 태그를 붙인다. */
class HeadTags {
  constructor(tags) { this.tags = tags; }
  element(head) { head.append(this.tags, { html: true }); }
}

/** 작품 정보로 실제 태그 문자열을 만든다. */
function buildMeta(media, dict, origin, id) {
  const title = resolveKoreanTitle(media, dict);
  const description = buildDescription(media, dict, id);
  // 가로로 긴 배너가 있으면 그것이 카드에서 제일 크게 보인다. 없으면 세로 포스터를 쓴다.
  const image = media.bannerImage
    || media.coverImage?.extraLarge
    || media.coverImage?.large
    || `${origin}/og-default.png`;
  const pageUrl = `${origin}/anime/${id}`;

  const meta = [
    ['property', 'og:type', 'video.tv_show'],
    ['property', 'og:site_name', '모아니'],
    ['property', 'og:locale', 'ko_KR'],
    ['property', 'og:url', pageUrl],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:image', image],
    ['property', 'og:image:alt', `${title} 이미지`],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', description],
    ['name', 'twitter:image', image],
    ['name', 'description', description],
  ];

  return [
    `<title>${esc(title)} · 모아니</title>`,
    `<link rel="canonical" href="${esc(pageUrl)}">`,
    ...meta.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`),
  ].join('');
}

/** "2019 · TV · 26화 · 라프텔, 티빙" 형태의 한 줄 설명. */
function buildDescription(media, dict, id) {
  const parts = [];
  if (media.seasonYear) parts.push(`${media.seasonYear}`);
  const format = FORMAT_KO[media.format];
  if (format) parts.push(format);
  // 극장판·뮤직비디오는 화수가 늘 1 이라 '1화'가 붙으면 어색하다.
  const singleRun = media.format === 'MOVIE' || media.format === 'MUSIC';
  if (media.episodes && !singleRun) parts.push(`${media.episodes}화`);

  const genres = (media.genres ?? []).map((g) => GENRE_KO[g]).filter(Boolean).slice(0, 3);
  if (genres.length) parts.push(genres.join(', '));

  const ott = (dict?.ott?.[String(id)] ?? []).slice(0, 4);
  const line = parts.join(' · ');
  if (ott.length) return `${line}${line ? ' · ' : ''}${ott.join(', ')}에서 시청`;
  return line || '보고 싶은 애니를 모으는 곳, 모아니';
}

/* ==========================================================================
 * 데이터 가져오기
 * ========================================================================== */

const MEDIA_QUERY = `query($id:Int){Media(id:$id,type:ANIME){
  id title{romaji english native} synonyms format episodes seasonYear genres
  coverImage{extraLarge large} bannerImage
}}`;

/**
 * AniList 에서 작품 하나를 받아온다.
 *
 * GraphQL 은 POST 라서 Cloudflare 가 자동으로 캐시하지 않는다.
 * 그래서 GET 모양의 가짜 열쇠를 만들어 Cache API 에 직접 넣는다.
 * (AniList 는 분당 요청 수 제한이 있고, 같은 링크를 여러 명이 공유하면 같은 작품을 반복해서 묻게 된다.)
 */
async function fetchMedia(id, ctx) {
  const cache = caches.default;
  const key = new Request(`https://og-cache.moani.internal/anime/${id}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const response = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: MEDIA_QUERY, variables: { id: Number(id) } }),
  });
  if (!response.ok) return null;

  const payload = await response.json();
  const media = payload?.data?.Media;
  if (!media) return null;

  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(media), {
    headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ANILIST_TTL}` },
  })));
  return media;
}

/** 빌드 때 만들어 둔 한국어 제목·OTT 사전. isolate 안에서 한 번만 읽는다. */
let ogDataPromise = null;
function loadOgData(env, origin) {
  if (!ogDataPromise) {
    ogDataPromise = env.ASSETS.fetch(`${origin}/og-data.json`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  }
  return ogDataPromise;
}

/* ==========================================================================
 * 제목 고르기 — src/data/animeTitle.ts 의 순서를 그대로 따른다.
 * 순서를 바꾸면 미리보기 제목과 실제 화면 제목이 달라진다.
 * ========================================================================== */

function resolveKoreanTitle(media, dict) {
  const key = String(media.id);
  const byId = dict?.byId ?? {};
  const byName = dict?.byName ?? {};

  if (byId[key]) return byId[key];

  const named = byName[normalizeName(media.title?.romaji ?? '')]
    ?? byName[normalizeName(media.title?.english ?? '')];
  if (named) return named;

  const native = media.title?.native?.trim();
  if (native && HANGUL.test(native)) return native;

  const synonym = (media.synonyms ?? []).find((n) => n && HANGUL.test(n));
  if (synonym) return synonym;

  const low = dict?.low ?? {};
  if (low[key]) return low[key];

  return media.title?.romaji ?? media.title?.english ?? media.title?.native ?? '제목 미상';
}

/* ========================================================================== */

const esc = (value = '') => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/\s+/g, ' ').trim();
