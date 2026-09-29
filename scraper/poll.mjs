// 커버리지 레이더 라이브 — 수집 스크립트
// GitHub Actions에서 5분 간격으로 이 파일을 실행함(.github/workflows/poll-telegram.yml, poll-keywords.yml 참고 — 텔레그램/키워드를 따로 실행).
// 로컬에서 테스트하려면: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scraper/poll.mjs

import { createClient } from "@supabase/supabase-js";
import Parser from "rss-parser";
import { KEYWORD_BATCH_SIZE, GROUP_SIZE, CONCURRENCY, PER_KEYWORD_LIMIT, categorize, guessSentiment, guessImportance } from "./sources.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY 환경변수가 없습니다.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const rss = new Parser({ timeout: 15000 });

function googleNewsUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
}

function splitTitleSource(rawTitle) {
  // Google News 타이틀은 보통 "기사 제목 - 매체명" 형태
  const idx = rawTitle.lastIndexOf(" - ");
  if (idx === -1) return { title: rawTitle, source: "Google News" };
  return { title: rawTitle.slice(0, idx), source: rawTitle.slice(idx + 3) };
}

let failedSearches = 0; // 이번 실행에서 (재시도 후에도) 실패한 키워드 검색 수 — 차단 여부 확인용

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function fetchKeywordGroup(group) {
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
    failedSearches++;
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

async function fetchTelegramItems(handle) {
  try {
    const res = await fetch(`https://t.me/s/${handle}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; coverage-radar-bot/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const blocks = html.split('class="tgme_widget_message ').slice(1);
    const items = [];
    for (const block of blocks.slice(-20)) {
      const postMatch = block.match(/data-post="([^"]+)"/);
      const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
      const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (!postMatch || !timeMatch) continue;
      const rawText = textMatch ? textMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
      if (!rawText) continue;
      const title = rawText.length > 60 ? rawText.slice(0, 60) + "…" : rawText;
      items.push({
        title,
        // 뉴스정리/브리핑 스타일 글은 꽤 길 수 있어서 넉넉하게 저장(2026-09-23 늘림) —
        // summarize.js의 텔레그램 다중뉴스 분리 단계가 원문 전체를 봐야 정확히 쪼갤 수 있음.
        summary: rawText.slice(0, 3000),
        url: `https://t.me/${postMatch[1]}`,
        source: `텔레그램: ${handle}`,
        source_type: "telegram",
        category: categorize(rawText),
        keyword_match: null,
        sentiment: guessSentiment(rawText),
        importance: guessImportance(rawText),
        published_at: timeMatch[1],
      });
    }
    return items;
  } catch (err) {
    console.error(`[telegram] ${handle} 실패:`, err.message);
    return [];
  }
}

// 실행 방식: node scraper/poll.mjs telegram   — 텔레그램 채널만(몇 초, 워크플로 poll-telegram.yml)
//            node scraper/poll.mjs keywords   — 추적 키워드만(Google News, 워크플로 poll-keywords.yml)
// 둘을 따로 돌려서, 키워드 수집이 느려지거나 차단돼도 텔레그램 수집은 영향이 없게 함.
const MODE = process.argv[2];
if (MODE !== "telegram" && MODE !== "keywords") {
  console.error("사용법: node scraper/poll.mjs telegram|keywords");
  process.exit(1);
}

async function main() {
  let allItems = [];
  let note = "";

  if (MODE === "keywords") {
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

    const results = await runPool(groups, fetchKeywordGroup);
    // 같은 실행 안에서 주소가 같거나 제목이 같은 기사(여러 매체가 똑같이 받아쓴 것)는 하나만 남김
    const seen = new Set();
    allItems = results.flat().filter((it) => {
      if (!it.url || !it.title) return false;
      const key = "t:" + it.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      if (seen.has(key) || seen.has("u:" + it.url)) return false;
      seen.add(key);
      seen.add("u:" + it.url);
      return true;
    });

    await supabase.from("poll_cursor").update({ idx: nextIdx }).eq("id", 1);
    note = `키워드 ${batch.length}개` + (failedSearches ? ` · 검색 ${groups.length}번 중 ${failedSearches}번 실패(차단 의심)` : "");
  } else {
    const { data: channelRows } = await supabase.from("telegram_channels").select("handle");
    const channels = (channelRows || []).map((r) => r.handle);
    console.log(`텔레그램 채널 ${channels.length}개 조회`);
    const results = await Promise.all(channels.map(fetchTelegramItems));
    allItems = results.flat().filter((it) => it.url && it.title);
    note = `텔레그램 채널 ${channels.length}개`;
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

  const { count } = await supabase.from("items").select("id", { count: "exact", head: true });

  // 수집 상태는 종류별로 한 줄씩: id 1 = 텔레그램, id 2 = 추적 키워드(화면 상단에 마지막 수집 시각을 따로 표시)
  // id 2 줄은 supabase/schema.sql 아래쪽 안내대로 한 번 만들어 둬야 함(없으면 여기서 오류 로그만 남기고 계속)
  const { error: statusError } = await supabase.from("status").upsert(
    {
      id: MODE === "keywords" ? 2 : 1,
      last_run_at: new Date().toISOString(),
      last_note: `이번 실행: 신규 ${inserted}건 (${note})`,
      total_items: count || 0,
    },
    { onConflict: "id" }
  );
  if (statusError) console.error("status 갱신 실패:", statusError.message);

  console.log(`신규 저장: ${inserted}건, 전체 누적: ${count}건`);
}

main().catch((err) => {
  console.error("poll 실행 중 오류:", err);
  process.exit(1);
});
