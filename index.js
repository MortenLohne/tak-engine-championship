import { applyPatch } from "https://esm.sh/fast-json-patch@3.1.1";
import Chart from "https://esm.sh/chart.js@4.5.0/auto";

// const SERVER_URL = "http://localhost:23456";
const SERVER_URL = "https://racetrack.mortenlohne.no";

let gameState = null;
let roundNumber = 0;
let moveCount = 0;

let ninjaGameState = null;
let theme = null;

const ninjaSettingsToSave = [
  "axisLabels",
  "axisLabelsSmall",
  "showMove",
  "showPTN",
  "showToolbarAnalysis",
  "stackCounts",
  "themeID",
];
const ninjaSettingsStorageKey = "ninjaSettings";
let ninjaSettings = localStorage.getItem(ninjaSettingsStorageKey);
if (ninjaSettings) {
  ninjaSettings = JSON.parse(ninjaSettings);
}

const ninja = document.getElementById("ninja").contentWindow;

function sendToNinja(action, value) {
  ninja.postMessage({ action, value }, "*");
}

function updateNinjaSettings(settings) {
  if ("themeID" in settings) {
    sendToNinja("GET_THEME");
  }
  let hasChanged = false;
  ninjaSettingsToSave.forEach((key) => {
    if (key in settings) {
      if (!ninjaSettings) {
        ninjaSettings = { [key]: settings[key] };
        hasChanged = true;
      } else if (ninjaSettings[key] !== settings[key]) {
        ninjaSettings[key] = settings[key];
        hasChanged = true;
      }
    }
  });
  if (hasChanged) {
    localStorage.setItem(
      ninjaSettingsStorageKey,
      JSON.stringify(ninjaSettings)
    );
  }
}

const chartContainer = document.getElementById("chart-wrapper");
const chart = new Chart(document.getElementById("chart"), {
  type: "line",
  data: {
    labels: [],
    datasets: [],
  },
  options: {
    animations: false,
    maintainAspectRatio: false,
    interaction: {
      mode: "x",
    },
    onClick: ({ x }) => {
      const plyID =
        chart.scales.x.getValueForPixel(x) + gameState.openingMoves.length - 1;
      sendToNinja("GO_TO_PLY", { plyID, isDone: true });
    },
    scales: {
      x: {
        ticks: {
          color: () => {
            return theme
              ? theme.secondaryDark
                ? theme.colors.textLight
                : theme.colors.textDark
              : "";
          },
        },
        grid: {
          color: () => {
            return theme?.colors.bg;
          },
        },
      },
      y: {
        // min: -100,
        // max: 100,
        ticks: {
          color: () => {
            return theme
              ? theme.secondaryDark
                ? theme.colors.textLight
                : theme.colors.textDark
              : "";
          },
        },
        grid: {
          color: () => {
            return theme?.colors.bg;
          },
        },
      },
    },
  },
});

function normalizeEval(cpScore) {
  return cpScore;
  // return Math.min(100, Math.max(-100, cpScore || 0));
}

const player1LineColor = () => theme?.colors.player1 || "white";
const player2LineColor = () => theme?.colors.player2 || "black";
const player1FillColor = () =>
  theme?.colors.player1clear.replace(/00$/, "33") || "white";
const player2FillColor = () =>
  theme?.colors.player2clear.replace(/00$/, "33") || "black";

function updateChart() {
  if (!gameState) {
    return;
  }

  let scores = gameState.moves.map((move, ply) => ({
    ply: ply + gameState.openingMoves.length,
    score: normalizeEval(move.uciInfo?.cpScore),
  }));

  scores.push({
    ply: scores.length,
    score: normalizeEval(gameState.currentMoveUciInfo?.cpScore),
  });

  chart.data = {
    labels: scores.map((row) => (row.ply + 1) / 2),
    datasets: [
      {
        label: `${formatName(gameState.whitePlayer)}'s evaluation`,
        data: scores.map(({ ply, score }) => (ply % 2 === 0 ? score : null)),
        spanGaps: true,
        borderColor: player1LineColor,
        backgroundColor: player1FillColor,
        fill: {
          target: "origin",
          above: player1FillColor,
          below: player2FillColor,
        },
      },
      {
        label: `${formatName(gameState.blackPlayer)}'s evaluation`,
        data: scores.map(({ ply, score }) => (ply % 2 === 1 ? -score : null)),
        spanGaps: true,
        borderColor: player2LineColor,
        backgroundColor: player2FillColor,
        fill: {
          target: "origin",
          above: player1FillColor,
          below: player2FillColor,
        },
      },
    ],
  };
  chart.update();
}

function resizeChart() {
  chart.resize(chartContainer.offsetWidth, chartContainer.offsetHeight);
}
resizeChart();
window.addEventListener("resize", resizeChart);

function updateTheme(newTheme) {
  theme = newTheme;

  const textColor = theme
    ? theme.secondaryDark
      ? theme.colors.textLight
      : theme.colors.textDark
    : "";

  document.body.style.background = theme.colors.bg;
  chartContainer.style.background = theme.colors.panel;
  Chart.defaults.color = textColor;
  chart.update();
}

function formatName(name) {
  return name.replace(/^(.*[\/\\])/g, "");
}

function formatAnalysis(uciInfo, currentPlayer, tps = null) {
  const { cpScore, depth, hashfull, nodes, nps, pv, seldepth, time } = uciInfo;

  let evaluation = cpScore;

  if (currentPlayer === 2) {
    evaluation = -evaluation;
  }

  return {
    tps,
    evaluation,
    depth,
    hashfull,
    nodes,
    nps,
    pv,
    seldepth,
    time,
  };
}

function setAnalysis(
  plyID,
  currentPlayer,
  tps = null,
  isAtEndOfMainBranch = false
) {
  if (isAtEndOfMainBranch && gameState.currentMoveUciInfo) {
    sendToNinja(
      "SET_ANALYSIS",
      formatAnalysis(gameState.currentMoveUciInfo, currentPlayer)
    );
  }
  if (plyID < gameState.openingMoves.length) {
    return null;
  }
  const move = gameState.moves[plyID - gameState.openingMoves.length + 1];
  if (move && move.uciInfo) {
    sendToNinja(
      "SET_ANALYSIS",
      formatAnalysis(move.uciInfo, currentPlayer, tps)
    );
  }
}

async function fetchLoop() {
  const evtSource = new EventSource(SERVER_URL + "/0/sse");

  evtSource.onmessage = (event) => {
    const patch = JSON.parse(event.data);
    gameState = applyPatch(gameState, patch).newDocument;
    if (gameState !== null) {
      updateGameState();
    }
  };

  evtSource.onerror = (error) => {
    console.error("Error in SSE connection:", error);
    gameState = null;
    evtSource.close();
    window.setTimeout(fetchLoop, 2000);
  };
}

function updateGameState() {
  if (roundNumber !== gameState.roundNumber) {
    // New game
    roundNumber = gameState.roundNumber;
    moveCount = gameState.moves.length;
    let ptn = `[TPS "${gameState.openingTps}"]`;
    ptn += `\n[Player1 "${formatName(gameState.whitePlayer)}"]`;
    ptn += `\n[Player2 "${formatName(gameState.blackPlayer)}"]`;
    ptn += `\n[Size "${gameState.size}"]`;
    ptn += `\n[Site "Racetrack"]`;
    ptn += `\n[Round "${gameState.roundNumber}"]`;
    ptn += `\n[Komi "${Number(gameState.halfKomi) / 2}"]`;
    ptn +=
      " " +
      gameState.openingMoves
        .concat(gameState.moves.map(({ move }) => move))
        .join(" ");

    sendToNinja("SET_NAME", `Tak Engine Championship: Game ${roundNumber}`);
    sendToNinja("SET_CURRENT_PTN", ptn);
    sendToNinja("LAST");
  } else if (moveCount < gameState.moves.length) {
    // New move(s)
    gameState.moves.slice(moveCount).forEach((move) => {
      sendToNinja("APPEND_PLY", move.move);
    });
    moveCount = gameState.moves.length;
  } else if (
    ninjaGameState.isAtEndOfMainBranch &&
    gameState.currentMoveUciInfo
  ) {
    // New analysis
    sendToNinja(
      "SET_ANALYSIS",
      formatAnalysis(gameState.currentMoveUciInfo, ninjaGameState.turn)
    );
  }

  // Update the eval chart
  updateChart();
}

//#region PTN Ninja init
window.addEventListener(
  "message",
  (event) => {
    if (event.source !== ninja) {
      return;
    }

    const { action, value } = event.data;

    switch (action) {
      case "GAME_STATE":
        if (!ninjaGameState) {
          // Initiate connection to server
          fetchLoop();

          if (ninjaSettings) {
            // Restore previous settings
            sendToNinja("SET_UI", ninjaSettings);
          }
          if (!ninjaSettings || !("themeID" in ninjaSettings)) {
            // Request theme info
            sendToNinja("GET_THEME");
          }
        }
        ninjaGameState = value;
        if (gameState) {
          // Show analysis for current position
          setAnalysis(
            ninjaGameState.boardPly ? ninjaGameState.boardPly.id : -1,
            ninjaGameState.turn,
            ninjaGameState.tps,
            ninjaGameState.isAtEndOfMainBranch
          );
        }
        break;
      case "GET_THEME":
        updateTheme(value);
        break;
      case "SET_UI":
        updateNinjaSettings(value);
        break;
      case "GAME_END":
        sendToNinja("NOTIFY", {
          icon: "result",
          message: `Game ${roundNumber} ended ${value.result.player1}-${value.result.player2}`,
          position: "top-right",
          actions: [
            {
              color: "primary",
              label: "View",
              icon: "open_in_new",
              action: "VIEW_FINISHED_GAME",
              value: value.url,
            },
            {
              icon: "close",
            },
          ],
        });
        break;
      case "VIEW_FINISHED_GAME":
        window.open(value, "_blank");
        break;
    }
  },
  false
);
