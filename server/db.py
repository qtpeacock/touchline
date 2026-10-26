"""SQLite storage for accounts, teams, schedules, drills and practice plans."""
import json
import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("TOUCHLINE_DB", ROOT / "data" / "touchline.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]',
  profile TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  age_group TEXT NOT NULL DEFAULT '',
  season TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#174c3d',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  number TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS drills (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',  -- legacy single category; replaced by categories
  minutes INTEGER NOT NULL DEFAULT 15,
  notes TEXT NOT NULL DEFAULT '',
  board TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  categories TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS drill_categories (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner_id, name)
);
CREATE TABLE IF NOT EXISTS practices (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  focus TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  practice_id INTEGER REFERENCES practices(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('practice', 'game')),
  title TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  opponent TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_owner_date ON events (owner_id, date);
-- One reply per player per practice or game. No row means the player hasn't replied yet.
CREATE TABLE IF NOT EXISTS attendance (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('yes', 'maybe', 'no')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, player_id)
);
-- Links an account to a player on a coach's roster: as that player, or as their parent.
CREATE TABLE IF NOT EXISTS player_links (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('player', 'parent')),
  PRIMARY KEY (user_id, player_id, relation)
);
-- A coach's invitation for an email to connect to a roster player, as that player or as a parent.
-- The person accepts it on their account home (after signing up, if they're new); then it becomes a player_link.
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  relation TEXT NOT NULL CHECK (relation IN ('player', 'parent')),
  invited_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, email, relation)
);
-- Drills a coach shares with players. A share with no rows in shared_drill_players goes to the whole team.
CREATE TABLE IF NOT EXISTS shared_drills (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  drill_id INTEGER NOT NULL REFERENCES drills(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS shared_drill_players (
  share_id INTEGER NOT NULL REFERENCES shared_drills(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (share_id, player_id)
);
-- A family's travel plan for an away game.
CREATE TABLE IF NOT EXISTS travel_plans (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('driving', 'need_ride', 'carpool', 'other')),
  seats INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, player_id)
);
-- Every AI run (a practice plan, a single drill, or one chat answer): what was asked, each agent step,
-- token usage and the proposal.
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'practice' CHECK (kind IN ('practice', 'drill', 'chat')),
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  request TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  usage TEXT NOT NULL DEFAULT '{}',
  trace TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  error TEXT,
  saved_practice_id INTEGER REFERENCES practices(id) ON DELETE SET NULL,
  saved_drill_id INTEGER REFERENCES drills(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS agent_runs_owner ON agent_runs (owner_id, created_at);
"""


def _replies(status: str) -> str:
    # Only replies from players still on the event's team count.
    return (f"(SELECT COUNT(*) FROM attendance a JOIN players pl ON pl.id = a.player_id "
            f"WHERE a.event_id = e.id AND pl.team_id = e.team_id AND a.status = '{status}')")


# An event with its team, its practice plan's name and its reply counts.
EVENT_SELECT = (
    "SELECT e.*, t.name AS team_name, t.color AS team_color, p.name AS practice_name, "
    f"{_replies('yes')} AS going, {_replies('maybe')} AS maybe, {_replies('no')} AS not_going, "
    "(SELECT COUNT(*) FROM players pl WHERE pl.team_id = e.team_id) AS roster_size FROM events e "
    "LEFT JOIN teams t ON t.id = e.team_id LEFT JOIN practices p ON p.id = e.practice_id"
)


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    # FastAPI may run a request's dependency and handler on different threadpool
    # threads; each connection is still only used by one request at a time.
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


DEFAULT_CATEGORIES = ["Shooting", "Finishing", "Passing", "First touch", "Possession", "1v1", "2v2", "Defense"]


def add_category(conn, owner_id: int, name: str) -> None:
    """Add a drill category for a coach (no-op if they already have it)."""
    conn.execute(
        "INSERT OR IGNORE INTO drill_categories (owner_id, name, sort) "
        "VALUES (?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM drill_categories WHERE owner_id = ?))",
        (owner_id, name, owner_id),
    )


def add_default_categories(conn, owner_id: int) -> None:
    for name in DEFAULT_CATEGORIES:
        add_category(conn, owner_id, name)


def _migrate(conn) -> None:
    """Upgrade databases created by earlier versions. `PRAGMA user_version` records how far we got."""
    if conn.execute("PRAGMA user_version").fetchone()[0] < 1:
        # v1: drills get any number of categories, chosen from each coach's own list.
        if "categories" not in {r["name"] for r in conn.execute("PRAGMA table_info(drills)")}:
            conn.execute("ALTER TABLE drills ADD COLUMN categories TEXT NOT NULL DEFAULT '[]'")
        for (user_id,) in conn.execute("SELECT id FROM users").fetchall():
            add_default_categories(conn, user_id)
        renamed = {"Defending": "Defense", "Other": None}
        for row in conn.execute("SELECT id, owner_id, category FROM drills WHERE categories = '[]'").fetchall():
            name = renamed.get(row["category"], row["category"])
            if name:
                add_category(conn, row["owner_id"], name)
                conn.execute("UPDATE drills SET categories = ? WHERE id = ?", (json.dumps([name]), row["id"]))
        conn.execute("PRAGMA user_version = 1")
    # Columns added after the first release, so older databases get them too.
    added = [
        ("agent_runs", "kind", "TEXT NOT NULL DEFAULT 'practice'"),   # agent_runs made before the drill builder were practice builds
        ("agent_runs", "saved_drill_id", "INTEGER REFERENCES drills(id) ON DELETE SET NULL"),
        ("attendance", "source", "TEXT NOT NULL DEFAULT 'coach'"),     # who gave the reply: coach, player or parent
        ("events", "away", "INTEGER NOT NULL DEFAULT 0"),              # away games can carry travel plans
        ("teams", "parents_see_drills", "INTEGER NOT NULL DEFAULT 1"), # can parents see drills shared with players?
    ]
    for table, column, spec in added:
        if column not in {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {spec}")


def init_db() -> None:
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        _migrate(conn)
        conn.commit()
    finally:
        conn.close()


def get_db():
    """FastAPI dependency: one connection per request, committed on success."""
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def attendance_for(conn, event_id: int, team_id: int | None) -> dict:
    """Each player on the event's team with their reply (None = no reply yet), plus the counts."""
    players = to_dicts(conn.execute(
        "SELECT p.id, p.name, p.number, p.position, a.status, a.source, a.updated_at FROM players p "
        "LEFT JOIN attendance a ON a.player_id = p.id AND a.event_id = ? WHERE p.team_id = ? ORDER BY p.sort, p.id",
        (event_id, team_id),
    ).fetchall()) if team_id else []
    counts = {s: sum(p["status"] == s for p in players) for s in ("yes", "maybe", "no")}
    counts["no_reply"] = sum(p["status"] is None for p in players)
    counts["roster"] = len(players)
    return {"event_id": event_id, "team_id": team_id, "players": players, "counts": counts}


def set_reply(conn, event_id: int, player_id: int, status: str | None, source: str) -> None:
    """Record (or with status None, clear) a player's reply. source says who answered: coach, player or parent."""
    if status is None:
        conn.execute("DELETE FROM attendance WHERE event_id = ? AND player_id = ?", (event_id, player_id))
    else:
        conn.execute(
            "INSERT INTO attendance (event_id, player_id, status, source) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (event_id, player_id) DO UPDATE SET status = excluded.status, source = excluded.source, "
            "updated_at = datetime('now')",
            (event_id, player_id, status, source),
        )


def to_dict(row: sqlite3.Row | None, *json_cols: str) -> dict | None:
    if row is None:
        return None
    data = dict(row)
    for col in json_cols:
        data[col] = json.loads(data[col])
    return data


def to_dicts(rows: list[sqlite3.Row], *json_cols: str) -> list[dict]:
    return [to_dict(row, *json_cols) for row in rows]
