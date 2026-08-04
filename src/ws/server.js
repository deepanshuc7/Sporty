import { WebSocket, WebSocketServer } from "ws";
import { isSpoofedBot } from "@arcjet/inspect";
import { arcjetMode, wsArcjet } from "../arcjet.js";

const matchSubscribers = new Map();
const MAX_MATCH_ID = 2_147_483_647;
const MAX_SUBSCRIPTIONS_PER_SOCKET = 100;
const HEARTBEAT_INTERVAL_MS = 30_000;

const webConcurrency = Number(process.env.WEB_CONCURRENCY ?? 1);
if (!Number.isInteger(webConcurrency) || webConcurrency !== 1) {
  throw new Error(
    "WebSocket subscriptions require WEB_CONCURRENCY=1; configure a shared broker before running multiple processes.",
  );
}

function isValidMatchId(matchId) {
  return Number.isInteger(matchId) && matchId > 0 && matchId <= MAX_MATCH_ID;
}

function subscribe(matchId, socket) {
  if (!matchSubscribers.has(matchId)) {
    matchSubscribers.set(matchId, new Set());
  }

  matchSubscribers.get(matchId).add(socket);
}

function unsubscribe(matchId, socket) {
  const subscribers = matchSubscribers.get(matchId);

  if (!subscribers) return;

  subscribers.delete(socket);

  if (subscribers.size === 0) {
    matchSubscribers.delete(matchId);
  }
}

function cleanupSubscriptions(socket) {
  for (const matchId of socket.subscriptions) {
    unsubscribe(matchId, socket);
  }
}

function sendJson(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;

  socket.send(JSON.stringify(payload));
}

function broadcastToAll(wss, payload) {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;

    client.send(JSON.stringify(payload));
  }
}

function broadcastToMatch(matchId, payload) {
  const subscribers = matchSubscribers.get(matchId);
  if (!subscribers || subscribers.size === 0) return;

  const message = JSON.stringify(payload);

  for (const client of subscribers) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
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

function handleMessage(socket, data) {
  let message;

  try {
    message = JSON.parse(data.toString());
  } catch {
    sendJson(socket, { type: 'error', message: 'Invalid JSON'});
    return;
  }

  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    sendJson(socket, { type: "error", message: "Message must be an object" });
    return;
  }

  const messageType =
    typeof message.type === "string" ? message.type.toLowerCase() : "";

  if(messageType === "subscribe") {
    if (!isValidMatchId(message.matchId)) {
      sendJson(socket, { type: "error", message: "Invalid matchId" });
      return;
    }

    const isNewSubscription = !socket.subscriptions.has(message.matchId);
    if (
      isNewSubscription &&
      socket.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_SOCKET
    ) {
      sendJson(socket, {
        type: "error",
        message: "Subscription limit reached",
      });
      return;
    }

    subscribe(message.matchId, socket);
    socket.subscriptions.add(message.matchId);
    sendJson(socket, {type: 'subscribed', matchId: message.matchId});
    return;
  }

  if(messageType === "unsubscribe" && isValidMatchId(message.matchId)) {
    unsubscribe(message.matchId, socket);
    socket.subscriptions.delete(message.matchId);
    sendJson(socket, { type: 'unsubscribed', matchId: message.matchId});
    return;
  }
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

        if (decision.isDenied() && !(spoofedBot && arcjetMode === "DRY_RUN")) {
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
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true;});

    socket.subscriptions = new Set();

    sendJson(socket, { type: "welcome" });

    socket.on('message', (data) => {
      handleMessage(socket, data);
    });

    socket.on('error', () => {
      socket.terminate();
    });

    socket.on('close', () => {
      cleanupSubscriptions(socket);
    });

    socket.on("error", console.error);
  });

  const heartbeatInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      if (client.isAlive === false) {
        cleanupSubscriptions(client);
        client.terminate();
        continue;
      }

      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatInterval.unref();

  const clearHeartbeat = () => clearInterval(heartbeatInterval);
  server.once("close", clearHeartbeat);
  wss.once("close", clearHeartbeat);

  function broadcastMatchCreated(match) {
    broadcastToAll(wss, { type: "match_created", data: match });
  }

  function broadcastCommentary(matchId, comment) {
    broadcastToMatch(matchId, { type: 'message', data: comment });
  }

  return { broadcastMatchCreated, broadcastCommentary };
}
