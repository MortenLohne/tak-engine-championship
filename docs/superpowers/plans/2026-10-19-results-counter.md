# Match Results Counter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a server-tracked tally of the match (score strip, game dots and a collapsible game list) beside the eval graph, and let viewers open any finished game in the embedded viewer and return to the live game.

**Architecture:** Racetrack keeps an in-memory `MatchHistory` of finished games. It publishes a compact `results` list in the existing SSE state and serves full games from `GET /games/{round}`. PTN Ninja's embed API gains notification ids and `DISMISS_NOTIFY`. The frontend turns the state into a view model in a pure, tested module (`results.js`), renders it with a small DOM module (`results-panel.js`), and switches the viewer between the live game and a fetched finished game.

**Tech Stack:** Rust (axum, serde) in Racetrack; Vue 2 / Quasar in PTN Ninja (Playwright e2e tests); plain ES modules with no build step in the frontend (Chart.js and fast-json-patch from esm.sh), tested with `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-19-results-counter-design.md`

**Repos and branches:**
- Part A, Racetrack: `~/Projects/racetrack`. New branch `match-history` from `http`, worked on in a worktree, because the main checkout is on `lazy-opening-book`.
- Part B, PTN Ninja: `~/Projects/PTN-Ninja`. New branch `embed-dismiss-notify` from `dev`.
- Part C, Frontend: `~/Projects/tak-engine-championship`, on `dev`.

Parts A, B and C depend only on the contracts below, so they can be built in any order. Task C4 needs A and C done; B only affects whether the notification is dismissed.

## Contracts

Racetrack JSON, added to the existing `/{id}` and `/{id}/sse` payloads:

```text
engines: [String]                         // engine A = index 0
results: [{ roundNumber, whiteEngine, blackEngine, result, plies }]   // ascending roundNumber
totalRounds?: Number                      // omitted for SPRT
```

`GET /games/{round}` returns the existing `GameStateOutput` shape for a finished game, with `currentMoveUciInfo: null` and the final clocks. It returns 404 for an unknown or unfinished round and 400 for a non-numeric round.

PTN Ninja embed API:
- `NOTIFY*` values may carry `id: String`. A new notification with the same `id` replaces the old one.
- `DISMISS_NOTIFY` with value `{ id }` dismisses it, and does nothing if it's already gone.

## Global Constraints

- Frontend: no build step. Plain HTML plus ES modules; a `package.json` exists only to mark modules and run `node --test`.
- PTN Ninja is a cross-origin iframe, driven only through `postMessage`.
- No horizontal scrolling anywhere in the strip or the game list, at every width and match length. Only vertical scrolling.
- The open game list takes at most about half of the graph panel's height. The graph always stays visible.
- The dot area is capped at about three rows, scrolls vertically past that, and stays pinned to the newest row unless the viewer has scrolled up.
- On touch screens, dot hit areas are at least about 24 px.
- Viewers are never pulled off a finished game they're viewing.
- Notification id for the viewing notification: `"viewing-finished-game"`. Back-to-live action name: `"BACK_TO_LIVE"`.
- `localStorage` key for the list's open state: `"resultsOpen"`.
- Score copy: `syntaks 3 · 1 draw · 1 takzero` (draws pluralised as "draws"). There are no points. The live row's result is `--`.

## Review Focus

1. **A live game that has just finished is both in `results` and still the live state** (Racetrack resets the state only when the next game starts). Expected: it shows once, as a finished game, with no live dot. Pinned in C1 (`liveGameAlreadyFinished`).
2. **Results finishing out of order (concurrency above 1).** Expected: rows and dots are in round order. Pinned in A1 (`results_sorted_by_round`) and C1 (`sortsByRound`).
3. **`/games/{round}` failing (404, network error).** Expected: the viewer stays on or returns to live, and PTN Ninja shows a brief error notification. Pinned in C3 step 7.
4. **Returning to live after one or more games ended while viewing.** Expected: the viewer rebuilds the current live game (new round, notes, clocks, live analysis), not a stale one. Pinned in C4 step 4.
5. **Hundreds of games on a phone-width panel.** Expected: no horizontal overflow, the dots are capped and scroll, and the list scrolls only vertically. Pinned in C2 step 6.

---

## Part A — Racetrack

### Task A1: `MatchHistory`

**Files:**
- Create: `src/history.rs`
- Modify: `src/main.rs` (add `mod history;`), `src/tests/mod.rs` (add `mod history_tests;`)
- Test: `src/tests/history_tests.rs`

**Interfaces:**
- Produces, in `crate::history`:
  - `pub struct MatchHistory<B: PgnPosition>`, holding `engines: Vec<String>`, `total_rounds: Option<usize>` and `games: BTreeMap<usize, FinishedGame<B>>`
  - `struct FinishedGame<B> { white_engine: usize, black_engine: usize, result: String, state: ExternalGameState<B> }`
  - `#[derive(Clone, Debug, PartialEq, Eq)] #[cfg_attr(feature = "http", derive(Serialize), serde(rename_all = "camelCase"))] pub struct GameResultSummary { pub round_number: usize, pub white_engine: usize, pub black_engine: usize, pub result: String, pub plies: usize }`
  - `impl MatchHistory<B>`:
    - `new(total_rounds: Option<usize>) -> Self`
    - `set_engines(&mut self, names: Vec<String>)`
    - `engines(&self) -> &[String]`
    - `total_rounds(&self) -> Option<usize>`
    - `record(&mut self, white_engine: usize, black_engine: usize, result: Option<&str>, state: ExternalGameState<B>)`
    - `results(&self) -> Vec<GameResultSummary>`
    - `game(&self, round_number: usize) -> Option<&ExternalGameState<B>>`
- Semantics:
  - `record` keys by `state.round_number`, which is already 1-based.
  - It stores `result.unwrap_or("*")`.
  - It sets the snapshot's `current_move_uci_info` to `None`.
  - `plies = state.opening.moves.len() + state.moves.len()`.

- [ ] **Step 1: Write the failing tests** in `src/tests/history_tests.rs`, using `tiltak::position::Position<6>` states built with `ExternalGameState { .. }`:

```rust
#[test] fn results_sorted_by_round()        // record rounds 3, 1, 2 -> results() round_numbers == [1, 2, 3]
#[test] fn missing_result_is_star()         // record(.., None, ..) -> results()[0].result == "*"
#[test] fn result_string_is_kept()          // record(.., Some("0-R"), ..) -> "0-R"
#[test] fn plies_include_opening()          // opening 3 moves + 2 played moves -> plies == 5
#[test] fn snapshot_drops_live_info()       // state with current_move_uci_info Some -> game(round).unwrap().current_move_uci_info.is_none()
#[test] fn engines_by_index_with_same_name()// set_engines(["tiltak", "tiltak"]); record(1, 0, ..) -> white_engine == 1, black_engine == 0
#[test] fn unknown_round_is_none()          // game(99).is_none()
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test --release history`
Expected: compile errors (`unresolved import crate::history`).

- [ ] **Step 3: Implement `src/history.rs`** to the interface above.

- [ ] **Step 4: Run the tests**

Run: `cargo test --release`
Expected: all tests pass (24 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add src/history.rs src/main.rs src/tests/mod.rs src/tests/history_tests.rs
git commit -m "Keep an in-memory history of finished games"
```

### Task A2: Record games and serve them over HTTP

**Files:**
- Modify: `src/main.rs`:
  - create `Arc<Mutex<MatchHistory<Position<S>>>>` with `total_rounds = if matches!(cli_args.tournament_type, TournamentType::Sprt) { None } else { Some(cli_args.games) }`;
  - pass it to `tournament.play` and `http::http_server`.
- Modify: `src/tournament.rs`, in `play`:
  - add a `history: &Arc<Mutex<MatchHistory<B>>>` parameter;
  - call `set_engines(engine_names.clone())` right after `engine_names` is built;
  - in the worker loop, capture the white and black engine ids before `play_game` consumes `scheduled_game`;
  - in the `Ok(game)` arm only, call `record(white, black, game.game_result_str, external_state.lock().unwrap().clone())`. The `Err` arm's placeholder game is never recorded.
- Modify: `src/http.rs`:
  - `AppState` gains `history`;
  - `GameStateOutput` becomes `pub(crate)` and gains `engines: Vec<String>`, `results: Vec<GameResultSummary>`, and `#[serde(skip_serializing_if = "Option::is_none")] total_rounds: Option<usize>`;
  - replace `From<ExternalGameState>` with the constructor below;
  - add the route `/games/{round}` with the same CORS layer.
- Test: `src/tests/history_tests.rs`

**Interfaces:**
- Consumes: A1's `MatchHistory`.
- Produces:
  - `impl<const S: usize> GameStateOutput { pub(crate) fn new(state: ExternalGameState<Position<S>>, history: &MatchHistory<Position<S>>) -> Self }`
  - `pub(crate) fn finished_game_output<const S: usize>(history: &MatchHistory<Position<S>>, round: usize) -> Option<GameStateOutput>`, used by the `/games/{round}` handler (`None` → 404, unparsable round → 400).

- [ ] **Step 1: Write the failing tests:**

```rust
#[test] fn output_includes_results_and_engines()
// serde_json::to_value(GameStateOutput::new(live_state, &history)):
//   ["engines"] == ["syntaks", "takzero"], ["results"][0]["whiteEngine"] == 0,
//   ["results"][0]["roundNumber"] == 1, ["totalRounds"] == 20
#[test] fn output_omits_total_rounds_for_sprt()   // MatchHistory::new(None) -> no "totalRounds" key
#[test] fn finished_game_output_has_moves()       // round 1 recorded with 2 moves -> ["moves"].len() == 2, ["currentMoveUciInfo"].is_null()
#[test] fn finished_game_output_unknown_round()   // finished_game_output(&history, 7).is_none()
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test --release history`
Expected: compile errors (`GameStateOutput::new` not found).

- [ ] **Step 3: Implement the changes** in `main.rs`, `tournament.rs` and `http.rs` as listed under Files.

- [ ] **Step 4: Run the tests and clippy**

Run: `cargo test --release && cargo clippy --release`
Expected: all tests pass; clippy reports no new warnings (the existing `ExternalGameHistory` dead-code warning may be resolved by deleting that unused struct).

- [ ] **Step 5: Smoke-test the server**

Run: `cargo run --release -- -s 6 --engine path=$HOME/Projects/tiltak/target/release/tei --engine path=$HOME/Projects/tiltak/target/release/tei --all-engines tc=5+0.05 --games 2`, then in another shell, after the first game ends: `curl -s localhost:23456/0 | jq '{engines, results, totalRounds}'` and `curl -s -o /dev/null -w '%{http_code}' localhost:23456/games/1` and `.../games/99`.
Expected: one result entry with `roundNumber` 1, `totalRounds` 2, `200` for `/games/1` and `404` for `/games/99`.

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "Publish finished-game results and serve full games over HTTP"
```

---

## Part B — PTN Ninja

### Task B1: Notification ids and `DISMISS_NOTIFY`

**Files:**
- Modify: `src/store/ui/actions.js`:
  - keep a module-level `Map` from id to Quasar's dismiss function (`Notify.create` returns it, and the `notify*` helpers return that);
  - wrap `NOTIFY`, `NOTIFY_ERROR`, `NOTIFY_SUCCESS`, `NOTIFY_WARNING` and `NOTIFY_HINT` so that a value with `id` dismisses any existing notification with that id first;
  - pass an `onDismiss` that removes the entry from the map;
  - add `DISMISS_NOTIFY`.
- Modify: `src/App.vue`, embed listener: add `case "DISMISS_NOTIFY": this.$store.dispatch("ui/DISMISS_NOTIFY", data.value)`.
- Modify: `readme.md`:
  - document `id` in the `NOTIFY` object list;
  - add a `#### DISMISS_NOTIFY (value: <Object>)` section in alphabetical position.
- Modify: `src/changelog.json`: add an `"added"` entry under the unreleased `3.7.0`: "Embed API: notifications can be given an `id`, replacing any earlier one with the same id, and dismissed with the new `DISMISS_NOTIFY` action."
- Test: `tests/e2e/embed-notify.spec.js`

**Interfaces:**
- Produces: `export const DISMISS_NOTIFY = (context, { id }) => void` in `src/store/ui/actions.js`.

- [ ] **Step 1: Write the failing e2e test.** Open the app with the helpers' `openApp(page)`, and post embed messages the same way `trim-matrix.spec.js` (R24) does, with `window.dispatchEvent(new MessageEvent("message", { data: { action, value } }))`:

```js
test("an id'd notification is replaced, then dismissed", async ({ page }) => {
  // NOTIFY { id: "x", message: "one", timeout: 0 }, then NOTIFY { id: "x", message: "two", timeout: 0 }
  // expect(page.locator(".q-notification")).toHaveCount(1); its text contains "two"
  // DISMISS_NOTIFY { id: "x" } -> expect(page.locator(".q-notification")).toHaveCount(0)
});
test("dismissing an unknown or closed id does nothing", async ({ page }) => {
  // DISMISS_NOTIFY { id: "nope" } -> no error in the console, 0 notifications
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && npx playwright test embed-notify`
Expected: FAIL, with 2 notifications counted.

- [ ] **Step 3: Implement** the changes listed under Files.

- [ ] **Step 4: Run the test and lint**

Run: `cd tests && npx playwright test embed-notify && cd .. && yarn lint`
Expected: both tests pass; lint is clean.

- [ ] **Step 5: Commit**

```bash
git add src/store/ui/actions.js src/App.vue readme.md src/changelog.json tests/e2e/embed-notify.spec.js
git commit -m "Embed API: notification ids and DISMISS_NOTIFY"
```

---

## Part C — Frontend

### Task C1: Results view model

**Files:**
- Create: `package.json` containing `{ "private": true, "type": "module", "scripts": { "test": "node --test" } }`
- Create: `results.js`
- Test: `results.test.js`

**Interfaces:**
- Produces, as exports of `results.js`:
  - `resultWinner(result: string) -> "white" | "black" | "draw"`: a result ending in `-0` is a White win, one starting with `0-` is a Black win, and anything else (`1/2-1/2`, `*`) is a draw.
  - `fullMoves(plies: number) -> number`, which is `Math.ceil(plies / 2)`.
  - `buildResultsModel({ engines, results, totalRounds, live }) -> ResultsModel | null`, which returns `null` when `results` is not an array.
    - `live` is `{ roundNumber, whitePlayer, blackPlayer, plies } | null`.
    - `ResultsModel = { twoEngines, names: [a, b] | null, wins: [a, b], draws, games: GameRow[], label }`
    - `GameRow = { round, white, black, result, moves, winner: "white" | "black" | "draw" | null, dot: "a" | "b" | "draw" | "white" | "black" | "live", live }`
    - `label` is `"Game N of T"`, or `"Game N"` without `totalRounds`, where N is the live round, or else the last finished round.

- [ ] **Step 1: Write the failing tests** in `results.test.js` with `node:test` and `node:assert/strict`:

```text
resultWinner: "R-0","F-0","1-0" -> white; "0-R","0-F","0-1" -> black; "1/2-1/2","*" -> draw
fullMoves: 0 -> 0, 1 -> 1, 2 -> 1, 41 -> 21
countsWinsAndDraws: engines [syntaks, takzero]; results r1 R-0 (white 0, black 1), r2 0-R (white 1, black 0),
  r3 1/2-1/2, r4 F-0 (white 1, black 0), r5 * -> wins [2, 1], draws 2, twoEngines true, names [syntaks, takzero]
dotsFromEngineA: syntaks wins as Black -> dot "a"; takzero wins as White -> dot "b"; draw -> "draw"
liveRowLast: live round 6 -> last row { live: true, result: "--", dot: "live", winner: null }
liveGameAlreadyFinished: live.roundNumber present in results -> no live row; label uses that round
sortsByRound: results given as rounds 3, 1, 2 -> rows 1, 2, 3
manyEngines: engines of length 3 -> twoEngines false, names null, dots "white" | "black" | "draw"
labelWithTotal: totalRounds 20, live round 6 -> "Game 6 of 20"; totalRounds absent -> "Game 6"
noResults: results undefined -> null
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test`
Expected: FAIL (`Cannot find module './results.js'`).

- [ ] **Step 3: Implement `results.js`** to the interface above. It has no imports and doesn't touch the DOM.

- [ ] **Step 4: Run the tests**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add package.json results.js results.test.js
git commit -m "Add the match results view model"
```

### Task C2: Strip and game list

**Files:**
- Create: `results-panel.js`
- Modify: `index.html`:
  - `#chart-wrapper` becomes a flex column holding `<div id="results">` and a new `<div id="chart-area">` (position relative, `flex: 1`) that holds the canvas;
  - the CSS for the strip, list, caret, dots and container queries;
  - `#chart-wrapper { container-type: size }`, so the list can use `max-height: 50cqh`.
- Modify: `index.js`:
  - `chartContainer` becomes `#chart-area`, and `resizeChart` sizes the canvas from it;
  - create the panel and call `panel.update(...)` at the end of `updateGameState`;
  - `updateTheme` sets the CSS variables `--results-panel`, `--results-text`, `--results-p1`, `--results-p2` and `--results-accent` from `theme.colors` (`panel`, the computed text colour, `player1`, `player2`, `primary`);
  - `SERVER_URL` takes the `?server=` query parameter when present (for local testing), falling back to the current constant.

**Interfaces:**
- Consumes: C1's `buildResultsModel`, `fullMoves`.
- Produces:
  - `export function createResultsPanel(root: HTMLElement, { onSelect: (round: number | null) => void }) -> { update(model: ResultsModel | null, viewingRound: number | null): void }`
  - `null` passed to `onSelect` means the live game.
  - `update(null, …)` hides the panel. That's the older-server case, where the page must look exactly as it does today.

Behaviour to implement:
- When `model.twoEngines` is false, hide the names, counts and bar, and keep the dots, label, caret and list.
- The strip renders the names, win counts and draw count in the copy format from Global Constraints, followed by the bar, the dots, the label and a caret.
- Clicking the strip (except a dot) toggles the list, with a ~250 ms `grid-template-rows` transition. The caret rotates 180°, and the open state persists under `"resultsOpen"`.
- The table columns are #, White, Black, Result, Moves, with the winner in bold and the live row in italics.
- An `@container` rule on `#results` drops Moves first, then ellipsises the names. Use `table-layout: fixed` with width-constrained name columns.
- When the list opens, it scrolls to the live row. When a game is selected from a dot, its row scrolls into view. The row and dot for `viewingRound` are highlighted.
- The dot area is pinned to the bottom unless the viewer has scrolled up. It's capped at about three rows. On `(pointer: coarse)`, hit areas are at least about 24 px.

- [ ] **Step 1: Implement `results-panel.js` and the `index.html` and `index.js` changes.**

- [ ] **Step 2: Start a static server for the page.** Add a local, uncommitted `.claude/launch.json` entry named `frontend` running `python3 -m http.server 8080`, then open `http://localhost:8080/?server=https://racetrack.mortenlohne.no` in the preview browser.
Expected: the page loads the live game as before. The panel is hidden, because the live server doesn't send `results` yet.

- [ ] **Step 3: Check the panel with a synthetic model.** In the page console, call the panel's `update` with `buildResultsModel` output for 5 finished games and a live game. Expose the panel as `window.__resultsPanel` only while `?debug` is in the URL.
Expected: the strip matches the approved prototype. Clicking the strip toggles the list with the animation, and the caret rotates.

- [ ] **Step 4: Check the layouts.** Use `resize_window` with the presets mobile (375×812), tablet (768×1024) and desktop, plus a custom 812×375 (landscape phone).
Expected: in every layout, the strip sits above the graph and the graph is visible with the list open.

- [ ] **Step 5: Check theme switching.** Switch PTN Ninja between a light and a dark theme.
Expected: the strip and list colours follow the theme.

- [ ] **Step 6: Check horizontal overflow (Review Focus 5).** With 300 synthetic games at 375×812 and at desktop width, run in the console: `[...document.querySelectorAll('#results, #results *')].filter(e => e.scrollWidth > e.clientWidth + 1).length`
Expected: `0`. The dot area height is at most about three rows and scrolls vertically.

- [ ] **Step 7: Commit**

```bash
git add index.html index.js results-panel.js
git commit -m "Show the match results strip and game list beside the graph"
```

### Task C3: Viewing finished games

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: C2's `createResultsPanel` (`onSelect`). A2's `GET /games/{round}`. B1's `NOTIFY.id` and `DISMISS_NOTIFY`.
- Produces, inside `index.js`:
  - `let viewedGame = null`: the finished game shown in place of the live one.
  - `function shownGame()`: returns `viewedGame ?? gameState`.
  - `function loadGameIntoNinja(game, { live })`: extracted from the new-game branch of `updateGameState`. It sends `SET_NAME`, `SET_CURRENT_PTN` and `LAST`, clears `savedNotePlies`, saves the notes and sends the clocks. For a finished game, it sends `SET_TIMER_LIVE` `false` with the final times.
  - `async function showFinishedGame(round)`: fetches `${SERVER_URL}/games/${round}`, caching responses in `const finishedGames = new Map()`.
  - `function showLiveGame()`

Behaviour to implement:
- `updateChart`, `setCurrentAnalysis`, `saveAnalysisToNotes` and `updateChartVerticalLine` read `shownGame()` instead of `gameState`. `saveAnalysisToNotes` applies `pvWithContinuation` only to the live game.
- While `viewedGame` is set, `updateGameState` applies patches and updates the panel, but sends nothing to PTN Ninja or the chart. It also leaves `roundNumber` and `moveCount` alone.
- `showFinishedGame` does the following:
  - sets `viewedGame`;
  - calls `loadGameIntoNinja(game, { live: false })`;
  - redraws the chart;
  - sends `NOTIFY` with `{ id: "viewing-finished-game", message: "Viewing game N", timeout: 0, actions: [{ label: "Back to live", action: "BACK_TO_LIVE" }, { icon: "close" }] }`.
- `showLiveGame` does the following:
  - clears `viewedGame`;
  - sends `DISMISS_NOTIFY` `{ id: "viewing-finished-game" }`;
  - sets `roundNumber = 0`, so the next `updateGameState()` takes the new-game path;
  - calls `updateGameState()` right away.
- The message listener handles `"BACK_TO_LIVE"` by calling `showLiveGame()`. For `"GAME_END"`, it only notifies when `viewedGame === null`.
- The panel's `onSelect(null)` calls `showLiveGame()`, and `onSelect(round)` calls `showFinishedGame(round)`.
- Every `panel.update` call passes `viewedGame?.roundNumber ?? null` as `viewingRound`.

- [ ] **Step 1: Implement the changes above.**

- [ ] **Step 2: Replay check.** Run the existing replay harness (`scratchpad/harness.mjs` from this session, or rebuild it: stub `EventSource` to replay a captured SSE log and record `sendToNinja` calls) against the new `index.js`.
Expected: the live replay sends the same `SET_ANALYSIS` and `ADD_NOTES` sequence as before C3. The minimum Syntaks PV length is still 25.

- [ ] **Steps 3–7 run against a local Racetrack from Task A2 step 5**, at `?server=http://localhost:23456`.

- [ ] **Step 3:** Click a finished game's dot.
Expected: the board, PTN, graph and notes switch to that game. "Viewing game N" appears with a Back to live button, and the dot and row are highlighted.

- [ ] **Step 4:** Click a different finished game's row.
Expected: still a single notification, now for the new game.

- [ ] **Step 5:** Click the notification's Back to live.
Expected: the live game is restored at its latest position with live analysis, clocks and notes. The notification is gone.

- [ ] **Step 6:** Open a finished game, then click the live dot.
Expected: back to live. With PTN Ninja dev from B1 the notification is dismissed; with production PTN Ninja it may linger, which is acceptable.

- [ ] **Step 7 (Review Focus 3):** In the console, call `showFinishedGame(999)`.
Expected: the viewer stays on live, a `NOTIFY_ERROR` "Couldn't load game 999" appears, and there are no uncaught errors in the console.

- [ ] **Step 8: Commit**

```bash
git add index.js
git commit -m "Open finished games in the viewer and return to the live game"
```

### Task C4: End-to-end check across a game boundary

**Files:** none (verification only).

- [ ] **Step 1:** Run Racetrack from `match-history` with Syntaks against Tiltak: `cargo run --release -- -s 6 --engine path=$HOME/Projects/syntaks/target/release/syntaks --engine path=$HOME/Projects/tiltak/target/release/tei --all-engines tc=20+0.2 --games 6`
- [ ] **Step 2:** Open the page with `?server=http://localhost:23456`.
Expected: the strip shows `Game 1 of 6` and a dashed live dot.
- [ ] **Step 3:** When game 1 ends.
Expected: a light or dark dot replaces the live dot, a new dashed dot appears for game 2, and the counts update. Exactly one dot exists for round 1 (Review Focus 1).
- [ ] **Step 4 (Review Focus 4):** Open game 1 and stay there until game 2 ends.
Expected: the viewer stays on game 1 while the strip gains game 2's dot. Back to live then shows game 3 at its latest position, with live analysis and the clocks running.
- [ ] **Step 5:** Reload the page partway through game 3.
Expected: the full tally appears immediately, and the list's open state is restored.
- [ ] **Step 6:** Record the results in the PR description when the branches are pushed. Pushing and opening PRs are separate decisions for the user.
