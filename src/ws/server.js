import { WebSocket, WebSocketServer } from "ws";
import { isSpoofedBot } from "@arcjet/inspect";
import { arcjetMode, wsArcjet } from "../arcjet.js";

function sendJson(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;

  socket.send(JSON.stringify(payload));
}

function broadcast(wss, payload) {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;

    client.send(JSON.stringify(payload));
  }
}

function rejectUpgrade(socket, statusCode, statusText) {
  if (!socket.destroyed) {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
  socket.destroy();
}

export function attachWebSocketServer(server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });

  server.on("upgrade", async (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const onSocketError = (error) => {
      console.error("WS upgrade socket error", error);
    };
    socket.on("error", onSocketError);

    try {
      if (wsArcjet) {
        const decision = await wsArcjet.protect(req);

        if (decision.isErrored()) {
          console.error("Arcjet WS decision error:", decision.reason.message);
          rejectUpgrade(socket, 503, "Service Unavailable");
          return;
        }

        const spoofedBot = decision.results.some(isSpoofedBot);
        if (spoofedBot) {
          if (arcjetMode === "LIVE") {
            rejectUpgrade(socket, 403, "Forbidden");
            return;
          }

          console.warn("Arcjet detected a spoofed bot in DRY_RUN mode");
        }

        if (
          decision.isDenied() &&
          !(spoofedBot && arcjetMode === "DRY_RUN")
        ) {
          if (decision.reason.isRateLimit()) {
            rejectUpgrade(socket, 429, "Too Many Requests");
          } else {
            rejectUpgrade(socket, 403, "Forbidden");
          }
          return;
        }
      }
    } catch (error) {
      console.error("WS authorization error", error);
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }

    socket.removeListener("error", onSocketError);
    wss.handleUpgrade(req, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, req);
    });
  });

  wss.on("connection", (socket) => {
    sendJson(socket, { type: "welcome" });

    socket.on("error", console.error);
  });

  function broadcastMatchCreated(match) {
    broadcast(wss, { type: "match_created", data: match });
  }

  return { broadcastMatchCreated };
}
