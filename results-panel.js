// The match results strip (score, bar, one dot per game) and its collapsible
// game list. Rendering only: the model comes from results.js.

const OPEN_STORAGE_KEY = "resultsOpen";

// Quasar's q-expansion-item caret (Material "keyboard_arrow_down")
const CARET_PATH = "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z";

function readOpen() {
  try {
    return localStorage.getItem(OPEN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeOpen(open) {
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, String(open));
  } catch {
    // Storage unavailable: the open state just isn't remembered
  }
}

function setText(el, text) {
  if (el.textContent !== text) {
    el.textContent = text;
  }
}

function isAtBottom(el) {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
}

function gameSignature(game) {
  return [
    game.white,
    game.black,
    game.result,
    game.moves,
    game.winner,
    game.dot,
    game.live,
  ].join("\u0001");
}

function gameTitle(game) {
  const players = `${game.white ?? "?"} vs ${game.black ?? "?"}`;
  return `Game ${game.round}: ${players}, ${game.live ? "in progress" : game.result}`;
}

// Keep `parent`'s children in the order of `elements`, moving only the ones
// that are out of place (usually none: games only get appended)
function reorder(parent, elements) {
  let expected = parent.firstChild;
  for (const el of elements) {
    if (el !== expected) {
      parent.insertBefore(el, expected);
    } else {
      expected = expected.nextSibling;
    }
  }
}

export function createResultsPanel(root, { onSelect }) {
  root.innerHTML = `
    <div class="results-strip" role="button" tabindex="0" aria-controls="results-games" aria-expanded="false">
      <div class="results-body">
        <div class="results-score">
          <span class="results-side results-side-a"><span class="results-name"></span><b class="results-wins"></b></span>
          <span class="results-draws"></span>
          <span class="results-side results-side-b"><b class="results-wins"></b><span class="results-name"></span></span>
        </div>
        <div class="results-bar"><span class="results-bar-a"></span><span class="results-bar-draw"></span><span class="results-bar-b"></span></div>
        <div class="results-row">
          <div class="results-dots"></div>
          <span class="results-label"></span>
        </div>
      </div>
      <svg class="results-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="${CARET_PATH}" /></svg>
    </div>
    <div class="results-expand">
      <div class="results-expand-inner">
        <div class="results-games" id="results-games">
          <table>
            <thead>
              <tr>
                <th class="results-num">#</th>
                <th>White</th>
                <th>Black</th>
                <th class="results-result">Result</th>
                <th class="results-num results-moves">Moves</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  const strip = root.querySelector(".results-strip");
  const score = root.querySelector(".results-score");
  const [nameA, nameB] = root.querySelectorAll(".results-name");
  const [winsA, winsB] = root.querySelectorAll(".results-wins");
  const drawsEl = root.querySelector(".results-draws");
  const barA = root.querySelector(".results-bar-a");
  const barDraw = root.querySelector(".results-bar-draw");
  const barB = root.querySelector(".results-bar-b");
  const dots = root.querySelector(".results-dots");
  const label = root.querySelector(".results-label");
  const list = root.querySelector(".results-games");
  const thead = list.querySelector("thead");
  const tbody = list.querySelector("tbody");

  // round -> { sig, dot, row }
  const rendered = new Map();
  let lastSignature = null;
  let viewing = null;
  let liveRow = null;
  let open = readOpen();
  // Wide panels show the list as a column regardless of `open`
  let wide = false;
  let hasRendered = false;
  // Follow the newest dot / row unless the viewer has scrolled up
  let dotsPinned = true;
  let listPinned = true;

  function scrollRowIntoView(row) {
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const top = rowRect.top - listRect.top + list.scrollTop;
    const bottom = top + rowRect.height;
    const headerHeight = thead.offsetHeight;
    if (top - headerHeight < list.scrollTop) {
      list.scrollTop = top - headerHeight;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }

  function scrollToLiveRow() {
    const row = liveRow || tbody.lastElementChild;
    if (row) {
      scrollRowIntoView(row);
    }
  }

  function isWide() {
    return (
      getComputedStyle(root).getPropertyValue("--results-layout").trim() ===
      "column"
    );
  }

  function listShown() {
    return open || wide;
  }

  function applyOpen() {
    root.classList.toggle("is-open", open);
    strip.setAttribute("aria-expanded", String(listShown()));
  }

  function toggle() {
    if (wide) {
      // The list is always shown here: keep the saved preference as it is
      return;
    }
    open = !open;
    applyOpen();
    writeOpen(open);
    if (open) {
      scrollToLiveRow();
    }
  }

  function select(el) {
    const round = Number(el.dataset.round);
    onSelect(el.dataset.live === "true" ? null : round);
  }

  strip.addEventListener("click", (event) => {
    const dot = event.target.closest(".results-dot");
    if (dot) {
      const entry = rendered.get(Number(dot.dataset.round));
      if (entry) {
        scrollRowIntoView(entry.row);
      }
      select(dot);
    } else {
      toggle();
    }
  });
  strip.addEventListener("keydown", (event) => {
    if (
      event.target === strip &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      toggle();
    }
  });
  tbody.addEventListener("click", (event) => {
    const row = event.target.closest("tr");
    if (row) {
      select(row);
    }
  });

  dots.addEventListener("scroll", () => {
    dotsPinned = isAtBottom(dots);
  });
  list.addEventListener("scroll", () => {
    listPinned = isAtBottom(list);
  });
  new ResizeObserver(() => {
    if (dotsPinned) {
      dots.scrollTop = dots.scrollHeight;
    }
  }).observe(dots);

  // Lets the list's max-height leave room for the graph below the strip
  function measureStrip() {
    const height = `${strip.offsetHeight}px`;
    if (root.style.getPropertyValue("--results-strip-height") !== height) {
      root.style.setProperty("--results-strip-height", height);
    }
  }
  new ResizeObserver(measureStrip).observe(strip);
  // The panel's width changes whenever the layout switches
  new ResizeObserver(() => {
    const nowWide = isWide();
    if (nowWide === wide) {
      return;
    }
    const wasShown = listShown();
    wide = nowWide;
    applyOpen();
    if (hasRendered && !wasShown) {
      scrollToLiveRow();
    }
  }).observe(root);
  new ResizeObserver(() => {
    if (listShown() && listPinned) {
      list.scrollTop = list.scrollHeight;
    }
  }).observe(list);

  function renderGame(game, entry) {
    const { dot, row } = entry;
    dot.className = `results-dot results-dot-${game.dot}`;
    dot.dataset.round = game.round;
    dot.dataset.live = String(game.live);
    dot.title = gameTitle(game);

    row.className = game.live ? "results-live" : "";
    row.dataset.round = game.round;
    row.dataset.live = String(game.live);
    const cells = [
      [String(game.round), "results-num"],
      [game.white ?? "", game.winner === "white" ? "results-winner" : ""],
      [game.black ?? "", game.winner === "black" ? "results-winner" : ""],
      [game.result, "results-result"],
      [String(game.moves), "results-num results-moves"],
    ];
    row.replaceChildren(
      ...cells.map(([text, className]) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (className) {
          td.className = className;
        }
        return td;
      }),
    );
  }

  function renderGames(games) {
    const dotsWerePinned = dotsPinned;
    const seen = new Set();
    liveRow = null;
    for (const game of games) {
      seen.add(game.round);
      let entry = rendered.get(game.round);
      if (!entry) {
        entry = {
          sig: null,
          dot: document.createElement("span"),
          row: document.createElement("tr"),
        };
        rendered.set(game.round, entry);
      }
      const sig = gameSignature(game);
      if (entry.sig !== sig) {
        entry.sig = sig;
        renderGame(game, entry);
      }
      if (game.live) {
        liveRow = entry.row;
      }
    }
    for (const [round, entry] of rendered) {
      if (!seen.has(round)) {
        entry.dot.remove();
        entry.row.remove();
        rendered.delete(round);
      }
    }
    const entries = games.map((game) => rendered.get(game.round));
    reorder(
      dots,
      entries.map((entry) => entry.dot),
    );
    reorder(
      tbody,
      entries.map((entry) => entry.row),
    );
    if (dotsWerePinned) {
      dots.scrollTop = dots.scrollHeight;
    }
  }

  function renderViewing(round) {
    if (viewing === round) {
      return;
    }
    const previous = rendered.get(viewing);
    if (previous) {
      previous.dot.classList.remove("is-viewing");
      previous.row.classList.remove("is-viewing");
    }
    viewing = round;
  }

  function applyViewing() {
    const entry = viewing === null ? null : rendered.get(viewing);
    if (entry) {
      entry.dot.classList.add("is-viewing");
      entry.row.classList.add("is-viewing");
    }
  }

  function renderStrip(model) {
    root.classList.toggle("results-multi", !model.twoEngines);
    if (model.twoEngines) {
      const [a, b] = model.names;
      const [wa, wb] = model.wins;
      const drawText = `${model.draws} ${model.draws === 1 ? "draw" : "draws"}`;
      setText(nameA, a);
      setText(nameB, b);
      setText(winsA, String(wa));
      setText(winsB, String(wb));
      setText(drawsEl, `· ${drawText} ·`);
      score.setAttribute("aria-label", `${a} ${wa} · ${drawText} · ${wb} ${b}`);
      barA.style.flexGrow = wa;
      barDraw.style.flexGrow = model.draws;
      barB.style.flexGrow = wb;
    }
    setText(label, model.label || "");
  }

  return {
    update(model, viewingRound) {
      if (!model) {
        if (!root.hidden) {
          root.hidden = true;
        }
        lastSignature = null;
        return;
      }
      const signature = `${JSON.stringify(model)}|${viewingRound}`;
      if (signature === lastSignature) {
        return;
      }
      lastSignature = signature;

      const listWasPinned = listPinned;
      if (!hasRendered) {
        // While still hidden, so a saved open state doesn't animate
        wide = isWide();
        applyOpen();
      }
      root.hidden = false;
      renderStrip(model);
      // Clear the old highlight before rows are rebuilt, then reapply it
      renderViewing(viewingRound ?? null);
      renderGames(model.games);
      applyViewing();
      measureStrip();

      if (!hasRendered) {
        hasRendered = true;
        if (listShown()) {
          scrollToLiveRow();
        }
      } else if (listShown() && listWasPinned) {
        list.scrollTop = list.scrollHeight;
      }
    },
  };
}
