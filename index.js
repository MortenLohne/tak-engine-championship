let ptnNinjaHasLoaded = false;
let gameState = null;

window.addEventListener(
    "message",
    (event) => {
        if (event.source !== ninja.contentWindow) {
            return
        }

        if (!ptnNinjaHasLoaded) {
            if (event.data.action === "GAME_STATE") {
                ptnNinjaHasLoaded = true;
                console.log("ptn.ninja loaded");
                fetchLoop();
            } else {
                return; // Ignore other messages until ptn.ninja is fully loaded
            }
        }
    },
    false
);

const fetchLoop = async () => {
    try {
        const result = await fetch("https://dodo-healthy-eft.ngrok-free.app/0", { headers: { "ngrok-skip-browser-warning": "true" } });
        gameState = await result.json();
    } catch (error) {
        console.error("Error fetching game state:", error);
        window.setTimeout(fetchLoop, 1000);
        return;
    }

    setGameState(gameState);
    window.setTimeout(fetchLoop, 1000);
}

const setGameState = (newGameState) => {
    const ninja = document.getElementById("ninja");
    let newPtn = `[TPS "${newGameState.openingTps}"]`;
    newPtn += `\n[Player1 "${newGameState.whitePlayer}"]`;
    newPtn += `\n[Player2 "${newGameState.blackPlayer}"]`;
    newPtn += `\n[Komi "${newGameState.halfKomi / 2}"]`;
    for (const move of newGameState.openingMoves) {
        newPtn += ` ${move} `;
    }
    for (const move of newGameState.moves) {
        newPtn += ` ${move.move} `;
    }
    console.log("Setting new PTN:", newPtn);
    ninja.contentWindow.postMessage({ action: "SET_CURRENT_PTN", value: newPtn }, "*");
    ninja.contentWindow.postMessage({ action: "LAST", value: "" }, "*");
}
