// Vercel 서버리스 함수 — 대시보드의 "브리핑 생성" 버튼이 호출하는 엔드포인트.
// 서비스 키/API 키는 전부 서버사이드 환경변수로만 쓰고, 브라우저에는 절대 노출되지 않음.
//
// 방식: 새로 쌓인 기사/텔레그램 항목을 AI(Gemini)에게 보여줄 때, "오늘 이미 진행 중인 클러스터 목록"도
// 함께 보여줘서 같은 주제면 기존 클러스터에 합치고, 새로운 주제면 새 클러스터를 만들게 함
// (tool-use로 구조화된 JSON 강제). 즉 "브리핑 생성"을 하루에 여러 번 눌러도 같은 주제 카드는
// 계속 갱신되고, 그 안에 시간별 업데이트 이력이 쌓임 — 완전히 새로 쌓이는 목록이 아님.
//
// 클러스터 하나 = { headline, impact(high/medium/low), targets, why(현재 종합 설명),
//                   sources(누적 원본 기사), updates(시간별 이력 [{at, note}]) }
// day_key(KST 날짜) 기준으로 하루 단위로만 누적되고, 자정 지나면 새 클러스터로 시작됨.
//
// 클러스터링 기준(2026-09-22 정리): 특정 회사 고유의 이벤트는 그 회사 단위로, 여러 회사에 걸친
// 섹터/테마성 흐름은 섹터/테마 단위로 묶음 — 아래 UPDATE_TOOL.description과 프롬프트 참고.
//
// 백로그 처리(2026-09-22 추가): 예전엔 한 번 호출에 MAX_ITEMS(150)개까지만 처리하고 나면
// "다음 조회 시작점"이 무조건 "지금 이 순간"으로 넘어가버려서, 오래 밀렸을 때 150개 넘는 나머지가
// 영원히 스킵되는 버그가 있었음(예: 6시간 25분 밀렸을 때 150개만 처리되고 나머지 소리소문없이 유실).
// 지금은 "마지막으로 처리 완료한 항목의 added_at" 을 커서로 저장해두고, 버튼 한 번 누르면
// 그 커서 이후로 밀린 게 남아있는 한(최대 MAX_BATCHES번 또는 TIME_BUDGET_MS 시간 예산 안에서)
// 150개씩 끊어서 자동으로 이어서 처리함. 시간/횟수 예산을 다 써서 이번 호출에 못 끝내도,
// 커서는 "실제로 처리 완료한 만큼만" 전진하므로 다음 클릭 때 그 지점부터 이어서 처리됨 — 유실 없음.
// (같은 poll 실행에서 넣은 행들은 added_at이 동일할 수 있어서, 배치 경계가 그 타임스탬프 그룹을
//  중간에 자르지 않도록 살짝 넘겨서(EXTEND_BUFFER) 안전하게 끊음 — 아래 fetchNextBatch 참고.)
//
// 중복 클러스터 방지 안전장치(2026-09-22 추가): 예전엔 프롬프트에 "오늘 진행 중인 클러스터"를
// MAX_EXISTING_CLUSTERS개까지만 보여줬는데, 하루에 그보다 클러스터가 많이 쌓이면(예: 70개 이상)
// 모델이 안 보이는 기존 클러스터와는 매칭을 못 해서 같은 회사/사건인데도 새 클러스터를 또
// 만들어버리는 문제가 있었음(같은 배치 안에서 모델이 판단을 잘못해서 쪼개는 경우도 있었음).
// 지금은 모델이 "새 클러스터"라고 반환한 항목들을, 프롬프트에 안 보였던 것까지 포함해서
// 오늘 하루 전체 클러스터를 대상으로 (같은 대표 타겟 + 헤드라인 유사도) 기준으로 한 번 더
// 코드 레벨에서 검사해서, 겹치는 게 있으면 새로 만들지 않고 기존 클러스터에 강제로 합침 —
// 단, 같은 회사/타겟이라도 사건 자체가 다르면(유사도 낮으면) 절대 합치지 않음.
//
// targets 태깅 강제(2026-09-22 추가): 예전엔 모델이 애매한 항목을 "기타 시장 뉴스" 같은
// 이름 없는 통에 넣으면서 targets를 빈 배열로 남기는 경우가 있었음 — 이러면 나중에 회사명으로
// 검색해도 안 걸려서, 데이터는 있는데 못 찾는 문제가 생김. 지금은 targets가 최소 1개는
// 있도록 프롬프트로 강제하고, 그래도 비어있으면 코드에서 해당 항목의 원본 카테고리(category)를
// 최후의 안전장치로 채워 넣음 — 완전히 빈 태그는 절대 안 나오게 함.
//
// 회사/섹터 카드 그룹핑(2026-09-22 추가): targets 배열의 첫 번째 항목이 이 클러스터를 대표하는
// 회사/섹터명이 되도록 모델에게 요청함 — 화면(web/index.html)에서 이 첫 번째 항목 기준으로
// 클러스터를 묶어서 회사/섹터 카드 하나 + 그 아래 사건별 서브 항목으로 보여줌.
//
// 리포트 숫자 요약(2026-09-22 추가): 증권사 리포트에서 나온 내용은 note를 자유 문장이 아니라
// 실적(매출/영업이익/EPS, 컨센서스 대비 BEAT/MISS)·목표주가 변화·추정치 변화율·핵심 driver 숫자
// 순서로 정리하도록 프롬프트로 강제함 — 아래 프롬프트의 "[note 작성 규칙]" 참고.
//
// 실제 게시 시각 기준 타임스탬프(2026-09-23 변경): 예전엔 day_key(오늘/어제 구분)·updated_at
// (카드 대표 시간)·업데이트 이력 시각을 전부 "AI가 브리핑 생성을 처리한 시각"으로 기록했음.
// 백로그가 밀렸다가 한번에 처리되면 몇 시간 전(또는 전날) 기사도 화면엔 "방금 나온 것"처럼
// 보이는 문제가 있었음. 지금은 원본 기사/텔레그램의 실제 published_at 기준으로 기록함 —
// 새 클러스터의 day_key/created_at/updated_at은 그 클러스터를 이룬 기사 중 가장 최근 게시
// 시각으로, 기존 클러스터 갱신 시 updated_at도 (기존 값, 새로 합쳐진 기사 게시 시각) 중 늦은
// 쪽으로 기록함. day_key 자체는 클러스터가 처음 생성된 날짜에 고정(나중 업데이트로 안 움직임).
// 아래 latestPublishedAt/distinctDayKeys 참고.
//
// 필요한 Vercel 환경변수(Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  — GitHub Actions 시크릿과 같은 값
//   GEMINI_API_KEY                      — aistudio.google.com/apikey 에서 발급받은 키(무료 등급)
//
// AI 모델 변경(2026-10-25): 비용 때문에 Claude Haiku → Google Gemini 무료 등급으로 바꿈.
// 무료 등급은 분당/하루 호출 횟수 한도가 있음(하루 한도는 미국 서부 자정 = 한국 오후 4~5시에 초기화).
// 요약 품질이 아쉬우면 MODEL만 "gemini-3.8-flash"로 바꾸면 됨(대신 무료 한도가 더 빡빡함).
//
// 참고: vercel.json에 이 함수의 maxDuration을 300초(Vercel 무료 플랜 최대치)로 설정해둬야
// 백로그가 많이 밀렸을 때 여러 배치를 이어서 처리할 시간이 확보됨.

import { createClient } from "@supabase/supabase-js";

// (2026-11-28) 사용자 결정: 무료 등급 안에서 윗급 모델로 올림(flash-lite → flash). 무료 한도가 더 빡빡해서
// 429(한도 초과)가 자주 나면 "gemini-3.5-flash-lite"로 되돌릴 것.
const MODEL = "gemini-3.8-flash";
const MAX_ITEMS = 40;               // 한 배치당 분류할 최대 신규 항목 수(비용/토큰 제한용 + 응답 길이 제한용)
                                     // (2026-09-27 150→75, 2026-10-23 75→40: 배치가 크면 응답이 길어져서 한 번에
                                     // 1~2분씩 걸리고 형식 오류도 잦았음 — 작게 끊어서 빨리빨리 여러 번 처리하는 게 나음)
const SCAN_LIMIT = 1000;            // 커서 이후 항목을 훑어볼 최대 개수(url/시각만 가볍게 읽음 — fetchNextBatch 참고)
const PROMPT_SUMMARY_CHARS = 1500;  // 클러스터링 프롬프트에 같이 보여줄 본문 길이(2026-10-23 추가 — 예전엔 앞 60자 제목만 보여줘서
                                     // 리포트 숫자를 AI가 아예 못 봤음)
                                     // (2026-11-28 400→1500: 글 4개 중 1개가 400자를 넘는데 그 뒤쪽은 AI가 아예 못 봐서,
                                     //  긴 리포트 요약 글의 뒤쪽 숫자가 통째로 빠졌음. 실제 48시간 데이터로 재 보니 원문 숫자의 10%만 요약에 남았음)
const MAX_FACTS = 30;               // 사건(update) 하나에 저장할 숫자·사실 줄 수 한도
const MAX_FACT_CHARS = 300;         // 한 줄 최대 길이
const SPLIT_MIN_CHARS = 300;        // 이보다 짧은 텔레그램 글은 "뉴스정리" 분리 후보에서 뺌(짧은 글은 쪼갤 게 없음)
const SPLIT_TEXT_CHARS = 1500;      // 분리 단계에 보여줄 원문 최대 길이(원문 3000자 × 수십 건이면 프롬프트가 너무 커짐)
const MAX_EXISTING_CLUSTERS = 80;   // 프롬프트에 보여줄 "오늘 진행 중인 클러스터" 최대 개수(이보다 많아도
                                     // 아래 중복 방지 안전장치가 전체 클러스터를 대상으로 한 번 더 검사함)
const MAX_TOKENS = 40000;           // 리포트 숫자 요약이 길어질 수 있어 넉넉히 잡음
                                     // (2026-10-25 24000→40000: Gemini는 내부 생각 토큰도 이 한도에 포함됨)
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000; // 이전 실행 기록이 없을 때 기본 조회 범위(24시간)
const MAX_BACKLOG_MS = 48 * 60 * 60 * 1000; // (2026-09-27 추가) 커서가 이보다 더 옛날이면 강제로 이 시점까지 당겨서 시작함.
                                     // 화면은 어차피 오늘/어제만 보여주는데, 무슨 이유로든(장애 등) 커서가 며칠씩 밀리면
                                     // 오래된 거 순서대로 다 처리해야 최근 걸로 넘어가는 구조라 오늘/어제가 계속 안 보이는
                                     // 문제가 있었음 — 48시간(이틀)보다 오래 밀린 백로그는 그냥 버리고 최근 것부터 처리함.
const MAX_BATCHES = 20;             // 한 번 호출에 처리할 배치 수 안전장치(주로 아래 시간 예산이 먼저 걸림)
const TIME_BUDGET_MS = 60 * 1000;   // 이 시간이 지나면 다음 배치를 새로 시작하지 않고 응답함 — 밀린 게 남으면 화면이 자동으로 이어서 호출
                                     // (2026-10-23 180→60초: 한 호출이 오래 걸릴수록 브라우저/네트워크 쪽에서 끊기거나("Failed to fetch")
                                     // 300초 강제 종료에 걸릴 위험이 커짐 — 짧게 자주 응답하는 게 안정적이고 진행 상황도 바로 보임)
                                     // (2026-09-27 축소: 240초는 이 체크 통과 직후 시작한 배치 하나가 오래 걸리면
                                     // (텔레그램 분리+클러스터링 합쳐서 배치당 1~2분씩 걸릴 수 있음) 실제로 300초를
                                     // 넘겨버려서 Vercel이 함수를 강제 종료(FUNCTION_INVOCATION_TIMEOUT)하는 경우가
                                     // 있었음 — 마지막 배치가 끝날 여유를 충분히 두기 위해 더 보수적으로 줄임)
const IMPACT_RANK = { high: 3, medium: 2, low: 1 };

// ── 숫자·사실 목록(facts, 2026-11-28 추가) ──────────────────────────
// 예전엔 카드에 AI가 쓴 2~3문장(note)만 남아서 원문 숫자가 거의 다 사라졌음(low는 설명 자체가 없었음).
// 지금은 AI가 note와 별개로 "원문에 나온 숫자·사실을 한 줄씩 전부" facts로 돌려주고, 이걸 updates 이력에
// {at, note, facts, run_at}로 같이 저장함(새 컬럼 없이 기존 updates 칸에 들어감). 화면이 모든 이력의 facts를 모아서 보여줌.
function cleanFacts(raw) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(raw) ? raw : []) {
    if (typeof f !== "string") continue;
    const line = f.replace(/\s+/g, " ").replace(/^[-•·*▪◦]\s*/, "").trim().slice(0, MAX_FACT_CHARS);
    const key = line.replace(/\s/g, "");
    if (!line || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

// ── 잡동사니 통 막기(2026-11-28 추가) ──────────────────────────────
// AI가 관련 없는 글을 "기타 소식 모음" 같은 카드 하나에 계속 몰아넣어서, 글 37개가 한 카드에 묻히고
// 설명은 마지막 글 것만 남는 일이 있었음. 이런 제목의 카드는 (1) 합칠 대상 목록에서 빼서 더 안 커지게 하고
// (2) AI가 새로 만들려고 하면 글 하나씩 따로 떼어 냄.
const JUNK_BUCKET_RE = /^기타|(소식|뉴스|이슈|잡담|단신)\s*(모음|정리)|모음\s*\S{0,4}$/;
function isJunkBucket(headline) { return JUNK_BUCKET_RE.test(String(headline || "").trim()); }
const DUP_SIMILARITY_THRESHOLD = 0.45; // 이 이상이면 "같은 사건"으로 보고 강제 병합 대상으로 판단

const CAT_LABEL = {
  packaging: "패키징", hbm: "HBM", cpo: "CPO/광인터커넥트", power: "전력반도체",
  ai_server: "AI서버", korea: "한국주식", biotech: "바이오", disclosure: "공시",
  telegram: "텔레그램", other: "기타",
};

// KST(UTC+9) 기준 날짜키 'YYYY-MM-DD' — 이 값이 같은 클러스터끼리만 하루 동안 누적됨
function kstDayKey(date) {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ── 중복 클러스터 강제 병합용 헬퍼 ──────────────────────────
// 한글은 띄어쓰기 기준 토큰화가 의미 없는 경우가 많아서, 글자 2-그램(bigram) 기준
// Dice 유사도로 헤드라인이 "같은 사건"인지 판단함. 타겟(회사/섹터)이 하나라도 겹치고
// 헤드라인 유사도가 임계값 이상일 때만 "같은 사건"으로 보고 병합 대상으로 삼음 —
// 같은 회사여도 사건 자체가 다르면(유사도 낮으면) 병합하지 않음.
function normTargets(targets) {
  return (Array.isArray(targets) ? targets : []).map(t => String(t).trim().toLowerCase()).filter(Boolean);
}
function sharesTarget(a, b) {
  const setB = new Set(normTargets(b));
  return normTargets(a).some(t => setB.has(t));
}
function bigramSet(s) {
  const clean = String(s || "").replace(/\s+/g, "");
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}
function headlineSimilarity(a, b) {
  const A = bigramSet(a), B = bigramSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
function isLikelyDuplicate(targetsA, headlineA, targetsB, headlineB) {
  if (!sharesTarget(targetsA, targetsB)) return false;
  return headlineSimilarity(headlineA, headlineB) >= DUP_SIMILARITY_THRESHOLD;
}

// ── 텔레그램/일반출처 교차 병합 방지(2026-09-28 추가) ──────────────────
// 예전엔 "같은 회사 + 같은 사건"이면 출처가 텔레그램이든 일반 뉴스검색이든 상관없이 하나의
// 클러스터로 합쳐버렸음. 근데 화면(web/index.html)의 텔레그램/추적키워드 탭 분류는 클러스터
// 안에 섞인 출처들 중 다수결로 탭 하나를 정하다 보니, 텔레그램발 내용이 나중에 일반뉴스 출처가
// 더 많이 합쳐지면서 "추적 키워드" 탭으로 새어 들어가는 문제가 있었음. 지금은 애초에 텔레그램
// 출처 항목과 일반(뉴스검색/키워드) 출처 항목이 하나의 클러스터로 합쳐지지 못하게 막음 — 같은
// 사건이 텔레그램과 일반뉴스 양쪽에 다 잡히면, 카드가 2개로 나뉘어서 각자 자기 탭에만 뜨게 됨.
// poll.mjs가 텔레그램 항목의 source를 항상 "텔레그램: <채널>"로 저장해서 이 접두어로 판단함.
function isTelegramSourceStr(s) {
  return (s || "").startsWith("텔레그램:");
}
function idxListOrigin(idxList, items) {
  return idxList.some(i => isTelegramSourceStr(items[i - 1]?.source)) ? "telegram" : "other";
}
function clusterOrigin(clusterRow) {
  const sources = clusterRow.sources || [];
  if (!sources.length) return "other";
  return isTelegramSourceStr(sources[0].source) ? "telegram" : "other";
}

// targets가 끝까지 비어있을 때 최후의 안전장치로 채우는 카테고리 기반 태그
function deriveCategoryFallbackTag(idxList, items) {
  const counts = {};
  idxList.forEach(i => {
    const cat = items[i - 1]?.category;
    if (cat) counts[cat] = (counts[cat] || 0) + 1;
  });
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  return CAT_LABEL[best[0]] || best[0];
}

// ── 실제 게시 시각 기반 타임스탬프(2026-09-23 추가) ──────────────────
// 예전엔 클러스터의 day_key(오늘/어제 구분)·updated_at(카드 대표 시간)·업데이트 이력 시각을
// 전부 "AI가 브리핑 생성을 처리한 시각"으로 기록했음. 그러다 보니 백로그가 밀렸다가 한번에
// 처리되면, 몇 시간 전(또는 전날) 기사도 화면엔 "방금 나온 것"처럼 보이는 문제가 있었음.
// items 테이블엔 원본 기사/텔레그램의 실제 published_at이 이미 정확히 들어있으므로,
// 지금은 이 값을 기준으로 day_key/updated_at/업데이트 이력 시각을 기록함.
function latestPublishedAt(items, idxList, fallback) {
  let max = null;
  for (const i of idxList) {
    const raw = items[i - 1]?.published_at;
    if (!raw) continue;
    const d = new Date(raw);
    if (!isNaN(d.getTime()) && (!max || d > max)) max = d;
  }
  return max || fallback || new Date();
}
// 이번 배치에 섞여있는 기사들이 실제로 걸쳐있는 날짜(들) — 백로그가 자정을 넘겨서 처리되면
// 여러 날짜가 섞여있을 수 있어서, "오늘 진행 중인 클러스터" 조회 범위를 여기서 정함
function distinctDayKeys(items) {
  const set = new Set();
  for (const it of items) {
    const d = new Date(it.published_at);
    set.add(!isNaN(d.getTime()) ? kstDayKey(d) : kstDayKey(new Date()));
  }
  return Array.from(set);
}

const UPDATE_TOOL = {
  name: "emit_updates",
  description:
    "새로 들어온 헤드라인들을 검토해서 클러스터로 정리한다. 클러스터링 기본 원칙: " +
    "(1) 특정 회사 고유의 이벤트(그 회사만의 계약·실적·투자·공장/설비 소식 등)는 그 회사 이름 단위로 클러스터링한다. " +
    "(2) 특정 회사 하나로 좁혀지지 않고 여러 회사에 걸친 섹터/산업 전반의 흐름(예: 특정 부품 공급 동향, 수요 전망, 가격 추세 등)은 " +
    "섹터/테마 이름 단위로 클러스터링하고, 관련된 여러 회사를 targets에 함께 태깅한다. " +
    "(3) 같은 회사(또는 같은 섹터/테마) + 같은 사건이면 반드시 하나의 클러스터로 합치고, 별도의 새 클러스터로 쪼개지 않는다 — " +
    "단 같은 회사라도 사건 자체가 다르면 절대 하나로 합치지 않는다. " +
    "(4) targets는 절대 비워두지 않는다 — 최소 1개는 회사명 또는 섹터/테마명으로 채우고, 첫 번째 항목이 이 클러스터를 " +
    "가장 잘 대표하는 회사/섹터명이 되도록 한다(화면에서 이 순서로 그룹핑됨). " +
    "[오늘 진행 중인 클러스터] 중 같은 회사 또는 같은 섹터·테마 + 같은 사건을 다루는 게 있으면 그 클러스터로 합치고, " +
    "없으면 새 클러스터를 만든다. 입력된 신규 헤드라인 전체가 빠짐없이, 정확히 하나의 update에 포함되어야 한다.",
  input_schema: {
    type: "object",
    properties: {
      updates: {
        type: "array",
        description: "신규 헤드라인들을 처리한 결과 목록",
        items: {
          type: "object",
          properties: {
            indices: {
              type: "array",
              items: { type: "integer" },
              description: "이 update에 속하는 [신규 헤드라인] 번호 목록 (1부터 시작, 최소 1개). 같은 회사 또는 같은 섹터/테마의 신규 헤드라인끼리는 하나로 묶어도 됨",
            },
            existing_cluster_ref: {
              type: "integer",
              description: "[오늘 진행 중인 클러스터] 목록에서 같은 회사 또는 같은 섹터/테마 + 같은 사건인 클러스터의 번호. 해당하는 기존 클러스터가 없으면 0",
            },
            headline: {
              type: "string",
              description: "existing_cluster_ref가 0일 때만 채움: 새 클러스터의 핵심을 담은 한 줄 제목 — 회사 단위 클러스터면 회사명으로 시작, 섹터 단위 클러스터면 섹터/테마명으로 시작. 원문 헤드라인을 그대로 복사하지 말고 새로 정리해서 쓸 것. 한글로 작성(한자 금지). 단 숫자는 아라비아 숫자 그대로, 영어 회사명·제품명·단위는 원문 표기 그대로 둘 것",
            },
            impact: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "이 클러스터의 중요도. 프롬프트의 [impact 규칙]대로: high = 숫자가 바뀌는 것(전망치·추정치 변경, 판도를 바꿀 이벤트, 숫자로 뒷받침된 새 의견), medium = 새 정보지만 숫자 근거가 약하거나 파급이 한 회사에 그침, low = 새 의견도 숫자 변화도 없는 반복·잡담·시황 중계",
            },
            impact_reason: {
              type: "string",
              description: "왜 이 중요도인지 10자 안팎 한마디. high/medium이면 다음 중 하나로: \"전망치 변경\", \"판도 이벤트\", \"새 의견+숫자\", \"실적·추정치 변경\", \"가격·수급 변화\", \"새 의견(숫자 없음)\", \"개별 회사 소식\". low면 \"반복\", \"잡담\", \"시황 중계\", \"홍보\" 등",
            },
            targets: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description: "관련 종목명 또는 산업/테마명. 절대 빈 배열 금지 — 특정 회사/섹터를 명확히 못 짚겠으면 가장 근접한 업종/테마명이나 내용을 가장 잘 나타내는 구체적인 표현으로 채울 것(\"시황\"·\"증시\"·\"시장동향\"·\"마켓\" 등 뭉뚱그린 단어는 절대 쓰지 말 것 — 대신 기사에서 실제로 다루는 구체적 소재로 채울 것). 첫 번째 항목이 이 클러스터를 대표하는 핵심 회사/섹터명. 섹터 단위 클러스터면 그 뒤에 관련 회사들을 나열하되, 고유 숫자(목표주가·추정치 등)가 주어진 회사만 추가할 것",
            },
            note: {
              type: "string",
              description: "모든 클러스터에서 채움(low는 무슨 내용인지 한 줄이면 됨). medium/high는: 리포트/실적 관련이면 실적(매출·영업이익·EPS, BEAT/MISS)·목표주가 변화·추정치 변화율·핵심 driver 숫자 순으로 줄바꿈 구분해서 작성, 일반 뉴스면 2~3문장 자연스러운 서술. 한글로 작성(한자 금지). 단 숫자는 아라비아 숫자 그대로, 영어 회사명·제품명·단위는 원문 표기 그대로 둘 것, 너무 축약하지 말 것",
            },
            facts: {
              type: "array",
              items: { type: "string" },
              description: "이 update에 속한 원문에 나온 숫자·구체적 사실을 한 줄에 하나씩 전부 옮겨 적은 목록(중요도와 상관없이 채움). 예: \"3분기 매출 1,155.6억위안(+21.6% YoY), 컨센서스 1,133.7억위안 상회\", \"TP 30만원 → 35만원\", \"GPU 32만 5천 개를 월 12.5억 달러에 임대\". 숫자·단위·회사명·제품명은 원문 표기 그대로(AI5, HBM4, $3.50/kWh — 한글로 풀어 쓰지 말 것). 원문에 숫자가 있으면 하나도 빼지 말 것. 원문에 없는 숫자를 만들지 말 것. 숫자나 구체적 사실이 전혀 없는 잡담이면 빈 배열",
            },
          },
          required: ["indices", "existing_cluster_ref", "headline", "impact", "impact_reason", "targets", "note", "facts"],
        },
      },
    },
    required: ["updates"],
  },
};

// ── 텔레그램 "뉴스정리" 글 분리(2026-09-23 추가) ──────────────────
// 텔레그램 채널에 여러 개의 서로 다른 뉴스가 한 번에 정리되어 올라오는 경우(뉴스정리/데일리
// 브리핑 스타일), 예전엔 이 글 전체가 통째로 하나의 클러스터로만 처리돼서 예를 들어 그 안에
// SK하이닉스 얘기가 섞여있어도 하이닉스 클러스터로는 안 들어갔음. 본격적으로 클러스터링하기
// 전에, 이런 글들을 먼저 AI가 읽고 개별 뉴스 단위로 쪼개서(여러 개의 합성 항목으로 치환)
// 이후 로직은 그대로 두어도 각 조각이 알아서 맞는 회사/섹터 클러스터로 들어가게 함.
const TELEGRAM_SPLIT_TOOL = {
  name: "split_telegram_digests",
  description:
    "텔레그램 원문 중에서 여러 개의 서로 다른 뉴스/이슈가 한 번에 정리되어 올라온 글(뉴스정리·데일리 브리핑 스타일)이 있으면, " +
    "그 글들만 골라서 각각 개별 뉴스 단위로 나눠서 반환한다. 하나의 이슈만 다루는 일반적인 글은 결과에 포함시키지 않는다(그런 항목은 원래대로 유지됨).",
  input_schema: {
    type: "object",
    properties: {
      splits: {
        type: "array",
        description: "여러 뉴스가 섞여있다고 판단된 텔레그램 항목들의 분리 결과만 포함(섞이지 않은 항목은 아예 넣지 말 것)",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "아래 [텔레그램 원문] 목록에서의 번호" },
            stories: {
              type: "array",
              minItems: 2,
              description: "이 글 안에 섞여있는 개별 뉴스 목록 — 반드시 2개 이상일 때만 이 항목을 포함시킬 것",
              items: {
                type: "object",
                properties: {
                  headline: { type: "string", description: "개별 뉴스의 한 줄 제목. 한글로 작성(한자 금지). 단 숫자는 아라비아 숫자 그대로, 영어 회사명·제품명·단위는 원문 표기 그대로 둘 것" },
                  detail: { type: "string", description: "그 뉴스에 대해 원문에 나온 구체적 내용(숫자·사실관계 등 있는 만큼)" },
                },
                required: ["headline", "detail"],
              },
            },
          },
          required: ["index", "stories"],
        },
      },
    },
    required: ["splits"],
  },
};

// Gemini API 호출 + 일시적 오류 자동 재시도(2026-10-23 추가, 2026-10-25 Claude→Gemini로 변경) — 서버가
// 잠깐 바쁘거나(503) 분당 요청 한도(429)에 걸리면 몇 초 기다렸다 최대 2번 더 시도함. 그 외 오류(400 등)는 바로 던짐.
// 도구(function) 하나를 반드시 호출하게 강제해서(mode: ANY) 구조화된 JSON 결과만 받음 — Claude 때의 tool_choice와 같은 역할.
// 반환값: { args(도구 입력값 객체, 없으면 null), finishReason }
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
async function callGemini(apiKey, tool, prompt, maxTokens) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ functionDeclarations: [{
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.input_schema,
    }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tool.name] } },
    generationConfig: { maxOutputTokens: maxTokens },
  };
  const waits = [3000, 8000];
  for (let attempt = 0; ; attempt++) {
    let apiRes;
    try {
      apiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < waits.length) { await new Promise(r => setTimeout(r, waits[attempt])); continue; }
      throw new Error(`Gemini API 연결 실패: ${err.message}`);
    }
    if (apiRes.ok) {
      const json = await apiRes.json();
      const cand = (json.candidates || [])[0] || {};
      const call = (cand.content?.parts || []).find(p => p.functionCall?.name === tool.name);
      return { args: call?.functionCall?.args || null, finishReason: cand.finishReason || "알수없음" };
    }
    const errBody = await apiRes.text();
    if (RETRYABLE_STATUS.has(apiRes.status) && attempt < waits.length) {
      console.error(`Gemini API ${apiRes.status} — ${waits[attempt] / 1000}초 후 재시도`);
      await new Promise(r => setTimeout(r, waits[attempt]));
      continue;
    }
    const hint = apiRes.status === 429 ? " (무료 한도 초과 — 잠시 후, 하루 한도면 한국 시간 오후 4~5시 이후 다시 시도)" : "";
    throw new Error(`Gemini API 오류 ${apiRes.status}${hint}: ${errBody.slice(0, 500)}`);
  }
}

async function splitTelegramDigests(items, { GEMINI_API_KEY }) {
  // 텔레그램 출처이면서 원문이 어느 정도 긴(여러 뉴스가 섞였을 가능성 있는) 항목만 후보로 삼음 —
  // 짧은 단신까지 매번 AI에 물어보면 비용만 늘고 어차피 쪼갤 게 없음.
  const candidates = [];
  items.forEach((it, i) => {
    const isTelegram = (it.source || "").startsWith("텔레그램:");
    if (isTelegram && (it.summary || "").length > SPLIT_MIN_CHARS) candidates.push({ it, idx: i + 1 });
  });
  if (!candidates.length) return items;

  const lines = candidates.map(({ it, idx }) => `${idx}. ${it.summary.slice(0, SPLIT_TEXT_CHARS)}`).join("\n\n");
  const prompt =
    `다음은 텔레그램 채널에 올라온 글들이다(번호 매겨져 있음). 이 중 "여러 개의 서로 다른 뉴스/이슈가 한 번에 정리되어" ` +
    `올라온 글(뉴스정리·데일리 브리핑 스타일)이 있으면 split_telegram_digests 도구로 그 글들만 개별 뉴스 단위로 나눠서 반환하라. ` +
    `하나의 이슈만 다루는 글은 결과에 포함시키지 말 것.\n\n[텔레그램 원문]\n${lines}`;

  try {
    const { args } = await callGemini(GEMINI_API_KEY, TELEGRAM_SPLIT_TOOL, prompt, 16000);
    if (!args || !Array.isArray(args.splits)) return items;

    const splitMap = new Map(); // 1-based index -> stories[]
    for (const s of args.splits) {
      if (Number.isInteger(s.index) && Array.isArray(s.stories) && s.stories.length >= 2) {
        splitMap.set(s.index, s.stories);
      }
    }
    if (!splitMap.size) return items;

    const newItems = [];
    items.forEach((it, i) => {
      const stories = splitMap.get(i + 1);
      const pieces = (stories || []).filter(st => st && typeof st.headline === "string" && st.headline.trim());
      if (!pieces.length) { newItems.push(it); return; } // 쪼갠 결과가 비면 원본 그대로(글이 통째로 사라지지 않게)
      for (const st of pieces) {
        newItems.push({ ...it, title: st.headline.trim(), summary: (st.detail || "").trim() });
      }
    });
    return newItems.length ? newItems : items;
  } catch (err) {
    console.error("텔레그램 분리 중 오류(그냥 원본으로 진행):", err.message);
    return items;
  }
}

// items 테이블에서 커서(added_at) 이후로 다음 배치를 가져옴(2026-10-23 다시 짬).
// poll.mjs는 한 번 실행에 새 글을 한꺼번에 넣어서, 같은 실행에서 들어온 행들은 added_at이 완전히 같음.
// 예전 방식의 문제 두 가지를 고침:
//  (1) 같은 added_at 묶음을 중간에 안 자르려고 배치를 늘려 잡다 보니, 수집이 한동안 밀렸다 한꺼번에
//      들어오면 배치 하나가 수백 건이 돼서 AI 응답이 잘리거나 형식 오류로 계속 실패 → 커서가 영영
//      안 움직이고 매번 같은 데서 막혔음.
//  (2) 커서를 JS Date로 바꾸면서 DB 시각의 마이크로초가 잘려서, 마지막 묶음이 다음 호출 때 또
//      조회되고 또 요약됐음(같은 글이 카드에 중복으로 붙고 AI 호출도 낭비).
// 지금은: 커서 이후 항목을 url/시각만 가볍게 훑고, 이미 클러스터에 들어간 url은 빼고, 남은 것 중
// 앞에서부터 MAX_ITEMS개만 집음. 커서는 "전부 처리 끝난 묶음"까지만 DB 원래 문자열 그대로 전진함 —
// 큰 묶음은 여러 호출에 나눠서 처리되고, 중간에 죽어도 이미 처리한 글은 다시 처리하지 않음.
async function fetchNextBatch(sb, cursorIso) {
  const { data: scan, error } = await sb
    .from("items")
    .select("url, added_at, published_at")
    .eq("source_type", "telegram") // 추적 키워드 뉴스는 AI 요약 없이 화면에서 바로 정리함(2026-09-29) — 텔레그램만 처리
    .gt("added_at", cursorIso)
    .order("added_at", { ascending: true })
    .order("url", { ascending: true })
    .limit(SCAN_LIMIT);
  if (error) throw error;
  if (!scan || !scan.length) return { batch: [], nextCursor: cursorIso, noMoreAfterThis: true };

  // 이미 클러스터에 들어간 url — 그 글이 들어간 클러스터는 updated_at이 그 글 게시 시각 이후라서 이걸로 범위를 좁힘
  const minPublished = scan.reduce((m, r) => (r.published_at < m ? r.published_at : m), scan[0].published_at);
  const { data: doneClusters, error: doneErr } = await sb
    .from("clusters")
    .select("sources")
    .gte("updated_at", minPublished);
  if (doneErr) throw doneErr;
  const done = new Set();
  for (const c of doneClusters || []) for (const src of c.sources || []) if (src && src.url) done.add(src.url);

  // added_at 묶음 단위로 나눔. 훑은 게 SCAN_LIMIT에 꽉 찼으면 마지막 묶음은 잘렸을 수 있으니 이번엔 안 건드림
  const groups = [];
  for (const r of scan) {
    const last = groups[groups.length - 1];
    if (last && last.at === r.added_at) last.rows.push(r); else groups.push({ at: r.added_at, rows: [r] });
  }
  const scanFull = scan.length >= SCAN_LIMIT;
  if (scanFull && groups.length > 1) groups.pop();

  const pickedUrls = [];
  let nextCursor = cursorIso;
  let more = scanFull;
  for (const g of groups) {
    const pending = g.rows.filter(r => !done.has(r.url));
    const room = MAX_ITEMS - pickedUrls.length;
    if (pending.length > room) { pickedUrls.push(...pending.slice(0, room).map(r => r.url)); more = true; break; }
    pickedUrls.push(...pending.map(r => r.url));
    nextCursor = g.at; // 이 묶음은 이번 배치까지 하면 전부 처리됨
    if (pickedUrls.length >= MAX_ITEMS) { more = more || g !== groups[groups.length - 1]; break; }
  }
  if (!pickedUrls.length) return { batch: [], nextCursor, noMoreAfterThis: !more };

  const { data: rows, error: rowsErr } = await sb
    .from("items")
    .select("title, url, source, summary, category, sentiment, importance, ticker, published_at, added_at")
    .in("url", pickedUrls);
  if (rowsErr) throw rowsErr;
  const order = new Map(pickedUrls.map((u, i) => [u, i]));
  const batch = (rows || []).sort((x, y) => order.get(x.url) - order.get(y.url));
  return { batch, nextCursor, noMoreAfterThis: !more };
}

async function summarizeCore(req, res, sb, GEMINI_API_KEY) {
  const startedAt = Date.now();

  // "업데이트 버튼을 누른 순간"(2026-09-29 추가): 화면이 버튼 한 번당 하나씩 만들어 보내는 시각.
  // 이어서 여러 번 호출돼도(밀린 게 많을 때) 같은 값이 오므로 한 번 누른 것으로 묶임. 이번에 처리한
  // 기사(sources)와 요약 메모(updates)에 run_at으로 붙여서, 화면이 누른 순간별로 구분해서 보여줌.
  // 값이 없거나 이상하면(옛날 화면 캐시 등) 이번 호출 시작 시각으로 대신함.
  let runAt = new Date();
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const d = new Date(body && body.run_at);
    const age = Date.now() - d.getTime();
    if (!isNaN(d) && age >= -60 * 1000 && age <= 6 * 3600 * 1000) runAt = d;
  } catch { /* 본문이 없거나 JSON이 아니면 무시 */ }
  const runAtIso = runAt.toISOString();

  try {
    // 1) 마지막 실행 기록 확인 (연타 방지 + 이어서 처리할 커서 위치 산정)
    //    커서는 "마지막으로 실제 처리 완료한 지점"(period_to)을 씀 — 예전처럼 "그때의 시각(created_at)"을
    //    쓰면, 처리 못 하고 남은 백로그가 있어도 다음 조회가 그냥 "지금부터"로 건너뛰어버려서 유실이 생겼었음.
    const { data: lastRun } = await sb
      .from("briefings")
      .select("created_at, period_to")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // (연타 방지 쿨다운은 2026-11-26에 없앰 — 자동 요약이 5분마다 돌면서 briefings에 기록을 남기니까 사람이
    //  "지금 업데이트"를 누를 때마다 쿨다운에 걸렸음. 동시에 두 번 도는 건 아래 handler의 잠금이 막음.)

    // 커서는 DB에서 받은 문자열 그대로 씀(2026-10-23) — JS Date로 바꾸면 마이크로초가 잘려서 같은 글을 또 처리했음
    let startCursor = lastRun?.period_to || new Date(Date.now() - FALLBACK_WINDOW_MS).toISOString();

    // 커서가 너무 옛날(48시간 초과)이면 강제로 당김 — 그 사이 밀려있던 백로그는 영영 스킵됨(의도된 동작)
    const minAllowedCursor = new Date(Date.now() - MAX_BACKLOG_MS);
    const skippedOldBacklog = new Date(startCursor) < minAllowedCursor;
    if (skippedOldBacklog) startCursor = minAllowedCursor.toISOString();

    // 2) 커서 이후로 밀린 게 남아있는 한(시간/횟수 예산 안에서) MAX_ITEMS개씩 끊어서 이어서 처리
    let cursor = startCursor;
    let totalProcessed = 0;
    let totalNewClusters = 0;
    const touchedClusterIds = new Set();
    let batchesRun = 0;
    let stoppedReason = "caught_up"; // caught_up | time_budget | batch_cap
    let cursorMoved = false;

    while (true) {
      if (batchesRun >= MAX_BATCHES) { stoppedReason = "batch_cap"; break; }
      if (Date.now() - startedAt > TIME_BUDGET_MS) { stoppedReason = "time_budget"; break; }

      const fetched = await fetchNextBatch(sb, cursor);
      let { noMoreAfterThis } = fetched;
      let nextCursor = fetched.nextCursor;
      if (!fetched.batch.length) {
        // 커서 뒤에 있는 게 전부 이미 처리된 글이면 커서만 앞으로 옮기고 계속 봄
        const moved = nextCursor !== cursor;
        if (moved) { cursor = nextCursor; cursorMoved = true; }
        if (noMoreAfterThis || !moved) { stoppedReason = "caught_up"; break; }
        continue;
      }

      // 텔레그램 "뉴스정리" 글(여러 뉴스가 한 번에 섞여있는 글)이 있으면 개별 뉴스 단위로
      // 쪼갬(2026-09-23 추가) — 쪼개진 뒤에는 이후 로직에서 완전히 일반 항목과 동일하게 처리됨.
      let items = await splitTelegramDigests(fetched.batch, { GEMINI_API_KEY });

      // 이번 배치에 실제로 섞여있는 기사 날짜(들) — 보통은 하루지만, 백로그가 자정을 넘겨서
      // 처리되면 여러 날짜가 같이 들어있을 수 있음. 아래 조회들은 전부 이 날짜(들) 기준으로 함.
      const batchDayKeys = distinctDayKeys(items);

      // 이번 배치 시점 기준으로 "진행 중인 클러스터" 다시 조회 — 같은 실행 안에서 앞 배치가
      // 만들거나 갱신한 클러스터도 다음 배치의 매칭 대상에 포함되어야 하므로 매 배치마다 새로 가져옴.
      // 프롬프트에는 최근 갱신순 MAX_EXISTING_CLUSTERS개까지만 보여줌(토큰 비용 때문).
      const { data: existingClustersRaw, error: exErr } = await sb
        .from("clusters")
        .select("id, headline, impact, targets, why, sources, updates, updated_at")
        .in("day_key", batchDayKeys)
        .order("updated_at", { ascending: false })
        .limit(MAX_EXISTING_CLUSTERS);
      if (exErr) throw exErr;
      const existingClusters = (existingClustersRaw || []).filter(c => !isJunkBucket(c.headline));

      // AI가 응답을 잘라먹거나(max_tokens) 형식을 못 맞추면(2026-10-23 추가) 예전엔 바로 오류로 끝나고 커서도
      // 안 움직여서, 다시 눌러도 같은 배치에서 계속 똑같이 실패했음. 지금은 배치를 반으로 줄여서 다시 시도하고,
      // 줄인 만큼은 커서를 안 옮김(다음 배치에서 처리됨 — 이미 처리한 글은 fetchNextBatch가 알아서 건너뜀).
      const existingLines = existingClusters.length
        ? existingClusters.map((c, i) => `${i + 1}. ${c.headline} [${(c.targets || []).join(", ") || "-"}]`).join("\n")
        : "(오늘 진행 중인 클러스터 없음)";
      let toolArgs = null;
      while (true) {
        // 텔레그램 제목은 본문 앞 60자를 자른 거라 숫자가 거의 안 들어있음 — 본문 앞부분을 같이 보여줌(2026-10-23)
        const newLines = items.map((it, i) => {
          const cat = CAT_LABEL[it.category] || it.category || "기타";
          const tag = it.ticker ? `[${it.ticker}] ` : "";
          const text = String(it.summary || it.title || "").replace(/\s+/g, " ").trim().slice(0, PROMPT_SUMMARY_CHARS);
          const head = text.startsWith(String(it.title || "").replace(/…$/, "")) ? text : `${it.title} | ${text}`;
          return `${i + 1}. (${cat}) ${tag}${head} — ${it.source || "출처불명"}`;
        }).join("\n");

        const prompt = `당신은 반도체·AI인프라 섹터를 커버하는 증권사 애널리스트를 돕는 리서치 어시스턴트입니다.

[오늘 진행 중인 클러스터] (총 ${existingClusters.length}개)
${existingLines}

[신규 헤드라인] (지난 확인 이후 새로 수집됨, 총 ${items.length}건, 번호가 매겨져 있음)
${newLines}

신규 헤드라인을 검토해서 클러스터로 정리하세요. emit_updates 도구로 결과를 반환하세요. 규칙:

[분류/병합 규칙]
- [신규 헤드라인] 전체(${items.length}건)가 빠짐없이, 정확히 하나의 update에 포함되어야 함 — 하나도 빠뜨리지 말고, 같은 번호를 두 update에 중복으로 넣지도 말 것
- 클러스터링 기준: 특정 회사 고유 이벤트(그 회사만의 계약/실적/투자/공장 소식 등)는 그 회사명 단위로 클러스터링. 여러 회사에 걸친 섹터/산업 전반 흐름(특정 회사 하나로 좁혀지지 않는 공급망/수요/가격 동향 등)은 섹터/테마명 단위로 클러스터링
- 매우 중요: 같은 회사(또는 같은 섹터/테마) + 같은 사건(같은 뉴스, 같은 발표, 같은 리포트)이면 반드시 하나의 클러스터로 합칠 것 — 같은 회사의 같은 사건을 별도의 새 클러스터 여러 개로 쪼개서 만들지 말 것. 단, 같은 회사라도 사건 자체가 다르면(예: 인사 이슈와 신규 계약은 별개 사건) 절대 하나로 합치지 말고 각각 별도 클러스터로 유지
- existing_cluster_ref: 위 [오늘 진행 중인 클러스터] 목록에서 같은 회사(또는 같은 섹터/테마) + 같은 사건인 번호. 해당하는 게 없으면 0

[targets 규칙 — 절대 비워두지 말 것]
- targets는 반드시 최소 1개 이상 채워야 함 — 빈 배열 금지.
- 특정 회사나 특정 업종/섹터/테마를 명확히 짚을 수 있으면 그 이름으로 채울 것(예: "SK하이닉스", "HBM", "AI인프라")
- 특정 회사·섹터를 명확히 짚을 수 없는 일반적인 시장 전체 동향/투자심리/지수 얘기(예: 코스피·코스닥 등락, 외국인 수급, 시장 전반 분위기, 거시경제 등)라도, "시황"·"증시"·"시장동향"·"마켓" 같은 뭉뚱그린 단어는 절대 쓰지 말 것 — 대신 기사에서 실제로 다루는 구체적인 소재(예: "반도체 수출", "원달러 환율", "미국 금리", "코스피 지수" 등 실제 다뤄진 대상)로 첫 번째 항목을 채울 것. 여러 소재가 섞여있으면 가장 비중 있게 다뤄진 소재 하나를 고를 것
- targets 배열의 첫 번째 항목은 이 클러스터를 가장 잘 대표하는 핵심 회사명 또는 섹터/테마명이어야 함(화면에서 이 순서 기준으로 회사별/섹터별로 묶어서 보여줌). 나머지 관련 회사/섹터는 그 뒤에 이어서 나열
- 섹터/테마 단위 클러스터에서 여러 회사가 언급되더라도, 그 회사만의 고유한 숫자(목표주가·추정치 변경·실적 등)가 리포트/기사에 구체적으로 주어진 경우에만 그 회사도 targets에 추가할 것. 단순히 예시로 이름만 스쳐 지나간 경우는 targets에 추가하지 말 것

[headline 규칙]
- headline은 existing_cluster_ref가 0일 때만 채울 것 — 새 클러스터의 핵심을 담은 새 한 줄 제목. 회사 단위면 회사명으로 시작, 섹터 단위면 섹터/테마명으로 시작. 원문 헤드라인을 그대로 복사하지 말고 새로 정리해서 쓸 것. 한글로 작성(한자 금지). 단 숫자는 아라비아 숫자 그대로, 영어 회사명·제품명·단위는 원문 표기 그대로 둘 것

[impact 규칙]
(2026-11-28 사용자가 직접 정한 기준 — 핵심은 "숫자가 바뀌는 것"이 중요하다는 것. 특정 회사 목록이 아니라 산업(섹터) 전체 관점에서 판단할 것)
- high: 아래 중 하나에 해당하고, 원문에 그걸 보여주는 구체적 숫자나 사실이 있을 때
  · 시장·산업 전체의 숫자 전망치가 바뀜(시장 규모, capex, 출하량, 가격, 수요·공급 전망의 상향/하향)
  · 산업의 판도를 크게 바꿀 수 있는 이벤트(규제·관세·수출통제, 대형 계약·인수합병, 기술 전환, 공급 차질, 큰 고객의 발주·투자 계획 변경 등)
  · 특정 산업에 대한 새로운 의견인데 그걸 뒷받침하는 숫자가 같이 나옴(기존에 알려진 시각과 다른 뷰 + 근거 숫자)
  · 실적·가이던스·추정치·목표주가처럼 숫자가 실제로 바뀌었고, 그 변화가 그 회사 하나가 아니라 산업 전체 흐름을 말해 줌(업계 대표 회사의 실적 서프라이즈, 여러 회사 추정치 동시 변경 등)
- medium: 새 정보이긴 하지만 high에는 못 미치는 것 — 새로운 의견인데 뒷받침 숫자가 없음 / 숫자 변화가 있지만 파급이 그 회사 하나에 그침 / 이미 알려진 흐름을 새 숫자로 다시 확인해 준 정도
- low: 새로운 의견도 숫자 변화도 없는 것 — 이미 나온 내용의 반복·재전달, 주가·지수 등락만 전하는 시황 중계, 개인 감상·잡담, 홍보·공지, 일정 안내
- 헷갈리면 이렇게 물어볼 것: "이 글을 읽고 나서 바꿔야 할 숫자(전망·추정·가정)가 있는가?" 있으면 high 쪽, 생각은 바뀌는데 숫자는 아직이면 medium, 아무것도 안 바뀌면 low
- 주가가 많이 올랐다/내렸다는 것만으로는 high가 아님(왜 움직였는지 새 숫자·사건이 있어야 함). 글이 길거나 유명한 사람이 썼다는 것도 이유가 안 됨
- impact_reason에 왜 그 중요도인지 한마디로 적을 것(도구 설명의 보기 중에서 고름)

[note 작성 규칙 — 매우 중요, 아래 형식을 반드시 지킬 것]
note는 모든 클러스터에서 채움. impact가 low면 무슨 내용인지 한 줄이면 됨. medium/high는 아래 세 유형 중 해당하는 형식을 따르고, 유형마다 줄바꿈(\\n)으로 항목을 구분할 것:

(유형 A) 증권사 리서치 리포트에서 나온 "회사 단위" 클러스터(목표주가·투자의견·실적추정치·컨센서스 비교·애널리스트 코멘트 등이 언급됨):
  - 실적이 발표되어 컨센서스와 비교된 경우, 첫 줄을 "[BEAT]" 또는 "[MISS]" 또는 "[혼조]" 중 하나로 시작(매출/영업이익/EPS 중 다수 기준으로 종합 판단). 실적 발표 자체가 없으면 이 줄은 생략
  - 그 다음 줄에 매출/영업이익/EPS 각각 컨센서스 대비 숫자(있는 항목만, 없으면 그 항목은 쓰지 말 것)
  - 목표주가가 바뀌었으면 "TP: (이전값) → (신규값)" 형식으로 한 줄
  - 실적발표 없이 추정치만 조정된 경우, 매출/영업이익/EPS 추정치가 각각 몇 % 상향/하향됐는지 한 줄
  - 리포트에서 강조하는 핵심 driver 숫자 변화(출하량 전망, 마진 전망, 물량 등)가 있으면 한 줄
  - 해당 없는 항목은 쓰지 말 것(빈 줄 만들지 말 것). 숫자는 하나도 빠짐없이 담을 것 — 길어져도 됨

(유형 B) "섹터/테마 단위" 클러스터(2026-09-23 강화 — 아래 4개 항목을 하나씩 전부 확인하고, 원문에 실제로 나온 항목은 반드시 채울 것. "해당 없음"은 원문에 그 내용 자체가 없을 때만이고, 원문에 있는데 대충 한두 문장으로 뭉뚱그려서 생략하는 것은 금지):
  - 섹터 톤: 투자의견/비중 변화(비중확대·중립·비중축소) 또는 전망 방향(강세/약세/횡보 등)을 원문 표현 그대로 한 줄
  - 핵심 업황 숫자: 가격 변동률, 물량/출하량 전망치, capex 규모, 수요 성장률, 마진 전망 등 원문에 나온 숫자를 전부(하나만 고르지 말고 나온 만큼 전부) 한 줄에 나열
  - 탑픽: 리포트가 특정 종목을 콕 집어 언급했으면(목표주가·투자의견 포함) 그 종목명과 숫자를 한 줄로 — 예: "탑픽: SK하이닉스(TP 30만원), 삼성전자(TP 12만원 유지)"
  - 리스크: 원문이 명시한 리스크 요인(공급과잉, 경쟁 심화, 규제 등)이 있으면 한 줄
  - 해당 없는 항목만 생략. 아래는 실제로 있었던 나쁜 예시 — 이렇게 뭉뚱그려서 짧게 쓰는 것 금지:
    나쁜 예: "증권가 목표주가 63만원. 30만선 회복 앞두고 강기조 전망." (숫자 하나만 언급하고 나머지 다 생략 — 금지)
    좋은 예: "섹터 톤: 반도체 메모리 비중확대\n핵심 업황 숫자: HBM 가격 18개월간 60~130% 상승 전망, 메모리 시장 호황 지속 전망\n탑픽: SK하이닉스(TP 30만원), 삼성전자(TP 12만원)\n리스크: 중국 CXMT 등 후발주자 증설에 따른 공급 과잉 우려"

(유형 C) 리포트가 아닌 일반 뉴스(공시, 계약, 사건사고 등):
  - 기존처럼 자연스러운 문장 2~3문장으로. 기존 클러스터에 합치는 경우 이번에 새로 반영된 내용이 무엇인지, 새 클러스터인 경우 왜 중요한지. 너무 축약하지 말고 읽으면 바로 이해되게

모든 유형 공통: 한글로 작성(한자 금지). 단 숫자는 아라비아 숫자 그대로, 영어 회사명·제품명·단위는 원문 표기 그대로 둘 것
- 실제로 있었던 나쁜 예: "AI5 칩"을 "에이아이오분 칩"으로, "$3.50/kWh → $5.50/kWh"를 "삼점오달러에서 오점오달러"로, "60%"를 "60퍼센트"로 풀어 쓴 것 — 전부 금지. 원문 표기 그대로 쓸 것

[facts 작성 규칙 — note와 별개로 반드시 채울 것]
- facts는 이 update에 속한 원문들에 나온 숫자·구체적 사실을 한 줄에 하나씩 전부 옮겨 적은 목록. impact가 low여도 원문에 숫자가 있으면 채움
- note에 이미 쓴 숫자라도 facts에 다시 적을 것. 원문에 숫자가 10개 있으면 facts에도 10개가 다 들어가야 함 — 대표 숫자 한두 개만 고르는 것 금지
- 각 줄은 "무엇이 얼마"인지 알 수 있게 주어와 함께(예: "핵심 로컬 커머스 영업이익 57억위안(전년동기 -141억위안에서 흑자전환)"). 비교 대상(컨센서스·전년·이전 값)이 원문에 있으면 같이 적을 것
- 원문에 없는 숫자를 만들거나 계산해서 넣지 말 것. 숫자도 구체적 사실도 없는 잡담·감상이면 빈 배열

[잡동사니 통 금지]
- 서로 관련 없는 글을 "기타 소식 모음"·"기타 뉴스"·"잡담 모음" 같은 통 하나에 몰아넣지 말 것. 관련 없는 글은 각각 따로 update를 만들고 impact를 low로 둘 것`;

        const { args, finishReason } = await callGemini(GEMINI_API_KEY, UPDATE_TOOL, prompt, MAX_TOKENS);

        let failMsg = null;
        if (finishReason === "MAX_TOKENS") {
          failMsg = `응답이 너무 길어서 중간에 잘림 (처리하려던 항목 ${items.length}건)`;
        } else {
          toolArgs = args;
          if (!toolArgs || !Array.isArray(toolArgs.updates)) {
            failMsg = `Gemini가 구조화된 분류 결과를 반환하지 않음 (형식 오류, finishReason: ${finishReason})`;
          }
        }
        if (!failMsg) break;

        const urls = [...new Set(items.map(it => it.url))];
        if (urls.length <= 1) throw new Error(failMsg);
        const keep = new Set(urls.slice(0, Math.ceil(urls.length / 2)));
        console.error(`${failMsg} — 배치를 ${urls.length}건 → ${keep.size}건으로 줄여서 다시 시도`);
        items = items.filter(it => keep.has(it.url));
        nextCursor = cursor;      // 뒤쪽 절반은 아직 안 했으니 커서는 그대로
        noMoreAfterThis = false;
      }

      // 모델이 반환한 update들을 "기존 클러스터로 합칠 그룹"과 "신규 클러스터 후보"로 나눠서 모음.
      // existingGroups는 클러스터 id를 키로 씀(같은 클러스터를 가리키는 update가 여러 개여도, 또는
      // 아래 중복 방지 안전장치가 새 항목을 기존 클러스터로 재배정하는 경우에도 하나로 합쳐지도록).
      const seen = new Set();
      const existingGroups = new Map(); // clusterId -> {current, idxList, targets:Set, notes:[], impacts:[]}
      const newEntries = []; // {idxList, headline, targets, impact, note}

      function getOrCreateGroup(clusterRow) {
        if (!existingGroups.has(clusterRow.id)) {
          existingGroups.set(clusterRow.id, {
            current: clusterRow,
            idxList: [],
            targets: new Set(clusterRow.targets || []),
            notes: [],
            facts: [],
            impacts: [],
          });
        }
        return existingGroups.get(clusterRow.id);
      }

      for (const u of toolArgs.updates) {
        const idxList = Array.isArray(u.indices)
          ? u.indices.filter(i => Number.isInteger(i) && i >= 1 && i <= items.length && !seen.has(i))
          : [];
        if (!idxList.length) continue;
        idxList.forEach(i => seen.add(i));

        const impact = ["high", "medium", "low"].includes(u.impact) ? u.impact : "low";
        // 왜 그 중요도인지 한마디(2026-11-28 추가) — 화면 카드의 중요도 옆에 작게 보여줘서, 기준이 틀렸을 때 바로 알아볼 수 있게 함
        const reason = typeof u.impact_reason === "string" ? u.impact_reason.replace(/\s+/g, " ").trim().slice(0, 30) : "";
        const targets = Array.isArray(u.targets) ? u.targets.filter(Boolean) : [];
        const note = typeof u.note === "string" ? u.note.trim() : "";
        const facts = cleanFacts(u.facts);
        const ref = Number.isInteger(u.existing_cluster_ref) ? u.existing_cluster_ref : 0;

        const refOriginMatches = ref >= 1 && ref <= existingClusters.length
        && clusterOrigin(existingClusters[ref - 1]) === idxListOrigin(idxList, items);
      if (refOriginMatches) {
          const g = getOrCreateGroup(existingClusters[ref - 1]);
          g.idxList.push(...idxList);
          targets.forEach(t => g.targets.add(t));
          if (note) g.notes.push(note);
          g.facts.push(...facts);
          g.impacts.push(impact);
          if (reason && IMPACT_RANK[impact] >= IMPACT_RANK[g.reasonImpact || "low"]) { g.reason = reason; g.reasonImpact = impact; }
        } else if (isJunkBucket(u.headline) && idxList.length > 1) {
          // 관련 없는 글을 한 통에 몰아넣으려 한 것 → 글 하나씩 따로(설명은 섞여 있어서 못 씀. 원문은 화면에서 바로 열어 볼 수 있음)
          for (const i of idxList) newEntries.push({ idxList: [i], headline: items[i - 1].title, targets: [], impact: "low", note: "", facts: [] });
        } else {
          newEntries.push({ idxList, headline: u.headline, targets, impact, note, facts, reason });
        }
      }

      // 모델이 빠뜨린 신규 항목이 있으면 단독 클러스터 후보로 자동 보충 — 분류 누락 방지용 안전장치
      for (let i = 1; i <= items.length; i++) {
        if (seen.has(i)) continue;
        newEntries.push({ idxList: [i], headline: items[i - 1].title, targets: [], impact: "low", note: "", facts: [] });
      }

      // ── 중복 클러스터 강제 병합 안전장치 ──────────────────────
      // (1) 신규 클러스터 후보들끼리 먼저 검사 — 같은 배치 안에서 모델이 같은 회사/사건을
      //     두 개 이상의 새 클러스터로 쪼갰으면 여기서 하나로 합침
      const mergedNewEntries = [];
      for (const entry of newEntries) {
        const match = (() => { const entryOrigin = idxListOrigin(entry.idxList, items); return mergedNewEntries.find(m => idxListOrigin(m.idxList, items) === entryOrigin && isLikelyDuplicate(m.targets, m.headline, entry.targets, entry.headline)); })();
        if (match) {
          match.idxList.push(...entry.idxList);
          entry.targets.forEach(t => { if (!match.targets.includes(t)) match.targets.push(t); });
          if (entry.note) match.note = match.note ? `${match.note}\n${entry.note}` : entry.note;
          match.facts = cleanFacts([...match.facts, ...entry.facts]);
          if (IMPACT_RANK[entry.impact] > IMPACT_RANK[match.impact]) { match.impact = entry.impact; match.reason = entry.reason; }
        } else {
          mergedNewEntries.push({ ...entry, targets: [...entry.targets], facts: [...entry.facts] });
        }
      }

      // (2) 프롬프트 캡(MAX_EXISTING_CLUSTERS)과 무관하게 이번 배치 날짜(들)의 클러스터 전체를
      //     대상으로 다시 검사 — 모델에게 안 보였던 기존 클러스터와 겹치면 새로 만들지 않고 그쪽으로 합침
      const { data: allTodayClustersRaw, error: allErr } = await sb
        .from("clusters")
        .select("id, headline, impact, targets, why, sources, updates, updated_at")
        .in("day_key", batchDayKeys);
      if (allErr) throw allErr;
      const allTodayClusters = (allTodayClustersRaw || []).filter(c => !isJunkBucket(c.headline));

      const finalNewEntries = [];
      for (const entry of mergedNewEntries) {
    const entryOrigin = idxListOrigin(entry.idxList, items);
        let target = null;
        for (const g of existingGroups.values()) {
          if (clusterOrigin(g.current) === entryOrigin && isLikelyDuplicate(g.current.targets, g.current.headline, entry.targets, entry.headline)) { target = g; break; }
        }
        if (!target) {
          const fullMatch = allTodayClusters.find(c => clusterOrigin(c) === entryOrigin && isLikelyDuplicate(c.targets, c.headline, entry.targets, entry.headline));
          if (fullMatch) target = getOrCreateGroup(fullMatch);
        }
        if (target) {
          target.idxList.push(...entry.idxList);
          entry.targets.forEach(t => target.targets.add(t));
          if (entry.note) target.notes.push(entry.note);
          target.facts.push(...entry.facts);
          target.impacts.push(entry.impact);
          if (entry.reason && IMPACT_RANK[entry.impact] >= IMPACT_RANK[target.reasonImpact || "low"]) { target.reason = entry.reason; target.reasonImpact = entry.impact; }
        } else {
          finalNewEntries.push(entry);
        }
      }

      const now = new Date(); // published_at이 없는 예외적인 경우의 최후 fallback으로만 씀
      const toSource = (i) => {
        const it = items[i - 1];
        return { title: it.title, url: it.url, source: it.source, published_at: it.published_at, category: it.category, run_at: runAtIso };
      };

      // 기존 클러스터 갱신 (LLM이 직접 매칭한 것 + 중복 방지 안전장치가 재배정한 것 전부 포함)
      for (const g of existingGroups.values()) {
        const current = g.current;
        const mergedImpact = g.impacts.length
          ? g.impacts.reduce((best, cur) => (IMPACT_RANK[cur] > IMPACT_RANK[best] ? cur : best), "low")
          : (current.impact || "low");
        const mergedNote = g.notes.join("\n");
        let mergedTargets = Array.from(new Set([...(current.targets || []), ...g.targets]));
        if (!mergedTargets.length) {
          const fb = deriveCategoryFallbackTag(g.idxList, items);
          if (fb) mergedTargets = [fb];
        }
        const mergedSources = [...(current.sources || []), ...g.idxList.map(toSource)];
        // 이번에 새로 합쳐진 기사(들)의 실제 게시 시각 — updated_at/업데이트 이력 시각을 여기서 씀.
        // day_key(오늘/어제 소속)는 이 클러스터가 처음 생성된 날짜에 그대로 고정 — 안 건드림.
        const newItemsAt = latestPublishedAt(items, g.idxList, now);
        const prevUpdatedAt = current.updated_at ? new Date(current.updated_at) : null;
        const nextUpdatedAt = (prevUpdatedAt && prevUpdatedAt > newItemsAt) ? prevUpdatedAt : newItemsAt;
        const mergedUpdates = [...(current.updates || [])];
        const mergedFacts = cleanFacts(g.facts);
        if (mergedNote || mergedFacts.length) {
          mergedUpdates.push({ at: newItemsAt.toISOString(), note: mergedNote, ...(mergedFacts.length ? { facts: mergedFacts } : {}), ...(g.reason ? { reason: g.reason } : {}), run_at: runAtIso });
        }

        const { error: updErr } = await sb
          .from("clusters")
          .update({
            impact: mergedImpact,
            targets: mergedTargets,
            why: mergedNote || current.why,
            sources: mergedSources,
            updates: mergedUpdates,
            updated_at: nextUpdatedAt.toISOString(),
          })
          .eq("id", current.id);
        if (updErr) throw updErr;
        touchedClusterIds.add(current.id);
      }

      // 신규 클러스터 생성 (중복 방지 안전장치를 통과하고 남은 것만)
      if (finalNewEntries.length) {
        const rows = finalNewEntries.map(e => {
          const sources = e.idxList.map(toSource);
          let targets = e.targets;
          if (!targets.length) {
            const fb = deriveCategoryFallbackTag(e.idxList, items);
            targets = fb ? [fb] : targets;
          }
          // day_key/created_at/updated_at 전부 "지금 이 순간"이 아니라 이 클러스터를 이룬
          // 기사(들) 중 가장 최근 게시 시각 기준으로 기록 — 오늘/어제 분류·카드 시간이 실제 뉴스
          // 시점을 반영하게 됨(2026-09-23 변경).
          const createdAt = latestPublishedAt(items, e.idxList, now);
          return {
            day_key: kstDayKey(createdAt),
            headline: typeof e.headline === "string" && e.headline.trim() ? e.headline.trim() : sources[0].title,
            impact: e.impact,
            targets,
            why: e.note,
            sources,
            updates: [{ at: createdAt.toISOString(), note: e.note || "새로 감지됨", ...(e.facts.length ? { facts: e.facts } : {}), ...(e.reason ? { reason: e.reason } : {}), run_at: runAtIso }],
            created_at: createdAt.toISOString(),
            updated_at: createdAt.toISOString(),
          };
        });
        const { error: insErr } = await sb.from("clusters").insert(rows);
        if (insErr) throw insErr;
        totalNewClusters += rows.length;
      }

      totalProcessed += items.length;
      batchesRun++;
      if (nextCursor !== cursor) cursorMoved = true;
      cursor = nextCursor;

      // 배치 하나 끝날 때마다 진행 지점(커서)을 바로 저장(2026-09-28 추가) — 예전엔 전체 실행이
      // 끝까지 성공해야만 맨 마지막에 한 번 저장됐어서, 다음 배치에서 타임아웃/에러로 이번 실행이
      // 죽어버리면 이미 API 호출까지 해서 처리 완료한 배치들의 진행 지점이 기록 안 되고 날아갔음.
      // 그러면 다음 실행이 그 지점을 못 찾고 같은 구간을 처음부터 또 처리하면서 API를 중복으로
      // 호출하는 낭비가 생겼음 — 이제 배치마다 체크포인트를 남겨서, 죽어도 이미 처리한 만큼은
      // 다음 실행이 절대 다시 안 하도록 함. 체크포인트 저장 자체가 실패해도(드문 경우) 이번 실행은
      // 계속 진행 — 맨 마지막에 정상 완료되면 어차피 최종 요약 기록이 다시 저장됨.
      const { error: checkpointErr } = await sb.from("briefings").insert({
        period_from: startCursor,
        period_to: cursor,
        item_count: totalProcessed,
        content: `(진행중) ${totalProcessed}건 처리(배치 ${batchesRun}개)`,
        signals: [],
      });
      if (checkpointErr) console.error("체크포인트 저장 실패(무시하고 계속):", checkpointErr.message);

      if (noMoreAfterThis) { stoppedReason = "caught_up"; break; }
    }

    // 3) 실행 기록 저장 — period_to가 "실제로 처리 완료한 지점"의 커서가 되어 다음 호출의 시작점이 됨.
    //    이번 호출에서 하나도 처리 못 했으면(커서가 안 움직였으면) 굳이 기록을 새로 남기지 않음.
    if (totalProcessed === 0) {
      // 새 글은 없었지만 이미 처리된 글을 건너뛰느라 커서가 움직였으면 그 위치는 저장해 둠(다음에 또 훑지 않게)
      if (cursorMoved) {
        const { error: mvErr } = await sb.from("briefings").insert({
          period_from: startCursor, period_to: cursor, item_count: 0,
          content: "새로 쌓인 글 없음(이미 처리한 글 건너뜀)", signals: [],
        });
        if (mvErr) console.error("커서 저장 실패(무시):", mvErr.message);
      }
      res.status(200).json({
        skipped: true,
        message: "마지막 브리핑 이후로 새로 쌓인 기사가 없음.",
        cursor: startCursor,
      });
      return;
    }

    const hasMoreBacklog = stoppedReason !== "caught_up";
    const { error: logErr } = await sb
      .from("briefings")
      .insert({
        period_from: startCursor,
        period_to: cursor,
        item_count: totalProcessed,
        content: `${totalProcessed}건 처리(배치 ${batchesRun}개) · 새 클러스터 ${totalNewClusters}개 · 기존 클러스터 갱신 ${touchedClusterIds.size}건` +
          (hasMoreBacklog ? ` · 아직 밀린 게 남음(${stoppedReason === "time_budget" ? "시간 예산 초과" : "배치 수 한도 초과"}) — 다음 자동 실행이 이어서 처리` : "") +
          (skippedOldBacklog ? ` · 48시간 넘게 밀린 오래된 백로그는 건너뛰고 최근 것부터 처리함` : ""),
        signals: [],
      });
    if (logErr) throw logErr;

    res.status(200).json({
      skipped: false,
      item_count: totalProcessed,
      batches_run: batchesRun,
      new_clusters: totalNewClusters,
      updated_clusters: touchedClusterIds.size,
      has_more_backlog: hasMoreBacklog,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}

// ── 자동 요약 잠금(2026-11-26 추가) ─────────────────────────────
// 요약이 5분마다 자동으로 돌고(api/tick.js) 사람도 "지금 업데이트"를 누를 수 있어서, 둘이 겹치면 같은 글을
// 동시에 처리해 카드가 중복될 수 있음. status 테이블 id 3 줄을 잠금 겸 "마지막 자동 요약 결과" 기록으로 씀:
// last_note가 "진행중"이고 LOCK_LEASE_MS 안이면 다른 실행이 돌고 있는 것 → 409로 돌려보냄.
// 실행이 중간에 죽어서 잠금이 안 풀려도 LOCK_LEASE_MS가 지나면 자동으로 풀림.
const LOCK_ID = 3;
const LOCK_LEASE_MS = 5 * 60 * 1000;

async function acquireLock(sb) {
  const { data: row } = await sb.from("status").select("id, last_run_at, last_note").eq("id", LOCK_ID).maybeSingle();
  if (row && String(row.last_note || "").startsWith("진행중")
    && Date.now() - new Date(row.last_run_at).getTime() < LOCK_LEASE_MS) return false;
  const { error } = await sb.from("status").upsert(
    { id: LOCK_ID, last_run_at: new Date().toISOString(), last_note: "진행중" }, { onConflict: "id" });
  if (error) throw error;
  return true;
}

async function releaseLock(sb, note) {
  const { error } = await sb.from("status").upsert(
    { id: LOCK_ID, last_run_at: new Date().toISOString(), last_note: note }, { onConflict: "id" });
  if (error) console.error("요약 잠금 해제 실패:", error.message);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST만 지원함" });
    return;
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, GEMINI_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GEMINI_API_KEY) {
    res.status(500).json({ error: "서버 환경변수(SUPABASE_URL/SUPABASE_SERVICE_KEY/GEMINI_API_KEY)가 설정되지 않음" });
    return;
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    if (!(await acquireLock(sb))) {
      res.status(409).json({ busy: true, error: "자동 요약이 지금 돌고 있음 — 끝나면 화면에 바로 뜸" });
      return;
    }
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
    return;
  }

  // summarizeCore의 응답을 가로채서 잠금 해제 메모로 남김(화면 상단 "자동 요약" 표시에 쓰임)
  let code = 200, body = {};
  const capture = { status(c) { code = c; return capture; }, json(j) { body = j; } };
  try {
    await summarizeCore(req, capture, sb, GEMINI_API_KEY);
  } catch (err) {
    code = 500; body = { error: String(err.message || err) };
  }
  const note = code !== 200 ? `오류: ${body.error || code}`
    : body.skipped ? "새 글 없음"
    : `${body.item_count}건 정리(새 카드 ${body.new_clusters}개, 갱신 ${body.updated_clusters}개)` + (body.has_more_backlog ? " · 밀린 것 남음" : "");
  await releaseLock(sb, note);
  res.status(code).json(body);
}
