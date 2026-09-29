CREATE TABLE IF NOT EXISTS app_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO app_config (id, revision, config_json, updated_at)
VALUES (1, 0, '{"servers":[]}', unixepoch());

CREATE TABLE IF NOT EXISTS agent_metrics (
  username TEXT PRIMARY KEY,
  metrics_json TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  traffic_period TEXT NOT NULL,
  traffic_base_in INTEGER NOT NULL,
  traffic_base_out INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_state (
  username TEXT PRIMARY KEY,
  is_online INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
