// 시험용 가짜 Supabase — summarize.js가 쓰는 만큼만 흉내 냄(실제 DB 안 건드림).
// 행 데이터는 DB 객체에 메모리로만 들고 있음.
export function makeDb() {
  const DB = { items: [], clusters: [], briefings: [] };
  let nextId = 1;
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.orders = []; this.max = null; this.op = "select"; this.single = false; }
    select() { return this; }
    eq(c, v) { this.filters.push(r => r[c] === v); return this; }
    gt(c, v) { this.filters.push(r => r[c] > v); return this; }
    gte(c, v) { this.filters.push(r => r[c] >= v); return this; }
    in(c, vs) { this.filters.push(r => vs.includes(r[c])); return this; }
    order(c, { ascending = true } = {}) { this.orders.push([c, ascending]); return this; }
    limit(n) { this.max = n; return this; }
    maybeSingle() { this.single = true; return this; }
    insert(rows) { this.op = "insert"; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
    update(patch) { this.op = "update"; this.patch = patch; return this; }
    then(resolve, reject) { try { resolve(this.run()); } catch (e) { reject(e); } }
    run() {
      const table = DB[this.table];
      if (this.op === "insert") {
        for (const r of this.rows) table.push({ id: nextId++, created_at: new Date().toISOString(), ...structuredClone(r) });
        return { error: null };
      }
      let rows = table.filter(r => this.filters.every(f => f(r)));
      if (this.op === "update") { rows.forEach(r => Object.assign(r, structuredClone(this.patch))); return { error: null }; }
      rows = [...rows];
      for (const [c, asc] of [...this.orders].reverse()) rows.sort((x, y) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * (asc ? 1 : -1));
      if (this.max != null) rows = rows.slice(0, this.max);
      rows = structuredClone(rows);
      return { data: this.single ? (rows[0] || null) : rows, error: null };
    }
  }
  return { DB, client: { from: t => new Query(t) } };
}
