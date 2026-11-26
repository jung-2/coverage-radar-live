// 커버리지 레이더 라이브 — 수집 로직(공용)
// 두 군데서 똑같이 씀(2026-11-26 분리):
//   - scraper/poll.mjs  : GitHub Actions가 실행(예비용 — GitHub가 "5분마다"를 무시하고 실제론 6~10시간에 한 번만 돌림)
//   - api/poll.js       : 대시보드를 열어 두면 화면이 5분마다 부르는 Vercel 함수(주 수집 경로)
// supabase 클라이언트를 받아서 실행하고, 결과 요약을 돌려줌. 환경변수/프로세스 종료는 부르는 쪽이 처리.

import Parser from "rss-parser";
import { KEYWORD_BATCH_SIZE, GROUP_SIZE, CONCURRENCY, PER_KEYWORD_LIMIT, categorize, guessSentiment, guessImportance } from "./sources.mjs";

const rss = new Parser({ timeout: 15000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 텔레그램 빠진 글 거슬러 올라가기(2026-11-26 추가): t.me/s/<채널> 한 페이지엔 최근 20개쯤만 나옴.
// 수집이 몇 시간씩 안 돌면 그사이 20개 넘게 올라온 글은 예전엔 그냥 날아갔음. 지금은 DB에 있는 그 채널의
// 가장 최근 글 번호까지 ?before=<번호>로 이전 페이지를 더 읽어서 채움. 단, 너무 옛날(요약이 어차피 안 보는
// 48시간 이전)이거나 페이지를 너무 많이 넘기면 멈춤.
const TG_MAX_PAGES = 8;
const TG_BACKFILL_MS = 48 * 3600 * 1000;

function googleNewsUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
}

function splitTitleSource(rawTitle) {
  // Google News 타이틀은 보통 "기사 제목 - 매체명" 형태
  const idx = rawTitle.lastIndexOf(" - ");
  if (idx === -1) return { title: rawTitle, source: "Google News" };
  return { title: rawTitle.slice(0, idx), source: rawTitle.slice(idx + 3) };
}

// 429(차단)나 일시 오류면 잠깐 기다렸다가 딱 1번만 재시도
async function parseWithRetry(url) {
  try {
    return await rss.parseURL(url);
  } catch (err) {
    await sleep(2500);
    return await rss.parseURL(url);
  }
}

// 키워드 여러 개를 "A" OR "B" 한 번의 검색으로 조회하고, 기사 제목/요약에 들어있는 키워드로
// keyword_match를 다시 붙임(어느 키워드에도 안 걸리는 기사는 관련 없는 검색 결과라 버림).
async function fetchKeywordGroup(group, stats) {
  try {
    const query = group.map((k) => `"${k}"`).join(" OR ");
    const feed = await parseWithRetry(googleNewsUrl(query));
    const counts = new Map();
    const out = [];
    for (const it of feed.items || []) {
      const { title, source } = splitTitleSource(it.title || "");
      const text = `${title} ${it.contentSnippet || ""}`;
      const lower = text.toLowerCase();
      const keyword = group.find((k) => lower.includes(k.toLowerCase()) && (counts.get(k) || 0) < PER_KEYWORD_LIMIT);
      if (!keyword) continue;
      counts.set(keyword, (counts.get(keyword) || 0) + 1);
      out.push({
        title,
        summary: (it.contentSnippet || "").slice(0, 300),
        url: it.link,
        source,
        source_type: "newswire",
        category: categorize(text),
        keyword_match: keyword,
        sentiment: guessSentiment(text),
        importance: guessImportance(text),
        published_at: it.isoDate || it.pubDate || new Date().toISOString(),
      });
    }
    return out;
  } catch (err) {
    stats.failedSearches++;
    console.error(`[keyword] ${group.join(", ")} 실패:`, err.message);
    return [];
  }
}

// 동시에 CONCURRENCY개까지만 실행(요청 사이에 짧게 쉼)
async function runPool(tasks, worker) {
  const results = [];
  let next = 0;
  async function run() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await worker(tasks[i]);
      await sleep(300);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, run));
  return results;
}

// t.me/s 페이지 HTML → 글 목록(오래된 것부터). id = 채널 안 글 번호
export function parseTelegramPage(html, handle) {
  const blocks = html.split('class="tgme_widget_message ').slice(1);
  const posts = [];
  for (const block of blocks) {
    const postMatch = block.match(/data-post="([^"]+)"/);
    const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
    const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!postMatch || !timeMatch) continue;
    const id = Number(postMatch[1].split("/").pop());
    const rawText = textMatch ? textMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
    posts.push({ id, post: postMatch[1], time: timeMatch[1], rawText });
  }
  return posts.map((p) => ({ ...p, handle }));
}

function telegramItem(p) {
  const title = p.rawText.length > 60 ? p.rawText.slice(0, 60) + "…" : p.rawText;
  return {
    title,
    // 뉴스정리/브리핑 스타일 글은 꽤 길 수 있어서 넉넉하게 저장(2026-09-23 늘림) —
    // summarize.js의 텔레그램 다중뉴스 분리 단계가 원문 전체를 봐야 정확히 쪼갤 수 있음.
    summary: p.rawText.slice(0, 3000),
    url: `https://t.me/${p.post}`,
    source: `텔레그램: ${p.handle}`,
    source_type: "telegram",
    category: categorize(p.rawText),
    keyword_match: null,
    sentiment: guessSentiment(p.rawText),
    importance: guessImportance(p.rawText),
    published_at: p.time,
  };
}

async function fetchTelegramPage(handle, beforeId) {
  const url = `https://t.me/s/${handle}` + (beforeId ? `?before=${beforeId}` : "");
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; coverage-radar-bot/1.0)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseTelegramPage(await res.text(), handle);
}

// knownMaxId: DB에 이미 있는 이 채널의 가장 최근 글 번호(없으면 null → 첫 페이지만 읽음)
export async function fetchTelegramItems(handle, knownMaxId, stats) {
  try {
    let posts = await fetchTelegramPage(handle);
    let pages = 1;
    const cutoff = Date.now() - TG_BACKFILL_MS;
    while (knownMaxId != null && posts.length && pages < TG_MAX_PAGES) {
      const oldest = posts[0];
      if (oldest.id <= knownMaxId + 1 || new Date(oldest.time).getTime() < cutoff) break;
      const older = (await fetchTelegramPage(handle, oldest.id)).filter((p) => p.id < oldest.id);
      if (!older.length) break;
      posts = [...older, ...posts];
      pages++;
    }
    if (pages > 1) stats.backfilledPages += pages - 1;
    return posts.filter((p) => p.rawText && (knownMaxId == null || p.id > knownMaxId)).map(telegramItem);
  } catch (err) {
    stats.failedChannels++;
    console.error(`[telegram] ${handle} 실패:`, err.message);
    return [];
  }
}

// 채널별 DB에 있는 가장 최근 글 번호
async function knownMaxIds(supabase, channels) {
  const out = new Map();
  await Promise.all(channels.map(async (handle) => {
    const { data } = await supabase
      .from("items")
      .select("url")
      .eq("source", `텔레그램: ${handle}`)
      .order("published_at", { ascending: false })
      .limit(1);
    const id = data && data[0] ? Number(String(data[0].url).split("/").pop()) : NaN;
    out.set(handle, Number.isFinite(id) ? id : null);
  }));
  return out;
}

// 추적 키워드 뉴스는 "오늘" 것만 씀(2026-09-29): 오늘 0시(KST) 이전에 나온 기사는 저장하지 않고, 이미 저장된 것도 지움.
export function startOfTodayKstIso() {
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const y = kstNow.getUTCFullYear(), m = kstNow.getUTCMonth(), d = kstNow.getUTCDate();
  return new Date(Date.UTC(y, m, d) - 9 * 3600 * 1000).toISOString();
}

// mode: "telegram" | "keywords". 둘을 따로 돌려서, 키워드 수집이 느려지거나 차단돼도 텔레그램 수집은 영향이 없게 함.
// trigger: 누가 돌렸는지(status 메모에 남김 — "github" | "화면")
export async function runCollect(supabase, mode, { trigger = "github" } = {}) {
  const stats = { failedSearches: 0, failedChannels: 0, backfilledPages: 0 };
  let allItems = [];
  let note = "";

  if (mode === "keywords") {
    const [{ data: keywordRows }, { data: cursorRow }] = await Promise.all([
      supabase.from("keywords").select("term").order("term"),
      supabase.from("poll_cursor").select("idx").eq("id", 1).single(),
    ]);
    const keywords = (keywordRows || []).map((r) => r.term);
    const startIdx = cursorRow?.idx || 0;
    const batch = [];
    for (let i = 0; i < Math.min(KEYWORD_BATCH_SIZE, keywords.length); i++) {
      batch.push(keywords[(startIdx + i) % keywords.length]);
    }
    const nextIdx = keywords.length ? (startIdx + KEYWORD_BATCH_SIZE) % keywords.length : 0;

    const groups = [];
    for (let i = 0; i < batch.length; i += GROUP_SIZE) groups.push(batch.slice(i, i + GROUP_SIZE));
    console.log(`키워드 ${batch.length}개(전체 ${keywords.length}개 중, 검색 ${groups.length}번) 조회`);

    const todayStart = startOfTodayKstIso();
    const results = await runPool(groups, (g) => fetchKeywordGroup(g, stats));
    // 같은 실행 안에서 주소가 같거나 제목이 같은 기사(여러 매체가 똑같이 받아쓴 것)는 하나만 남김
    const seen = new Set();
    allItems = results.flat().filter((it) => {
      if (!it.url || !it.title) return false;
      if (new Date(it.published_at) < new Date(todayStart)) return false; // 오늘 0시(KST) 이전 기사는 안 씀
      const key = "t:" + it.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      if (seen.has(key) || seen.has("u:" + it.url)) return false;
      seen.add(key);
      seen.add("u:" + it.url);
      return true;
    });

    await supabase.from("poll_cursor").update({ idx: nextIdx }).eq("id", 1);
    note = `키워드 ${batch.length}개` + (stats.failedSearches ? ` · 검색 ${groups.length}번 중 ${stats.failedSearches}번 실패(차단 의심)` : "");
  } else {
    const { data: channelRows } = await supabase.from("telegram_channels").select("handle");
    const channels = (channelRows || []).map((r) => r.handle);
    console.log(`텔레그램 채널 ${channels.length}개 조회`);
    const known = await knownMaxIds(supabase, channels);
    const results = await Promise.all(channels.map((h) => fetchTelegramItems(h, known.get(h), stats)));
    allItems = results.flat().filter((it) => it.url && it.title);
    note = `텔레그램 채널 ${channels.length}개`
      + (stats.backfilledPages ? ` · 빠진 글 ${stats.backfilledPages}페이지 더 읽음` : "")
      + (stats.failedChannels ? ` · ${stats.failedChannels}개 채널 실패` : "");
  }

  console.log(`수집된 원시 항목: ${allItems.length}건 (중복은 DB unique(url)에서 자동 무시)`);

  let inserted = 0;
  if (allItems.length) {
    // url 중복은 upsert + ignoreDuplicates로 DB 레벨에서 처리 (경합 조건에도 안전)
    const { data, error } = await supabase
      .from("items")
      .upsert(allItems, { onConflict: "url", ignoreDuplicates: true })
      .select("id");
    if (error) {
      console.error("insert 실패:", error.message);
    } else {
      inserted = data?.length || 0;
    }
  }

  let purged = 0;
  if (mode === "keywords") {
    const { data: deleted, error: delError } = await supabase
      .from("items")
      .delete()
      .eq("source_type", "newswire")
      .lt("published_at", startOfTodayKstIso())
      .select("id");
    if (delError) console.error("지난 키워드 기사 삭제 실패:", delError.message);
    else purged = deleted?.length || 0;
    if (purged) console.log(`오늘 이전 키워드 기사 ${purged}건 삭제`);
  }

  const { count } = await supabase.from("items").select("id", { count: "exact", head: true });

  // 수집 상태는 종류별로 한 줄씩: id 1 = 텔레그램, id 2 = 추적 키워드(화면 상단에 마지막 수집 시각을 따로 표시)
  // id 2 줄은 supabase/schema.sql 아래쪽 안내대로 한 번 만들어 둬야 함(없으면 여기서 오류 로그만 남기고 계속)
  const { error: statusError } = await supabase.from("status").upsert(
    {
      id: mode === "keywords" ? 2 : 1,
      last_run_at: new Date().toISOString(),
      last_note: `이번 실행(${trigger}): 신규 ${inserted}건 (${note})`,
      total_items: count || 0,
    },
    { onConflict: "id" }
  );
  if (statusError) console.error("status 갱신 실패:", statusError.message);

  console.log(`신규 저장: ${inserted}건, 전체 누적: ${count}건`);
  return { mode, inserted, purged, note };
}
