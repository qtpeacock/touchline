"""What players and parents see: the roster players an account is linked to, their team's schedule with
the player's own replies, travel plans, and the drills the coach shared. Also the account home's combined
schedule. Used by the API (main.py) and the AI chat (assistant.py)."""
from datetime import date, timedelta
from typing import Optional

from fastapi import HTTPException

from . import db

RELATIONS = ("player", "parent")
TRAVEL_LABELS = {"driving": "Driving", "need_ride": "Needs a ride", "carpool": "Carpooling", "other": "Other plan"}

# An event as players and parents see it: no practice plan and no other players' replies.
FAMILY_EVENT = (
    "SELECT e.id, e.kind, e.title, e.date, e.start_time, e.end_time, e.location, e.opponent, e.notes, e.away, "
    "e.team_id, t.name AS team_name, t.color AS team_color FROM events e JOIN teams t ON t.id = e.team_id"
)


def links_for(conn, user_id: int, relation: str) -> list[dict]:
    """The roster players this account is linked to as that player, or as their parent."""
    return db.to_dicts(conn.execute(
        "SELECT p.id, p.name, p.number, p.position, p.team_id, t.name AS team_name, t.color AS team_color, "
        "t.age_group, t.parents_see_drills, u.name AS coach_name FROM player_links l "
        "JOIN players p ON p.id = l.player_id JOIN teams t ON t.id = p.team_id JOIN users u ON u.id = t.owner_id "
        "WHERE l.user_id = ? AND l.relation = ? ORDER BY p.id",
        (user_id, relation),
    ).fetchall())


def linked_player(conn, user_id: int, relation: str, player_id: int) -> dict:
    player = next((p for p in links_for(conn, user_id, relation) if p["id"] == player_id), None)
    if not player:
        raise HTTPException(404, "That player isn't linked to your account.")
    return player


def shares_for(conn, team_id: int, player_id: Optional[int] = None) -> list[dict]:
    """A team's shared drills, newest first, with the drill itself and who it went to (empty = everyone).
    With player_id, only the shares that reach that player."""
    rows = conn.execute(
        "SELECT s.id, s.note, s.created_at, s.team_id, d.id AS drill_id, d.name, d.categories, d.minutes, d.notes, d.board "
        "FROM shared_drills s JOIN drills d ON d.id = s.drill_id WHERE s.team_id = ? ORDER BY s.created_at DESC, s.id DESC",
        (team_id,),
    ).fetchall()
    out = []
    for row in rows:
        to = db.to_dicts(conn.execute(
            "SELECT p.id, p.name, p.number FROM shared_drill_players sp JOIN players p ON p.id = sp.player_id "
            "WHERE sp.share_id = ? ORDER BY p.sort, p.id", (row["id"],),
        ).fetchall())
        if player_id is not None and to and player_id not in {p["id"] for p in to}:
            continue
        share = db.to_dict(row, "categories", "board")
        share["to"] = to
        out.append(share)
    return out


def family_view(conn, user_id: int, relation: str, days: int = 42) -> list[dict]:
    """For each linked player: their team's upcoming practices and games with the player's reply (and, for a
    parent, the travel plan for away games), plus the drills shared with them."""
    today = date.today()
    kids = []
    for player in links_for(conn, user_id, relation):
        events = db.to_dicts(conn.execute(
            FAMILY_EVENT + " WHERE e.team_id = ? AND e.date BETWEEN ? AND ? ORDER BY e.date, e.start_time, e.id",
            (player["team_id"], today.isoformat(), (today + timedelta(days=days)).isoformat()),
        ).fetchall())
        replies = {r["event_id"]: {"status": r["status"], "by": r["source"], "at": r["updated_at"]}
                   for r in conn.execute("SELECT * FROM attendance WHERE player_id = ?", (player["id"],))}
        travel = {r["event_id"]: {"plan": r["plan"], "seats": r["seats"], "note": r["note"]}
                  for r in conn.execute("SELECT * FROM travel_plans WHERE player_id = ?", (player["id"],))}
        for ev in events:
            ev["away"] = bool(ev["away"])
            ev["reply"] = replies.get(ev["id"])
            if relation == "parent" and ev["kind"] == "game" and ev["away"]:
                ev["travel"] = travel.get(ev["id"])
        drills_visible = relation == "player" or bool(player["parents_see_drills"])
        kids.append({
            "player": {k: player[k] for k in ("id", "name", "number", "position", "team_id", "team_name", "team_color", "age_group", "coach_name")},
            "events": events,
            "drills": shares_for(conn, player["team_id"], player["id"]) if drills_visible else [],
            "drills_hidden": not drills_visible,
        })
    return kids


def schedule_for(conn, user: dict, start: str, end: str) -> list[dict]:
    """Every event this account can see between two dates, once each, tagged with the roles it's seen through.
    Coach events carry reply counts; player and parent events carry that player's own reply."""
    events: dict[int, dict] = {}

    def add(row: dict, role: str) -> dict:
        ev = events.setdefault(row["id"], {**row, "roles": [], "replies": {}})
        if role not in ev["roles"]:
            ev["roles"].append(role)
        return ev

    if "coach" in user["roles"]:
        for row in db.to_dicts(conn.execute(db.EVENT_SELECT + " WHERE e.owner_id = ? AND e.date BETWEEN ? AND ?",
                                            (user["id"], start, end)).fetchall()):
            add(row, "coach")
    for relation in RELATIONS:
        if relation not in user["roles"]:
            continue
        for player in links_for(conn, user["id"], relation):
            rows = db.to_dicts(conn.execute(FAMILY_EVENT + " WHERE e.team_id = ? AND e.date BETWEEN ? AND ?",
                                            (player["team_id"], start, end)).fetchall())
            replies = {r["event_id"]: r["status"] for r in conn.execute("SELECT event_id, status FROM attendance WHERE player_id = ?", (player["id"],))}
            for row in rows:
                ev = add(row, relation)
                ev["replies"][relation] = {"player": player["name"], "status": replies.get(row["id"])}
    out = sorted(events.values(), key=lambda e: (e["date"], e["start_time"] or "", e["id"]))
    for ev in out:
        ev["away"] = bool(ev.get("away"))
    return out
