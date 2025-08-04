import { applyPatch } from "https://esm.sh/fast-json-patch@3.1.1";
import Chart from "https://esm.sh/chart.js@4.5.0/auto";

// const SERVER_URL = "http://localhost:23456";
const SERVER_URL = "https://racetrack.mortenlohne.no";

let gameState = null;
let roundNumber = 0;
let moveCount = 0;
let previousGame = null;

let ninjaGameState = null;
let theme = null;

const ninja = document.getElementById("ninja").contentWindow;

function sendToNinja(action, value) {
  ninja.postMessage({ action, value }, "*");
}

//#region PTN Ninja settings

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

//#region Chart settings

const chartSettingsStorageKey = "chartSettings";
let chartSettings = localStorage.getItem(chartSettingsStorageKey);
if (chartSettings) {
  chartSettings = JSON.parse(chartSettings);
} else {
  chartSettings = {
    fixYAxis: false,
  };
}
function setChartSettings(key, value) {
  chartSettings[key] = value;
  localStorage.setItem(chartSettingsStorageKey, JSON.stringify(chartSettings));
  const scale = chartSettings.fixYAxis ? 100 : 10;
  chart.config.options.scales.y.suggestedMax = scale;
  chart.config.options.scales.y.suggestedMin = -scale;
  chart.update();
}

//#region Chart initialization

const chartContainer = document.getElementById("chart-wrapper");

const verticalLinePlugin = {
  getLinePosition(chart, pointIndex) {
    const meta = chart.getDatasetMeta(0); // first dataset is used to discover X coordinate of a point
    const data = meta.data;
    return data[pointIndex]?.x;
  },

  renderVerticalLine(chartInstance, pointIndex) {
    const lineLeftOffset = this.getLinePosition(chartInstance, pointIndex);
    if (lineLeftOffset === null) {
      return;
    }
    const scale = chartInstance.scales.y;
    const context = chartInstance.ctx;
    // render vertical line
    context.beginPath();
    context.strokeStyle = theme.colors.primary;
    context.moveTo(lineLeftOffset, scale.top);
    context.lineTo(lineLeftOffset, scale.bottom);
    context.stroke();
  },

  beforeDatasetsDraw(chart) {
    if (chart.config._config.lineAtIndex !== null) {
      this.renderVerticalLine(chart, chart.config._config.lineAtIndex);
    }
  },
};

const chart = new Chart(document.getElementById("chart"), {
  type: "line",
  data: {
    labels: [],
    datasets: [],
  },
  lineAtIndex: null,
  plugins: [verticalLinePlugin],
  options: {
    animations: false,
    maintainAspectRatio: false,
    onClick: ({ x }) => {
      const plyID =
        chart.scales.x.getValueForPixel(x) + gameState.openingMoves.length - 1;
      sendToNinja("GO_TO_PLY", { plyID, isDone: true });
      ninja.focus();
    },
    plugins: {
      legend: {
        onClick: () => {
          setChartSettings("fixYAxis", !chartSettings.fixYAxis);
        },
      },
    },
    tension: 0.3,
    pointRadius: 2,
    pointBorderWidth: 2,
    pointHoverBorderWidth: 5,
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
        suggestedMin: chartSettings.fixYAxis ? -100 : -10,
        suggestedMax: chartSettings.fixYAxis ? 100 : 10,
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

const player1LineColor = () => theme?.colors.player1 || "white";
const player2LineColor = () => theme?.colors.player2 || "black";
const player1FillColor = () =>
  theme?.colors.player1clear.replace(/00$/, "33") || "white";
const player2FillColor = () =>
  theme?.colors.player2clear.replace(/00$/, "33") || "black";

//#region Chart sync

function updateChart() {
  if (!gameState) {
    return;
  }

  let scores = gameState.moves.map((move, ply) => {
    return {
      ply: ply + gameState.openingMoves.length,
      score: winningProbability(move.uciInfo),
    };
  });

  scores.push({
    ply: scores.length + gameState.openingMoves.length,
    score: winningProbability(gameState.currentMoveUciInfo),
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
    ].sort((a) => (a.data[a.data.length - 1] === null ? 1 : -1)),
  };
  chart.update();
}

function resizeChart() {
  chart.resize(chartContainer.offsetWidth, chartContainer.offsetHeight);
}
resizeChart();
window.addEventListener("resize", resizeChart);

function updateChartVerticalLine(plyID = null) {
  chart.config._config.lineAtIndex =
    gameState && plyID !== null
      ? plyID - gameState.openingMoves.length + 1
      : null;
  chart.update();
}

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

//#region Formatting helpers

function formatName(name) {
  return name.replace(/^(.*[\/\\])/g, "");
}

function formatAnalysis(uciInfo, currentPlayer, tps = null) {
  const { depth, hashfull, nodes, nps, pv, seldepth, time } = uciInfo;

  let evaluation = winningProbability(uciInfo);

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

function formatEvalNote(uciInfo, turn) {
  let { evaluation, depth, nodes, time } = formatAnalysis(uciInfo, turn);
  evaluation = Math.round(10 * evaluation) / 1000;
  if (evaluation >= 0) {
    evaluation = `+${evaluation}`;
  }
  if (depth) {
    depth = `/${depth}`;
  }
  return `${evaluation}${depth || ""} ${nodes} nodes ${time}ms`;
}

function formatPVNote(uciInfo) {
  return `pv ${uciInfo.pv.join(" ")}`;
}

// Extract winning probability, as a number between -100 and 100
function winningProbability(uciInfo) {
  if (uciInfo?.wdl) {
    return uciInfo.wdl[0] / 5 + uciInfo.wdl[1] / 10 - 100;
  } else {
    return uciInfo?.cpScore || 0;
  }
}

//#region Server sync

async function fetchLoop() {
  // Note: Opening an EventSource will not throw, even if the server cannot be reached
  const evtSource = new EventSource(SERVER_URL + "/0/sse");

  evtSource.onopen = () => {
    document.getElementById("loading-text").innerHTML = "Loading games...";
  };

  evtSource.onmessage = (event) => {
    document.getElementById("loading").style.display = "none";
    const patch = JSON.parse(event.data);
    gameState = applyPatch(gameState, patch).newDocument;
    if (gameState !== null) {
      updateGameState();
    }
  };

  evtSource.onerror = (error) => {
    document.getElementById("loading").style.display = "block";
    document.getElementById("loading-text").innerHTML = "Lost connection to the server, reconnecting...";
    console.error("Connection error: ", error);
    gameState = null;
    evtSource.close();
    window.setTimeout(fetchLoop, 2000);
  };
}

function updateGameState() {
  if (
    roundNumber !== gameState.roundNumber ||
    moveCount > gameState.moves.length
  ) {
    // New game
    roundNumber = gameState.roundNumber;
    moveCount = 0;
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
    saveAnalysisToNotes();
    moveCount = gameState.moves.length;
  } else if (moveCount < gameState.moves.length) {
    // New move(s)
    gameState.moves.slice(moveCount).forEach((move) => {
      sendToNinja("APPEND_PLY", move.move);
    });
    saveAnalysisToNotes();
    moveCount = gameState.moves.length;
  } else {
    // New analysis
    setCurrentAnalysis();
  }

  // Update the eval chart
  updateChart();
}

//#region PTN Ninja sync

function setCurrentAnalysis() {
  if (
    gameState &&
    gameState.currentMoveUciInfo &&
    ninjaGameState.isAtEndOfMainBranch
  ) {
    sendToNinja(
      "SET_ANALYSIS",
      formatAnalysis(gameState.currentMoveUciInfo, ninjaGameState.turn)
    );
  }
}

function saveAnalysisToNotes() {
  const notes = {};
  const moves = gameState.openingMoves.concat(gameState.moves);
  const openingMoveCount = gameState.openingMoves.length;
  moves.slice(openingMoveCount + moveCount).forEach((move, i) => {
    const plyID = i + openingMoveCount + moveCount;

    // Eval note
    if (moves[plyID - 1]) {
      if (!(plyID - 1 in notes)) {
        notes[plyID - 1] = [];
      }
      notes[plyID - 1].push(formatEvalNote(move.uciInfo, 1 + (plyID % 2)));
    }

    // PV note
    if (!(plyID in notes)) {
      notes[plyID] = [];
    }
    notes[plyID].push(formatPVNote(move.uciInfo));
  });
  if (Object.keys(notes).length) {
    sendToNinja("ADD_NOTES", notes);
  }
}

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
        // Show analysis for current position if possible
        setCurrentAnalysis();

        // Update vertical line
        updateChartVerticalLine(
          ninjaGameState.isAtEndOfMainBranch
            ? null
            : ninjaGameState.boardPly?.id
        );
        break;
      case "GET_THEME":
        updateTheme(value);
        break;
      case "SET_UI":
        updateNinjaSettings(value);
        break;
      case "GAME_END":
        previousGame = {
          roundNumber,
          result: value.result,
        };
        sendToNinja("GET_URL");
        break;
      case "GET_URL":
        sendToNinja("NOTIFY", {
          icon: "result",
          message: `Game ${previousGame.roundNumber} ended ${previousGame.result.player1}-${previousGame.result.player2}`,
          position: "top-right",
          actions: [
            {
              color: "primary",
              label: "View",
              icon: "open_in_new",
              action: "VIEW_FINISHED_GAME",
              value,
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
