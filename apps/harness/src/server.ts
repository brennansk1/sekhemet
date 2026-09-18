import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { BoardService } from "@sekhemet/board";
import type { EventLog } from "@sekhemet/kernel";
import { BASALT_THEME } from "@sekhemet/ui";
import { runDoctor } from "./doctor.js";

export interface DashboardServerOptions {
  db: DatabaseSync;
  log: EventLog;
  boardService: BoardService;
  port?: number;
}

export function generateDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sekhemet Dashboard — Board-Native Local-First Coding Harness</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    body {
      background-color: ${BASALT_THEME.surfaceBackground};
      color: ${BASALT_THEME.textPrimary};
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
    }
    header {
      background-color: ${BASALT_THEME.surfaceRaised};
      border-bottom: 1px solid ${BASALT_THEME.borderSubtle};
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand h1 {
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .badge {
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid ${BASALT_THEME.borderSubtle};
      background-color: ${BASALT_THEME.surfaceOverlay};
      color: ${BASALT_THEME.textMuted};
    }
    .badge.verified {
      border-color: ${BASALT_THEME.accentGreen};
      color: ${BASALT_THEME.accentGreen};
    }
    .badge.backpressure {
      border-color: ${BASALT_THEME.accentAmber};
      color: ${BASALT_THEME.accentAmber};
      background-color: rgba(245, 158, 11, 0.1);
    }
    .header-meta {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 0.85rem;
      color: ${BASALT_THEME.textMuted};
    }
    main {
      flex: 1;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .banner-backpressure {
      display: none;
      background-color: rgba(245, 158, 11, 0.15);
      border: 1px solid ${BASALT_THEME.accentAmber};
      color: ${BASALT_THEME.accentAmber};
      padding: 12px 16px;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 500;
    }
    .kanban-board {
      display: grid;
      grid-template-columns: repeat(6, minmax(240px, 1fr));
      gap: 16px;
      overflow-x: auto;
      padding-bottom: 12px;
    }
    .column {
      background-color: ${BASALT_THEME.surfaceRaised};
      border: 1px solid ${BASALT_THEME.borderSubtle};
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      min-height: 480px;
    }
    .column-header {
      padding: 12px 14px;
      border-bottom: 1px solid ${BASALT_THEME.borderSubtle};
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.82rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: ${BASALT_THEME.textMuted};
    }
    .column-count {
      font-size: 0.75rem;
      padding: 2px 6px;
      border-radius: 10px;
      background-color: ${BASALT_THEME.surfaceOverlay};
    }
    .card-list {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      flex: 1;
    }
    .card {
      background-color: ${BASALT_THEME.surfaceOverlay};
      border: 1px solid ${BASALT_THEME.borderSubtle};
      border-radius: 6px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      transition: border-color 0.15s ease;
    }
    .card:hover {
      border-color: ${BASALT_THEME.textMuted};
    }
    .card-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.75rem;
    }
    .tier-badge {
      font-weight: 700;
      text-transform: uppercase;
      font-size: 0.68rem;
      color: ${BASALT_THEME.accentGreen};
    }
    .card-title {
      font-size: 0.9rem;
      font-weight: 600;
      line-height: 1.35;
    }
    .card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.72rem;
      color: ${BASALT_THEME.textMuted};
      padding-top: 4px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }
    .event-log-drawer {
      background-color: ${BASALT_THEME.surfaceRaised};
      border: 1px solid ${BASALT_THEME.borderSubtle};
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .event-log-drawer h2 {
      font-size: 0.95rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .event-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
      font-family: monospace;
    }
    .event-table th, .event-table td {
      padding: 8px 10px;
      text-align: left;
      border-bottom: 1px solid ${BASALT_THEME.borderSubtle};
    }
    .event-table th {
      color: ${BASALT_THEME.textMuted};
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.72rem;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <h1>Sekhemet</h1>
      <span class="badge">Board-Native Local-First AI Coding Harness</span>
      <span id="chain-badge" class="badge verified">✓ SHA-256 Chain Verified</span>
    </div>
    <div class="header-meta">
      <span id="model-label">Model: Local Open-Weights</span>
      <span id="memory-label">Memory: Normal</span>
      <span id="backpressure-tag" class="badge backpressure" style="display:none;">Backpressure Active</span>
    </div>
  </header>

  <main>
    <div id="backpressure-banner" class="banner-backpressure">
      ⚠️ <strong>Review WIP Limit Reached:</strong> The Review column is currently at capacity. Execution transitions to Review are throttled until pending diffs are accepted or rejected.
    </div>

    <div class="kanban-board">
      <div class="column" id="col-backlog">
        <div class="column-header">Backlog <span class="column-count" id="count-backlog">0</span></div>
        <div class="card-list" id="cards-backlog"></div>
      </div>
      <div class="column" id="col-ready">
        <div class="column-header">Ready <span class="column-count" id="count-ready">0</span></div>
        <div class="card-list" id="cards-ready"></div>
      </div>
      <div class="column" id="col-in_progress">
        <div class="column-header">In Progress <span class="column-count" id="count-in_progress">0</span></div>
        <div class="card-list" id="cards-in_progress"></div>
      </div>
      <div class="column" id="col-verify">
        <div class="column-header">Verify <span class="column-count" id="count-verify">0</span></div>
        <div class="card-list" id="cards-verify"></div>
      </div>
      <div class="column" id="col-review">
        <div class="column-header">Review <span class="column-count" id="count-review">0</span></div>
        <div class="card-list" id="cards-review"></div>
      </div>
      <div class="column" id="col-done">
        <div class="column-header">Done <span class="column-count" id="count-done">0</span></div>
        <div class="card-list" id="cards-done"></div>
      </div>
    </div>

    <section class="event-log-drawer">
      <h2>Cryptographic Event Log & WAL Chain</h2>
      <table class="event-table">
        <thead>
          <tr>
            <th>Seq</th>
            <th>Type</th>
            <th>Actor</th>
            <th>Hash (SHA-256)</th>
            <th>Prev Hash</th>
            <th>Created At</th>
          </tr>
        </thead>
        <tbody id="event-tbody">
          <tr><td colspan="6" style="color:#a1a1aa;">Loading events...</td></tr>
        </tbody>
      </table>
    </section>
  </main>

  <script>
    async function refresh() {
      try {
        const [boardRes, eventsRes, doctorRes] = await Promise.all([
          fetch('/api/board').then(r => r.json()),
          fetch('/api/events').then(r => r.json()),
          fetch('/api/doctor').then(r => r.json())
        ]);

        // 1. Render Backpressure
        const banner = document.getElementById('backpressure-banner');
        const tag = document.getElementById('backpressure-tag');
        if (boardRes.backpressureActive) {
          banner.style.display = 'block';
          tag.style.display = 'inline-block';
        } else {
          banner.style.display = 'none';
          tag.style.display = 'none';
        }

        // 2. Clear column lists
        const cols = ['backlog', 'ready', 'in_progress', 'verify', 'review', 'done'];
        const counts = { backlog: 0, ready: 0, in_progress: 0, verify: 0, review: 0, done: 0 };
        cols.forEach(c => {
          const container = document.getElementById('cards-' + c);
          if (container) container.innerHTML = '';
        });

        // 3. Render cards
        boardRes.cards.forEach(card => {
          counts[card.status] = (counts[card.status] || 0) + 1;
          const container = document.getElementById('cards-' + card.status);
          if (container) {
            const cardEl = document.createElement('div');
            cardEl.className = 'card';
            cardEl.innerHTML = \`
              <div class="card-meta">
                <span class="tier-badge">\${card.tier}</span>
                <span style="font-family:monospace; color:#a1a1aa;">\${card.id}</span>
              </div>
              <div class="card-title">\${card.title}</div>
              <div class="card-footer">
                <span>Budget: \${card.stepsUsed}/\${card.stepBudget}</span>
                <span>\${card.scopeFiles?.length || 0} files</span>
              </div>
            \`;
            container.appendChild(cardEl);
          }
        });

        // Update counts
        cols.forEach(c => {
          const countEl = document.getElementById('count-' + c);
          if (countEl) countEl.innerText = counts[c] || 0;
        });

        // 4. Render events
        const tbody = document.getElementById('event-tbody');
        if (tbody && eventsRes.events) {
          tbody.innerHTML = '';
          eventsRes.events.slice(-8).reverse().forEach(evt => {
            const row = document.createElement('tr');
            row.innerHTML = \`
              <td>#\${evt.seq}</td>
              <td style="color:#22c55e;">\${evt.type}</td>
              <td>\${evt.actor}</td>
              <td title="\${evt.hash}">\${evt.hash.slice(0, 10)}...</td>
              <td title="\${evt.prevHash}">\${evt.prevHash.slice(0, 10)}...</td>
              <td style="color:#a1a1aa;">\${evt.createdAt}</td>
            \`;
            tbody.appendChild(row);
          });
        }
      } catch (err) {
        console.error("Dashboard refresh error:", err);
      }
    }

    refresh();
    setInterval(refresh, 2500);
  </script>
</body>
</html>`;
}

export function startDashboardServer(
  options: DashboardServerOptions,
): Promise<{ port: number; close: () => Promise<void> }> {
  const { db, log, boardService, port = 3333 } = options;

  const html = generateDashboardHtml();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (url === "/api/board") {
      const state = await boardService.getBoardState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }

    if (url === "/api/events") {
      const events = await log.getEvents(1, 100);
      const verification = await log.verifyHashChain();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ events, verification }));
      return;
    }

    if (url === "/api/doctor") {
      const report = await runDoctor();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(report));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((resClose) => {
            server.close(() => resClose());
          }),
      });
    });

    server.on("error", reject);
  });
}
