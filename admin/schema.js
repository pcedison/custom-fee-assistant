// =============================================================
// 使用統計資料表（D1）：主站寫入、後台讀取，兩邊共用這一份
//   - 不存 IP、不放 cookie
//   - vid：每天更換鹽值的雜湊（salts 表），隔天鹽值刪除後無法回推
// =============================================================
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    day TEXT NOT NULL,
    hour INTEGER NOT NULL,
    vid TEXT,
    country TEXT,
    region_code TEXT,
    region TEXT,
    city TEXT,
    net TEXT,
    device TEXT,
    os TEXT,
    browser TEXT,
    source TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS visits_day ON visits(day)',
  `CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    day TEXT NOT NULL,
    hour INTEGER NOT NULL,
    vid TEXT,
    text TEXT,
    via TEXT,
    kind TEXT,
    drinks TEXT,
    topics TEXT,
    typos TEXT,
    fuzzy TEXT,
    origin TEXT,
    region_code TEXT,
    device TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS questions_day ON questions(day)',
  'CREATE TABLE IF NOT EXISTS salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL)',
];

// 每個 isolate 只建一次表（每個 Worker 只連一個資料庫）
let ready = null;
export function ensureSchema(db) {
  if (!ready) ready = db.batch(SCHEMA.map(sql => db.prepare(sql))).catch(e => { ready = null; throw e; });
  return ready;
}

// 台北時間的日期與小時
export function taipei(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600e3);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
