// 문법 검사 — api/, scraper/의 JS 파일과 web/ 안 HTML의 <script> 블록을 전부 `node --check`로 확인함.
// 실행: npm run check
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const files = (dir, ext) => readdirSync(dir, { recursive: true }).filter(f => f.endsWith(ext)).map(f => join(dir, f));
const tmp = mkdtempSync(join(tmpdir(), "check-"));
let failed = 0;

function check(path, label = path) {
  try { execFileSync(process.execPath, ["--check", path], { stdio: "pipe" }); console.log(`ok   ${label}`); }
  catch (e) { failed++; console.error(`FAIL ${label}\n${e.stderr}`); }
}

for (const f of [...files("api", ".js"), ...files("scraper", ".mjs"), ...files("test", ".mjs"), ...files("scripts", ".mjs")]) check(f);
for (const f of files("web", ".html")) {
  const html = readFileSync(f, "utf8");
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  blocks.forEach((code, i) => {
    const out = join(tmp, `${f.replace(/[\/\\]/g, "_")}.${i}.js`);
    writeFileSync(out, code);
    check(out, `${f} <script> #${i + 1}`);
  });
}
if (failed) { console.error(`\n문법 오류 ${failed}개`); process.exit(1); }
