/**
 * The studio's local database: every video, script, stage result and log line.
 * SQLite ships with Electron's Node, so there is nothing to install or compile.
 */
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | running | paused | review | approved | rejected | error
  priority INTEGER NOT NULL DEFAULT 0,
  script_id INTEGER,
  data TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stages (
  video_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error | skipped
  progress REAL NOT NULL DEFAULT 0,
  message TEXT,
  result TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (video_id, name)
);
CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  tone TEXT NOT NULL,
  duration_target INTEGER NOT NULL,
  format TEXT NOT NULL,                    -- long | short
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | researching | writing | review | approved | rejected | error
  research TEXT,
  content TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  pending_instruction TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS script_versions (
  script_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  instruction TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (script_id, version)
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER,
  script_id INTEGER,
  agent TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',      -- info | decision | warn | error
  message TEXT NOT NULL,
  time INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_video ON logs (video_id, id);
CREATE INDEX IF NOT EXISTS logs_script ON logs (script_id, id);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL,
  file_hash TEXT NOT NULL,
  meta_hash TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const parse = (text, fallback) => {
  try {
    return text == null ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
};

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  const now = () => Date.now();
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  // One recording can give several videos (a long session split in parts): its path no longer names one video.
  if (/source_path TEXT NOT NULL UNIQUE/.test(one("SELECT sql FROM sqlite_master WHERE name = 'videos'")?.sql ?? "")) {
    try {
      db.exec(`VACUUM INTO '${`${file}.antes-das-partes.bak`.replace(/'/g, "''")}'`);
    } catch {
      // A backup that cannot be written does not stop the studio.
    }
    db.exec("BEGIN");
    try {
      db.exec(`CREATE TABLE videos_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, source_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 0, script_id INTEGER, data TEXT NOT NULL DEFAULT '{}', error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO videos_new SELECT id, title, source_path, status, priority, script_id, data, error, created_at, updated_at FROM videos;
        DROP TABLE videos;
        ALTER TABLE videos_new RENAME TO videos;`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS videos_source ON videos (source_path)");

  const video = (row) => row && { ...row, data: parse(row.data, {}) };
  const stage = (row) => row && { ...row, result: parse(row.result, null) };
  const script = (row) => row && { ...row, research: parse(row.research, null), content: parse(row.content, null) };

  return {
    close: () => db.close(),

    // --- Videos
    addVideo({ title, sourcePath, scriptId = null, stages }) {
      const t = now();
      const { lastInsertRowid } = run("INSERT INTO videos (title, source_path, script_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", title, sourcePath, scriptId, t, t);
      const id = Number(lastInsertRowid);
      for (const name of stages) run("INSERT INTO stages (video_id, name) VALUES (?, ?)", id, name);
      return id;
    },
    video: (id) => video(one("SELECT * FROM videos WHERE id = ?", id)),
    /** A video whose recording is made by the studio itself (a project in the editor's order). */
    setSource: (id, file) => run("UPDATE videos SET source_path = ? WHERE id = ?", file, id),
    videoByPath: (file) => video(one("SELECT * FROM videos WHERE source_path = ?", file)),
    videos: () => all("SELECT * FROM videos ORDER BY priority DESC, id ASC").map(video),
    updateVideo(id, patch) {
      const current = this.video(id);
      if (!current) return;
      const next = { ...current, ...patch, data: { ...current.data, ...(patch.data ?? {}) } };
      run(
        "UPDATE videos SET title = ?, status = ?, priority = ?, script_id = ?, data = ?, error = ?, updated_at = ? WHERE id = ?",
        next.title, next.status, next.priority, next.script_id, JSON.stringify(next.data), next.error ?? null, now(), id,
      );
    },
    removeVideo(id) {
      run("DELETE FROM stages WHERE video_id = ?", id);
      run("DELETE FROM logs WHERE video_id = ?", id);
      run("DELETE FROM approvals WHERE video_id = ?", id);
      run("DELETE FROM videos WHERE id = ?", id);
    },

    // --- Stages
    stages: (videoId) => all("SELECT * FROM stages WHERE video_id = ? ORDER BY rowid", videoId).map(stage),
    /** A stage that did not exist when the video entered the queue (the studio learned a new one since). */
    addStage: (videoId, name, status = "pending") => run("INSERT OR IGNORE INTO stages (video_id, name, status) VALUES (?, ?, ?)", videoId, name, status),
    stage: (videoId, name) => stage(one("SELECT * FROM stages WHERE video_id = ? AND name = ?", videoId, name)),
    updateStage(videoId, name, patch) {
      const current = this.stage(videoId, name);
      if (!current) return;
      const next = { ...current, ...patch };
      run(
        "UPDATE stages SET status = ?, progress = ?, message = ?, result = ?, attempt = ?, started_at = ?, finished_at = ? WHERE video_id = ? AND name = ?",
        next.status, next.progress, next.message ?? null, next.result == null ? null : JSON.stringify(next.result), next.attempt, next.started_at ?? null, next.finished_at ?? null, videoId, name,
      );
    },
    /** After a crash or a power cut nothing is really running any more. */
    resetRunning() {
      run("UPDATE stages SET status = 'pending', progress = 0, message = NULL WHERE status = 'running'");
      run("UPDATE videos SET status = 'queued' WHERE status = 'running'");
      run("UPDATE scripts SET status = 'queued' WHERE status IN ('researching', 'writing')");
    },

    // --- Scripts
    addScript({ topic, tone, durationTarget, format }) {
      const t = now();
      return Number(run("INSERT INTO scripts (topic, tone, duration_target, format, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", topic, tone, durationTarget, format, t, t).lastInsertRowid);
    },
    script: (id) => script(one("SELECT * FROM scripts WHERE id = ?", id)),
    scripts: () => all("SELECT * FROM scripts ORDER BY id DESC").map(script),
    updateScript(id, patch) {
      const current = this.script(id);
      if (!current) return;
      const next = { ...current, ...patch };
      run(
        "UPDATE scripts SET topic = ?, tone = ?, duration_target = ?, format = ?, status = ?, research = ?, content = ?, version = ?, pending_instruction = ?, error = ?, updated_at = ? WHERE id = ?",
        next.topic, next.tone, next.duration_target, next.format, next.status,
        next.research == null ? null : JSON.stringify(next.research), next.content == null ? null : JSON.stringify(next.content),
        next.version, next.pending_instruction ?? null, next.error ?? null, now(), id,
      );
    },
    /** Every change to a script is kept, so an adjustment that made it worse can be undone. */
    saveScriptVersion(id, content, instruction = null) {
      const current = this.script(id);
      const version = (current?.version ?? 0) + 1;
      run("INSERT INTO script_versions (script_id, version, content, instruction, created_at) VALUES (?, ?, ?, ?, ?)", id, version, JSON.stringify(content), instruction, now());
      this.updateScript(id, { content, version });
      return version;
    },
    scriptVersions: (id) => all("SELECT version, instruction, created_at FROM script_versions WHERE script_id = ? ORDER BY version DESC", id),
    scriptVersion: (id, version) => parse(one("SELECT content FROM script_versions WHERE script_id = ? AND version = ?", id, version)?.content, null),
    removeScript(id) {
      run("DELETE FROM script_versions WHERE script_id = ?", id);
      run("DELETE FROM logs WHERE script_id = ?", id);
      run("UPDATE videos SET script_id = NULL WHERE script_id = ?", id);
      run("DELETE FROM scripts WHERE id = ?", id);
    },

    // --- Logs
    log({ videoId = null, scriptId = null, agent, level = "info", message }) {
      run("INSERT INTO logs (video_id, script_id, agent, level, message, time) VALUES (?, ?, ?, ?, ?, ?)", videoId, scriptId, agent, level, String(message), now());
    },
    logs: ({ videoId = null, scriptId = null, limit = 300 } = {}) =>
      (videoId != null
        ? all("SELECT * FROM logs WHERE video_id = ? ORDER BY id DESC LIMIT ?", videoId, limit)
        : scriptId != null
          ? all("SELECT * FROM logs WHERE script_id = ? ORDER BY id DESC LIMIT ?", scriptId, limit)
          : all("SELECT * FROM logs ORDER BY id DESC LIMIT ?", limit)
      ).reverse(),

    // --- Approvals
    addApproval: (videoId, fileHash, metaHash) => run("INSERT INTO approvals (video_id, file_hash, meta_hash, approved_at) VALUES (?, ?, ?, ?)", videoId, fileHash, metaHash, now()),
    approval: (videoId) => one("SELECT * FROM approvals WHERE video_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1", videoId) ?? null,
    revokeApprovals: (videoId) => run("UPDATE approvals SET revoked_at = ? WHERE video_id = ? AND revoked_at IS NULL", now(), videoId),

    // --- Settings
    setting: (key, fallback = null) => parse(one("SELECT value FROM settings WHERE key = ?", key)?.value, fallback),
    setSetting: (key, value) => run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value)),
  };
}

module.exports = { openDb };
