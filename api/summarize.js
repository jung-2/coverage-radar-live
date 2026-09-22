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
// 입력 항목은 반드시 어딘가의 클러스터에 한 번씩만 포함되도록 서버에서 검증/보정함
// (모델이 일부를 빠뜨리면 단독 클러스터로 자동 보충 — 절대 소리소문없이 누락되지 않게).
//
// 필요한 Vercel 환경변수(Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  — GitHub Actions 시크릿과 같은 값
//   ANTHROPIC_API_KEY                   — console.anthropic.com(=platform.claude.com) 에서 발급받은 API 키

import { createClient } from "@supabase/supabase-js";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_ITEMS = 200;              // 한 번에 분류할 최대 신규 항목 수(비용/토큰 제한용)
const MAX_EXISTING_CLUSTERS = 40;   // 프롬프트에 보여줄 "오늘 진행 중인 클러스터" 최대 개수
const MAX_TOKENS = 8000;            // 항목이 많을 때도 잘리지 않도록 넉넉히
const COOLDOWN_MS = 30 * 1000;      // 연타 방지용 최소 간격
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000; // 이전 실행 기록이 없을 때 기본 조회 범위(24시간)
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
    "새로 들어온 헤드라인들을 검토해서, [오늘 진행 중인 클러스터] 중 같은 주제·종목·이슈를 다루는 것이 있으면 그 클러스터로 합치고, " +
    "전혀 새로운 주제면 새 클러스터를 만든다. 입력된 신규 헤드라인 전체가 빠짐없이, 정확히 하나의 update에 포함되어야 한다.",
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
              description: "이 update에 속하는 [신규 헤드라인] 번호 목록 (1부터 시작, 최소 1개). 같은 주제의 신규 헤드라인끼리는 하나로 묶어도 됨",
            },
            existing_cluster_ref: {
              type: "integer",
              description: "[오늘 진행 중인 클러스터] 목록에서 같은 주제인 클러스터의 번호. 해당하는 기존 클러스터가 없으면(=완전히 새로운 주제) 0",
            },
            headline: {
              type: "string",
              description: "existing_cluster_ref가 0일 때만 채움: 새 클러스터의 핵심을 담은 한 줄 제목. 원문 헤드라인을 그대로 복사하지 말고 새로 정리해서 쓸 것. 순한글로만 작성(한자 금지)",
            },
            impact: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "이 클러스터의 지금 시점 기준 종합 중요도. 특정 종목/산업에 실질적 영향이 있는지로 판단. 이미 알려진 내용의 반복, 잡담성 내용은 low",
            },
            targets: {
              type: "array",
              items: { type: "string" },
              description: "관련 종목명 또는 산업/테마명. 없으면 빈 배열",
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

  try {
    // 1) 마지막 실행 시점 확인 (연타 방지 + 조회 범위 산정) — briefings 테이블은 이제
    //    화면에 안 보이고, 실행 기록(쿨다운/기간 산정)용 로그로만 씀
    const { data: lastRun } = await sb
      .from("briefings")
      .select("created_at")
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

    const periodFrom = lastRun?.created_at
      ? new Date(lastRun.created_at)
      : new Date(Date.now() - FALLBACK_WINDOW_MS);
    const periodTo = new Date();
    const dayKey = kstDayKey(periodTo);

    // 2) 그 이후 새로 쌓인 항목 가져오기
    const { data: items, error: itemsErr } = await sb
      .from("items")
      .select("title, url, source, category, sentiment, importance, ticker, published_at")
      .gte("added_at", periodFrom.toISOString())
      .order("published_at", { ascending: false })
      .limit(MAX_ITEMS);

    if (itemsErr) throw itemsErr;

    if (!items || items.length === 0) {
      res.status(200).json({
        skipped: true,
        message: "마지막 브리핑 이후로 새로 쌓인 기사가 없음.",
        period_from: periodFrom.toISOString(),
        period_to: periodTo.toISOString(),
      });
      return;
    }

    // 3) 오늘 이미 진행 중인 클러스터 가져오기 (최근 갱신 순으로, 프롬프트 크기 제한 위해 상한선 적용)
    const { data: existingClustersRaw, error: exErr } = await sb
      .from("clusters")
      .select("id, headline, impact, targets, why, sources, updates")
      .eq("day_key", dayKey)
      .order("updated_at", { ascending: false })
      .limit(MAX_EXISTING_CLUSTERS);
    if (exErr) throw exErr;
    const existingClusters = existingClustersRaw || [];

    // 4) 프롬프트 구성
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

신규 헤드라인을 검토해서 [오늘 진행 중인 클러스터]와 같은 주제·종목·이슈를 다루면 그 클러스터 번호로 합치고, 전혀 새로운 주제면 existing_cluster_ref를 0으로 해서 새 클러스터를 만드세요. emit_updates 도구로 결과를 반환하세요. 규칙:
- [신규 헤드라인] 전체(${items.length}건)가 빠짐없이, 정확히 하나의 update에 포함되어야 함 — 하나도 빠뜨리지 말고, 같은 번호를 두 update에 중복으로 넣지도 말 것
- 같은 주제의 신규 헤드라인끼리는 하나의 update로 묶을 것 (기존 클러스터에 합치는 경우든 새 클러스터든)
- existing_cluster_ref: 위 [오늘 진행 중인 클러스터] 목록의 번호. 해당하는 게 없으면(완전히 새로운 주제) 0
- headline은 existing_cluster_ref가 0일 때만 채울 것 — 새 클러스터의 핵심을 담은 새 한 줄 제목, 원문 헤드라인을 그대로 복사하지 말고 정리해서 쓸 것. 순한글로만 작성(한자 금지)
- impact는 이 클러스터가 특정 종목이나 산업에 실질적인 영향을 줄 수 있는지로 판단. 이미 알려진 내용의 반복, 일반적인 시황 잡담, 영향이 불분명한 내용은 low
- targets에는 구체적인 종목명이나 산업/테마명을 적을 것. 없으면 빈 배열
- note는 impact가 medium 또는 high일 때만 2~3문장으로: 기존 클러스터에 합치는 경우 이번에 새로 반영된 내용이 무엇인지, 새 클러스터인 경우 왜 중요한지. 순한글로만 작성(한자 금지), 너무 축약하지 말고 읽으면 바로 이해되게. impact가 low면 빈 문자열`;

    // 5) Claude API 호출 (tool-use로 구조화된 JSON 강제)
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
    const toolUse = (apiJson.content || []).find(b => b.type === "tool_use" && b.name === "emit_updates");
    if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.updates)) {
      throw new Error("Claude가 구조화된 분류 결과를 반환하지 않음 (형식 오류)");
    }

    // 6) 모델이 반환한 update들을 "기존 클러스터 그룹"과 "신규 클러스터"로 나눠서 모음
    //    (같은 existing_cluster_ref를 가리키는 update가 여러 개여도 하나로 합쳐서 처리 — 덮어쓰기 방지)
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

    const nowIso = periodTo.toISOString();
    const toSource = (i) => {
      const it = items[i - 1];
      return { title: it.title, url: it.url, source: it.source, published_at: it.published_at, category: it.category };
    };

    // 7) 기존 클러스터 갱신
    let updatedCount = 0;
    for (const [ref, g] of existingGroups) {
      const current = existingClusters[ref - 1];
      const mergedImpact = g.impacts.reduce((best, cur) => (IMPACT_RANK[cur] > IMPACT_RANK[best] ? cur : best), "low");
      const mergedNote = g.notes.join(" ");
      const mergedTargets = Array.from(new Set([...(current.targets || []), ...g.targets]));
      const mergedSources = [...(current.sources || []), ...g.idxList.map(toSource)];
      const mergedUpdates = [...(current.updates || [])];
      if (mergedNote) mergedUpdates.push({ at: nowIso, note: mergedNote });

      const { error: updErr } = await sb
        .from("clusters")
        .update({
          impact: mergedImpact,
          targets: mergedTargets,
          why: mergedNote || current.why,
          sources: mergedSources,
          updates: mergedUpdates,
          updated_at: nowIso,
        })
        .eq("id", current.id);
      if (updErr) throw updErr;
      updatedCount++;
    }

    // 8) 신규 클러스터 생성
    let newCount = 0;
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
          updates: [{ at: nowIso, note: e.note || "새로 감지됨" }],
          created_at: nowIso,
          updated_at: nowIso,
        };
      });
      const { error: insErr } = await sb.from("clusters").insert(rows);
      if (insErr) throw insErr;
      newCount = rows.length;
    }

    // 9) 실행 기록 저장 (쿨다운/기간 산정용 — 화면에는 안 쓰임)
    const { error: logErr } = await sb
      .from("briefings")
      .insert({
        period_from: periodFrom.toISOString(),
        period_to: periodTo.toISOString(),
        item_count: items.length,
        content: `${items.length}건 처리 · 새 클러스터 ${newCount}개 · 기존 클러스터 갱신 ${updatedCount}건`,
        signals: [],
      });
    if (logErr) throw logErr;

    res.status(200).json({
      skipped: false,
      item_count: items.length,
      new_clusters: newCount,
      updated_clusters: updatedCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
