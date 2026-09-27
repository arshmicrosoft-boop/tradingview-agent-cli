// Server-Sent Events hub.
//
// Chosen over WebSocket deliberately: everything the console pushes is
// one-way, and node:http gives you a working, correctly-flushing streaming
// response for free. A hand-rolled WebSocket would mean implementing the
// handshake and frame codec to move data in the same single direction.

import { EventEmitter } from "node:events";

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const clients = new Set();
let nextId = 1;

export function sseHandler(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");

  const client = { id: nextId++, res };
  clients.add(client);

  send(client, "hello", { id: client.id, at: new Date().toISOString(), clients: clients.size });

  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      cleanup();
    }
  }, 15000);

  function cleanup() {
    clearInterval(ping);
    clients.delete(client);
  }
  req.on("close", cleanup);
  res.on("error", cleanup);
}

function send(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

export function publish(event, data) {
  for (const c of clients) send(c, event, data);
}

export const clientCount = () => clients.size;
