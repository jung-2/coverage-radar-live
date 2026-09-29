// 추적 키워드 종목의 KIS(한국투자증권 Open API) 현재 등락률 수집 스크립트
// GitHub Actions(.github/workflows/poll-prices.yml)가 장 시간(평일 09:00~15:55 KST)에 5분 간격으로 실행.
// 로컬에서 테스트하려면: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... KIS_APP_KEY=... KIS_APP_SECRET=... node scraper/prices.mjs
//
// 하는 일: keywords 테이블의 회사명 → 종목코드(KIS 종목 마스터 파일로 이름 매칭) → 종목별 현재가 조회 →
// price_moves 테이블에 등락률(전일 대비 %) 저장. 화면(web/index.html)이 이걸 읽어서 ±5% 이상 급등/급락 종목을
// 추적 키워드 탭 맨 위 구역에 보여줌. 해외 종목(영문 이름)은 코드가 없어서 건너뜀.

import { createClient } from "@supabase/supabase-js";
import AdmZip from "adm-zip";

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, KIS_APP_KEY, KIS_APP_SECRET } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY 환경변수가 없습니다.");
  process.exit(1);
}
if (!KIS_APP_KEY || !KIS_APP_SECRET) {
  // KIS 키를 GitHub Secrets에 아직 안 넣었으면 실패(빨간 X)로 알림이 오지 않게 그냥 건너뜀
  console.warn("KIS_APP_KEY / KIS_APP_SECRET 이 없어서 시세 수집을 건너뜁니다.");
  process.exit(0);
}

const KIS_BASE = "https://openapi.koreainvestment.com:9443"; // 실전투자 도메인(시세 조회용)
const MASTER_URLS = {
  kospi: { url: "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip", tail: 228 },
  kosdaq: { url: "https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip", tail: 222 },
};
const CONCURRENCY = 3;   // KIS는 초당 요청 수 제한(약 20건)이 있어서 천천히 조회
const PAUSE_MS = 150;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

// KIS 종목 마스터(고정폭 텍스트, cp949): 앞 9자 = 단축코드, 12자 = 표준코드, 그 뒤부터 뒤쪽 고정 길이(tail)를 뺀 부분 = 종목명
async function loadNameToCode() {
  const map = new Map();
  for (const [market, { url, tail }] of Object.entries(MASTER_URLS)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`종목 마스터(${market}) 다운로드 실패: HTTP ${res.status}`);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const text = new TextDecoder("euc-kr").decode(zip.getEntries()[0].getData());
    for (const row of text.split(/\r?\n/)) {
      if (row.length < 40) continue;
      const head = row.slice(0, row.length - tail);
      const code = head.slice(0, 9).trim();
      const name = head.slice(21).trim();
      if (!/^\d{6}$/.test(code) || !name) continue; // 펀드/ETN 등 6자리 숫자가 아닌 코드는 제외
      const key = norm(name);
      if (!map.has(key)) map.set(key, code);
    }
  }
  return map;
}

async function getToken() {
  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`KIS 토큰 발급 실패: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.access_token;
}

// 주식현재가 시세(FHKST01010100): output.stck_prpr = 현재가, output.prdy_ctrt = 전일 대비율(%)
async function fetchQuote(token, code, attempt = 1) {
  const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`;
  const res = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=UTF-8",
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: "FHKST01010100",
      custtype: "P",
    },
  });
  const json = await res.json().catch(() => ({}));
  // 초당 요청 제한에 걸리면 잠깐 쉬었다가 1번만 재시도
  if ((res.status === 500 || json.msg_cd === "EGW00201") && attempt === 1) {
    await sleep(1200);
    return fetchQuote(token, code, 2);
  }
  if (!res.ok || json.rt_cd !== "0" || !json.output) {
    throw new Error(`HTTP ${res.status} ${json.msg_cd || ""} ${json.msg1 || ""}`.trim());
  }
  const pct = parseFloat(json.output.prdy_ctrt);
  const price = parseFloat(json.output.stck_prpr);
  if (Number.isNaN(pct)) throw new Error(`등락률 필드를 못 읽음: ${JSON.stringify(json.output).slice(0, 200)}`);
  return { pct, price: Number.isNaN(price) ? null : price };
}

async function main() {
  const { data: keywordRows, error: kwErr } = await supabase.from("keywords").select("term");
  if (kwErr) throw kwErr;
  const nameToCode = await loadNameToCode();

  const targets = [];
  let noCode = 0;
  for (const { term } of keywordRows || []) {
    const code = nameToCode.get(norm(term));
    if (code) targets.push({ keyword: term, code });
    else noCode++;
  }
  console.log(`키워드 ${keywordRows?.length || 0}개 중 종목코드 매칭 ${targets.length}개 (해외/테마 등 ${noCode}개는 건너뜀)`);
  if (!targets.length) return;

  const token = await getToken();
  const rows = [];
  let failed = 0;
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const t = targets[next++];
      try {
        const { pct, price } = await fetchQuote(token, t.code);
        rows.push({ keyword: t.keyword, code: t.code, pct, price, checked_at: new Date().toISOString() });
      } catch (err) {
        failed++;
        if (failed <= 5) console.error(`[시세] ${t.keyword}(${t.code}) 실패:`, err.message);
      }
      await sleep(PAUSE_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (rows.length) {
    const { error } = await supabase.from("price_moves").upsert(rows, { onConflict: "keyword" });
    if (error) throw new Error(`price_moves 저장 실패: ${error.message}`);
  }
  const movers = rows.filter((r) => Math.abs(r.pct) >= 5).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  console.log(`시세 저장 ${rows.length}건, 실패 ${failed}건 | ±5% 이상 ${movers.length}개:`,
    movers.slice(0, 15).map((r) => `${r.keyword} ${r.pct > 0 ? "+" : ""}${r.pct}%`).join(", "));
  if (failed && !rows.length) process.exit(1); // 전부 실패하면 빨간 X로 알림
}

main().catch((err) => {
  console.error("prices 실행 중 오류:", err);
  process.exit(1);
});
