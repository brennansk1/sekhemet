import {
  constants,
  accessSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { type Server, type Socket, connect, createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * DEC-50: on Linux a command runs in an empty network namespace (bubblewrap's
 * `--unshare-net`, srt's too), so its egress proxy and its named loopback
 * ports (`localPorts`: a dev server, the browser's DevTools port, the app a
 * browser loads) are reached through relays across it, as srt does for its
 * own proxy. Each port gets a Unix socket in the command's scratch directory,
 * which the sandbox binds in:
 *
 * - inward (`f`): something on the host already listens on the port (the
 *   proxy, another card process's relay). The relay inside listens on the
 *   same loopback port and passes each connection to the socket; the harness
 *   listens on the socket and connects to the port on the host.
 * - outward (`r`): the port is free, so it is the command's own (a dev
 *   server). The relay inside listens on the socket and connects to the port
 *   inside; the harness listens on the port on the host's loopback (both
 *   `127.0.0.1` and `::1`) and connects to the socket. The host port must be
 *   free, and the harness holds it for the command's life.
 *
 * Each connection to a port tries `127.0.0.1` and then `::1`, inside and on
 * the host, so a server listening on `::1` alone is reached (C5).
 *
 * Nothing else crosses: a port no one named has no listener inside, so a
 * connection to it is refused. The host half never follows a path the
 * command can rewrite: an outward socket is opened by its inode, and must be
 * a socket (`connectPinned`, security item 14b). The inside half is `bin/sekhemet-relay`, a
 * POSIX script over socat (srt's own Linux dependency).
 */

export const RELAY_NAME = "sekhemet-relay";

export interface RelaySpec {
  /** `f`: inward, the host listens; `r`: outward, the command listens. */
  kind: "f" | "r";
  port: number;
  /** The Unix socket in the scratch directory that crosses the namespace. */
  socket: string;
}

/** Where the inside half lives: `packages/sandbox/bin`, beside `src` and `dist`. */
export function relayScriptPath(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", RELAY_NAME);
}

let scriptText: string | undefined;
/** The inside half's text: the native engine runs it with `/bin/sh -c`. */
export function relayScript(): string {
  scriptText ??= readFileSync(relayScriptPath(), "utf8");
  return scriptText;
}

/** A Unix socket path holds 107 bytes on Linux. */
const SOCKET_PATH_MAX = 107;
/** Words socat's address syntax and the script's word splitting read literally. */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

/**
 * One relay per distinct valid port, inward where `hostListens(port)`. A
 * socket path that is too long or holds a character socat's address syntax
 * would read gets no relay: that port has no route, as before DEC-50.
 */
export function relayPlan(
  ports: readonly number[],
  dir: string,
  hostListens: (port: number) => boolean,
): RelaySpec[] {
  const out: RelaySpec[] = [];
  for (const p of ports) {
    const port = Math.floor(p);
    if (!(port > 0 && port < 65536) || out.some((s) => s.port === port)) continue;
    const socket = join(dir, `.relay-${port}`);
    if (!SAFE_PATH.test(socket) || Buffer.byteLength(socket) > SOCKET_PATH_MAX) continue;
    out.push({ kind: hostListens(port) ? "f" : "r", port, socket });
  }
  return out;
}

/** The plan as `SEKHEMET_RELAYS`, which the inside half reads. */
export function relayEnv(plan: readonly RelaySpec[]): string {
  return plan.map((s) => `${s.kind}:${s.port}:${s.socket}`).join(" ");
}

/**
 * The loopback ports something on this host listens on, from the kernel's
 * TCP tables (synchronous, so a background process can be planned without
 * waiting). Linux only; elsewhere the set is empty.
 */
export function hostListeningPorts(): Set<number> {
  const ports = new Set<number>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(table, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      // local_address rem_address st: 0A is LISTEN.
      if (f[3] !== "0A") continue;
      const port = Number.parseInt(f[1]?.split(":")[1] ?? "", 16);
      if (Number.isFinite(port)) ports.add(port);
    }
  }
  return ports;
}

let socatCache: boolean | undefined;
/**
 * socat is on the PATH the sandbox's command gets (the README's Linux
 * requirement). Without it no relay is planned and the named ports have no
 * route, as before DEC-50, rather than each command waiting on a relay that
 * cannot start.
 */
export function socatAvailable(): boolean {
  socatCache ??= (process.env.PATH ?? "").split(delimiter).some((d) => {
    try {
      accessSync(join(d, "socat"), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  return socatCache;
}

/**
 * The relays a command under an empty network namespace needs: its egress
 * proxy and its named ports, unless the network is open or nothing is named.
 */
export function commandRelayPlan(options: {
  allowNetwork: boolean;
  egressProxyPort?: number;
  localPorts?: number[];
  scratchDir?: string;
}): RelaySpec[] {
  if (options.allowNetwork || !options.scratchDir) return [];
  const ports = [
    ...(options.egressProxyPort ? [options.egressProxyPort] : []),
    ...(options.localPorts ?? []),
  ];
  if (ports.length === 0 || !socatAvailable()) return [];
  const listening = hostListeningPorts();
  return relayPlan(ports, options.scratchDir, (p) => listening.has(p));
}

/**
 * A connection to a host loopback port, on `127.0.0.1` and then `::1`
 * (security item 14b, C5): a server listening on `::1` alone is reached as
 * one on `127.0.0.1` is. Undefined when neither answers.
 */
function connectLoopback(port: number): Promise<Socket | undefined> {
  const attempt = (host: string) =>
    new Promise<Socket | undefined>((resolve) => {
      const sock = connect(port, host);
      sock.once("connect", () => {
        sock.removeAllListeners("error");
        resolve(sock);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(undefined);
      });
    });
  return attempt("127.0.0.1").then((s) => s ?? attempt("::1"));
}

/** Join two sockets both ways; an error on either ends both. */
function splice(a: Socket, b: Socket): void {
  const end = () => {
    a.destroy();
    b.destroy();
  };
  a.on("error", end);
  b.on("error", end);
  a.pipe(b);
  b.pipe(a);
}

/** Linux's `O_PATH` (asm-generic): an fd naming an inode, opened with no access to it. */
const O_PATH = 0o10000000;

/**
 * Connect to an outward relay's socket without following a path the command
 * can rewrite (security item 14b). The socket is in the command's scratch
 * directory, which it may write: a symlink planted there would otherwise send
 * the harness, unconfined, to any socket on the host (docker.sock, the
 * ssh-agent, the D-Bus session bus). On Linux, the only place relays run,
 * the final component is opened `O_PATH | O_NOFOLLOW`, so the fd pins the
 * inode found: it must be a socket the harness's user owns, and the connect
 * goes through `/proc/self/fd/<fd>` to that very inode, so a swap after the
 * check changes nothing. Elsewhere it is refused unless it is such a socket
 * when looked at. Anything else is no route: the host connection is closed.
 */
function connectPinned(path: string): Socket | undefined {
  const uid = process.getuid?.();
  const owned = (st: { isSocket(): boolean; uid: number }) =>
    st.isSocket() && (uid === undefined || st.uid === uid);
  if (process.platform !== "linux") {
    try {
      return owned(lstatSync(path)) ? connect(path) : undefined;
    } catch {
      return undefined;
    }
  }
  let fd: number;
  try {
    fd = openSync(path, O_PATH | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    if (!owned(fstatSync(fd))) {
      closeSync(fd);
      return undefined;
    }
  } catch {
    closeSync(fd);
    return undefined;
  }
  const sock = connect(`/proc/self/fd/${fd}`);
  const release = () => {
    try {
      closeSync(fd);
    } catch {
      // Closed already.
    }
  };
  sock.once("connect", release);
  sock.once("error", release);
  sock.once("close", release);
  return sock;
}

export interface HostRelays {
  /** Settles once every listener is bound (or failed: that port then has no route). */
  ready: Promise<void>;
  /** Stop listening and remove the sockets. */
  close(): void;
}

/**
 * The host half: for an inward relay a listener on its socket, bound before
 * this returns, so the command can start at once; for an outward one a
 * listener on the host's loopback port. Close it when the command exits.
 */
export function startHostRelays(plan: readonly RelaySpec[]): HostRelays {
  const servers: Server[] = [];
  const bound: Promise<void>[] = [];
  const serve = (handler: (c: Socket) => void, listen: (s: Server) => void): void => {
    const server = createServer(handler);
    server.unref();
    bound.push(
      new Promise<void>((resolve) => {
        server.once("listening", () => resolve());
        // A host port taken since the plan, or no IPv6 loopback: no route there.
        server.once("error", () => resolve());
      }),
    );
    listen(server);
    servers.push(server);
  };
  for (const spec of plan) {
    if (spec.kind === "f") {
      // An inward relay's socket is the harness's own: to the host's port on
      // either loopback (C5), whichever the server there listens on.
      rmSync(spec.socket, { force: true });
      serve(
        (c) => {
          c.pause();
          c.on("error", () => c.destroy());
          void connectLoopback(spec.port).then((host) => {
            if (host && !c.destroyed) {
              splice(c, host);
              c.resume();
            } else {
              host?.destroy();
              c.destroy();
            }
          });
        },
        (s) => s.listen(spec.socket),
      );
      continue;
    }
    // An outward relay's socket is made inside: the host's port, on both
    // loopbacks (C5), reaches it — 14b: never by a path the command can rewrite.
    const outward = (c: Socket) => {
      const inside = connectPinned(spec.socket);
      if (inside) splice(c, inside);
      else c.destroy();
    };
    serve(outward, (s) => s.listen(spec.port, "127.0.0.1"));
    serve(outward, (s) => s.listen({ port: spec.port, host: "::1", ipv6Only: true }));
  }
  return {
    ready: Promise.all(bound).then(() => undefined),
    close: () => {
      for (const s of servers) {
        try {
          s.close();
        } catch {
          // Never bound.
        }
      }
      for (const spec of plan) rmSync(spec.socket, { force: true });
    },
  };
}
