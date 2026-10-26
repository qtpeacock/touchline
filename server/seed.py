"""Demo coach account so the app can be explored right after a fresh clone."""
import json
from datetime import date, timedelta

from .db import add_category, add_default_categories
from .security import hash_password

DEMO_EMAIL = "coach@example.com"
DEMO_PASSWORD = "coach1234"
DEMO_NAME = "Demo Account"
# Single-role demo logins, both tied to Player 1 on Team 1. The demo account above also holds both
# roles for Player 1, so a demo can switch between coach, player and parent without logging out.
PLAYER_EMAIL, PLAYER_PASSWORD, PLAYER_NAME = "player@example.com", "player1234", "Player 1"
PARENT_EMAIL, PARENT_PASSWORD, PARENT_NAME = "parent@example.com", "parent1234", "Parent of Player 1"
DEMO_EMAILS = (DEMO_EMAIL, PLAYER_EMAIL, PARENT_EMAIL)

WHITE, GOLD, BLUE, RED = "#f7f9f5", "#e8b34c", "#304dbe", "#e55c4b"


def _player(pid, x, y, color, label):
    return {"id": pid, "kind": "player", "x": x, "y": y, "color": color, "label": label}


def _ball(pid, x, y):
    return {"id": pid, "kind": "ball", "x": x, "y": y, "color": WHITE, "label": ""}


def _cone(pid, x, y):
    return {"id": pid, "kind": "cone", "x": x, "y": y, "color": "#f88939", "label": ""}


def _arrow(aid, kind, x1, y1, x2, y2):
    return {"id": aid, "kind": kind, "x1": x1, "y1": y1, "x2": x2, "y2": y2}


def _move(pid, x, y, kind="move"):
    return {"id": pid, "x": x, "y": y, "type": kind}


DRILLS = [
    {
        "name": "Dynamic Warm-up Lines",
        "categories": ["Warm-up"],
        "minutes": 10,
        "notes": "Four lines, 30 yards apart. Jog out and skip back, high knees out and open the gate back, "
                 "side shuffle both ways, then a build-up sprint to finish.\n\n"
                 "Coaching points: tall posture, quick feet, full range of motion.",
        "board": {
            "field": "blank",
            "pieces": [
                *[_cone(f"cs{i}", 22, y) for i, y in enumerate((25, 42, 58, 75))],
                *[_cone(f"ce{i}", 78, y) for i, y in enumerate((25, 42, 58, 75))],
                *[_player(f"w{i}", 15, y, GOLD, str(i + 1)) for i, y in enumerate((25, 42, 58, 75))],
            ],
            "arrows": [_arrow(f"a{i}", "move", 25, y, 74, y) for i, y in enumerate((25, 42, 58, 75))],
            "phases": [],
        },
    },
    {
        "name": "Passing Triangle",
        "categories": ["Passing", "First touch"],
        "minutes": 12,
        "notes": "Three players on cones 15 yards apart. Pass, then follow your pass to the next cone. "
                 "Switch direction every two minutes.\n\n"
                 "Coaching points: first touch out of your feet toward the next target, pass with the inside "
                 "of the foot, and call for the ball before it arrives.",
        "board": {
            "field": "blank",
            "pieces": [
                _cone("c1", 30, 72), _cone("c2", 70, 72), _cone("c3", 50, 34),
                _player("p1", 30, 80, BLUE, "1"), _player("p2", 70, 80, BLUE, "2"), _player("p3", 50, 26, BLUE, "3"),
                _ball("b", 33.5, 77),
            ],
            "arrows": [_arrow("a1", "pass", 35, 77, 65, 78), _arrow("a2", "move", 31, 86, 66, 87)],
            "phases": [
                {"id": "s1", "moves": [_move("b", 66.5, 78, "pass")]},
                {"id": "s2", "moves": [_move("p1", 64, 86), _move("b", 52, 30, "pass")]},
            ],
        },
    },
    {
        "name": "4v2 Rondo",
        "categories": ["Possession", "Passing"],
        "minutes": 15,
        "notes": "Four attackers keep the ball from two defenders inside a 12x12 yard grid. Two touches max. "
                 "When a defender wins it, they swap with the attacker who lost it.\n\n"
                 "Coaching points: open body shape, receive across the body, pass to the back foot, and move "
                 "to open a passing lane after every pass.",
        "board": {
            "field": "blank",
            "pieces": [
                _cone("c1", 34, 22), _cone("c2", 66, 22), _cone("c3", 66, 78), _cone("c4", 34, 78),
                _player("a1", 50, 22, WHITE, "1"), _player("a2", 66, 50, WHITE, "2"),
                _player("a3", 50, 78, WHITE, "3"), _player("a4", 34, 50, WHITE, "4"),
                _player("d1", 46, 44, RED, "5"), _player("d2", 55, 57, RED, "6"),
                _ball("b", 52.5, 26.5),
            ],
            "arrows": [_arrow("x1", "pass", 53, 29, 63, 46), _arrow("x2", "move", 47, 41, 56, 36)],
            "phases": [
                {"id": "s1", "moves": [_move("b", 63, 49, "pass"), _move("d1", 57, 43)]},
                {"id": "s2", "moves": [_move("b", 50, 74, "pass"), _move("d2", 52, 66), _move("d1", 56, 56)]},
            ],
        },
    },
    {
        "name": "1v1 to Goal",
        "categories": ["1v1", "Finishing", "Shooting"],
        "minutes": 15,
        "notes": "The attacker receives at the top of the gate and goes 1v1 against a defender to goal. The "
                 "defender starts at the edge of the box. Five seconds to get a shot off.\n\n"
                 "Coaching points: attack the defender's front foot, change pace after the move, and shoot "
                 "early across the keeper.",
        "board": {
            "field": "half",
            "pieces": [
                _player("gk", 50, 8, GOLD, "1"), _player("d", 50, 46, RED, "4"), _player("a", 50, 82, WHITE, "9"),
                _ball("b", 53, 78), _cone("g1", 42, 66), _cone("g2", 58, 66),
            ],
            "arrows": [_arrow("x1", "dribble", 53, 75, 62, 44), _arrow("x2", "pass", 62, 40, 54, 9)],
            "phases": [
                {"id": "s1", "moves": [_move("a", 61, 46), _move("b", 63.5, 42), _move("d", 56, 45)]},
                {"id": "s2", "moves": [_move("b", 55, 5, "pass"), _move("gk", 53, 8)]},
            ],
        },
    },
]

OPPONENTS = ["Riverside FC", "Blue Hawks", "Valley United", "Northside SC", "Harbor City", "Lakeside Rovers", "Elm Street FC"]
# Positions by jersey number for the demo rosters.
POSITIONS = {1: "GK", 2: "CB", 3: "CB", 4: "LB", 5: "RB", 6: "CM", 7: "CM", 8: "AM", 9: "LW", 10: "RW", 11: "ST"}


def _rsvps(yes=(), maybe=(), no=()) -> dict[int, str]:
    return {**{n: "yes" for n in yes}, **{n: "maybe" for n in maybe}, **{n: "no" for n in no}}


# Replies for each demo team's next few practices and games, by jersey number; anyone missing hasn't replied.
# Team 1's next practice has 8 yes, 2 maybe and 1 no, so the AI builder has to plan for 8 players.
RSVP_PATTERNS = [
    {
        "practice": [_rsvps(yes=range(1, 9), maybe=(9, 10), no=(11,)), _rsvps(yes=(1, 2, 3, 4, 5, 7, 9), maybe=(6,)), _rsvps(yes=(1, 2, 3))],
        "game": [_rsvps(yes=range(1, 11), maybe=(11,))],
    },
    {
        "practice": [_rsvps(yes=range(1, 7), maybe=(7, 8, 9), no=(10, 11)), _rsvps(yes=range(1, 10), no=(10,))],
        "game": [_rsvps(yes=range(1, 12))],
    },
]


def _seed_positions(conn, user_id: int) -> None:
    """Give the demo rosters positions, unless the coach has already set any."""
    for (team_id,) in conn.execute("SELECT id FROM teams WHERE owner_id = ?", (user_id,)).fetchall():
        if conn.execute("SELECT 1 FROM players WHERE team_id = ? AND position != ''", (team_id,)).fetchone():
            continue
        for number, position in POSITIONS.items():
            conn.execute("UPDATE players SET position = ? WHERE team_id = ? AND number = ?", (position, team_id, str(number)))


def _seed_attendance(conn, user_id: int) -> None:
    """Replies for each demo team's next practices and games. Events that already have replies are left alone."""
    teams = conn.execute("SELECT id FROM teams WHERE owner_id = ? ORDER BY id", (user_id,)).fetchall()
    for (team_id,), patterns in zip(teams, RSVP_PATTERNS):
        players = {row["number"]: row["id"] for row in conn.execute("SELECT id, number FROM players WHERE team_id = ?", (team_id,))}
        for kind, replies in patterns.items():
            events = conn.execute(
                "SELECT id FROM events WHERE team_id = ? AND kind = ? AND date >= ? ORDER BY date, start_time LIMIT ?",
                (team_id, kind, date.today().isoformat(), len(replies)),
            ).fetchall()
            for (event_id,), reply in zip(events, replies):
                if conn.execute("SELECT 1 FROM attendance WHERE event_id = ?", (event_id,)).fetchone():
                    continue
                conn.executemany(
                    "INSERT INTO attendance (event_id, player_id, status) VALUES (?, ?, ?)",
                    [(event_id, players[str(n)], status) for n, status in reply.items() if str(n) in players],
                )


def _user(conn, email: str, password: str, name: str, roles: list[str]) -> int:
    row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if row:
        return row["id"]
    profile = {"phone": "", "city": "New Haven, CT", "organization": "Demo Soccer Club", "bio": ""}
    return conn.execute(
        "INSERT INTO users (email, password_hash, name, roles, profile) VALUES (?, ?, ?, ?, ?)",
        (email, hash_password(password), name, json.dumps(roles), json.dumps(profile)),
    ).lastrowid


def _seed_family(conn, coach_id: int) -> None:
    """Player 1 on Team 1 gets a player login and a parent login, the demo account holds every role, Team 1
    gets some away games (for travel plans), and the coach has shared two drills."""
    team = conn.execute("SELECT id FROM teams WHERE owner_id = ? ORDER BY id LIMIT 1", (coach_id,)).fetchone()
    p1 = team and conn.execute("SELECT id FROM players WHERE team_id = ? AND number = '1'", (team["id"],)).fetchone()
    if not p1:
        return
    team_id, player_id = team["id"], p1["id"]
    conn.execute("UPDATE users SET roles = ?, name = CASE WHEN name = 'Demo Coach' THEN ? ELSE name END WHERE id = ?",
                 (json.dumps(["coach", "player", "parent"]), DEMO_NAME, coach_id))
    links = [(coach_id, "player"), (coach_id, "parent"),
             (_user(conn, PLAYER_EMAIL, PLAYER_PASSWORD, PLAYER_NAME, ["player"]), "player"),
             (_user(conn, PARENT_EMAIL, PARENT_PASSWORD, PARENT_NAME, ["parent"]), "parent")]
    conn.executemany("INSERT OR IGNORE INTO player_links (user_id, player_id, relation) VALUES (?, ?, ?)",
                     [(user_id, player_id, relation) for user_id, relation in links])
    # Every other upcoming Team 1 game is away, starting with the next one.
    games = conn.execute("SELECT id, opponent FROM events WHERE team_id = ? AND kind = 'game' AND date >= ? ORDER BY date",
                         (team_id, date.today().isoformat())).fetchall()
    for game in games[::2]:
        conn.execute("UPDATE events SET away = 1, location = ? WHERE id = ?", (f"{game['opponent'] or 'Opponent'} home field", game["id"]))
    conn.execute("UPDATE events SET away = 1 WHERE owner_id = ? AND location = 'Away'", (coach_id,))
    # Player 1's replies came from Player 1, so the coach's roster shows them as answered by the player.
    conn.execute("UPDATE attendance SET source = 'player' WHERE player_id = ?", (player_id,))
    drills = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM drills WHERE owner_id = ?", (coach_id,))}
    if "Passing Triangle" in drills:
        conn.execute("INSERT INTO shared_drills (owner_id, team_id, drill_id, note) VALUES (?, ?, ?, ?)",
                     (coach_id, team_id, drills["Passing Triangle"], "10 minutes against a wall before Thursday: first touch away from pressure."))
    if "1v1 to Goal" in drills:   # shared with Player 1 only
        share_id = conn.execute("INSERT INTO shared_drills (owner_id, team_id, drill_id, note) VALUES (?, ?, ?, ?)",
                                (coach_id, team_id, drills["1v1 to Goal"], "Keeper reps: set your feet before every shot.")).lastrowid
        conn.execute("INSERT INTO shared_drill_players (share_id, player_id) VALUES (?, ?)", (share_id, player_id))


def _upgrade_demo(conn) -> None:
    """Give a demo account made by an earlier version what later versions seed, once.
    Version 2 added positions and RSVPs; version 3 added the player and parent logins."""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version >= 3:
        return
    row = conn.execute("SELECT id FROM users WHERE email = ?", (DEMO_EMAIL,)).fetchone()
    if row and version < 2:
        _seed_positions(conn, row["id"])
        _seed_attendance(conn, row["id"])
    if row:
        _seed_family(conn, row["id"])
    conn.execute("PRAGMA user_version = 3")


def seed_demo(conn) -> None:
    if conn.execute("SELECT 1 FROM users WHERE email = ?", (DEMO_EMAIL,)).fetchone():
        _upgrade_demo(conn)
        return
    profile = {"phone": "", "city": "New Haven, CT", "organization": "Demo Soccer Club", "bio": ""}
    user_id = conn.execute(
        "INSERT INTO users (email, password_hash, name, roles, profile) VALUES (?, ?, ?, ?, ?)",
        (DEMO_EMAIL, hash_password(DEMO_PASSWORD), DEMO_NAME, json.dumps(["coach"]), json.dumps(profile)),
    ).lastrowid

    add_default_categories(conn, user_id)
    add_category(conn, user_id, "Warm-up")   # a coach-made category, to show custom ones

    team_ids = []
    for name, color in (("Team 1", "#174c3d"), ("Team 2", "#304dbe")):
        team_id = conn.execute(
            "INSERT INTO teams (owner_id, name, season, color) VALUES (?, ?, ?, ?)", (user_id, name, "Fall 2026", color)
        ).lastrowid
        team_ids.append(team_id)
        conn.executemany(
            "INSERT INTO players (team_id, name, number, position, sort) VALUES (?, ?, ?, ?, ?)",
            [(team_id, f"Player {n}", str(n), POSITIONS[n], n) for n in range(1, 12)],
        )

    plan_items = []
    for drill in DRILLS:
        drill_id = conn.execute(
            "INSERT INTO drills (owner_id, name, categories, minutes, notes, board) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, drill["name"], json.dumps(drill["categories"]), drill["minutes"], drill["notes"], json.dumps(drill["board"])),
        ).lastrowid
        plan_items.append({
            "drill_id": drill_id, "name": drill["name"], "categories": drill["categories"],
            "field": drill["board"]["field"], "minutes": drill["minutes"],
        })
    practice_id = conn.execute(
        "INSERT INTO practices (owner_id, team_id, name, focus, items) VALUES (?, ?, ?, ?, ?)",
        (user_id, team_ids[0], "Possession under pressure", "Keeping the ball when pressed", json.dumps(plan_items)),
    ).lastrowid

    # Two weeks of history and five weeks ahead, so the calendar has something on every screen.
    today = date.today()
    start = today - timedelta(days=today.weekday() + 14)
    team1, team2 = team_ids
    game = 0
    rows = []
    for offset in range(49):
        day = start + timedelta(days=offset)
        iso, weekday = day.isoformat(), day.weekday()
        if weekday in (1, 3):
            rows.append((team1, practice_id, "practice", iso, "17:30", "19:00", "Main field", ""))
        elif weekday in (0, 2):
            rows.append((team2, None, "practice", iso, "18:00", "19:30", "Field B", ""))
        elif weekday == 5:
            rows.append((team1, None, "game", iso, "10:00", "11:30", "Main field", OPPONENTS[game % len(OPPONENTS)]))
            rows.append((team2, None, "game", iso, "12:30", "14:00", "Away", OPPONENTS[(game + 3) % len(OPPONENTS)]))
            game += 1
    conn.executemany(
        "INSERT INTO events (owner_id, team_id, practice_id, kind, date, start_time, end_time, location, opponent) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(user_id, *row) for row in rows],
    )
    _seed_attendance(conn, user_id)
    _upgrade_demo(conn)
