import { subscribe } from "node:diagnostics_channel";
import type { Socket } from "node:net";

/**
 * On SIGTERM `next start` calls server.close(), which waits for every open connection. Node ends the
 * idle keep-alive ones itself, but not a connection that has not sent a byte yet, such as a browser
 * preconnect: Node counts it as a request in progress from the moment it is accepted, and close()
 * also stops the headersTimeout checks that would otherwise end it. Only the client can then release
 * the shutdown (Chrome after about 100 s). Nothing was received on such a connection, so ending it
 * loses no request: a client opens a new connection for its next one.
 */
export function endSilentConnectionsOnShutdown() {
  const sockets = new Set<Socket>();
  subscribe("net.server.socket", message => {
    const { socket } = message as { socket: Socket };
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => { for (const socket of sockets) if (socket.bytesRead === 0) socket.destroy(); });
  }
}
