// 1회성 데이터 정리용 엔드포인트(2026-09-23) — summarize.js를 "실제 게시 시각 기준
// 타임스탬프" 로직으로 바꾸기 전에, 이미 "AI가 처리한 시각" 기준으로 잘못 저장돼있던
// 클러스터들의 day_key(오늘/어제 구분)·updated_at(카드 대표 시간)을 각 클러스터에 이미
// 정확히 저장돼있는 sources[].published_at 기준으로 다시 계산해서 바로잡는 용도.
// 화면(web/index.html)에 실제로 보이는 오늘/어제 두 버킷만 대상으로 함 — 그보다 오래된
// 클러스터는 어차피 화면에 안 보이므로 건드릴 필요 없음.
// 다 쓰고 나면 이 파일은 GitHub에서 지우는 걸 권장함(계속 열어둘 필요 없는 1회성 관리자용).
import { createClient } from "@supabase/supabase-js";

function kstDayKey(date) {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST만 지원함" });
    return;
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: "서버 환경변수(SUPABASE_URL/SUPABASE_SERVICE_KEY)가 설정되지 않음" });
    return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const todayKey = kstDayKey(new Date());
    const yestKey = kstDayKey(new Date(Date.now() - 24 * 3600 * 1000));

    const { data: clusters, error } = await sb
      .from("clusters")
      .select("id, headline, day_key, updated_at, sources")
      .in("day_key", [todayKey, yestKey]);
    if (error) throw error;

    let checked = 0;
    let changed = 0;
    let skippedNoSourceTime = 0;
    const changes = [];

    for (const c of clusters || []) {
      checked++;
      const sources = Array.isArray(c.sources) ? c.sources : [];
      let max = null;
      for (const s of sources) {
        if (!s || !s.published_at) continue;
        const d = new Date(s.published_at);
        if (!isNaN(d.getTime()) && (!max || d > max)) max = d;
      }
      if (!max) { skippedNoSourceTime++; continue; } // 소스에 시각 정보가 없으면 건드리지 않음

      const correctDayKey = kstDayKey(max);
      const correctUpdatedAtIso = max.toISOString();
      if (correctDayKey !== c.day_key || correctUpdatedAtIso !== c.updated_at) {
        const { error: updErr } = await sb
          .from("clusters")
          .update({ day_key: correctDayKey, updated_at: correctUpdatedAtIso })
          .eq("id", c.id);
        if (updErr) throw updErr;
        changed++;
        changes.push({
          id: c.id,
          headline: c.headline,
          from_day_key: c.day_key,
          to_day_key: correctDayKey,
          from_updated_at: c.updated_at,
          to_updated_at: correctUpdatedAtIso,
        });
      }
    }

    res.status(200).json({ checked, changed, skippedNoSourceTime, changes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
