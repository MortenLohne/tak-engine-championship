# Match results counter — design

## Intent

Viewers of the Tak Engine Championship can currently see only the live game. Anyone who arrives mid-match has no idea how the match stands, and a finished game is lost from the page as soon as the next one starts, apart from a one-off notification.

Add a compact, always-visible tally of the match to the graph panel, together with a game list that opens any finished game in the embedded viewer. The tally comes from Racetrack, so every viewer sees the same complete history no matter when they arrived.

## Goals

- Show the match score at a glance: each engine's wins, the draw count, a win/draw/loss bar, and one dot per game, with the live game included.
- Make it possible to open any finished game in the embedded PTN Ninja viewer, with its board, eval graph and engine notes, and return to the live game easily.
- Work well on desktop and mobile, in both landscape and portrait.
- Track history on the server (Racetrack), not in the browser.

## Non-goals

- Standings for tournaments with more than two engines. The game list works for any number of engines, but the score row is designed for a two-engine match (see "My calls").
- Elo, LLR or SPRT figures. Racetrack computes these, but they are out of scope.
- Persisting history across Racetrack restarts. In-memory history for the running tournament is enough.

## Anti-goals

- Horizontal scrolling anywhere in the strip or the game list. Both must fit their panel at every width and every match length, scrolling vertically only.
- The game list squeezing the eval graph out of view. The graph must always remain visible.
- Pulling a viewer off a past game they're looking at, for example when the live game ends.
- Sending every finished game's full move list to each viewer when they connect.

## The design (agreed with the user)

The user approved a clickable prototype (`results-expansion-v3.html`, from the brainstorming session) that matches the description below. The one change since then is that the live row's result reads `--` instead of "live".

### Score strip (always visible)

A strip at the top of the graph panel, above the chart, in every orientation. The graph panel becomes a column: strip, then the collapsible list, then the chart, which fills the remaining space.

- Engine A's name and win count on the left, the draw count in the middle, and engine B's win count and name on the right (for example `syntaks 3 · 1 draw · 1 takzero`). There are no points or half points. The draw count counts `*` results too.
- A thin bar split into A's wins, draws and B's wins.
- One dot per game in round order: light for an A win, grey for a draw, dark for a B win, and a dashed outline for the live game.
- Matches can run to any number of games (whoever runs Racetrack decides), so the dots wrap onto new rows and never scroll sideways. The dot area is capped at about three rows. Past that it scrolls vertically and stays pinned to the newest row, unless the viewer has scrolled up to look at older games.
- A caret on the right, styled like Quasar's `q-expansion-item` (a down arrow that rotates 180° when open).
- Clicking anywhere on the strip except a dot toggles the game list.
- Clicking a dot opens that game in the viewer. Clicking the live game's dot returns to the live game.
- Optional "Game 6 of 20" text when the total number of rounds is known. Show it where it fits.

### Wide panels (added after approval)

When the graph panel is wide enough, a stacked table looks awkward stretched across it. Past a width threshold, the strip and the game list become their own column to the left of the chart, with the chart beside them. In this layout the list fills the column below the strip, scrolls vertically, and stays open, so the caret is hidden. Narrower panels keep the stacked layout. The switch is based on the graph panel's own width (a container query), not the window's, so it behaves the same in landscape and portrait.

### Game list (expands from the strip)

- It opens and closes with a height animation of about 250 ms, like `q-expansion-item`.
- It's a table with one row per game, round ascending, and the live game as the last row (in italics, with `--` as its result).
- Columns: **#**, **White**, **Black**, **Result**, **Moves**. The winner's name is in bold.
- **No horizontal scrolling.** As the panel narrows, drop **Moves** first. Then shorten engine names with an ellipsis, keeping **#** and **Result** whole. The table always fits the panel's width.
- The open list takes at most about half of the graph panel's height and scrolls vertically past that. The header row stays put while the rows scroll. When opened, the list is scrolled to the live row; when a game is opened from a dot, its row is scrolled into view.
- Clicking a row opens that game in the viewer, and the live row returns to live. The row and dot for the game being viewed are highlighted.
- Whether the list is open is remembered per viewer in `localStorage`, alongside the existing board settings.

### Viewing a past game

- Opening a past game loads it into the embedded PTN Ninja (board and PTN), the eval graph and the engine notes, exactly as the live game is shown today.
- While a past game is shown, a PTN Ninja notification (via the embed API's `NOTIFY`) says "Viewing game N" and has a **Back to live** action in the primary colour, like the game-over notification's "View" button. It stays up until the viewer returns to live, and it is dismissed whichever way they return: through its action, the live dot or the live row. Opening a different past game replaces it rather than stacking a second one. It appears in the top-right corner with the other notifications (`position: "top-right"`), because the default bottom position covers PTN Ninja's navigation toolbar (the user's call).
- While a past game is shown, live updates keep arriving and the strip and list keep updating, but nothing from the live game reaches the viewer or the graph.
- If the live game ends or a new game starts while a past game is shown, stay on the past game. The new result simply appears in the strip and list.
- **Back to live**, or the live dot or row, restores the live game in full: board at the latest position, graph, notes, clocks and live analysis.

### Theme

Use PTN Ninja's theme colours, which the page already receives through `GET_THEME` (`updateTheme`) for the chart and background. The dots and bar use the player colours, and the panel and text match the chart panel.

## Data (Racetrack, `http` branch)

### Results in the live state

Add a tournament-wide list of finished games to `GameStateOutput`, so it travels in the existing `/{id}` and `/{id}/sse` stream. It is identical for every concurrent game id.

```text
engines: [name, ...]   // Racetrack's engine list, in order (engine A = index 0)
results: [
  { roundNumber, whiteEngine, blackEngine, result, plies }   // engine indices
]
totalRounds            // scheduled games, only for fixed-length matches
```

- `roundNumber` is 1-based, as the existing `roundNumber` already is.
- Results refer to engines by index into `engines`, not by name, because two builds of the same engine can report the same `id name`.
- `result` is the finished game's PTN result string as Racetrack records it: `R-0`, `0-R`, `F-0`, `0-F`, `1-0`, `0-1` (time or forfeit), or `1/2-1/2`.
- A game that ends without a result (the move-limit cutoff) has `result: "*"` and counts as a draw, as Racetrack's own score printout does. The empty placeholder game written after a fatal engine error is left out.
- With concurrency above 1, games finish out of order. The list is sorted by `roundNumber`.
- The list only grows, so the SSE JSON-patch diff sends one appended entry per finished game. Each entry is a few dozen bytes, so even a thousand-game match adds only tens of kilobytes to a new viewer's first message. That's acceptable; full games are fetched only on demand.

### Full game on demand

Add `GET /games/{round}`, which returns one finished game in the same shape as `GameStateOutput` for the live game: players, size, komi, opening TPS and moves, round number, and `moves` with each move's `uciInfo`. Its `currentMoveUciInfo` is null and its clocks hold the final times. It returns 404 for an unknown or unfinished round.

- To support this, Racetrack keeps a snapshot of each game's `ExternalGameState` (moves with `uciInfo` included) when it finishes. Today, `moves` is reset when the next game starts, and the `tiltak::ptn::Game` written to the PTN file doesn't carry `uciInfo`. The unused `ExternalGameHistory` struct in `game.rs` looks like an earlier start on this.
- Apply the same CORS layer as the existing routes.

## Frontend (`index.js`, `index.html`)

- Render the strip and list from `gameState.results` plus the live game. If `results` is absent (an older Racetrack), show nothing new, and the page behaves as it does today.
- Opening a past game: fetch `/games/{round}`, then load it through the same path as a new live game. That means `SET_CURRENT_PTN` with the PTN built from the opening and moves, `ADD_NOTES` for each move's engine notes, and the chart from that game's moves. Cache fetched games, since finished games don't change.
- While viewing a past game, skip `APPEND_PLY`, `SET_ANALYSIS`/`SET_EVAL` for the live position, live notes, and `SET_GAME_TIME`/`SET_TIMER_LIVE` for the live game. Keep applying patches to `gameState` so the live state stays current.
- Back to live: rebuild the live game in PTN Ninja from `gameState`, as the existing new-game path does, including the PV continuation state (`livePv`) for the current ply.
- PTN Ninja sends `GAME_END` when the game it shows ends. Loading a finished game may trigger it, so the "Game N ended" notification must fire only for the live game.

## PTN Ninja (embed API, `dev` branch)

The page can create notifications with actions today (`NOTIFY` with `actions`, `group`, `timeout`, `position`), but it has no way to dismiss one. Add that to the embed API:

- `NOTIFY` accepts an `id` (a string chosen by the host page). A new notification with the same `id` replaces the existing one.
- New action `DISMISS_NOTIFY` with value `{ id }` dismisses that notification, and does nothing if it's already gone.
- Document both in the embed API section of `readme.md` and in `src/changelog.json`, as earlier API additions were.

Until PTN Ninja ships this, the "Viewing game N" notification can linger after the viewer returns to live by a dot or row. That's acceptable during the rollout.

## Constraints

- No build step: the page is plain HTML plus an ES module, with dependencies from esm.sh. Keep it that way.
- PTN Ninja is embedded as a cross-origin iframe and is driven only through its `postMessage` API.
- The layout switches between row (landscape) and column (portrait) at `max-aspect-ratio: 3/2`. The graph panel is the second child in both.
- Touch targets: the dots are drawn about 9 px wide, but on touch screens their hit area must be at least about 24 px.

## My calls (not explicitly confirmed by the user)

- "Engine A" (left) is the first engine in Racetrack's engine list. Points and dot colours count from A's side, regardless of who played White in each game.
- With more than two engines, hide the score row and the bar, and keep the dots (coloured by White win, draw or Black win) and the game list.
- The "Viewing game N" notification keeps its usual close button. If the viewer closes it, they can still return through the live dot or row.
- Past games open from the dots and rows in this page rather than in a new tab. The existing game-over notification's "View" button (new tab) stays as it is.
- Use `GET /games/{round}` (tournament-wide round number) rather than a per-game-id path, since results are tournament-wide.
- `engines` and per-result engine indices were added to the payload (the reviewer's question). The frontend can't otherwise know which engine is A, and names can collide.
- Concurrency above 1: the page still follows only game 0's stream as "live". Rounds in progress on other workers don't appear until they finish, so the list can briefly have gaps.
- `totalRounds` is sent only when the number of games is fixed. In an SPRT run the game cap isn't a meaningful total.
- The Moves column shows full moves (plies ÷ 2, rounded up), the way Tak players count.

## Left to the builder

- Exact sizes, spacing, breakpoints for dropping columns, and the animation easing, within the constraints above.
- How the strip and list pick up theme colours.
- Error handling when `/games/{round}` fails, as long as the viewer stays on (or returns to) the live game and the user sees a brief message.
- Racetrack-side structure: where the finished-game snapshots live and how `results` is assembled, as long as the JSON above is what clients receive.
