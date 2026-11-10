// 設定。settings 表に key/value で持つ。ここにない key は内部用（AIの起動状態など）。

export interface Settings {
  timezone: string;
  /** フォローアップの反映方式：approval＝承認制／immediate＝即時反映 */
  followup_mode: "approval" | "immediate";
  /** 繰り越しで「止まっている」とみなす回数 */
  stalled_carryover_count: number;
  /** 更新が止まっているとみなす日数 */
  stale_days: number;
  /** ホームのパーツの表示／非表示 */
  parts: { input: boolean; daily: boolean; tracker: boolean; proposals: boolean; events: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: "Asia/Tokyo",
  followup_mode: "approval",
  stalled_carryover_count: 3,
  stale_days: 14,
  parts: { input: true, daily: true, tracker: true, proposals: true, events: true },
};

const KEY = "user_settings";

export async function getSettings(db: D1Database): Promise<Settings> {
  const raw = await getValue(db, KEY);
  if (!raw) return DEFAULT_SETTINGS;
  const saved = JSON.parse(raw) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...saved, parts: { ...DEFAULT_SETTINGS.parts, ...(saved.parts ?? {}) } };
}

export function settingsStatement(db: D1Database, s: Settings): D1PreparedStatement {
  return setValueStatement(db, KEY, JSON.stringify(s));
}

export async function getValue(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export function setValueStatement(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value);
}

export async function setValue(db: D1Database, key: string, value: string): Promise<void> {
  await setValueStatement(db, key, value).run();
}

export async function deleteValue(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}
