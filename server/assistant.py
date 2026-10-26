"""The account home's AI chat: one Assistant agent that answers questions about the account's schedule,
replies, travel, teams and drills.

It can only read, and only what the signed-in account may see: a coach sees their own teams, and a player
or parent sees the player they're linked to. Each answer is capped (model calls, tool calls, tokens, time),
counts against the account's daily AI allowance, and is logged with its token use like every other run.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from contextlib import closing
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from pydantic_ai import Agent, RunContext, RunUsage, UsageLimitExceeded, UsageLimits
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart

from . import db, family, planner
from .ai import build_model, settings

logger = logging.getLogger("touchline.assistant")
PROMPT = Path(__file__).parent / "prompts" / "assistant.md"
CHAT_LIMITS = UsageLimits(request_limit=8, tool_calls_limit=10, total_tokens_limit=40_000)
CHAT_TIMEOUT_S = 60
HISTORY = 10            # earlier messages sent back with each question


@dataclass
class ChatDeps:
    user: dict
    run: planner.RunState
    flagged: set[str] = field(default_factory=set)

    @property
    def roles(self) -> list[str]:
        return self.user["roles"]

    def screen(self, text: str, where: str) -> str:
        if text and planner.INJECTION.search(text):
            if where not in self.flagged:
                self.flagged.add(where)
                self.run.log("Guardrail", "guardrail", f"Hid {where}: it read like instructions to the AI.", level="block")
            return planner.HIDDEN
        return text or ""


# ---------- tools (all read-only) ----------

async def my_schedule(ctx: RunContext[ChatDeps], days: int = 14) -> dict:
    """Upcoming practices and games for this account over the next `days` days (at most 60), for every
    role it has. Coach events include how many players said yes, maybe and no; player and parent events
    include the player's own reply.

    Args:
        days: how many days ahead to look.
    """
    d = ctx.deps
    days = max(1, min(days, 60))
    today = date.today()
    with closing(db.connect()) as conn:
        events = family.schedule_for(conn, d.user, today.isoformat(), (today + timedelta(days=days)).isoformat())
    d.run.log("Assistant", "tool", f"Looked up the schedule for the next {days} days: {len(events)} events")
    out = []
    for ev in events[:40]:
        item = {
            "event_id": ev["id"], "when": planner.when(ev), "kind": ev["kind"], "team": ev["team_name"],
            "opponent": ev.get("opponent") or None, "location": ev.get("location") or None, "away_game": ev["away"],
            "seen_as": ev["roles"],
        }
        if "coach" in ev["roles"] and "going" in ev:
            item["replies"] = {"yes": ev["going"], "maybe": ev["maybe"], "no": ev["not_going"],
                               "no_reply": max(ev["roster_size"] - ev["going"] - ev["maybe"] - ev["not_going"], 0)}
        for relation, reply in ev["replies"].items():
            item[f"{relation}_reply"] = f"{reply['player']}: {reply['status'] or 'no reply yet'}"
        out.append(item)
    return {"today": today.isoformat(), "events": out}


async def who_is_coming(ctx: RunContext[ChatDeps], event_id: int) -> dict:
    """Coach only: every player's reply (yes, maybe, no or no reply) to one of your practices or games, who
    answered (coach, player or parent), and families' travel plans for an away game. Get event_id from my_schedule.

    Args:
        event_id: the event to look up.
    """
    d = ctx.deps
    if "coach" not in d.roles:
        return {"error": "Only the team's coach can see everyone's replies. Players and parents see their own on their page."}
    with closing(db.connect()) as conn:
        event = conn.execute(db.EVENT_SELECT + " WHERE e.id = ? AND e.owner_id = ?", (event_id, d.user["id"])).fetchone()
        if not event:
            return {"error": f"Event {event_id} isn't one of your events. Use my_schedule to find the right id."}
        att = db.attendance_for(conn, event["id"], event["team_id"])
        travel = {r["player_id"]: r for r in conn.execute("SELECT * FROM travel_plans WHERE event_id = ?", (event_id,))}
    d.run.log("Assistant", "tool", f"Read the replies for {planner.when(dict(event))}: {att['counts']['yes']} yes, "
              f"{att['counts']['maybe']} maybe, {att['counts']['no']} no, {att['counts']['no_reply']} no reply")
    groups: dict[str, list[str]] = {"yes": [], "maybe": [], "no": [], "no_reply": []}
    for p in att["players"]:
        name = d.screen(p["name"], f"a player name (#{p['number']})")
        label = f"{name} ({p['position']})" if p["position"] else name
        if p["status"] and p["source"] in ("player", "parent"):
            label += f", answered by the {p['source']}"
        groups[p["status"] or "no_reply"].append(label)
    names = {p["id"]: p["name"] for p in att["players"]}
    return {
        "event": planner.when(dict(event)), "kind": event["kind"], "team": event["team_name"], "replies": groups,
        "travel_plans": [{"player": names.get(pid, "?"), "plan": family.TRAVEL_LABELS[t["plan"]], "seats": t["seats"],
                          "note": d.screen(t["note"], "a travel note")} for pid, t in travel.items()],
    }


async def my_teams(ctx: RunContext[ChatDeps]) -> dict:
    """Coach: each of your teams with its roster (names, numbers, positions). Player or parent: the player
    you're linked to, their team and their coach."""
    d = ctx.deps
    out: dict[str, Any] = {}
    with closing(db.connect()) as conn:
        if "coach" in d.roles:
            teams = conn.execute("SELECT id, name, age_group, season FROM teams WHERE owner_id = ? ORDER BY name", (d.user["id"],)).fetchall()
            out["coaching"] = [{
                "team": t["name"], "age_group": t["age_group"] or None, "season": t["season"] or None,
                "roster": [f"#{p['number']} {d.screen(p['name'], 'a player name')} {p['position']}".strip()
                           for p in conn.execute("SELECT number, name, position FROM players WHERE team_id = ? ORDER BY sort, id", (t["id"],))],
            } for t in teams]
        for relation in family.RELATIONS:
            if relation in d.roles:
                out[f"as_{relation}"] = [{"player": p["name"], "number": p["number"], "position": p["position"],
                                          "team": p["team_name"], "coach": p["coach_name"]} for p in family.links_for(conn, d.user["id"], relation)]
    d.run.log("Assistant", "tool", "Looked up teams and rosters")
    return out


async def find_drills(ctx: RunContext[ChatDeps], query: str = "") -> dict:
    """Coach: search your drill library by name, category or notes. Player or parent: the drills your coach
    has shared with you.

    Args:
        query: words to look for; leave empty to list them all.
    """
    d = ctx.deps
    words = [w for w in re.findall(r"[a-z0-9]+", query.lower()) if len(w) > 2 or any(c.isdigit() for c in w)]
    matches = lambda text: not words or any(w in text.lower() for w in words)  # noqa: E731
    out: dict[str, Any] = {}
    with closing(db.connect()) as conn:
        if "coach" in d.roles:
            rows = conn.execute("SELECT id, name, categories, minutes, notes, board FROM drills WHERE owner_id = ?", (d.user["id"],)).fetchall()
            out["library"] = [{
                "name": d.screen(r["name"], "a drill name"), "categories": json.loads(r["categories"]), "minutes": r["minutes"],
                "players_on_diagram": planner.players_on(json.loads(r["board"])), "notes": d.screen(r["notes"], f'the notes on "{r["name"]}"')[:240],
            } for r in rows if matches(f"{r['name']} {r['categories']} {r['notes']}")][:10]
        for relation in family.RELATIONS:
            if relation not in d.roles:
                continue
            for kid in family.family_view(conn, d.user["id"], relation, days=1):
                key = f"shared_with_{kid['player']['name']}_as_{relation}"
                if kid["drills_hidden"]:
                    out[key] = "The coach keeps shared drills between the coach and players for this team."
                    continue
                out[key] = [{"name": s["name"], "minutes": s["minutes"], "coach_note": d.screen(s["note"], "a coach note"),
                             "shared": s["created_at"][:10]} for s in kid["drills"] if matches(f"{s['name']} {s['note']} {s['notes']}")]
    d.run.log("Assistant", "tool", f'Looked up drills{f" for “{query}”" if query else ""}')
    return out


@lru_cache(maxsize=1)
def chat_agent() -> Agent:
    return Agent(
        build_model(), name="Assistant", deps_type=ChatDeps, output_type=str,
        instructions=PROMPT.read_text(encoding="utf-8"),
        tools=[my_schedule, who_is_coming, my_teams, find_drills],
        model_settings=settings(1500, "assistant"), retries=2,
    )


# ---------- one question ----------

def budget_problem(conn, owner_id: int) -> Optional[tuple[int, str]]:
    left = planner.allowance(conn, owner_id)
    if not left["chats_left"]:
        return 429, f"You've asked {planner.DAILY_CHATS} questions in the last 24 hours, your daily chat allowance. Try again later."
    if not left["tokens_left"]:
        return 429, "You've used your daily AI allowance. It frees up over the next 24 hours."
    return None


def _history(messages: list[dict]) -> list:
    """Earlier turns of the conversation, as model messages (the browser keeps the conversation)."""
    out = []
    for m in messages[-HISTORY:]:
        text = m["text"][:1500]
        out.append(ModelRequest(parts=[UserPromptPart(content=text)]) if m["role"] == "user" else ModelResponse(parts=[TextPart(content=text)]))
    return out


async def answer(conn, user: dict, messages: list[dict]) -> dict:
    question = messages[-1]["text"].strip()
    run = planner.RunState(id=uuid.uuid4().hex[:12], owner_id=user["id"], event_id=None, request=question, kind="chat")
    conn.execute("INSERT INTO agent_runs (id, owner_id, kind, request, status) VALUES (?, ?, 'chat', ?, 'running')",
                 (run.id, user["id"], question))
    conn.commit()
    run.log("Coach" if "coach" in user["roles"] else "You", "request", question)
    deps = ChatDeps(user=user, run=run)
    today = date.today()
    prompt = (f"Today is {today:%A, %B} {today.day}, {today.year}. You're talking with {user['name']}; "
              f"this account's roles: {', '.join(user['roles']) or 'none'}.\n\nTheir question: {question}")
    text = ""
    try:
        result = await asyncio.wait_for(
            planner.run_agent(chat_agent(), "Assistant", prompt, deps, RunUsage(), history=_history(messages[:-1]), limits=CHAT_LIMITS),
            CHAT_TIMEOUT_S,
        )
        text, run.status = result.output.strip(), "done"
        run.result = {"answer": text}
    except UsageLimitExceeded:
        run.status, run.error = "error", "Stopped at the chat's safety limit."
        run.log("Guardrail", "guardrail", "Stopped the answer: it needed more lookups than one chat answer may use.", level="block")
        text = "That question needed more lookups than one answer is allowed. Try asking something narrower."
    except TimeoutError:
        run.status, run.error = "error", "Timed out."
        text = "That took too long to answer. Please try again."
    except Exception as exc:  # tell the person, keep the details in the log
        logger.exception("Chat answer %s failed", run.id)
        run.status, run.error = "error", f"{type(exc).__name__}: {str(exc)[:200]}"
        text = "Sorry, I couldn't answer that just now. Please try again."
    finally:
        run.duration_s = round(time.monotonic() - run.started, 1)
        planner.persist(run)
    return {
        "answer": text, "ok": run.status == "done", "usage": run.usage()["total"],
        "steps": [s["text"] for s in run.trace if s["kind"] in ("tool", "guardrail")],
    }
