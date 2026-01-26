# Tak Engine Championship

A web-based visualization tool for watching live Tak engine matches. This application displays games in real-time using [PTN Ninja](https://ptn.ninja/) for board visualization and includes an interactive evaluation chart.

## Features

- **Live Game Display**: Watch Tak engine matches in real-time via an embedded PTN Ninja viewer
- **Evaluation Chart**: Interactive chart showing engine evaluations throughout the game
- **Theme Sync**: Chart colors automatically match the PTN Ninja theme
- **Game History**: Notifications when games end with links to view completed games
- **Persistent Settings**: Board and chart preferences are saved locally

## Requirements

- A running instance of [Racetrack](https://github.com/MortenLohne/racetrack) on the `http` branch
- A modern web browser
- A local HTTP server to serve the files

## Setup

### 1. Set up Racetrack

Clone Racetrack, checkout the `http` branch, and build it:

```bash
git clone https://github.com/MortenLohne/racetrack.git
cd racetrack
git checkout http
cargo build --release
```

### 2. Start Racetrack

Run a match between engines. See the [Racetrack README](https://github.com/MortenLohne/racetrack) for full usage details.

Example:

```bash
cargo run --release -- --engine path=tiltak --engine path=taktician arg=tei --games 10 --all-engines tc=60
```

### 3. Serve the Visualization

Serve this project using any HTTP server. For example, using Python:

```bash
cd tak-engine-championship
python -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

### 4. Configure Server URL (if needed)

By default, the application connects to `https://racetrack.mortenlohne.no`. If Racetrack is running on a different URL, edit the `SERVER_URL` constant in `index.js`:

```javascript
const SERVER_URL = "http://localhost:23456";
```

## Usage

Once connected, the interface displays:

- **Left/Top**: PTN Ninja board showing the current game position
- **Right/Bottom**: Evaluation chart showing each engine's winning probability over time

### Interactions

- **Click on the chart** to jump to that position in the game
- **Click the legend** to toggle between fixed and dynamic Y-axis scaling
- Use PTN Ninja's built-in controls to navigate the game

## Technology

- Vanilla JavaScript with ES modules
- [Chart.js](https://www.chartjs.org/) for evaluation visualization
- [PTN Ninja](https://ptn.ninja/) embedded via iframe for board display
- Server-Sent Events (SSE) for real-time updates from Racetrack
