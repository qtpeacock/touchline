# Demo script

How to show Touchline in about 5 minutes, coach first. Everything runs in **one login**: the Demo account is the coach of Team 1 and Team 2, and is also linked to Player 1 on Team 1 as the player and as the parent, so you can switch sides without logging out. The account home has a **Demo tour** card with a link for every step below.

**Log in:** on the login page, click **Log in** next to **Demo account** (`coach@example.com` / `coach1234`).

To show the player or parent on their own, use the other two demo logins: **Player 1** (`player@example.com` / `player1234`) and **Parent of Player 1** (`parent@example.com` / `parent1234`). A second browser window (or a private window) can stay logged in as one of them while you click through as the coach.

## 1. Account home (30 seconds)
- The **calendar** shows the next five weeks across every role. Coloured dots show which roles see each event: green for coach, blue for player, purple for parent.
- Flip the **All / Coach / Player / Parent** toggle to show how a multi-role account narrows the view.
- **Ask Touchline** (AI chat): click "Who's coming to Tuesday's practice?". It looks up the schedule and the replies, and answers with the real counts. The answer shows its model calls, tokens and cost.

## 2. The player answers (30 seconds)
- Open **Player** from Your roles. Show the schedule grouped by week and the suggested drills from the coach.
- Mark **Maybe** for Thursday's practice.

## 3. The parent plans travel (30 seconds)
- Back to the account home and open **Parent**. Thursday shows "Marked by the player".
- On Saturday's **away game**, set Travel to **Driving**, 2 seats free, and the note "Leaving 9:15 from the school lot". Click **Save**.

## 4. The coach sees it all (1 minute, the main part)
- Open **Coach**, then **Teams → Team 1**.
- **Roster and who's coming:** Player 1's Thursday box is now "?" with a blue dot (the player answered). Saturday's column says "1 travel plan", and the box has a black dot. Hover a box for who answered and when. Switch **Next 4 / 8 / 12** to see further ahead.
- **Away game travel** (right side) lists the parent's plan.
- **Drills shared with players:** click **Share a drill**, pick a drill, choose **Choose players → Player 1**, add a note, and share. Then flip **Parents can see these** off and on. With it off, the parent page says drills are for players only.
- **Connecting families:** the **Accounts** column shows who's connected to each player (Player 1 has a player account and two parents). Click **+ Connect** on Player 3, enter an email such as `new.parent@example.com`, choose **A parent**, and click **Send invite**. The row now says "1 invited".
  - To finish the story, open a private window and sign up with that email (any password, choose Parent).
  - The account home shows "Demo Account invited you as a parent of Player 3 on Team 1". Click **Accept**, and Player 3's schedule appears on the calendar and the Parent page.

## 5. The AI builders (2 minutes)
- **Practices → Build a practice with AI** (Team 1, Tuesday): "Defending practice, finish with a 5v5 like we always do."
  - The live feed shows the Head Coach, Attendance Scout, Drill Designer and Plan Reviewer at work.
  - Only 8 said yes, so the app caps every drill at 8 players. A 9-player drawing gets sent back.
  - The right side shows tokens, cost and the daily allowance left.
  - Save the plan, and it attaches to Tuesday.
- **Drills → Design a drill with AI:** "A pressing game, something like a 5v5", sized for Team 2's Monday practice (6 yes). It comes back as a 3v3, with a Play button for the animation.

## Reset after a demo
Stop the server, delete `data/touchline.db`, and start it again to get the original demo data back.
