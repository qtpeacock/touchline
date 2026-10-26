# Touchline: a coaching platform with AI agents

Touchline helps youth coaches run their season in one place:
- a team calendar and rosters, with who's coming to every practice and game;
- practice plans built from a drill library;
- a whiteboard for designing and animating drills;
- AI agents that plan a practice, or design a drill, for the players who are actually coming.

Players and parents have their own views on the same accounts. They answer Yes, Maybe or No, add travel plans for away games, and see drills the coach shares.

> **Touchline is a working name and may change.** The app starts with soccer. Hockey, basketball and football are planned, so a future name may be one that fits every sport. Built for the Yale SOM AI class final project.

## Run it locally

You need **Python 3.10 or newer**. Get the code, then run the steps below from the `touchline` folder:

```bash
git clone https://github.com/qtpeacock/touchline.git
cd touchline
```

1. (Recommended) create and turn on a virtual environment:
   ```bash
   python -m venv .venv
   .venv\Scripts\activate        # Windows
   source .venv/bin/activate     # macOS / Linux
   ```
2. Install the packages:
   ```bash
   pip install -r requirements.txt
   ```
3. Make sure a `.env` file with `PORTKEY_API_KEY` is in **this folder or the folder one level above it** (see `.env.example`). Everything except the AI features works without it.
4. Start the app:
   ```bash
   python run.py
   ```
5. Open **http://127.0.0.1:8000** and click **Log in** next to **Demo account** on the login page.

To use a different port, set `PORT` (for example `PORT=8010 python run.py`, or `$env:PORT=8010` in PowerShell before running). Stop the server with Ctrl+C.

The first run creates a local database at `data/touchline.db`, filled with demo teams, players, drills, a schedule and replies. Delete that file to reset everything to the demo data.

### The AI key

The AI features (the practice builder, the drill builder and the chat) need `PORTKEY_API_KEY`, used with the `gpt-6-luna` model through Portkey. The app reads a `.env` file from this folder first, then from the folder one level above it, so a shared `.env` next to the project folder works without copying it. The key never reaches the browser.

### Tests

```bash
python -m unittest -v
```

The tests use a throwaway database and a scripted fake model, so they make no API calls and cost nothing. They check attendance and the AI builder's guardrails.

### Demo logins

| Email | Password | What it is |
|-------|----------|------------|
| `coach@example.com` | `coach1234` | **Demo account:** coach of Team 1 and Team 2, and also linked to Player 1 as the player and the parent, so you can switch sides without logging out |
| `player@example.com` | `player1234` | Player 1 on Team 1 (player only) |
| `parent@example.com` | `parent1234` | Parent of Player 1 (parent only) |

The login page has a **Log in** button for each. [DEMO.md](DEMO.md) is a five-minute demo script, and the Demo account's home page has a **Demo tour** with a link for every step.

## What's in the app

- **Accounts:** sign up with email and password, and pick one or more roles (coach, player, parent). Roles can be added later from the account home.
- **Account home:** a five-week calendar of every practice and game across your roles, with an **All / Coach / Player / Parent** toggle; **Ask Touchline**, an AI chat that answers questions about your schedule, replies, travel and drills (it can look things up but not change anything); and your profile.
- **Player page:** the team's upcoming practices and games with **Yes / Maybe / No** on each, and the drills the coach shared.
- **Parent page:** the same for your child, plus a simple **travel plan** for away games (driving with seats free, needs a ride, carpooling, or other, with a note). The coach decides whether parents can see shared drills.
- **Coach tools** (open **Coach** from the account home):
  - **Calendar:** month view of practices and games. Click any day to add one, with optional weekly repeats. Clicking a practice shows its plan with an **Open practice plan** link, and the "Coming up" list links to each plan.
  - **Teams:** every team, plus a page per team with:
    - an editable roster that shows who's coming to the next 4, 8 or 12 practices and games. Click a player's box to mark Yes, Maybe or No; a dot shows when the player or a parent answered;
    - travel plans for away games;
    - **Drills shared with players**: share a library drill with the whole team or chosen players, with a note, and switch whether parents can see them;
    - an **Accounts** column to connect families. Invite an email as the player's own account or as a parent (up to 4). The person accepts the invitation on their account home, or right after signing up with that email, and only then sees the player's schedule. The coach can cancel invitations and disconnect accounts.
  - **Attendance:** every practice and game shows how many players are going, maybe or out (on the calendar, the practices page and the team page). Opening an event on the calendar lets you mark each player's reply.
  - **Practices:** the next scheduled practice, who's coming and its plan, saved practice plans, and a builder where you drag drills in from your library and reorder them.
  - **Build a practice with AI** (on the Practices page): say what to work on ("defending, finish with a game") and a team of AI agents plans the practice for the players who are actually coming. You watch each agent's steps live, with the token count, cost and your daily allowance left, then save the plan (and any new drills, already animated) with one click. Details below.
  - **Drills:** your drill library, with a diagram of each drill. Filter by category (Shooting, Finishing, Passing, First touch, Possession, 1v1, 2v2, Defense, plus any you create). A drill can carry several categories, picked under **Drill details** on the whiteboard.
  - **Design a drill with AI** (on the Drills page): describe one drill and how many players you have (or pick a practice to use its yes count). The Drill Designer draws it on the whiteboard, the Drill Reviewer checks it, and you save it to your library.
  - **Whiteboard:** full field, half field or blank board. Place players, cones and the ball, then draw run, curved run, pass and dribble arrows (any arrow can be bent). **Mirror** flips the drill left ↔ right.
  - **Animation (beta):** step-by-step movement. **Suggest animation** turns the drawn arrows into steps by following the ball pass by pass: receiving runs move with the pass, the passer moves after it, and curved runs follow their curve.
  - **Present:** the drill goes full screen, PowerPoint style, as a diagram or as an animation. Keys: → next step, ← back, Space play all, W/A switch view, N notes, Esc exit. Available on the whiteboard and on each drill card.

## The AI agents

Six agents, all on `gpt-6-luna`. The practice builder uses the first four, the drill builder uses the Drill Designer and the Drill Reviewer, and the account home's chat is the Assistant (each answer is capped at 8 model calls and 40,000 tokens, and counts toward a daily allowance of 60 questions).

| Agent | Job | Tools |
|-------|-----|-------|
| **Head Coach** (lead) | Plans the practice and hands work to the others | `get_practice_details`, `ask_attendance_scout`, `search_drill_library`, `ask_drill_designer` |
| **Attendance Scout** | Counts who said yes, maybe and no, notes missing positions, suggests groups | `get_rsvps` |
| **Drill Designer** | Draws a new drill as a whiteboard diagram | none (returns a typed diagram) |
| **Plan Reviewer** | Checks a practice plan like an assistant coach; can send it back once | none |
| **Drill Reviewer** | Checks a single new drill; can ask for one redraw | none |
| **Assistant** (account home chat) | Answers questions about the schedule, replies, travel, teams and drills | `my_schedule`, `who_is_coming` (coach only), `my_teams`, `find_drills` — all read-only and limited to what the account may see |

The rules that matter are enforced in code (`server/planner.py`), not just asked for in prompts:

- **Player limit:** the most players any drill may use is the number of players who said yes, read from the database. Library drills that need more are hidden from the Head Coach. A request to design a bigger drill is refused, a design that draws too many players is sent back, and the final plan is checked again. If nobody has replied yet, the whole roster counts.
- **Facts:** the Attendance Scout's counts must match the database, or its report is sent back.
- **Plan checks:** only real drills, no repeats, the minutes fit the practice, and the last drill is a game most of the players are in.
- **Untrusted text:** drill notes and names that read like instructions to the AI ("ignore your rules…") are hidden from the agents.
- **Spending:** each build is capped at 30 model calls, 40 tool calls and 200,000 tokens, plus 4 minutes and 3 new drills. Each coach can run one build at a time and has a daily allowance of 20 builds or 400,000 tokens (a rolling 24 hours, shared by both builders). While a build runs, the page shows the allowance left, counting that build's tokens as they're used.
- **No write tools:** the agents only read and propose. Nothing is saved until the coach clicks Save.

Every build is stored with its full activity log and token counts (`agent_runs` table) and appended to `data/agent_runs.jsonl`. Both builder pages show the live log, the tokens and cost per agent, the allowance left, and a history of recent builds. The prompts are in `server/prompts/`.

## Project layout

```
run.py                starts the server (no auto-reload)
server/main.py        FastAPI app: JSON API under /api, plus the static web app
server/db.py          SQLite schema and helpers
server/ai.py          the model (gpt-6-luna via Portkey), .env lookup, token prices
server/planner.py     the AI builders (practice and drill): agents, tools, guardrails, allowance, run log
server/assistant.py   the account home's AI chat (read-only, scoped to what the account may see)
server/family.py      what players and parents see: linked players, schedule, replies, travel, shared drills
server/prompts/       each agent's instructions
server/security.py    password hashing (scrypt), session tokens, login throttling
server/seed.py        demo coach, Team 1 and Team 2, sample drills, schedule and RSVPs
static/               the web app (plain HTML, CSS and JavaScript modules; no build step)
tests/                attendance and guardrail tests (no API calls)
```

## Security notes

- Passwords are stored only as salted scrypt hashes.
- Sessions are random tokens in an HttpOnly cookie, and only their SHA-256 hash is stored.
- An email is locked out for 10 minutes after 5 failed logins.
- Every coach API call checks that the data belongs to the signed-in coach.
