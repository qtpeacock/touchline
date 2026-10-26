"""The AI builders: a whole practice (Practices tab) or a single drill (Drills tab).

Practice builder: a Head Coach agent plans one practice with three worker agents.

    coach's request
         │
    Head Coach (lead) ── get_practice_details
         ├── ask_attendance_scout ──► Attendance Scout ── get_rsvps
         ├── search_drill_library
         └── ask_drill_designer ────► Drill Designer (draws a whiteboard diagram)
         │
    draft plan ──► plan checks (code) ──► Plan Reviewer ──► at most one revision
         │
    proposal shown to the coach. Nothing is saved until the coach clicks Save.

Drill builder: the Drill Designer draws one drill for the coach's group, the Drill Reviewer checks
it, and the designer redraws it at most once.

The rules that matter are enforced in code, not just asked for in prompts:
- Player cap: the most players any drill may use is the number of "yes" replies, read from the
  database (not from an agent). Too-big library drills are hidden from the Head Coach, a design
  request for too many players is refused, a design that draws too many is sent back, and the
  final plan is checked again.
- Grounded facts: the Attendance Scout's counts must match the database, or its report is sent back.
- Untrusted text: drill notes, names and player names that read like instructions to the AI are hidden.
- Spending: per-run limits on model calls, tool calls and tokens, a time limit, at most
  MAX_DESIGNS new drills per run, one run at a time per coach, and a daily allowance per coach.
- No write tools: agents only read. Saving the plan is a separate route the coach triggers.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal, Optional

from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelRetry, RunContext, RunUsage, ToolOutput, UsageLimitExceeded, UsageLimits

from . import db
from .ai import MODEL_NAME, PRICES, build_model, cost_usd, settings

logger = logging.getLogger("touchline.planner")
PROMPTS = Path(__file__).parent / "prompts"
RUN_LOG = db.DB_PATH.parent / "agent_runs.jsonl"   # next to the database (data/ by default)

# ---------- limits ----------
# One run (the Head Coach plus every worker it asks) shares these caps. A normal run uses about
# 10–14 model calls; the caps stop a loop long before it costs anything real.
USAGE_LIMITS = UsageLimits(request_limit=30, tool_calls_limit=40, total_tokens_limit=200_000)
RUN_TIMEOUT_S = 240
MAX_DESIGNS = 3                 # new drills the Drill Designer may draw per run (the prompt asks for at most 2)
MAX_REQUEST_CHARS = 500
DAILY_RUNS = int(os.getenv("TOUCHLINE_DAILY_AI_RUNS", "20"))          # per coach, rolling 24 hours
DAILY_TOKENS = int(os.getenv("TOUCHLINE_DAILY_AI_TOKENS", "400000"))  # per coach, rolling 24 hours
DAILY_CHATS = int(os.getenv("TOUCHLINE_DAILY_AI_CHATS", "60"))        # chat questions per account, rolling 24 hours

AGENTS = ("Head Coach", "Attendance Scout", "Drill Designer", "Plan Reviewer", "Drill Reviewer")
USAGE_FIELDS = ("requests", "input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens")


class PlanBlocked(Exception):
    """A plan can't be built (for example nobody said yes). The message is shown to the coach."""


# ---------- small helpers ----------

# "5v5", "4 v 4", "3v3 + 2", "2 on 2". Grid sizes like "20x30" are not formats, so "x" isn't matched.
FORMAT = re.compile(r"\b(\d{1,2})\s*(?:v|vs\.?|on)\s*(\d{1,2})(?:\s*\+\s*(\d{1,2}))?", re.I)

# Text typed into the app that reads like instructions to an AI rather than coaching notes.
INJECTION = re.compile(
    r"ignore\b.{0,40}\b(instructions?|rules?|prompts?|limits?)"
    r"|disregard\b.{0,40}\b(instructions?|rules?|limits?)"
    r"|\b(system|developer)\s*(prompt|message|override)?\s*:"
    r"|\byou are now\b|\bnew instructions\b"
    r"|\b(reveal|print|repeat|show)\s+(your|the)\s+(system\s+)?(prompt|instructions)",
    re.I,
)
HIDDEN = "[hidden by Touchline: this text read like instructions to the AI]"
KEEPER = {"gk", "g", "goalkeeper", "keeper"}


def format_players(text: str) -> int:
    """The most players named by a format such as "5v5" or "3v3 + 2" in the text (0 if none)."""
    return max((int(a) + int(b) + int(c or 0) for a, b, c in FORMAT.findall(text or "")), default=0)


def players_on(board: dict) -> int:
    return sum(1 for p in board.get("pieces", []) if p.get("kind") == "player")


def drill_size(board: dict, name: str) -> int:
    """Players a saved drill needs: the players on its diagram, or the format in its name ("5v5 Scrimmage")
    if that's bigger. Notes aren't counted: they often mention other formats ("progress to 5v5")."""
    return max(players_on(board), format_players(name))


def practice_minutes(event: dict) -> Optional[int]:
    if not event.get("start_time") or not event.get("end_time"):
        return None
    sh, sm = map(int, event["start_time"].split(":"))
    eh, em = map(int, event["end_time"].split(":"))
    return (eh * 60 + em) - (sh * 60 + sm) or None


def when(event: dict) -> str:
    day = datetime.strptime(event["date"], "%Y-%m-%d").strftime("%a %b %d").replace(" 0", " ")
    if not event.get("start_time"):
        return day

    def hm(t: str) -> str:
        h, m = map(int, t.split(":"))
        return f"{h % 12 or 12}:{m:02d} {'PM' if h >= 12 else 'AM'}"
    return f"{day}, {hm(event['start_time'])}" + (f"–{hm(event['end_time'])}" if event.get("end_time") else "")


def player_cap(counts: dict) -> tuple[int, str]:
    """The most players any drill may use, and why. Read from the database, never from an agent."""
    if not counts["roster"]:
        return 0, "This team has no players on its roster yet."
    if counts["no_reply"] == counts["roster"]:
        return counts["roster"], f"No one has replied yet, so drills may use up to the full roster of {counts['roster']}."
    return counts["yes"], f"{counts['yes']} players said yes, so no drill may use more than {counts['yes']} players."


# ---------- one run: live trace and token meter ----------

@dataclass
class RunState:
    id: str
    owner_id: int
    event_id: Optional[int]
    request: str
    kind: str = "practice"          # "practice" or "drill"
    status: str = "running"
    trace: list[dict] = field(default_factory=list)
    agents: dict[str, dict] = field(default_factory=dict)
    result: Optional[dict] = None
    error: Optional[str] = None
    started: float = field(default_factory=time.monotonic)
    duration_s: Optional[float] = None

    def log(self, agent: str, kind: str, text: str, **extra: Any) -> None:
        """One line of the activity feed. kind: request, tool, handoff, report, guardrail, model, error, done."""
        self.trace.append({"t": round(time.monotonic() - self.started, 1), "agent": agent, "kind": kind, "text": text, **extra})

    def count(self, agent: str, usage: Any) -> dict:
        """Add one model response's tokens to that agent's total; returns this response's numbers."""
        step = {
            "input_tokens": usage.input_tokens or 0,
            "cache_read_tokens": usage.cache_read_tokens or 0,
            "cache_write_tokens": usage.cache_write_tokens or 0,
            "output_tokens": usage.output_tokens or 0,
            "reasoning_tokens": (usage.details or {}).get("reasoning_tokens", 0),
        }
        row = self.agents.setdefault(agent, dict.fromkeys(USAGE_FIELDS, 0))
        row["requests"] += 1
        for key, value in step.items():
            row[key] += value
        return step

    def usage(self) -> dict:
        agents = {name: {**row, "cost_usd": round(cost_usd(row), 7)} for name, row in self.agents.items()}
        total = {key: sum(row[key] for row in self.agents.values()) for key in USAGE_FIELDS}
        total["total_tokens"] = total["input_tokens"] + total["output_tokens"]
        total["cost_usd"] = round(cost_usd(total), 7)
        return {"model": MODEL_NAME, "prices_per_million_usd": PRICES, "agents": agents, "total": total}

    def public(self) -> dict:
        elapsed = self.duration_s if self.duration_s is not None else round(time.monotonic() - self.started, 1)
        return {
            "id": self.id, "kind": self.kind, "status": self.status, "request": self.request, "event_id": self.event_id,
            "trace": list(self.trace), "usage": self.usage(), "result": self.result, "error": self.error,
            "elapsed_s": elapsed, "saved_practice_id": None, "saved_drill_id": None,
        }


@dataclass
class PlanDeps:
    """What every agent in one run can see. The owner id never comes from a model."""
    run: RunState
    owner_id: int
    event: Optional[dict]     # the practice being planned (optional for the drill builder)
    request: str
    attendance: Optional[dict] = None     # from the database: the truth the scout's report is checked against
    scout_report: Optional[dict] = None
    cap: Optional[int] = None
    cap_reason: str = ""
    library: dict[int, dict] = field(default_factory=dict)   # drills shown to the Head Coach (all fit the cap)
    designs: list[dict] = field(default_factory=list)        # new drills, numbered from 1
    design_requests: int = 0
    flagged: set[str] = field(default_factory=set)

    @property
    def length(self) -> Optional[int]:
        return practice_minutes(self.event) if self.event else None

    def screen(self, text: str, where: str) -> str:
        """Hide app text that reads like instructions to the AI (and say so in the activity feed, once)."""
        if text and INJECTION.search(text):
            if where not in self.flagged:
                self.flagged.add(where)
                self.run.log("Guardrail", "guardrail", f"Hid {where}: it read like instructions to the AI, not coaching notes.", level="block")
            return HIDDEN
        return text


# ---------- what each agent returns ----------

class AttendanceReport(BaseModel):
    yes: int = Field(ge=0, description="Players who said yes, copied from get_rsvps")
    maybe: int = Field(ge=0)
    no: int = Field(ge=0)
    no_reply: int = Field(ge=0)
    goalkeepers_coming: int = Field(ge=0, description="Players listed as GK who said yes")
    summary: str = Field(max_length=500, description="2-3 sentences for the Head Coach")
    group_ideas: list[str] = Field(default_factory=list, max_length=4, description="Ways to split the players who said yes")


class DPlayer(BaseModel):
    team: Literal["attack", "defense", "neutral", "keeper"]
    x: float = Field(ge=2, le=98)
    y: float = Field(ge=2, le=98)


class DPoint(BaseModel):
    x: float = Field(ge=1, le=99)
    y: float = Field(ge=1, le=99)


class DArrow(BaseModel):
    kind: Literal["run", "pass", "dribble"]
    from_x: float = Field(ge=1, le=99)
    from_y: float = Field(ge=1, le=99)
    to_x: float = Field(ge=1, le=99)
    to_y: float = Field(ge=1, le=99)


class DrillDesign(BaseModel):
    name: str = Field(min_length=3, max_length=60)
    categories: list[str] = Field(default_factory=list, max_length=3)
    minutes: int = Field(ge=5, le=45)
    players_needed: int = Field(ge=1, le=22)
    board: Literal["blank", "half", "full"]
    setup: str = Field(max_length=500)
    how_it_works: str = Field(max_length=700)
    coaching_points: list[str] = Field(min_length=2, max_length=5)
    progression: str = Field("", max_length=300)
    players: list[DPlayer] = Field(min_length=1, max_length=22)
    cones: list[DPoint] = Field(default_factory=list, max_length=16)
    balls: list[DPoint] = Field(min_length=1, max_length=4)
    arrows: list[DArrow] = Field(default_factory=list, max_length=10)


class PlanItem(BaseModel):
    library_drill_id: Optional[int] = Field(None, description="id from search_drill_library")
    new_drill_number: Optional[int] = Field(None, description="new_drill_number from ask_drill_designer")
    kind: Literal["warm-up", "technical", "game-like", "game"]
    minutes: int = Field(ge=3, le=60)
    purpose: str = Field(max_length=220)


class PracticeProposal(BaseModel):
    title: str = Field(max_length=70)
    focus: str = Field(max_length=120)
    items: list[PlanItem] = Field(min_length=2, max_length=8)
    coach_notes: str = Field(max_length=700)
    if_maybes_come: str = Field("", max_length=350)


class Review(BaseModel):
    verdict: Literal["approve", "revise"]
    strengths: list[str] = Field(default_factory=list, max_length=3)
    issues: list[str] = Field(default_factory=list, max_length=4)


# ---------- the agent loop ----------

async def run_agent(agent: Agent, name: str, prompt: str, deps: Any, usage: RunUsage, history=None, limits: UsageLimits = USAGE_LIMITS):
    """Run one agent step by step, adding each model response's tokens to the meter.

    Every agent in a run shares one RunUsage, so the limits cover the whole team, not each agent.
    """
    async with agent.iter(prompt, deps=deps, usage=usage, usage_limits=limits, message_history=history) as run:
        async for node in run:
            if Agent.is_call_tools_node(node):
                step = deps.run.count(name, node.model_response.usage)
                cached = f" ({step['cache_read_tokens']:,} cached)" if step["cache_read_tokens"] else ""
                deps.run.log(name, "model", f"Model call: {step['input_tokens']:,} tokens in{cached}, {step['output_tokens']:,} out", tokens=step)
    return run.result


# ---------- Attendance Scout ----------

async def get_rsvps(ctx: RunContext[PlanDeps]) -> dict:
    """Every player on the team with their position and reply to this practice ("yes", "maybe", "no" or
    "no reply"), plus the counts."""
    d = ctx.deps
    counts = d.attendance["counts"]
    d.run.log("Attendance Scout", "tool",
              f"Read the RSVPs: {counts['yes']} yes, {counts['maybe']} maybe, {counts['no']} no, {counts['no_reply']} no reply")
    players = [{
        "name": d.screen(p["name"], f"a player name (#{p['number'] or '?'})"),
        "number": p["number"],
        "position": p["position"] or "not set",
        "reply": p["status"] or "no reply",
    } for p in d.attendance["players"]]
    return {"counts": {k: counts[k] for k in ("yes", "maybe", "no", "no_reply", "roster")}, "players": players}


def check_scout_report(ctx: RunContext[PlanDeps], report: AttendanceReport) -> AttendanceReport:
    """The scout's numbers must match the database. A miscount is sent back, never passed on."""
    d = ctx.deps
    truth = d.attendance["counts"]
    keepers = sum(1 for p in d.attendance["players"] if p["status"] == "yes" and (p["position"] or "").strip().lower() in KEEPER)
    problems = []
    said = {k: getattr(report, k) for k in ("yes", "maybe", "no", "no_reply")}
    real = {k: truth[k] for k in said}
    if said != real:
        problems.append(f"your counts {said} don't match get_rsvps {real}")
    if report.goalkeepers_coming != keepers:
        problems.append(f"goalkeepers_coming is {report.goalkeepers_coming}, but {keepers} players listed as GK said yes")
    too_big = [g for g in report.group_ideas if format_players(g) > d.cap]
    if too_big:
        problems.append(f"group ideas {too_big} need more than the {d.cap} players who are coming")
    if problems:
        d.run.log("Guardrail", "guardrail", f"Sent the Attendance Scout's report back: {problems[0]}.", level="block")
        raise ModelRetry("Fix your report and call final_result again: " + "; ".join(problems) + ".")
    return report


@lru_cache(maxsize=None)
def scout_agent() -> Agent:
    agent = Agent(
        build_model(), name="Attendance Scout", deps_type=PlanDeps, output_type=ToolOutput(AttendanceReport),
        instructions=(PROMPTS / "attendance_scout.md").read_text(encoding="utf-8"),
        tools=[get_rsvps], model_settings=settings(1500, "attendance-scout"), retries=2,
    )
    agent.output_validator(check_scout_report)
    return agent


# ---------- Drill Designer ----------

COLORS = {"attack": "#304dbe", "defense": "#e55c4b", "neutral": "#f7f9f5", "keeper": "#e8b34c"}
ARROW_KIND = {"run": "move", "pass": "pass", "dribble": "dribble"}


def check_design(ctx: RunContext[PlanDeps], design: DrillDesign) -> DrillDesign:
    """A design may never use more players than are coming, and its write-up must match its drawing."""
    d = ctx.deps
    drawn = len(design.players)
    named = format_players(f"{design.name} {design.how_it_works}")
    problems = []
    if drawn > d.cap:
        problems.append(f"you drew {drawn} players but only {d.cap} are coming; redesign it for at most {d.cap} players")
    elif named > d.cap:
        problems.append(f"your name or rules describe a {named}-player format but only {d.cap} are coming")
    if design.players_needed != drawn:
        problems.append(f"players_needed is {design.players_needed} but you drew {drawn} players")
    if problems:
        d.run.log("Guardrail", "guardrail", f'Sent the Drill Designer\'s "{design.name}" back: {problems[0]}.', level="block")
        raise ModelRetry("Fix this and call final_result again: " + "; ".join(problems) + ".")
    return design


@lru_cache(maxsize=None)
def designer_agent() -> Agent:
    agent = Agent(
        build_model(), name="Drill Designer", deps_type=PlanDeps, output_type=ToolOutput(DrillDesign),
        instructions=(PROMPTS / "drill_designer.md").read_text(encoding="utf-8"),
        model_settings=settings(5000, "drill-designer"), retries=3,
    )
    agent.output_validator(check_design)
    return agent


def team_line(d: PlanDeps) -> str:
    if not d.event or not d.event.get("team_id"):
        return "not given"
    with closing(db.connect()) as conn:
        team = conn.execute("SELECT name, age_group FROM teams WHERE id = ?", (d.event["team_id"],)).fetchone()
    return f"{team['name']}, age group {team['age_group'] or 'not set'}"


def designer_brief(d: PlanDeps, *, asker: str, focus: str, players: int, minutes: int, format_idea: str,
                   board: str, request_label: str) -> str:
    """The Drill Designer's task. Only the brief changes between calls; its instructions stay the same (and cached)."""
    with closing(db.connect()) as conn:
        categories = [r["name"] for r in conn.execute("SELECT name FROM drill_categories WHERE owner_id = ? ORDER BY sort, id", (d.owner_id,))]
    return (
        f"Design one drill for {asker}.\n"
        f"- Focus: {focus}\n"
        f"- Players to draw: {players}\n"
        f"- Hard limit: {d.cap} players (goalkeepers count)\n"
        f"- Minutes: {minutes}\n"
        f"- Format idea: {format_idea or 'your choice'}\n"
        f"- Board: {board}\n"
        f"- Team: {team_line(d)}\n"
        f"- Coach's categories: {', '.join(categories) or 'none yet'}\n"
        f'- {request_label}: """{d.request}"""'
    )


def design_to_drill(design: DrillDesign, number: int) -> dict:
    """The design as a Touchline drill: a whiteboard board the app can draw, edit and animate."""
    r = lambda v: round(v, 1)  # noqa: E731
    pieces = [
        {"id": f"p{i}", "kind": "player", "x": r(p.x), "y": r(p.y), "color": COLORS[p.team],
         "label": "GK" if p.team == "keeper" else str(i)}
        for i, p in enumerate(design.players, 1)
    ]
    pieces += [{"id": f"c{i}", "kind": "cone", "x": r(c.x), "y": r(c.y), "color": "#f88939", "label": ""} for i, c in enumerate(design.cones, 1)]
    pieces += [{"id": f"b{i}", "kind": "ball", "x": r(b.x), "y": r(b.y), "color": "#f7f9f5", "label": ""} for i, b in enumerate(design.balls, 1)]
    arrows = [
        {"id": f"a{i}", "kind": ARROW_KIND[a.kind], "x1": r(a.from_x), "y1": r(a.from_y), "x2": r(a.to_x), "y2": r(a.to_y)}
        for i, a in enumerate(design.arrows, 1)
    ]
    return {
        "new_drill_number": number, "name": design.name.strip(), "categories": design.categories, "minutes": design.minutes,
        "players_needed": len(design.players), "field": design.board, "setup": design.setup, "how_it_works": design.how_it_works,
        "coaching_points": design.coaching_points, "progression": design.progression,
        "board": {"field": design.board, "pieces": pieces, "arrows": arrows, "phases": [], "mirrored": False},
    }


# ---------- Head Coach tools ----------

async def get_practice_details(ctx: RunContext[PlanDeps]) -> dict:
    """The practice being planned: date and time, length in minutes, team, age group, location,
    the team's next game, and the team's most recent practice plans."""
    d = ctx.deps
    ev = d.event
    with closing(db.connect()) as conn:
        team = conn.execute("SELECT name, age_group, season FROM teams WHERE id = ?", (ev["team_id"],)).fetchone()
        game = conn.execute(
            "SELECT date, opponent FROM events WHERE team_id = ? AND kind = 'game' AND date >= ? ORDER BY date, start_time LIMIT 1",
            (ev["team_id"], ev["date"]),
        ).fetchone()
        recent = conn.execute(
            "SELECT name, focus FROM practices WHERE owner_id = ? AND team_id = ? ORDER BY updated_at DESC LIMIT 3",
            (d.owner_id, ev["team_id"]),
        ).fetchall()
    d.run.log("Head Coach", "tool", f"Looked up the practice: {when(ev)}, {d.length or '?'} minutes, {team['name']}")
    return {
        "when": when(ev),
        "length_minutes": d.length,
        "team": team["name"],
        "age_group": team["age_group"] or "not set",
        "season": team["season"],
        "location": ev["location"],
        "next_game": f"{game['date']} vs {game['opponent'] or 'TBD'}" if game else None,
        "recent_plans": [{"name": d.screen(p["name"], "a practice plan name"), "focus": d.screen(p["focus"], "a practice plan focus")} for p in recent],
    }


async def ask_attendance_scout(ctx: RunContext[PlanDeps]) -> dict:
    """Ask the Attendance Scout who is coming to this practice. Call it before choosing drills: the
    report's max_players_per_drill is the most players any drill in this practice may use."""
    d = ctx.deps
    if d.scout_report is None:
        with closing(db.connect()) as conn:
            d.attendance = db.attendance_for(conn, d.event["id"], d.event["team_id"])
        # The cap comes straight from the database, before the scout says anything.
        d.cap, d.cap_reason = player_cap(d.attendance["counts"])
        if d.cap == 0:
            raise PlanBlocked(
                "No one has said yes to this practice yet, so there's nobody to plan for. Mark who's coming on the team page and try again."
                if d.attendance["counts"]["roster"] else "This team has no players yet. Add your roster on the team page first."
            )
        d.run.log("Head Coach", "handoff", "Asked the Attendance Scout who is coming", to="Attendance Scout")
        result = await run_agent(scout_agent(), "Attendance Scout",
                                 "Count who is coming to this practice and report back to the Head Coach.", d, ctx.usage)
        d.scout_report = result.output.model_dump()
        d.run.log("Attendance Scout", "report", d.scout_report["summary"], to="Head Coach",
                  counts={k: d.scout_report[k] for k in ("yes", "maybe", "no", "no_reply")})
        d.run.log("Guardrail", "guardrail", f"Player limit set: {d.cap_reason}", level="info", cap=d.cap)
    return {**d.scout_report, "max_players_per_drill": d.cap, "why": d.cap_reason}


async def search_drill_library(ctx: RunContext[PlanDeps], focus: str = "") -> dict:
    """Search the coach's saved drills. Returns the drills that fit today's player limit, best matches
    for `focus` first, and names any drills hidden because they need too many players.

    Args:
        focus: words to match against drill names, categories and notes, e.g. "defending 1v1".
            Leave empty to list every drill.
    """
    d = ctx.deps
    if d.cap is None:
        return {"error": "Ask the Attendance Scout first, so you know how many players are coming."}
    with closing(db.connect()) as conn:
        rows = conn.execute("SELECT id, name, categories, minutes, notes, board FROM drills WHERE owner_id = ?", (d.owner_id,)).fetchall()
    words = [w for w in re.findall(r"[a-z0-9]+", focus.lower()) if len(w) > 2 or any(ch.isdigit() for ch in w)]
    fit, hidden = [], []
    for row in rows:
        board, categories = json.loads(row["board"]), json.loads(row["categories"])
        name = d.screen(row["name"], f'a drill name in the library (drill {row["id"]})')
        notes = d.screen(row["notes"], f'the notes on "{row["name"]}"' if name != HIDDEN else f'the notes on drill {row["id"]}')
        need = drill_size(board, name)
        drill = {"id": row["id"], "name": name, "categories": categories, "minutes": row["minutes"], "players_needed": need,
                 "notes": notes[:320], "board": board}
        title = f"{name} {' '.join(categories)}".lower()
        drill["score"] = sum(3 * (w in title) + f"{title} {notes.lower()}".count(w) for w in words)
        (fit if need <= d.cap else hidden).append(drill)
    fit.sort(key=lambda x: -x["score"])
    for drill in fit:
        d.library[drill["id"]] = drill
    shown = fit[:8]
    d.run.log("Head Coach", "tool", f'Searched the drill library for "{focus or "everything"}": {len(fit)} fit'
              + (f", {len(hidden)} hidden" if hidden else ""))
    new_hidden = [h for h in hidden if f"too big {h['id']}" not in d.flagged]
    if new_hidden:
        d.flagged.update(f"too big {h['id']}" for h in new_hidden)
        names = ", ".join(f'"{h["name"]}" ({h["players_needed"]} players)' for h in new_hidden[:3])
        d.run.log("Guardrail", "guardrail", f"Kept {names} out of the plan: only {d.cap} players are coming.", level="block")
    return {
        "max_players_per_drill": d.cap,
        "drills": [{k: x[k] for k in ("id", "name", "categories", "minutes", "players_needed", "notes")} for x in shown],
        "more_drills_that_fit": max(len(fit) - len(shown), 0),
        "hidden_because_too_many_players": [{"name": h["name"], "players_needed": h["players_needed"]} for h in hidden],
    }


async def ask_drill_designer(
    ctx: RunContext[PlanDeps], focus: str, players: int, minutes: int, format_idea: str = "",
    board: Literal["blank", "half", "full"] = "blank",
) -> dict:
    """Ask the Drill Designer to create a new drill, drawn as a whiteboard diagram, for a part of the
    practice the library can't cover. Returns the new drill's number to use in the plan.

    Args:
        focus: what the drill trains, e.g. "pressing the ball carrier as a pair".
        players: how many players the drill uses. At most max_players_per_drill.
        minutes: how long the drill runs.
        format_idea: optional, e.g. "4v4 to mini goals" or "3v1 rondo".
        board: "blank" for a coned grid, "half" for drills to one goal, "full" for team shape.
    """
    d = ctx.deps
    if d.cap is None:
        return {"error": "Ask the Attendance Scout first, so you know how many players are coming."}
    asked = max(players, format_players(format_idea))
    if asked > d.cap:
        label = f"{format_idea} " if format_idea else ""
        d.run.log("Guardrail", "guardrail", f"Blocked a request for a {label}drill with {asked} players: only {d.cap} said yes.", level="block")
        return {"error": f"Only {d.cap} players are coming, so a drill can use at most {d.cap}. Ask again with players <= {d.cap} and a format that fits."}
    if players < 1:
        return {"error": "A drill needs at least 1 player."}
    if d.design_requests >= MAX_DESIGNS:
        d.run.log("Guardrail", "guardrail", f"Refused a new-drill request: this run already asked for {MAX_DESIGNS}.", level="block")
        return {"error": f"You've used all {MAX_DESIGNS} new drills for this practice. Use library drills or finish the plan."}
    d.design_requests += 1
    d.run.log("Head Coach", "handoff", f"Asked the Drill Designer for {focus} ({format_idea + ', ' if format_idea else ''}{players} players, {minutes} min)",
              to="Drill Designer")
    brief = designer_brief(d, asker="the Head Coach", focus=focus, players=players, minutes=minutes,
                           format_idea=format_idea, board=board, request_label="The coach's request for the whole practice")
    try:
        result = await run_agent(designer_agent(), "Drill Designer", brief, d, ctx.usage)
    except (UsageLimitExceeded, PlanBlocked):
        raise
    except Exception as exc:  # the designer kept failing its checks; let the Head Coach carry on without it
        logger.warning("Drill Designer failed: %s", exc)
        d.run.log("Drill Designer", "error", "Couldn't finish this drill within its retries.")
        return {"error": "The Drill Designer couldn't finish that drill. Use a library drill or ask for a simpler format."}
    drill = design_to_drill(result.output, len(d.designs) + 1)
    d.designs.append(drill)
    d.run.log("Drill Designer", "report", f'Drew "{drill["name"]}": {drill["players_needed"]} players, {drill["minutes"]} min',
              to="Head Coach", board=drill["board"], name=drill["name"])
    return {k: drill[k] for k in ("new_drill_number", "name", "players_needed", "minutes", "how_it_works")}


def check_plan(ctx: RunContext[PlanDeps], plan: PracticeProposal) -> PracticeProposal:
    """The plan's hard rules, checked in code: real drills only, every drill within the player limit,
    no repeats, and the minutes fit the practice."""
    d = ctx.deps
    if d.cap is None:
        raise ModelRetry("Ask the Attendance Scout who is coming before you finish the plan.")
    problems, used = [], set()
    for i, item in enumerate(plan.items, 1):
        if (item.library_drill_id is None) == (item.new_drill_number is None):
            problems.append(f"drill {i} needs exactly one of library_drill_id or new_drill_number")
            continue
        key = ("lib", item.library_drill_id) if item.library_drill_id is not None else ("new", item.new_drill_number)
        if key in used:
            problems.append(f"drill {i} repeats a drill that's already in the plan")
        used.add(key)
        if item.library_drill_id is not None and item.library_drill_id not in d.library:
            with closing(db.connect()) as conn:
                row = conn.execute("SELECT name, board, notes FROM drills WHERE id = ? AND owner_id = ?", (item.library_drill_id, d.owner_id)).fetchone()
            need = row and drill_size(json.loads(row["board"]), row["name"])
            if row and need > d.cap:
                problems.append(f'drill {i} ("{row["name"]}") needs {need} players but only {d.cap} are coming')
            else:
                problems.append(f"drill {i}: id {item.library_drill_id} wasn't returned by search_drill_library; only use ids it returned")
        if item.new_drill_number is not None and not 1 <= item.new_drill_number <= len(d.designs):
            problems.append(f"drill {i}: there is no new drill number {item.new_drill_number}")
    total = sum(item.minutes for item in plan.items)
    if d.length and not (d.length - 15 <= total <= d.length):
        problems.append(f"the drills add up to {total} minutes; this practice is {d.length} minutes, so aim for {d.length - 15}–{d.length}")
    if not problems:
        # Every practice ends with a game most of the confirmed players are in. (Big squads may run two games side by side.)
        last = plan.items[-1]
        size = (d.library[last.library_drill_id] if last.library_drill_id is not None else d.designs[last.new_drill_number - 1])["players_needed"]
        need = d.cap if d.cap <= 4 else min(d.cap - 2, 8)
        if last.kind != "game" or size < need:
            problems.append(f"finish with a game (kind \"game\") that uses at least {need} of the {d.cap} confirmed players; "
                            f"the last drill is a {last.kind} drill for {size} players. Move the game to the end or ask the Drill Designer for one")
    if problems:
        d.run.log("Guardrail", "guardrail", f"Plan check sent the draft back: {problems[0]}.", level="block")
        raise ModelRetry("Fix the plan and call final_result again: " + "; ".join(problems) + ".")
    d.run.log("Guardrail", "guardrail",
              f"Plan checks passed: {len(plan.items)} drills, {total}{f' of {d.length}' if d.length else ''} minutes, every drill uses at most {d.cap} players.",
              level="pass")
    return plan


@lru_cache(maxsize=None)
def head_coach_agent() -> Agent:
    agent = Agent(
        build_model(), name="Head Coach", deps_type=PlanDeps, output_type=ToolOutput(PracticeProposal),
        instructions=(PROMPTS / "head_coach.md").read_text(encoding="utf-8"),
        tools=[get_practice_details, ask_attendance_scout, search_drill_library, ask_drill_designer],
        model_settings=settings(3000, "head-coach"), retries=3,
    )
    agent.output_validator(check_plan)
    return agent


# ---------- Plan Reviewer ----------

@lru_cache(maxsize=None)
def reviewer_agent() -> Agent:
    return Agent(
        build_model(), name="Plan Reviewer", deps_type=PlanDeps, output_type=ToolOutput(Review),
        instructions=(PROMPTS / "plan_reviewer.md").read_text(encoding="utf-8"),
        model_settings=settings(1500, "plan-reviewer"), retries=2,
    )


def new_item(drill: dict, **extra: Any) -> dict:
    """A newly designed drill as the browser shows it (and the save route stores it)."""
    return {
        "source": "new", "new_drill_number": drill["new_drill_number"], "name": drill["name"], "categories": drill["categories"],
        "minutes": drill["minutes"], "players_needed": drill["players_needed"], "about": drill["how_it_works"],
        "setup": drill["setup"], "coaching_points": drill["coaching_points"], "progression": drill["progression"],
        "board": drill["board"], **extra,
    }


def expand(d: PlanDeps, plan: PracticeProposal) -> list[dict]:
    """The plan's drills with everything the coach (and the reviewer) needs to see."""
    items = []
    for item in plan.items:
        if item.library_drill_id is not None:
            drill = d.library[item.library_drill_id]
            items.append({
                "source": "library", "drill_id": drill["id"], "name": drill["name"], "categories": drill["categories"], "kind": item.kind,
                "minutes": item.minutes, "players_needed": drill["players_needed"], "purpose": item.purpose,
                "about": drill["notes"], "board": drill["board"],
            })
        else:
            items.append(new_item(d.designs[item.new_drill_number - 1], kind=item.kind, minutes=item.minutes, purpose=item.purpose))
    return items


async def review_plan(d: PlanDeps, plan: PracticeProposal, usage: RunUsage) -> Review:
    counts, report = d.attendance["counts"], d.scout_report
    lines = [
        f'Coach\'s request: """{d.request}"""',
        f"Practice length: {d.length or 'not set'} minutes.",
        f"Who is coming: {counts['yes']} yes, {counts['maybe']} maybe, {counts['no']} no, {counts['no_reply']} no reply; "
        f"goalkeepers coming: {report['goalkeepers_coming']}. Drill limit: {d.cap} players.",
        f"Attendance Scout's note: {report['summary']}",
        f'Draft plan: "{plan.title}" (focus: {plan.focus}), {sum(i.minutes for i in plan.items)} minutes of drills:',
    ]
    for n, item in enumerate(expand(d, plan), 1):
        lines.append(f"{n}. {item['name']} ({item['kind']}): {item['minutes']} min, {item['players_needed']} players, "
                     f"{'new drill' if item['source'] == 'new' else 'from the coach library'}. Purpose: {item['purpose']} About: {item['about'][:260]}")
    lines += [f"Coach notes: {plan.coach_notes}", f"If the maybes come: {plan.if_maybes_come or '-'}",
              "The app's hard-rule checks passed (player limit, length, real drills)."]
    d.run.log("Head Coach", "handoff", f'Sent the draft "{plan.title}" to the Plan Reviewer', to="Plan Reviewer")
    result = await run_agent(reviewer_agent(), "Plan Reviewer", "\n".join(lines), d, usage)
    review = result.output
    text = "Approved the plan." if review.verdict == "approve" else "Asked for changes: " + " ".join(review.issues)
    d.run.log("Plan Reviewer", "report", text, to="Head Coach", verdict=review.verdict)
    return review


# ---------- the whole run ----------

async def build_practice(run: RunState, event: dict, request: str) -> None:
    d = PlanDeps(run=run, owner_id=run.owner_id, event=event, request=request)
    usage = RunUsage()
    run.log("Coach", "request", request)
    task = (
        "Plan this practice for the coach.\n"
        f"Practice: {when(event)} ({d.length or 'unknown'} minutes).\n"
        f'Coach\'s request, in their words: """{request}"""\n'
        "Start with get_practice_details and ask_attendance_scout."
    )
    result = await run_agent(head_coach_agent(), "Head Coach", task, d, usage)
    plan, revised = result.output, False
    review = await review_plan(d, plan, usage)
    if review.verdict == "revise" and review.issues:
        fix = ("The Plan Reviewer asked for these changes:\n- " + "\n- ".join(review.issues)
               + "\nKeep what works and change only what these points need. You can use your tools again, but don't add a "
               "drill that's nearly the same as one already in the plan. Then call final_result with the full updated plan.")
        result = await run_agent(head_coach_agent(), "Head Coach", fix, d, usage, history=result.all_messages())
        plan, revised = result.output, True
        review = await review_plan(d, plan, usage)   # a second look for the record; no further rounds
    items = expand(d, plan)
    run.result = {
        "title": plan.title, "focus": plan.focus, "coach_notes": plan.coach_notes, "if_maybes_come": plan.if_maybes_come,
        "items": items, "total_minutes": sum(i["minutes"] for i in items), "practice_length": d.length,
        "cap": d.cap, "cap_reason": d.cap_reason, "revised": revised, "review": review.model_dump(),
        "attendance": {**d.attendance["counts"], **{k: d.scout_report[k] for k in ("summary", "group_ideas", "goalkeepers_coming")}},
        "event": {"id": event["id"], "date": event["date"], "when": when(event), "team_id": event["team_id"], "team_name": event["team_name"]},
    }
    run.log("Head Coach", "done", f'Proposed "{plan.title}": {len(items)} drills, {run.result["total_minutes"]} minutes.')


# ---------- the drill builder ----------

@lru_cache(maxsize=None)
def drill_reviewer_agent() -> Agent:
    return Agent(
        build_model(), name="Drill Reviewer", deps_type=PlanDeps, output_type=ToolOutput(Review),
        instructions=(PROMPTS / "drill_reviewer.md").read_text(encoding="utf-8"),
        model_settings=settings(1500, "drill-reviewer"), retries=2,
    )


async def review_drill(d: PlanDeps, drill: dict, usage: RunUsage) -> Review:
    pieces = drill["board"]["pieces"]
    count = lambda kind: sum(1 for p in pieces if p["kind"] == kind)  # noqa: E731
    lines = [
        f'Coach\'s request: """{d.request}"""',
        f"Players available: {d.cap} (goalkeepers count). Team: {team_line(d)}.",
        f'Drill: "{drill["name"]}", {drill["minutes"]} min, {drill["players_needed"]} players, board "{drill["field"]}".',
        f"Setup: {drill['setup']}",
        f"How it works: {drill['how_it_works']}",
        "Coaching points: " + "; ".join(drill["coaching_points"]),
        f"Progression: {drill['progression'] or '-'}",
        f"Diagram: {count('player')} players, {count('cone')} cones, {count('ball')} ball(s), arrows: "
        + (", ".join(a["kind"].replace("move", "run") for a in drill["board"]["arrows"]) or "none") + ".",
        "The app has already checked the player count.",
    ]
    d.run.log("Drill Designer", "handoff", f'Sent "{drill["name"]}" to the Drill Reviewer', to="Drill Reviewer")
    result = await run_agent(drill_reviewer_agent(), "Drill Reviewer", "\n".join(lines), d, usage)
    review = result.output
    text = "Approved the drill." if review.verdict == "approve" else "Asked for changes: " + " ".join(review.issues)
    d.run.log("Drill Reviewer", "report", text, to="Drill Designer", verdict=review.verdict)
    return review


async def build_drill(run: RunState, request: str, players: int, minutes: int, board: Optional[str], event: Optional[dict]) -> None:
    """One new drill for the coach's group. When a practice is picked, its yes count caps the players."""
    d = PlanDeps(run=run, owner_id=run.owner_id, event=event, request=request)
    run.log("Coach", "request", request)
    d.cap = players
    if event:
        with closing(db.connect()) as conn:
            d.attendance = db.attendance_for(conn, event["id"], event["team_id"])
        going, _ = player_cap(d.attendance["counts"])
        if going == 0:
            raise PlanBlocked("No one has said yes to that practice yet, so there's nobody to design for. "
                              "Mark who's coming, or build the drill without picking a practice.")
        if players > going:
            d.cap = going
            run.log("Guardrail", "guardrail", f"You asked for {players} players, but only {going} said yes to the "
                    f"{when(event)} practice, so the drill will use at most {going}.", level="block")
    d.cap_reason = f"The drill may use at most {d.cap} players."
    run.log("Guardrail", "guardrail", f"Player limit set: {d.cap_reason}", level="info", cap=d.cap)
    usage = RunUsage()
    brief = designer_brief(d, asker="the coach", focus="what the coach asks for below", players=d.cap, minutes=minutes,
                           format_idea="", board=board or "your choice: blank, half or full", request_label="The coach's request")
    result = await run_agent(designer_agent(), "Drill Designer", brief, d, usage)
    drill = design_to_drill(result.output, 1)
    run.log("Drill Designer", "report", f'Drew "{drill["name"]}": {drill["players_needed"]} players, {drill["minutes"]} min',
            board=drill["board"], name=drill["name"])
    review, revised = await review_drill(d, drill, usage), False
    if review.verdict == "revise" and review.issues:
        fix = ("The Drill Reviewer asked for these changes:\n- " + "\n- ".join(review.issues)
               + "\nKeep what works, fix these points, and call final_result with the full redrawn drill.")
        result = await run_agent(designer_agent(), "Drill Designer", fix, d, usage, history=result.all_messages())
        drill, revised = design_to_drill(result.output, 1), True
        run.log("Drill Designer", "report", f'Redrew "{drill["name"]}": {drill["players_needed"]} players, {drill["minutes"]} min',
                board=drill["board"], name=drill["name"])
        review = await review_drill(d, drill, usage)   # a second look for the record; no further rounds
    run.result = {
        "type": "drill", "title": drill["name"], "drill": new_item(drill), "review": review.model_dump(), "revised": revised,
        "cap": d.cap, "cap_reason": d.cap_reason,
        "event": {"id": event["id"], "when": when(event), "team_name": event["team_name"]} if event else None,
    }
    run.log("Drill Designer", "done", f'Proposed "{drill["name"]}": {drill["players_needed"]} players, {drill["minutes"]} minutes.')


async def execute(run: RunState, job: Callable[[RunState], Awaitable[None]]) -> None:
    try:
        await asyncio.wait_for(job(run), RUN_TIMEOUT_S)
        run.status = "done"
    except PlanBlocked as exc:
        run.status, run.error = "error", str(exc)
        run.log("Guardrail", "guardrail", str(exc), level="block")
    except UsageLimitExceeded as exc:
        run.status, run.error = "error", "This build hit its safety limit on model calls or tokens, so it was stopped. Nothing was saved."
        run.log("Guardrail", "guardrail", f"Stopped the run: {exc}", level="block")
    except TimeoutError:
        run.status, run.error = "error", f"This build took longer than {RUN_TIMEOUT_S // 60} minutes, so it was stopped. Nothing was saved."
        run.log("Guardrail", "guardrail", "Stopped the run: time limit reached.", level="block")
    except Exception as exc:  # report every other failure to the coach instead of leaving the run hanging
        logger.exception("AI builder run %s failed", run.id)
        run.status, run.error = "error", f"The AI builder ran into a problem ({type(exc).__name__}). Nothing was saved. Try again."
        run.log("Guardrail", "error", f"{type(exc).__name__}: {str(exc)[:300]}")
    finally:
        run.duration_s = round(time.monotonic() - run.started, 1)
        try:
            persist(run)
        finally:
            RUNS.pop(run.id, None)


# ---------- storage, budget and the routes' helpers ----------

RUNS: dict[str, RunState] = {}          # runs still going, for the live activity feed
_TASKS: set[asyncio.Task] = set()


def persist(run: RunState) -> None:
    usage = run.usage()
    with closing(db.connect()) as conn:
        conn.execute(
            "UPDATE agent_runs SET status = ?, finished_at = datetime('now'), usage = ?, trace = ?, result = ?, error = ? WHERE id = ?",
            (run.status, json.dumps({**usage, "duration_s": run.duration_s}), json.dumps(run.trace),
             json.dumps(run.result) if run.result else None, run.error, run.id),
        )
        conn.commit()
    # A plain log file as well, one JSON line per run, for the token numbers in the report.
    record = {
        "run_id": run.id, "kind": run.kind, "finished": datetime.now().isoformat(timespec="seconds"), "owner_id": run.owner_id,
        "event_id": run.event_id, "request": run.request, "status": run.status, "error": run.error,
        "duration_s": run.duration_s, "usage": usage,
        "trace": [{k: v for k, v in step.items() if k != "board"} for step in run.trace],
    }
    RUN_LOG.parent.mkdir(parents=True, exist_ok=True)
    with RUN_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


def mark_interrupted(conn) -> None:
    """Runs left 'running' by a server that stopped mid-run can never finish; close them."""
    conn.execute("UPDATE agent_runs SET status = 'error', error = 'The server stopped before this build finished.', "
                 "finished_at = datetime('now') WHERE status = 'running'")


def allowance(conn, owner_id: int) -> dict:
    """The account's daily AI allowance (a rolling 24 hours): builds (practice and drill builders), chat
    questions, and the tokens all of them share. Counts the tokens a build still running has used so far."""
    row = conn.execute(
        "SELECT COALESCE(SUM(kind != 'chat'), 0) AS runs, COALESCE(SUM(kind = 'chat'), 0) AS chats, "
        "COALESCE(SUM(json_extract(usage, '$.total.total_tokens')), 0) AS tokens, "
        "COALESCE(SUM(json_extract(usage, '$.total.cost_usd')), 0) AS cost FROM agent_runs "
        "WHERE owner_id = ? AND created_at >= datetime('now', '-1 day')",
        (owner_id,),
    ).fetchone()
    # A running build's row has no usage yet (it's written when the build ends), so add its live meter.
    live = [r.usage()["total"] for r in RUNS.values() if r.owner_id == owner_id]
    tokens = int(row["tokens"]) + sum(t["total_tokens"] for t in live)
    return {
        "runs_used": row["runs"], "run_limit": DAILY_RUNS, "runs_left": max(DAILY_RUNS - row["runs"], 0),
        "chats_used": row["chats"], "chat_limit": DAILY_CHATS, "chats_left": max(DAILY_CHATS - row["chats"], 0),
        "tokens_used": tokens, "token_limit": DAILY_TOKENS, "tokens_left": max(DAILY_TOKENS - tokens, 0),
        "cost_usd": round(row["cost"] + sum(t["cost_usd"] for t in live), 6),
    }


def active_run(owner_id: int) -> Optional[str]:
    return next((r.id for r in RUNS.values() if r.owner_id == owner_id and r.status == "running"), None)


def budget_problem(conn, owner_id: int) -> Optional[tuple[int, str]]:
    """Why this coach can't start a build right now (status code, message), or None."""
    if active_run(owner_id):
        return 409, "An AI build is already running. Wait for it to finish first."
    left = allowance(conn, owner_id)
    if not left["runs_left"]:
        return 429, f"You've used all {DAILY_RUNS} AI builds in your daily allowance. It frees up over the next 24 hours."
    if not left["tokens_left"]:
        return 429, f"You've used your daily AI allowance of {DAILY_TOKENS:,} tokens. It frees up over the next 24 hours."
    return None


def start_run(conn, owner_id: int, request: str, job: Callable[[RunState], Awaitable[None]], *,
              kind: str = "practice", event_id: Optional[int] = None) -> RunState:
    """Record the run and start `job` in the background; the browser follows it with get_run()."""
    run = RunState(id=uuid.uuid4().hex[:12], owner_id=owner_id, event_id=event_id, request=request, kind=kind)
    conn.execute("INSERT INTO agent_runs (id, owner_id, kind, event_id, request, status) VALUES (?, ?, ?, ?, ?, 'running')",
                 (run.id, owner_id, kind, event_id, request))
    conn.commit()
    RUNS[run.id] = run
    task = asyncio.create_task(execute(run, job))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return run


def stored_run(row) -> dict:
    return {
        "id": row["id"], "kind": row["kind"], "status": row["status"], "request": row["request"], "event_id": row["event_id"],
        "trace": json.loads(row["trace"]), "usage": json.loads(row["usage"]) or None,
        "result": json.loads(row["result"]) if row["result"] else None, "error": row["error"],
        "elapsed_s": (json.loads(row["usage"]) or {}).get("duration_s"), "saved_practice_id": row["saved_practice_id"],
        "saved_drill_id": row["saved_drill_id"], "created_at": row["created_at"],
    }


def get_run(conn, owner_id: int, run_id: str) -> Optional[dict]:
    live = RUNS.get(run_id)
    if live and live.owner_id == owner_id:
        return live.public()
    row = conn.execute("SELECT * FROM agent_runs WHERE id = ? AND owner_id = ?", (run_id, owner_id)).fetchone()
    return stored_run(row) if row else None


def recent_runs(conn, owner_id: int, kind: str, limit: int = 8) -> list[dict]:
    rows = conn.execute(
        "SELECT r.id, r.kind, r.created_at, r.request, r.status, r.usage, r.error, r.saved_practice_id, r.saved_drill_id, r.event_id, "
        "json_extract(r.result, '$.title') AS title, e.date AS event_date, t.name AS team_name FROM agent_runs r "
        "LEFT JOIN events e ON e.id = r.event_id LEFT JOIN teams t ON t.id = e.team_id "
        "WHERE r.owner_id = ? AND r.kind = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?",
        (owner_id, kind, limit),
    ).fetchall()
    out = []
    for row in rows:
        usage = json.loads(row["usage"]) or {}
        out.append({
            "id": row["id"], "kind": row["kind"], "created_at": row["created_at"], "request": row["request"], "status": row["status"],
            "title": row["title"], "error": row["error"], "saved_practice_id": row["saved_practice_id"], "saved_drill_id": row["saved_drill_id"],
            "event_id": row["event_id"], "event_date": row["event_date"], "team_name": row["team_name"],
            "total": usage.get("total"), "duration_s": usage.get("duration_s"),
        })
    return out
