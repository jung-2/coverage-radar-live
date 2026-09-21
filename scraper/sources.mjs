// 고정 테마 검색어 — 사용자가 대시보드에서 추가하는 키워드(keywords 테이블)와 별도로 매 실행마다 항상 포함
export const FIXED_THEMES = [
  "advanced packaging CoWoS",
  "HBM4 memory",
  "co-packaged optics CPO",
  "800VDC power semiconductor",
  "AI server capex",
  "TSMC monthly revenue",
];

// 한 번 실행(poll)당 사용자 키워드에서 몇 개씩 순환할지 — 너무 많으면 Google News RSS가 순간적으로
// 막히거나(429) 실행 시간이 길어짐. 5분 주기 실행 기준으로 이 정도면 전체 목록이 20~30분 안에 한 바퀴 돔.
export const KEYWORD_BATCH_SIZE = 12;

// 카테고리 분류용 키워드 매핑 — 제목+요약에 아래 단어가 들어있으면 해당 카테고리로 태깅
export const CATEGORY_RULES = [
  ["packaging", ["CoWoS", "CoPoS", "패키징", "OSAT", "TCB", "본딩"]],
  ["hbm", ["HBM", "고대역폭메모리", "D램", "DRAM", "메모리"]],
  ["cpo", ["CPO", "광인터커넥트", "포토닉스", "실리콘포토닉스", "옵틱스", "트랜시버", "레이저"]],
  ["power", ["800VDC", "전력반도체", "GaN", "SiC", "전류센서", "파워"]],
  ["ai_server", ["AI서버", "capex", "캐펙스", "데이터센터", "하이퍼스케일러", "GPU"]],
  ["korea", ["삼성전자", "SK하이닉스", "DB하이텍", "코스닥", "코스피", "원화"]],
  ["biotech", ["GLP-1", "비만치료제", "바이오", "임상", "신약", "제약"]],
  ["disclosure", ["공시", "매출 발표", "월매출", "실적발표", "DART"]],
];

export function categorize(text) {
  for (const [cat, words] of CATEGORY_RULES) {
    if (words.some((w) => text.includes(w))) return cat;
  }
  return "other";
}

const BEAT_WORDS = ["상향", "호조", "급등", "확대", "beat", "surge", "record", "growth", "돌파", "증가"];
const MISS_WORDS = ["하향", "급락", "부진", "우려", "miss", "cut", "decline", "감소", "축소"];
const NOTE_WORDS = ["경고", "지연", "리스크", "조정", "note", "delay", "risk"];

export function guessSentiment(text) {
  if (BEAT_WORDS.some((w) => text.includes(w))) return "beat";
  if (MISS_WORDS.some((w) => text.includes(w))) return "miss";
  if (NOTE_WORDS.some((w) => text.includes(w))) return "note";
  return "neutral";
}

export function guessImportance(text) {
  const HIGH = ["목표주가", "실적", "HBM4", "capex", "공시", "M&A", "인수"];
  if (HIGH.some((w) => text.includes(w))) return "high";
  return "medium";
}
