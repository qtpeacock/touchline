"""Touchline server: a JSON API for accounts and coach data, plus the static web app."""
import json
import re
import time
from contextlib import asynccontextmanager
from datetime import date, timedelta
from typing import Annotated, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, StringConstraints, field_validator

from . import assistant, db, family, planner
from .ai import MODEL_NAME, ai_ready
from .security import DUMMY_HASH, LoginThrottle, hash_password, hash_token, new_session_token, verify_password
from .seed import DEMO_EMAILS, seed_demo

STATIC_DIR = db.ROOT / "static"
COOKIE = "touchline_session"
SESSION_DAYS = 30
ROLES = ("coach", "player", "parent")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DATE = r"^\d{4}-\d{2}-\d{2}$"
TIME = r"^(\d{2}:\d{2})?$"
COLOR = r"^#[0-9a-fA-F]{6}$"

Role = Literal["coach", "player", "parent"]
CategoryName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=30)]
FieldType = Literal["full", "half", "blank"]

throttle = LoginThrottle()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    conn = db.connect()
    try:
        seed_demo(conn)
        planner.mark_interrupted(conn)
        conn.commit()
    finally:
        conn.close()
    yield


app = FastAPI(title="Touchline", lifespan=lifespan)


_version = {"checked": 0.0, "value": ""}


def app_version() -> str:
    """Changes whenever a file of the web app changes (checked at most every 2 seconds)."""
    now = time.monotonic()
    if now - _version["checked"] > 2:
        latest = max((p.stat().st_mtime for p in STATIC_DIR.rglob("*") if p.is_file()), default=0)
        _version.update(checked=now, value=str(int(latest)))
    return _version["value"]


@app.middleware("http")
async def cache_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    if request.url.path.startswith("/api/"):
        # A tab opened before an update keeps running the old code; the browser reloads when this changes.
        response.headers["X-App-Version"] = app_version()
    return response


# ---------- request models ----------

def _clean_email(value: str) -> str:
    value = value.strip().lower()
    if not EMAIL_RE.match(value):
        raise ValueError("Enter a valid email address")
    return value


def _real_date(value: Optional[str]) -> Optional[str]:
    if value:
        try:
            date.fromisoformat(value)
        except ValueError:
            raise ValueError("Enter a real date") from None
    return value


class SignupIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    email: str = Field(max_length=254)
    password: str = Field(min_length=8, max_length=200)
    roles: list[Role] = Field(min_length=1, max_length=3)

    clean_email = field_validator("email")(_clean_email)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Enter your name")
        return v.strip()


class LoginIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=200)


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    phone: str = Field("", max_length=40)
    city: str = Field("", max_length=80)
    organization: str = Field("", max_length=120)
    bio: str = Field("", max_length=600)


class RoleIn(BaseModel):
    role: Role


class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    age_group: str = Field("", max_length=40)
    season: str = Field("", max_length=40)
    color: str = Field("#174c3d", pattern=COLOR)


class PlayerIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    number: str = Field("", max_length=4)
    position: str = Field("", max_length=30)
    notes: str = Field("", max_length=300)


class EventIn(BaseModel):
    kind: Literal["practice", "game"]
    team_id: Optional[int] = None
    practice_id: Optional[int] = None
    title: str = Field("", max_length=80)
    date: str = Field(pattern=DATE)
    start_time: str = Field("", pattern=TIME)
    end_time: str = Field("", pattern=TIME)
    location: str = Field("", max_length=120)
    opponent: str = Field("", max_length=80)
    notes: str = Field("", max_length=500)
    away: bool = False
    repeat_until: Optional[str] = Field(None, pattern=DATE)

    check_dates = field_validator("date", "repeat_until")(_real_date)


class Piece(BaseModel):
    id: str = Field(max_length=24)
    kind: Literal["player", "ball", "cone"]
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)
    color: str = Field("#f7f9f5", pattern=COLOR)
    label: str = Field("", max_length=16)


class Arrow(BaseModel):
    id: str = Field(max_length=24)
    kind: Literal["move", "pass", "dribble"]
    x1: float = Field(ge=0, le=100)
    y1: float = Field(ge=0, le=100)
    x2: float = Field(ge=0, le=100)
    y2: float = Field(ge=0, le=100)
    # Optional control point: when present the arrow is a curve. It may sit a little off the board.
    cx: Optional[float] = Field(None, ge=-50, le=150)
    cy: Optional[float] = Field(None, ge=-50, le=150)


class Move(BaseModel):
    id: str = Field(max_length=24)
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)
    type: Literal["move", "pass"] = "move"
    cx: Optional[float] = Field(None, ge=-50, le=150)
    cy: Optional[float] = Field(None, ge=-50, le=150)


class Phase(BaseModel):
    id: str = Field(max_length=24)
    moves: list[Move] = Field(default_factory=list, max_length=80)


class Board(BaseModel):
    field: FieldType = "full"
    pieces: list[Piece] = Field(default_factory=list, max_length=80)
    arrows: list[Arrow] = Field(default_factory=list, max_length=80)
    phases: list[Phase] = Field(default_factory=list, max_length=20)
    mirrored: bool = False


def _unique_labels(labels: list[str]) -> list[str]:
    seen, out = set(), []
    for label in labels:
        if label.lower() not in seen:
            seen.add(label.lower())
            out.append(label)
    return out


class DrillIn(BaseModel):
    name: str = Field(min_length=1, max_length=70)
    categories: list[CategoryName] = Field(default_factory=list, max_length=12)
    minutes: int = Field(15, ge=1, le=180)
    notes: str = Field("", max_length=2000)
    board: Board = Field(default_factory=Board)

    unique_categories = field_validator("categories")(_unique_labels)


class PracticeItem(BaseModel):
    drill_id: Optional[int] = None
    name: str = Field(min_length=1, max_length=70)
    category: str = Field("", max_length=30)   # legacy single category, kept for older saved plans
    categories: list[CategoryName] = Field(default_factory=list, max_length=12)
    field: FieldType = "full"
    minutes: int = Field(ge=1, le=240)


class PracticeIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    team_id: Optional[int] = None
    focus: str = Field("", max_length=120)
    notes: str = Field("", max_length=1000)
    items: list[PracticeItem] = Field(default_factory=list, max_length=40)


# ---------- auth helpers ----------

def as_user(row) -> dict:
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "roles": json.loads(row["roles"]),
        "profile": json.loads(row["profile"]),
        "demo": row["email"] in DEMO_EMAILS,   # shows the demo tour on the account home
    }


def start_session(conn, response: Response, user_id: int) -> None:
    token = new_session_token()
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
        (hash_token(token), user_id, f"+{SESSION_DAYS} days"),
    )
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax")


def current_user(request: Request, conn=Depends(db.get_db)) -> dict:
    token = request.cookies.get(COOKIE)
    row = token and conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token_hash = ? AND s.expires_at > datetime('now')",
        (hash_token(token),),
    ).fetchone()
    if not row:
        raise HTTPException(401, "Please log in.")
    return as_user(row)


def coach(user: dict = Depends(current_user)) -> dict:
    if "coach" not in user["roles"]:
        raise HTTPException(403, "Add the Coach role to your account to use coach tools.")
    return user


def require_owned(conn, table: str, row_id: Optional[int], owner_id: int, label: str) -> None:
    if row_id is None:
        return
    if not conn.execute(f"SELECT 1 FROM {table} WHERE id = ? AND owner_id = ?", (row_id, owner_id)).fetchone():
        raise HTTPException(404, f"{label} not found.")


# ---------- accounts ----------

@app.post("/api/auth/signup", status_code=201)
def signup(body: SignupIn, response: Response, conn=Depends(db.get_db)):
    if conn.execute("SELECT 1 FROM users WHERE email = ?", (body.email,)).fetchone():
        raise HTTPException(409, "An account with that email already exists. Try logging in instead.")
    roles = [r for r in ROLES if r in body.roles]
    cur = conn.execute(
        "INSERT INTO users (email, password_hash, name, roles) VALUES (?, ?, ?, ?)",
        (body.email, hash_password(body.password), body.name, json.dumps(roles)),
    )
    db.add_default_categories(conn, cur.lastrowid)
    start_session(conn, response, cur.lastrowid)
    return as_user(conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.post("/api/auth/login")
def login(body: LoginIn, response: Response, conn=Depends(db.get_db)):
    email = body.email.strip().lower()
    if throttle.blocked(email):
        raise HTTPException(429, "Too many failed attempts. Wait a few minutes and try again.")
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    password_ok = verify_password(body.password, row["password_hash"] if row else DUMMY_HASH)
    if not row or not password_ok:
        throttle.fail(email)
        raise HTTPException(401, "That email and password don't match an account.")
    throttle.reset(email)
    conn.execute("DELETE FROM sessions WHERE expires_at <= datetime('now')")
    start_session(conn, response, row["id"])
    return as_user(row)


@app.post("/api/auth/logout", status_code=204)
def logout(request: Request, response: Response, conn=Depends(db.get_db)):
    token = request.cookies.get(COOKIE)
    if token:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))
    response.delete_cookie(COOKIE)


@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    return user


@app.get("/api/session")
def session_info(request: Request, conn=Depends(db.get_db)):
    """Who is signed in, or null; used on page load so a signed-out visit isn't an error."""
    try:
        return {"user": current_user(request, conn)}
    except HTTPException:
        return {"user": None}


@app.put("/api/me/profile")
def update_profile(body: ProfileIn, user: dict = Depends(current_user), conn=Depends(db.get_db)):
    profile = body.model_dump(exclude={"name"})
    conn.execute(
        "UPDATE users SET name = ?, profile = ? WHERE id = ?", (body.name.strip(), json.dumps(profile), user["id"])
    )
    return {**user, "name": body.name.strip(), "profile": profile}


@app.post("/api/me/roles")
def add_role(body: RoleIn, user: dict = Depends(current_user), conn=Depends(db.get_db)):
    roles = [r for r in ROLES if r in user["roles"] or r == body.role]
    conn.execute("UPDATE users SET roles = ? WHERE id = ?", (json.dumps(roles), user["id"]))
    return {**user, "roles": roles}


# ---------- teams + players ----------

@app.get("/api/teams")
def list_teams(user: dict = Depends(coach), conn=Depends(db.get_db)):
    return db.to_dicts(conn.execute(
        "SELECT t.*, (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) AS player_count "
        "FROM teams t WHERE t.owner_id = ? ORDER BY t.name COLLATE NOCASE, t.id",
        (user["id"],),
    ).fetchall())


@app.post("/api/teams", status_code=201)
def create_team(body: TeamIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    cur = conn.execute(
        "INSERT INTO teams (owner_id, name, age_group, season, color) VALUES (?, ?, ?, ?, ?)",
        (user["id"], body.name.strip(), body.age_group.strip(), body.season.strip(), body.color),
    )
    return get_team(cur.lastrowid, user, conn)


@app.get("/api/teams/{team_id}")
def get_team(team_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    team = db.to_dict(conn.execute(
        "SELECT * FROM teams WHERE id = ? AND owner_id = ?", (team_id, user["id"])
    ).fetchone())
    if not team:
        raise HTTPException(404, "Team not found.")
    team["players"] = db.to_dicts(conn.execute(
        "SELECT * FROM players WHERE team_id = ? ORDER BY sort, id", (team_id,)
    ).fetchall())
    for player in team["players"]:
        player["accounts"] = player_accounts(conn, player["id"])
    team["player_count"] = len(team["players"])
    return team


def player_accounts(conn, player_id: int) -> dict:
    """The accounts connected to a roster player, and the invitations still waiting for an answer."""
    return {
        "linked": db.to_dicts(conn.execute(
            "SELECT u.id AS user_id, u.name, u.email, l.relation FROM player_links l JOIN users u ON u.id = l.user_id "
            "WHERE l.player_id = ? ORDER BY l.relation DESC, u.name", (player_id,),
        ).fetchall()),
        "invited": db.to_dicts(conn.execute(
            "SELECT id, email, relation, created_at FROM invites WHERE player_id = ? ORDER BY created_at", (player_id,),
        ).fetchall()),
    }


@app.put("/api/teams/{team_id}")
def update_team(team_id: int, body: TeamIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "teams", team_id, user["id"], "Team")
    conn.execute(
        "UPDATE teams SET name = ?, age_group = ?, season = ?, color = ? WHERE id = ?",
        (body.name.strip(), body.age_group.strip(), body.season.strip(), body.color, team_id),
    )
    return get_team(team_id, user, conn)


@app.delete("/api/teams/{team_id}", status_code=204)
def delete_team(team_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "teams", team_id, user["id"], "Team")
    conn.execute("DELETE FROM teams WHERE id = ?", (team_id,))


def _owned_player(conn, player_id: int, owner_id: int):
    row = conn.execute(
        "SELECT p.* FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = ? AND t.owner_id = ?",
        (player_id, owner_id),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Player not found.")
    return row


@app.post("/api/teams/{team_id}/players", status_code=201)
def add_player(team_id: int, body: PlayerIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "teams", team_id, user["id"], "Team")
    sort = conn.execute("SELECT COALESCE(MAX(sort), 0) + 1 FROM players WHERE team_id = ?", (team_id,)).fetchone()[0]
    cur = conn.execute(
        "INSERT INTO players (team_id, name, number, position, notes, sort) VALUES (?, ?, ?, ?, ?, ?)",
        (team_id, body.name.strip(), body.number.strip(), body.position.strip(), body.notes.strip(), sort),
    )
    return db.to_dict(conn.execute("SELECT * FROM players WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.put("/api/players/{player_id}")
def update_player(player_id: int, body: PlayerIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    _owned_player(conn, player_id, user["id"])
    conn.execute(
        "UPDATE players SET name = ?, number = ?, position = ?, notes = ? WHERE id = ?",
        (body.name.strip(), body.number.strip(), body.position.strip(), body.notes.strip(), player_id),
    )
    return db.to_dict(conn.execute("SELECT * FROM players WHERE id = ?", (player_id,)).fetchone())


@app.delete("/api/players/{player_id}", status_code=204)
def delete_player(player_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    _owned_player(conn, player_id, user["id"])
    conn.execute("DELETE FROM players WHERE id = ?", (player_id,))


# ---------- connecting accounts to roster players ----------
# The coach invites an email as a player's own account or as a parent. Nothing is shared until the person
# accepts on their account home; then the invitation becomes a player_link and the role is added.

MAX_PARENTS = 4


class InviteIn(BaseModel):
    email: str = Field(max_length=254)
    relation: Literal["player", "parent"]

    clean_email = field_validator("email")(_clean_email)


@app.get("/api/players/{player_id}/accounts")
def get_player_accounts(player_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    _owned_player(conn, player_id, user["id"])
    return player_accounts(conn, player_id)


@app.post("/api/players/{player_id}/invites", status_code=201)
def invite_account(player_id: int, body: InviteIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    player = _owned_player(conn, player_id, user["id"])
    current = player_accounts(conn, player_id)
    if any(a["email"].lower() == body.email and a["relation"] == body.relation for a in current["linked"]):
        raise HTTPException(409, f"{body.email} is already connected to {player['name']} as {'the player' if body.relation == 'player' else 'a parent'}.")
    if any(i["email"].lower() == body.email and i["relation"] == body.relation for i in current["invited"]):
        raise HTTPException(409, f"{body.email} has already been invited. It's waiting for them to accept.")
    same = [a for a in current["linked"] + current["invited"] if a["relation"] == body.relation]
    if body.relation == "player" and same:
        raise HTTPException(409, f"{player['name']} already has a player account (or one invited). Remove it first to invite a different one.")
    if body.relation == "parent" and len(same) >= MAX_PARENTS:
        raise HTTPException(409, f"{player['name']} already has {MAX_PARENTS} parents connected or invited.")
    conn.execute("INSERT INTO invites (player_id, email, relation, invited_by) VALUES (?, ?, ?, ?)",
                 (player_id, body.email, body.relation, user["id"]))
    return player_accounts(conn, player_id)


@app.delete("/api/invites/{invite_id}", status_code=204)
def cancel_invite(invite_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    row = conn.execute("SELECT player_id FROM invites WHERE id = ?", (invite_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Invitation not found.")
    _owned_player(conn, row["player_id"], user["id"])
    conn.execute("DELETE FROM invites WHERE id = ?", (invite_id,))


@app.delete("/api/players/{player_id}/accounts/{account_id}", status_code=204)
def disconnect_account(player_id: int, account_id: int, relation: Literal["player", "parent"],
                       user: dict = Depends(coach), conn=Depends(db.get_db)):
    """Disconnect an account from a roster player. Their account and role stay; they just stop seeing this player."""
    _owned_player(conn, player_id, user["id"])
    conn.execute("DELETE FROM player_links WHERE player_id = ? AND user_id = ? AND relation = ?", (player_id, account_id, relation))


def my_invites(conn, user: dict) -> list[dict]:
    return db.to_dicts(conn.execute(
        "SELECT i.id, i.relation, i.created_at, p.name AS player_name, p.number, t.name AS team_name, u.name AS coach_name "
        "FROM invites i JOIN players p ON p.id = i.player_id JOIN teams t ON t.id = p.team_id JOIN users u ON u.id = i.invited_by "
        "WHERE i.email = ? ORDER BY i.created_at",
        (user["email"],),
    ).fetchall())


@app.get("/api/me/invites")
def list_my_invites(user: dict = Depends(current_user), conn=Depends(db.get_db)):
    return my_invites(conn, user)


def _my_invite(conn, invite_id: int, user: dict):
    row = conn.execute("SELECT * FROM invites WHERE id = ? AND email = ?", (invite_id, user["email"])).fetchone()
    if not row:
        raise HTTPException(404, "Invitation not found.")
    return row


@app.post("/api/me/invites/{invite_id}/accept")
def accept_invite(invite_id: int, user: dict = Depends(current_user), conn=Depends(db.get_db)):
    invite = _my_invite(conn, invite_id, user)
    conn.execute("INSERT OR IGNORE INTO player_links (user_id, player_id, relation) VALUES (?, ?, ?)",
                 (user["id"], invite["player_id"], invite["relation"]))
    conn.execute("DELETE FROM invites WHERE id = ?", (invite_id,))
    roles = [r for r in ROLES if r in user["roles"] or r == invite["relation"]]
    conn.execute("UPDATE users SET roles = ? WHERE id = ?", (json.dumps(roles), user["id"]))
    return {**user, "roles": roles}


@app.post("/api/me/invites/{invite_id}/decline", status_code=204)
def decline_invite(invite_id: int, user: dict = Depends(current_user), conn=Depends(db.get_db)):
    _my_invite(conn, invite_id, user)
    conn.execute("DELETE FROM invites WHERE id = ?", (invite_id,))


# ---------- calendar events ----------

EVENT_SELECT = db.EVENT_SELECT
EVENT_COLUMNS = ("team_id", "practice_id", "kind", "title", "date", "start_time", "end_time", "location", "opponent", "notes", "away")


def _check_event_refs(conn, body: EventIn, owner_id: int) -> None:
    require_owned(conn, "teams", body.team_id, owner_id, "Team")
    require_owned(conn, "practices", body.practice_id, owner_id, "Practice plan")
    if body.end_time and body.start_time and body.end_time < body.start_time:
        raise HTTPException(422, "End time must be after the start time.")


def _event_values(body: EventIn, on_date: str) -> tuple:
    data = body.model_dump()
    data["date"] = on_date
    if body.kind == "game":
        data["practice_id"] = None
    else:
        data["away"] = False
    return tuple(data[c].strip() if isinstance(data[c], str) else data[c] for c in EVENT_COLUMNS)


@app.get("/api/events")
def list_events(
    start: Optional[str] = Query(None, pattern=DATE),
    end: Optional[str] = Query(None, pattern=DATE),
    kind: Optional[Literal["practice", "game"]] = None,
    team_id: Optional[int] = None,
    limit: int = Query(500, ge=1, le=1000),
    user: dict = Depends(coach),
    conn=Depends(db.get_db),
):
    sql, args = EVENT_SELECT + " WHERE e.owner_id = ?", [user["id"]]
    for clause, value in (("e.date >= ?", start), ("e.date <= ?", end), ("e.kind = ?", kind), ("e.team_id = ?", team_id)):
        if value is not None:
            sql += f" AND {clause}"
            args.append(value)
    sql += " ORDER BY e.date, e.start_time, e.id LIMIT ?"
    return db.to_dicts(conn.execute(sql, (*args, limit)).fetchall())


@app.post("/api/events", status_code=201)
def create_event(body: EventIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    _check_event_refs(conn, body, user["id"])
    dates = [body.date]
    if body.repeat_until and body.repeat_until > body.date:
        day, last = date.fromisoformat(body.date), date.fromisoformat(body.repeat_until)
        while len(dates) < 52 and (day := day + timedelta(days=7)) <= last:
            dates.append(day.isoformat())
    placeholders = ", ".join("?" * (len(EVENT_COLUMNS) + 1))
    ids = [
        conn.execute(
            f"INSERT INTO events (owner_id, {', '.join(EVENT_COLUMNS)}) VALUES ({placeholders})",
            (user["id"], *_event_values(body, d)),
        ).lastrowid
        for d in dates
    ]
    return {"created": len(ids), "ids": ids}


@app.put("/api/events/{event_id}")
def update_event(event_id: int, body: EventIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "events", event_id, user["id"], "Event")
    _check_event_refs(conn, body, user["id"])
    assignments = ", ".join(f"{c} = ?" for c in EVENT_COLUMNS)
    conn.execute(f"UPDATE events SET {assignments} WHERE id = ?", (*_event_values(body, body.date), event_id))
    return db.to_dict(conn.execute(EVENT_SELECT + " WHERE e.id = ?", (event_id,)).fetchone())


class AttachPracticeIn(BaseModel):
    practice_id: Optional[int] = None


@app.put("/api/events/{event_id}/practice")
def attach_practice(event_id: int, body: AttachPracticeIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    """Link a saved practice plan to one scheduled practice (or unlink it with null)."""
    require_owned(conn, "events", event_id, user["id"], "Event")
    require_owned(conn, "practices", body.practice_id, user["id"], "Practice plan")
    conn.execute("UPDATE events SET practice_id = ? WHERE id = ? AND kind = 'practice'", (body.practice_id, event_id))
    return db.to_dict(conn.execute(EVENT_SELECT + " WHERE e.id = ?", (event_id,)).fetchone())


@app.delete("/api/events/{event_id}", status_code=204)
def delete_event(event_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "events", event_id, user["id"], "Event")
    conn.execute("DELETE FROM events WHERE id = ?", (event_id,))


# ---------- attendance (RSVPs) ----------

class AttendanceIn(BaseModel):
    status: Optional[Literal["yes", "maybe", "no"]] = None   # null clears the reply


def _owned_event(conn, event_id: int, owner_id: int) -> dict:
    event = db.to_dict(conn.execute(EVENT_SELECT + " WHERE e.id = ? AND e.owner_id = ?", (event_id, owner_id)).fetchone())
    if not event:
        raise HTTPException(404, "Event not found.")
    return event


@app.get("/api/events/{event_id}/attendance")
def event_attendance(event_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    event = _owned_event(conn, event_id, user["id"])
    return db.attendance_for(conn, event["id"], event["team_id"])


@app.put("/api/events/{event_id}/attendance/{player_id}")
def set_attendance(event_id: int, player_id: int, body: AttendanceIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    event = _owned_event(conn, event_id, user["id"])
    if _owned_player(conn, player_id, user["id"])["team_id"] != event["team_id"]:
        raise HTTPException(422, "That player isn't on this event's team.")
    db.set_reply(conn, event_id, player_id, body.status, "coach")
    return db.attendance_for(conn, event["id"], event["team_id"])


@app.get("/api/teams/{team_id}/attendance")
def team_attendance(team_id: int, limit: int = Query(4, ge=1, le=14), user: dict = Depends(coach), conn=Depends(db.get_db)):
    """The team's next practices and games and every player's reply to each (with who answered and when),
    plus families' travel plans for away games. Feeds the roster grid."""
    require_owned(conn, "teams", team_id, user["id"], "Team")
    events = db.to_dicts(conn.execute(
        EVENT_SELECT + " WHERE e.team_id = ? AND e.date >= ? ORDER BY e.date, e.start_time, e.id LIMIT ?",
        (team_id, date.today().isoformat(), limit),
    ).fetchall())
    replies: dict[int, dict[int, str]] = {ev["id"]: {} for ev in events}
    answered: dict[int, dict[int, dict]] = {ev["id"]: {} for ev in events}
    travel: dict[int, dict[int, dict]] = {ev["id"]: {} for ev in events}
    if events:
        marks = ", ".join("?" * len(events))
        for row in conn.execute(f"SELECT * FROM attendance WHERE event_id IN ({marks})", list(replies)):
            replies[row["event_id"]][row["player_id"]] = row["status"]
            answered[row["event_id"]][row["player_id"]] = {"by": row["source"], "at": row["updated_at"]}
        for row in conn.execute(f"SELECT * FROM travel_plans WHERE event_id IN ({marks})", list(replies)):
            travel[row["event_id"]][row["player_id"]] = {"plan": row["plan"], "seats": row["seats"], "note": row["note"], "at": row["updated_at"]}
    return {"events": events, "replies": replies, "answered": answered, "travel": travel}


# ---------- drills shared with players ----------

class ShareIn(BaseModel):
    drill_id: int
    player_ids: list[int] = Field(default_factory=list, max_length=60)   # empty = the whole team
    note: str = Field("", max_length=300)


class ParentsSeeDrillsIn(BaseModel):
    parents_see_drills: bool


shares_for = family.shares_for


@app.get("/api/teams/{team_id}/shared-drills")
def list_shares(team_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "teams", team_id, user["id"], "Team")
    team = conn.execute("SELECT parents_see_drills FROM teams WHERE id = ?", (team_id,)).fetchone()
    return {"parents_see_drills": bool(team["parents_see_drills"]), "shares": shares_for(conn, team_id)}


@app.post("/api/teams/{team_id}/shared-drills", status_code=201)
def share_drill(team_id: int, body: ShareIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "teams", team_id, user["id"], "Team")
    require_owned(conn, "drills", body.drill_id, user["id"], "Drill")
    players = set(body.player_ids)
    roster = {r["id"] for r in conn.execute("SELECT id FROM players WHERE team_id = ?", (team_id,))}
    if not players <= roster:
        raise HTTPException(422, "Every player you share with must be on this team.")
    share_id = conn.execute("INSERT INTO shared_drills (owner_id, team_id, drill_id, note) VALUES (?, ?, ?, ?)",
                            (user["id"], team_id, body.drill_id, body.note.strip())).lastrowid
    conn.executemany("INSERT INTO shared_drill_players (share_id, player_id) VALUES (?, ?)", [(share_id, p) for p in players])
    return next(s for s in shares_for(conn, team_id) if s["id"] == share_id)


@app.delete("/api/shared-drills/{share_id}", status_code=204)
def unshare_drill(share_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "shared_drills", share_id, user["id"], "Shared drill")
    conn.execute("DELETE FROM shared_drills WHERE id = ?", (share_id,))


@app.put("/api/teams/{team_id}/parents-see-drills")
def set_parents_see_drills(team_id: int, body: ParentsSeeDrillsIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "teams", team_id, user["id"], "Team")
    conn.execute("UPDATE teams SET parents_see_drills = ? WHERE id = ?", (int(body.parents_see_drills), team_id))
    return {"parents_see_drills": body.parents_see_drills}


# ---------- players and parents ----------
# An account sees a player's team through player_links: as that player, or as their parent. Each only
# ever sees and answers for the players it's linked to.

Relation = Literal["player", "parent"]


class FamilyReplyIn(BaseModel):
    player_id: int
    status: Optional[Literal["yes", "maybe", "no"]] = None   # null clears the reply


class TravelIn(BaseModel):
    player_id: int
    plan: Optional[Literal["driving", "need_ride", "carpool", "other"]] = None   # null clears the plan
    seats: int = Field(0, ge=0, le=8)
    note: str = Field("", max_length=200)


def _require_role(user: dict, role: str) -> None:
    if role not in user["roles"]:
        raise HTTPException(403, f"Add the {role.title()} role to your account first.")


def _family_event(conn, event_id: int, player: dict):
    event = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    if not event or event["team_id"] != player["team_id"]:
        raise HTTPException(404, "Event not found.")
    if event["date"] < date.today().isoformat():
        raise HTTPException(422, "That one has already happened.")
    return event


@app.get("/api/family/{relation}")
def family_page(relation: Relation, user: dict = Depends(current_user), conn=Depends(db.get_db)):
    _require_role(user, relation)
    return {"relation": relation, "kids": family.family_view(conn, user["id"], relation)}


@app.put("/api/family/{relation}/events/{event_id}/reply")
def family_reply(relation: Relation, event_id: int, body: FamilyReplyIn, user: dict = Depends(current_user), conn=Depends(db.get_db)):
    """A player answers for themself, or a parent for their child. The coach sees who answered."""
    _require_role(user, relation)
    player = family.linked_player(conn, user["id"], relation, body.player_id)
    _family_event(conn, event_id, player)
    db.set_reply(conn, event_id, player["id"], body.status, relation)
    return {"event_id": event_id, "player_id": player["id"], "status": body.status, "by": relation}


@app.put("/api/family/parent/events/{event_id}/travel")
def set_travel(event_id: int, body: TravelIn, user: dict = Depends(current_user), conn=Depends(db.get_db)):
    _require_role(user, "parent")
    player = family.linked_player(conn, user["id"], "parent", body.player_id)
    event = _family_event(conn, event_id, player)
    if event["kind"] != "game" or not event["away"]:
        raise HTTPException(422, "Travel plans are for away games.")
    if body.plan is None:
        conn.execute("DELETE FROM travel_plans WHERE event_id = ? AND player_id = ?", (event_id, player["id"]))
    else:
        conn.execute(
            "INSERT INTO travel_plans (event_id, player_id, plan, seats, note) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (event_id, player_id) DO UPDATE SET plan = excluded.plan, seats = excluded.seats, "
            "note = excluded.note, updated_at = datetime('now')",
            (event_id, player["id"], body.plan, body.seats if body.plan == "driving" else 0, body.note.strip()),
        )
    return {"event_id": event_id, "player_id": player["id"], "plan": body.plan, "seats": body.seats, "note": body.note.strip()}


@app.get("/api/me/schedule")
def my_schedule(start: str = Query(pattern=DATE), end: str = Query(pattern=DATE),
                user: dict = Depends(current_user), conn=Depends(db.get_db)):
    """Every event the account sees through any of its roles, for the account home calendar."""
    return {"events": family.schedule_for(conn, user, start, end),
            "links": {r: family.links_for(conn, user["id"], r) for r in family.RELATIONS if r in user["roles"]}}


# ---------- AI chat on the account home ----------

class ChatMessageIn(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=2000)


class ChatIn(BaseModel):
    messages: list[ChatMessageIn] = Field(min_length=1, max_length=20)


@app.post("/api/chat")
async def chat(body: ChatIn, user: dict = Depends(current_user), conn=Depends(db.get_db)):
    if not ai_ready():
        raise HTTPException(503, "The AI chat isn't set up: add PORTKEY_API_KEY to a .env file (see the README).")
    question = body.messages[-1]
    if question.role != "user" or not question.text.strip():
        raise HTTPException(422, "Ask a question first.")
    if len(question.text) > planner.MAX_REQUEST_CHARS:
        raise HTTPException(422, f"Keep questions under {planner.MAX_REQUEST_CHARS} characters.")
    if problem := assistant.budget_problem(conn, user["id"]):
        raise HTTPException(*problem)
    reply = await assistant.answer(conn, user, [m.model_dump() for m in body.messages])
    return {**reply, "allowance": planner.allowance(conn, user["id"])}


# ---------- drills + drill categories ----------

def _category_names(conn, owner_id: int) -> list[str]:
    return [r["name"] for r in conn.execute(
        "SELECT name FROM drill_categories WHERE owner_id = ? ORDER BY sort, id", (owner_id,)
    ).fetchall()]


def _labels_for(conn, owner_id: int, labels: list[str]) -> list[str]:
    """Match labels to the coach's categories (ignoring case); new ones are added to their list."""
    known = {name.lower(): name for name in _category_names(conn, owner_id)}
    out = []
    for label in labels:
        if label.lower() not in known:
            db.add_category(conn, owner_id, label)
            known[label.lower()] = label
        out.append(known[label.lower()])
    return out


def _drill_values(conn, body: DrillIn, owner_id: int) -> tuple:
    return (
        body.name.strip(), json.dumps(_labels_for(conn, owner_id, body.categories)), body.minutes, body.notes,
        json.dumps(body.board.model_dump(exclude_none=True)),
    )


@app.get("/api/drills")
def list_drills(user: dict = Depends(coach), conn=Depends(db.get_db)):
    return db.to_dicts(conn.execute(
        "SELECT * FROM drills WHERE owner_id = ? ORDER BY updated_at DESC, id DESC", (user["id"],)
    ).fetchall(), "board", "categories")


@app.get("/api/drills/{drill_id}")
def get_drill(drill_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    drill = db.to_dict(conn.execute(
        "SELECT * FROM drills WHERE id = ? AND owner_id = ?", (drill_id, user["id"])
    ).fetchone(), "board", "categories")
    if not drill:
        raise HTTPException(404, "Drill not found.")
    return drill


@app.post("/api/drills", status_code=201)
def create_drill(body: DrillIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    cur = conn.execute(
        "INSERT INTO drills (owner_id, name, categories, minutes, notes, board) VALUES (?, ?, ?, ?, ?, ?)",
        (user["id"], *_drill_values(conn, body, user["id"])),
    )
    return get_drill(cur.lastrowid, user, conn)


@app.put("/api/drills/{drill_id}")
def update_drill(drill_id: int, body: DrillIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "drills", drill_id, user["id"], "Drill")
    conn.execute(
        "UPDATE drills SET name = ?, categories = ?, minutes = ?, notes = ?, board = ?, updated_at = datetime('now') "
        "WHERE id = ?",
        (*_drill_values(conn, body, user["id"]), drill_id),
    )
    return get_drill(drill_id, user, conn)


@app.delete("/api/drills/{drill_id}", status_code=204)
def delete_drill(drill_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "drills", drill_id, user["id"], "Drill")
    conn.execute("DELETE FROM drills WHERE id = ?", (drill_id,))


class CategoryIn(BaseModel):
    name: CategoryName


def _relabel_drills(conn, owner_id: int, old: str, new: Optional[str]) -> None:
    """Rename (or, with new=None, remove) a category on every drill that uses it."""
    for row in conn.execute("SELECT id, categories FROM drills WHERE owner_id = ?", (owner_id,)).fetchall():
        labels = json.loads(row["categories"])
        if any(label.lower() == old.lower() for label in labels):
            updated = [new if label.lower() == old.lower() else label for label in labels]
            conn.execute("UPDATE drills SET categories = ? WHERE id = ?", (json.dumps(_unique_labels([l for l in updated if l])), row["id"]))


def _owned_category(conn, category_id: int, owner_id: int):
    row = conn.execute("SELECT * FROM drill_categories WHERE id = ? AND owner_id = ?", (category_id, owner_id)).fetchone()
    if not row:
        raise HTTPException(404, "Category not found.")
    return row


def _check_name_free(conn, owner_id: int, name: str, except_id: Optional[int] = None) -> None:
    clash = conn.execute(
        "SELECT id FROM drill_categories WHERE owner_id = ? AND name = ? AND id IS NOT ?", (owner_id, name, except_id)
    ).fetchone()
    if clash:
        raise HTTPException(409, f'You already have a category called "{name}".')


@app.get("/api/categories")
def list_categories(user: dict = Depends(coach), conn=Depends(db.get_db)):
    return db.to_dicts(conn.execute(
        "SELECT id, name FROM drill_categories WHERE owner_id = ? ORDER BY sort, id", (user["id"],)
    ).fetchall())


@app.post("/api/categories", status_code=201)
def create_category(body: CategoryIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    _check_name_free(conn, user["id"], body.name)
    db.add_category(conn, user["id"], body.name)
    return db.to_dict(conn.execute(
        "SELECT id, name FROM drill_categories WHERE owner_id = ? AND name = ?", (user["id"], body.name)
    ).fetchone())


@app.put("/api/categories/{category_id}")
def rename_category(category_id: int, body: CategoryIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    row = _owned_category(conn, category_id, user["id"])
    _check_name_free(conn, user["id"], body.name, except_id=category_id)
    conn.execute("UPDATE drill_categories SET name = ? WHERE id = ?", (body.name, category_id))
    _relabel_drills(conn, user["id"], row["name"], body.name)
    return {"id": category_id, "name": body.name}


@app.delete("/api/categories/{category_id}", status_code=204)
def delete_category(category_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    row = _owned_category(conn, category_id, user["id"])
    conn.execute("DELETE FROM drill_categories WHERE id = ?", (category_id,))
    _relabel_drills(conn, user["id"], row["name"], None)


# ---------- practice plans ----------

PRACTICE_SELECT = "SELECT p.*, t.name AS team_name FROM practices p LEFT JOIN teams t ON t.id = p.team_id"


@app.get("/api/practices")
def list_practices(user: dict = Depends(coach), conn=Depends(db.get_db)):
    return db.to_dicts(conn.execute(
        PRACTICE_SELECT + " WHERE p.owner_id = ? ORDER BY p.updated_at DESC, p.id DESC", (user["id"],)
    ).fetchall(), "items")


@app.get("/api/practices/{practice_id}")
def get_practice(practice_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    practice = db.to_dict(conn.execute(
        PRACTICE_SELECT + " WHERE p.id = ? AND p.owner_id = ?", (practice_id, user["id"])
    ).fetchone(), "items")
    if not practice:
        raise HTTPException(404, "Practice plan not found.")
    return practice


def _practice_values(body: PracticeIn) -> tuple:
    items = json.dumps([item.model_dump() for item in body.items])
    return body.name.strip(), body.team_id, body.focus.strip(), body.notes, items


@app.post("/api/practices", status_code=201)
def create_practice(body: PracticeIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "teams", body.team_id, user["id"], "Team")
    cur = conn.execute(
        "INSERT INTO practices (owner_id, name, team_id, focus, notes, items) VALUES (?, ?, ?, ?, ?, ?)",
        (user["id"], *_practice_values(body)),
    )
    return get_practice(cur.lastrowid, user, conn)


@app.put("/api/practices/{practice_id}")
def update_practice(practice_id: int, body: PracticeIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "practices", practice_id, user["id"], "Practice plan")
    require_owned(conn, "teams", body.team_id, user["id"], "Team")
    conn.execute(
        "UPDATE practices SET name = ?, team_id = ?, focus = ?, notes = ?, items = ?, updated_at = datetime('now') "
        "WHERE id = ?",
        (*_practice_values(body), practice_id),
    )
    return get_practice(practice_id, user, conn)


@app.delete("/api/practices/{practice_id}", status_code=204)
def delete_practice(practice_id: int, user: dict = Depends(coach), conn=Depends(db.get_db)):
    require_owned(conn, "practices", practice_id, user["id"], "Practice plan")
    conn.execute("DELETE FROM practices WHERE id = ?", (practice_id,))


# ---------- AI practice builder ----------
# The agents only read and propose (server/planner.py). Saving a proposal is this file's job, and
# only happens when the coach clicks Save.

class AskIn(BaseModel):
    request: str = Field(min_length=3, max_length=planner.MAX_REQUEST_CHARS)

    @field_validator("request")
    @classmethod
    def _request(cls, v: str) -> str:
        if len(v.strip()) < 3:
            raise ValueError("Tell the AI what you need")
        return v.strip()


class PlanRequestIn(AskIn):
    event_id: int


class DrillRequestIn(AskIn):
    players: int = Field(ge=1, le=22)
    minutes: int = Field(15, ge=5, le=45)
    board: Optional[FieldType] = None          # None lets the designer choose
    event_id: Optional[int] = None             # size the drill for this practice's yes replies


class SavePlanIn(BaseModel):
    name: Optional[str] = Field(None, max_length=80)
    attach: bool = True
    # Animation steps for the new drills, worked out in the browser from each drill's arrows
    # (the whiteboard's "Suggest animation"), keyed by new_drill_number.
    animations: dict[str, list[Phase]] = Field(default_factory=dict)


@app.get("/api/planner/status")
async def planner_status(user: dict = Depends(current_user), conn=Depends(db.get_db)):
    running = planner.active_run(user["id"])
    return {
        "ready": ai_ready(), "model": MODEL_NAME, "allowance": planner.allowance(conn, user["id"]),
        "running_run_id": running, "running_kind": planner.RUNS[running].kind if running else None,
    }


@app.get("/api/planner/runs")
async def planner_runs(kind: Literal["practice", "drill"] = "practice", limit: int = Query(8, ge=1, le=30),
                       user: dict = Depends(coach), conn=Depends(db.get_db)):
    return planner.recent_runs(conn, user["id"], kind, limit)


@app.post("/api/planner/runs", status_code=202)
async def start_planner_run(body: PlanRequestIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    if not ai_ready():
        raise HTTPException(503, "The AI builder isn't set up: add PORTKEY_API_KEY to a .env file (see the README).")
    event = _owned_event(conn, body.event_id, user["id"])
    if event["kind"] != "practice":
        raise HTTPException(422, "Pick a practice, not a game.")
    if not event["team_id"]:
        raise HTTPException(422, "This practice has no team. Give it a team on the calendar first.")
    if event["date"] < date.today().isoformat():
        raise HTTPException(422, "That practice is in the past. Pick an upcoming one.")
    if problem := planner.budget_problem(conn, user["id"]):
        raise HTTPException(*problem)
    run = planner.start_run(conn, user["id"], body.request, lambda r: planner.build_practice(r, event, body.request),
                            kind="practice", event_id=event["id"])
    return {"run_id": run.id}


@app.post("/api/planner/drill-runs", status_code=202)
async def start_drill_run(body: DrillRequestIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    if not ai_ready():
        raise HTTPException(503, "The AI builder isn't set up: add PORTKEY_API_KEY to a .env file (see the README).")
    event = None
    if body.event_id is not None:
        event = _owned_event(conn, body.event_id, user["id"])
        if not event["team_id"]:
            raise HTTPException(422, "That event has no team, so there's no one to count. Pick another or leave it blank.")
    if problem := planner.budget_problem(conn, user["id"]):
        raise HTTPException(*problem)
    job = lambda r: planner.build_drill(r, body.request, body.players, body.minutes, body.board, event)  # noqa: E731
    run = planner.start_run(conn, user["id"], body.request, job, kind="drill", event_id=event["id"] if event else None)
    return {"run_id": run.id}


@app.get("/api/planner/runs/{run_id}")
async def get_planner_run(run_id: str, user: dict = Depends(coach), conn=Depends(db.get_db)):
    run = planner.get_run(conn, user["id"], run_id)
    if not run:
        raise HTTPException(404, "AI build not found.")
    # The daily allowance left, including what this build has used so far, so the page can show it live.
    return {**run, "allowance": planner.allowance(conn, user["id"])}


def _new_drill_notes(drill: dict) -> str:
    points = "\n".join(f"• {p}" for p in drill["coaching_points"])
    parts = [drill["about"], f"Setup: {drill['setup']}", f"Coaching points:\n{points}"]
    if drill["progression"]:
        parts.append(f"Progression: {drill['progression']}")
    parts.append(f"Designed by the Touchline AI practice builder for {drill['players_needed']} players.")
    return "\n\n".join(parts)[:2000]


@app.post("/api/planner/runs/{run_id}/save", status_code=201)
def save_planner_run(run_id: str, body: SavePlanIn, user: dict = Depends(coach), conn=Depends(db.get_db)):
    """The coach approved a proposal. For a practice: add its new drills to their library, save the plan and
    (optionally) attach it to the practice on the calendar. For a drill: add it to the library.
    Uses the stored proposal, not one sent by the browser."""
    run = planner.get_run(conn, user["id"], run_id)
    if not run:
        raise HTTPException(404, "AI build not found.")
    if run["status"] != "done" or not run["result"]:
        raise HTTPException(409, "This build hasn't finished, so there's nothing to save yet.")
    if run["saved_practice_id"] or run["saved_drill_id"]:
        raise HTTPException(409, "This is already saved.")
    plan = run["result"]
    known = {name.lower(): name for name in _category_names(conn, user["id"])}
    if plan.get("type") == "drill":   # the drill builder: one new drill for the library
        item = plan["drill"]
        board = Board.model_validate({**item["board"], "phases": body.animations.get("1", [])})
        drill = create_drill(DrillIn(
            name=((body.name or "").strip() or item["name"])[:70], categories=[known[c.lower()] for c in item["categories"] if c.lower() in known],
            minutes=item["minutes"], notes=_new_drill_notes(item), board=board,
        ), user, conn)
        conn.execute("UPDATE agent_runs SET saved_drill_id = ? WHERE id = ?", (drill["id"], run_id))
        return {"drill_id": drill["id"]}
    items, drill_ids = [], []
    for item in plan["items"]:
        labels = [known[c.lower()] for c in item["categories"] if c.lower() in known]
        if item["source"] == "new":
            board = Board.model_validate({**item["board"], "phases": body.animations.get(str(item["new_drill_number"]), [])})
            drill = create_drill(DrillIn(
                name=item["name"][:70], categories=labels, minutes=item["minutes"], notes=_new_drill_notes(item), board=board,
            ), user, conn)
            drill_id = drill["id"]
            drill_ids.append(drill_id)
        else:
            drill_id = item["drill_id"]
            current = conn.execute("SELECT 1 FROM drills WHERE id = ? AND owner_id = ?", (drill_id, user["id"])).fetchone()
            drill_id = drill_id if current else None   # deleted since the plan was made: keep the item, drop the link
        items.append(PracticeItem(drill_id=drill_id, name=item["name"][:70], categories=labels, field=item["board"].get("field", "full"),
                                  minutes=item["minutes"]))
    notes = plan["coach_notes"] + (f"\n\nIf the maybes come: {plan['if_maybes_come']}" if plan.get("if_maybes_come") else "")
    practice = create_practice(PracticeIn(
        name=(body.name or plan["title"]).strip()[:80] or "AI practice", team_id=plan["event"]["team_id"],
        focus=plan["focus"][:120], notes=notes[:1000], items=items,
    ), user, conn)
    attached = False
    if body.attach and run["event_id"]:
        attached = conn.execute(
            "UPDATE events SET practice_id = ? WHERE id = ? AND owner_id = ? AND kind = 'practice'",
            (practice["id"], run["event_id"], user["id"]),
        ).rowcount > 0
    conn.execute("UPDATE agent_runs SET saved_practice_id = ? WHERE id = ?", (practice["id"], run_id))
    return {"practice_id": practice["id"], "drill_ids": drill_ids, "attached": attached}


# The web app itself; mounted last so the /api routes above take priority.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="web")
