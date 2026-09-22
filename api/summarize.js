// Vercel 서버리스 함수 — 대시보드의 "브리핑 생성" 버튼이 호출하는 엔드포인트.
// 서비스 키/API 키는 전부 서버사이드 환경변수로만 쓰고, 브라우저에는 절대 노출되지 않음.
//
// 방식: 새로 쌓인 기사/텔레그램 항목을 Claude에게 보여줄 때, "오늘 이미 진행 중인 클러스터 목록"도
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
// 필요한 Vercel 환경변수(Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  — GitHub Actions 시크릿과 같은 값
//   ANTHROPIC_API_KEY                   — console.anthropic.com(=platform.claude.com) 에서 발급받은 API 키
//
// 참고: vercel.json에 이 함수의 maxDuration을 300초(Vercel 무료 플랜 최대치)로 설정해둬야
// 백로그가 많이 밀렸을 때 여러 배치를 이어서 처리할 시간이 확보됨.

import { createClient } from "@supabase/supabase-js";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_ITEMS = 150;              // 한 배치당 분류할 최대 신규 항목 수(비용/토큰 제한용 + 응답 길이 제한용)
const EXTEND_BUFFER = 200;          // 배치 경계가 같은 added_at 타임스탬프 그룹을 자르지 않도록 여유로 더 가져오는 개수
const MAX_EXISTING_CLUSTERS = 40;   // 프롬프트에 보여줄 "오늘 진행 중인 클러스터" 최대 개수
const MAX_TOKENS = 16000;           // 항목이 많을 때(특히 medium/high 설명이 많을 때)도 안 잘리도록 넉넉히
const COOLDOWN_MS = 30 * 1000;      // 연타 방지용 최소 간격
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000; // 이전 실행 기록이 없을 때 기본 조회 범위(24시간)
const MAX_BATCHES = 20;             // 한 번 호출에 처리할 배치 수 안전장치(주로 아래 시간 예산이 먼저 걸림)
const TIME_BUDGET_MS = 240 * 1000;  // Vercel 함수 제한(300초) 안에서 안전하게 멈추기 위한 시간 예산
const IMPACT_RANK = { high: 3, medium: 2, low: 1 };

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

const UPDATE_TOOL = {
  name: "emit_updates",
  description:
    "새로 들어온 헤드라인들을 검토해서 클러스터로 정리한다. 클러스터링 기본 원칙 두 가지: " +
    "(1) 특정 회사 고유의 이벤트(그 회사만의 계약·실적·투자·공장/설비 소식 등)는 그 회사 이름 단위로 클러스터링한다. " +
    "(2) 특정 회사 하나로 좁혀지지 않고 여러 회사에 걸친 섹터/산업 전반의 흐름(예: 특정 부품 공급 동향, 수요 전망, 가격 추세 등)은 " +
    "섹터/테마 이름 단위로 클러스터링하고, 관련된 여러 회사를 targets에 함께 태깅한다. " +
    "[오늘 진행 중인 클러스터] 중 같은 회사(원칙1) 또는 같은 섹터·테마(원칙2)를 다루는 게 있으면 그 클러스터로 합치고, " +
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
              description: "[오늘 진행 중인 클러스터] 목록에서 같은 회사 또는 같은 섹터/테마인 클러스터의 번호. 해당하는 기존 클러스터가 없으면 0",
            },
            headline: {
              type: "string",
              description: "existing_cluster_ref가 0일 때만 채움: 새 클러스터의 핵심을 담은 한 줄 제목 — 회사 단위 클러스터면 회사명으로 시작, 섹터 단위 클러스터면 섹터/테마명으로 시작. 원문 헤드라인을 그대로 복사하지 말고 새로 정리해서 쓸 것. 순한글로만 작성(한자 금지)",
            },
            impact: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "이 클러스터의 지금 시점 기준 종합 중요도. 특정 종목/산업에 실질적 영향이 있는지로 판단. 이미 알려진 내용의 반복, 잡담성 내용은 low",
            },
            targets: {
              type: "array",
              items: { type: "string" },
              description: "관련 종목명 또는 산업/테마명. 섹터 단위 클러스터면 관련된 회사들을 전부 나열. 없으면 빈 배열",
            },
            note: {
              type: "string",
              description: "impact가 medium 또는 high일 때만 채움: 이번에 새로 반영된 내용 2~3문장 — 기존 클러스터에 합치는 경우 '무엇이 새로 추가/변화됐는지', 새 클러스터인 경우 '왜 중요한지'. 순한글로만 작성(한자 금지), 너무 축약하지 말 것. impact가 low면 빈 문자열",
            },
          },
          required: ["indices", "existing_cluster_ref", "headline", "impact", "targets", "note"],
        },
      },
    },
    required: ["updates"],
  },
};

// items 테이블에서 커서(added_at) 이후로 다음 배치를 가져옴.
// 같은 poll 실행에서 들어온 행들은 added_at이 완전히 같을 수 있어서(한 트랜잭션 안의 now()),
// 딱 MAX_ITEMS에서 끊으면 같은 타임스탬프 그룹이 배치 중간에 잘릴 위험이 있음 — 그러면 커서를
// "마지막 처리 항목의 added_at"으로 전진시킬 때, 잘린 나머지 절반이 다음 조회에서 조용히
// 스킵될 수 있음. 그래서 여유(EXTEND_BUFFER)를 더 가져온 뒤, 타임스탬프가 바뀌는 지점까지 확장해서 끊음.
async function fetchNextBatch(sb, cursorIso) {
  const fetchSize = MAX_ITEMS + EXTEND_BUFFER;
  const { data, error } = await sb
    .from("items")
    .select("title, url, source, category, sentiment, importance, ticker, published_at, added_at")
    .gt("added_at", cursorIso)
    .order("added_at", { ascending: true })
    .limit(fetchSize);
  if (error) throw error;
  if (!data || !data.length) return { batch: [], noMoreAfterThis: true };

  const dbExhausted = data.length < fetchSize; // DB에 이보다 더 남은 게 없다는 뜻
  let cut = Math.min(MAX_ITEMS, data.length);
  while (cut < data.length && data[cut].added_at === data[cut - 1].added_at) cut++;
  const batch = data.slice(0, cut);
  const noMoreAfterThis = dbExhausted && cut === data.length;
  return { batch, noMoreAfterThis };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST만 지원함" });
    return;
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "서버 환경변수(SUPABASE_URL/SUPABASE_SERVICE_KEY/ANTHROPIC_API_KEY)가 설정되지 않음" });
    return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const startedAt = Date.now();

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

    if (lastRun?.created_at) {
      const elapsed = Date.now() - new Date(lastRun.created_at).getTime();
      if (elapsed < COOLDOWN_MS) {
        res.status(429).json({ error: `너무 빠른 요청임. ${Math.ceil((COOLDOWN_MS - elapsed) / 1000)}초 후 다시 시도해줘.` });
        return;
      }
    }

    const startCursor = lastRun?.period_to
      ? new Date(lastRun.period_to)
      : new Date(Date.now() - FALLBACK_WINDOW_MS);
    const dayKey = kstDayKey(new Date());

    // 2) 커서 이후로 밀린 게 남아있는 한(시간/횟수 예산 안에서) 150개씩 끊어서 이어서 처리
    let cursor = startCursor;
    let totalProcessed = 0;
    let totalNewClusters = 0;
    const touchedClusterIds = new Set();
    let batchesRun = 0;
    let stoppedReason = "caught_up"; // caught_up | time_budget | batch_cap

    while (true) {
      if (batchesRun >= MAX_BATCHES) { stoppedReason = "batch_cap"; break; }
      if (Date.now() - startedAt > TIME_BUDGET_MS) { stoppedReason = "time_budget"; break; }

      const { batch: items, noMoreAfterThis } = await fetchNextBatch(sb, cursor.toISOString());
      if (!items.length) { stoppedReason = "caught_up"; break; }

      // 이번 배치 시점 기준으로 "오늘 진행 중인 클러스터" 다시 조회 — 같은 실행 안에서 앞 배치가
      // 만들거나 갱신한 클러스터도 다음 배치의 매칭 대상에 포함되어야 하므로 매 배치마다 새로 가져옴
      const { data: existingClustersRaw, error: exErr } = await sb
        .from("clusters")
        .select("id, headline, impact, targets, why, sources, updates")
        .eq("day_key", dayKey)
        .order("updated_at", { ascending: false })
        .limit(MAX_EXISTING_CLUSTERS);
      if (exErr) throw exErr;
      const existingClusters = existingClustersRaw || [];

      const newLines = items.map((it, i) => {
        const cat = CAT_LABEL[it.category] || it.category || "기타";
        const tag = it.ticker ? `[${it.ticker}] ` : "";
        return `${i + 1}. (${cat}) ${tag}${it.title} — ${it.source || "출처불명"}`;
      }).join("\n");

      const existingLines = existingClusters.length
        ? existingClusters.map((c, i) => `${i + 1}. ${c.headline} [${(c.targets || []).join(", ") || "-"}]`).join("\n")
        : "(오늘 진행 중인 클러스터 없음)";

      const prompt = `당신은 반도체·AI인프라 섹터를 커버하는 증권사 애널리스트를 돕는 리서치 어시스턴트입니다.

[오늘 진행 중인 클러스터] (총 ${existingClusters.length}개)
${existingLines}

[신규 헤드라인] (지난 확인 이후 새로 수집됨, 총 ${items.length}건, 번호가 매겨져 있음)
${newLines}

신규 헤드라인을 검토해서 클러스터로 정리하세요. emit_updates 도구로 결과를 반환하세요. 규칙:
- [신규 헤드라인] 전체(${items.length}건)가 빠짐없이, 정확히 하나의 update에 포함되어야 함 — 하나도 빠뜨리지 말고, 같은 번호를 두 update에 중복으로 넣지도 말 것
- 클러스터링 기준: 특정 회사 고유 이벤트(그 회사만의 계약/실적/투자/공장 소식 등)는 그 회사명 단위로 클러스터링. 여러 회사에 걸친 섹터/산업 전반 흐름(특정 회사 하나로 좁혀지지 않는 공급망/수요/가격 동향 등)은 섹터/테마명 단위로 클러스터링하고 관련 회사들을 targets에 나열
- existing_cluster_ref: 위 [오늘 진행 중인 클러스터] 목록에서 같은 회사 또는 같은 섹터/테마인 번호. 해당하는 게 없으면 0
- headline은 existing_cluster_ref가 0일 때만 채울 것 — 새 클러스터의 핵심을 담은 새 한 줄 제목, 원문 헤드라인을 그대로 복사하지 말고 정리해서 쓸 것. 순한글로만 작성(한자 금지)
- impact는 이 클러스터가 특정 종목이나 산업에 실질적인 영향을 줄 수 있는지로 판단. 이미 알려진 내용의 반복, 일반적인 시황 잡담, 영향이 불분명한 내용은 low
- targets에는 구체적인 종목명이나 산업/테마명을 적을 것. 없으면 빈 배열
- note는 impact가 medium 또는 high일 때만 2~3문장으로: 기존 클러스터에 합치는 경우 이번에 새로 반영된 내용이 무엇인지, 새 클러스터인 경우 왜 중요한지. 순한글로만 작성(한자 금지), 너무 축약하지 말고 읽으면 바로 이해되게. impact가 low면 빈 문자열`;

      const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          tools: [UPDATE_TOOL],
          tool_choice: { type: "tool", name: "emit_updates" },
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!apiRes.ok) {
        const errBody = await apiRes.text();
        throw new Error(`Claude API 오류 ${apiRes.status}: ${errBody.slice(0, 500)}`);
      }

      const apiJson = await apiRes.json();
      if (apiJson.stop_reason === "max_tokens") {
        throw new Error(
          `응답이 너무 길어서 중간에 잘림 (처리하려던 항목 ${items.length}건). ` +
          `MAX_ITEMS를 더 줄이거나 MAX_TOKENS를 더 늘려야 함.`
        );
      }
      const toolUse = (apiJson.content || []).find(b => b.type === "tool_use" && b.name === "emit_updates");
      if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.updates)) {
        throw new Error(`Claude가 구조화된 분류 결과를 반환하지 않음 (형식 오류, stop_reason: ${apiJson.stop_reason || "알수없음"})`);
      }

      // 모델이 반환한 update들을 "기존 클러스터 그룹"과 "신규 클러스터"로 나눠서 모음
      // (같은 existing_cluster_ref를 가리키는 update가 여러 개여도 하나로 합쳐서 처리 — 덮어쓰기 방지)
      const seen = new Set();
      const existingGroups = new Map(); // ref(1-based) -> {idxList, targets:Set, notes:[], impacts:[]}
      const newEntries = []; // {idxList, headline, targets, impact, note}

      for (const u of toolUse.input.updates) {
        const idxList = Array.isArray(u.indices)
          ? u.indices.filter(i => Number.isInteger(i) && i >= 1 && i <= items.length && !seen.has(i))
          : [];
        if (!idxList.length) continue;
        idxList.forEach(i => seen.add(i));

        const impact = ["high", "medium", "low"].includes(u.impact) ? u.impact : "low";
        const targets = Array.isArray(u.targets) ? u.targets.filter(Boolean) : [];
        const note = typeof u.note === "string" ? u.note.trim() : "";
        const ref = Number.isInteger(u.existing_cluster_ref) ? u.existing_cluster_ref : 0;

        if (ref >= 1 && ref <= existingClusters.length) {
          if (!existingGroups.has(ref)) existingGroups.set(ref, { idxList: [], targets: new Set(), notes: [], impacts: [] });
          const g = existingGroups.get(ref);
          g.idxList.push(...idxList);
          targets.forEach(t => g.targets.add(t));
          if (note) g.notes.push(note);
          g.impacts.push(impact);
        } else {
          newEntries.push({ idxList, headline: u.headline, targets, impact, note });
        }
      }

      // 모델이 빠뜨린 신규 항목이 있으면 단독 클러스터로 자동 보충 — 분류 누락 방지용 안전장치
      for (let i = 1; i <= items.length; i++) {
        if (seen.has(i)) continue;
        newEntries.push({ idxList: [i], headline: items[i - 1].title, targets: [], impact: "low", note: "" });
      }

      const batchNowIso = new Date().toISOString();
      const toSource = (i) => {
        const it = items[i - 1];
        return { title: it.title, url: it.url, source: it.source, published_at: it.published_at, category: it.category };
      };

      // 기존 클러스터 갱신
      for (const [ref, g] of existingGroups) {
        const current = existingClusters[ref - 1];
        const mergedImpact = g.impacts.reduce((best, cur) => (IMPACT_RANK[cur] > IMPACT_RANK[best] ? cur : best), "low");
        const mergedNote = g.notes.join(" ");
        const mergedTargets = Array.from(new Set([...(current.targets || []), ...g.targets]));
        const mergedSources = [...(current.sources || []), ...g.idxList.map(toSource)];
        const mergedUpdates = [...(current.updates || [])];
        if (mergedNote) mergedUpdates.push({ at: batchNowIso, note: mergedNote });

        const { error: updErr } = await sb
          .from("clusters")
          .update({
            impact: mergedImpact,
            targets: mergedTargets,
            why: mergedNote || current.why,
            sources: mergedSources,
            updates: mergedUpdates,
            updated_at: batchNowIso,
          })
          .eq("id", current.id);
        if (updErr) throw updErr;
        touchedClusterIds.add(current.id);
      }

      // 신규 클러스터 생성
      if (newEntries.length) {
        const rows = newEntries.map(e => {
          const sources = e.idxList.map(toSource);
          return {
            day_key: dayKey,
            headline: typeof e.headline === "string" && e.headline.trim() ? e.headline.trim() : sources[0].title,
            impact: e.impact,
            targets: e.targets,
            why: e.note,
            sources,
            updates: [{ at: batchNowIso, note: e.note || "새로 감지됨" }],
            created_at: batchNowIso,
            updated_at: batchNowIso,
          };
        });
        const { error: insErr } = await sb.from("clusters").insert(rows);
        if (insErr) throw insErr;
        totalNewClusters += rows.length;
      }

      totalProcessed += items.length;
      batchesRun++;
      cursor = new Date(items[items.length - 1].added_at);

      if (noMoreAfterThis) { stoppedReason = "caught_up"; break; }
    }

    // 3) 실행 기록 저장 — period_to가 "실제로 처리 완료한 지점"의 커서가 되어 다음 호출의 시작점이 됨.
    //    이번 호출에서 하나도 처리 못 했으면(커서가 안 움직였으면) 굳이 기록을 새로 남기지 않음.
    if (totalProcessed === 0) {
      res.status(200).json({
        skipped: true,
        message: "마지막 브리핑 이후로 새로 쌓인 기사가 없음.",
        cursor: startCursor.toISOString(),
      });
      return;
    }

    const hasMoreBacklog = stoppedReason !== "caught_up";
    const { error: logErr } = await sb
      .from("briefings")
      .insert({
        period_from: startCursor.toISOString(),
        period_to: cursor.toISOString(),
        item_count: totalProcessed,
        content: `${totalProcessed}건 처리(배치 ${batchesRun}개) · 새 클러스터 ${totalNewClusters}개 · 기존 클러스터 갱신 ${touchedClusterIds.size}건` +
          (hasMoreBacklog ? ` · 아직 밀린 게 남음(${stoppedReason === "time_budget" ? "시간 예산 초과" : "배치 수 한도 초과"}) — 다시 눌러서 이어서 처리 필요` : ""),
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
