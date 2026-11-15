import net from "node:net";

/**
 * A local TCP proxy to a database that can go silent (PM-1): it still accepts connections but carries nothing.
 *  - "accept": a new connection is accepted and held; nothing is forwarded in either direction.
 *  - "listen": a new connection signs in normally; from its first `LISTEN` on nothing is forwarded any more.
 * Connections that were open when the link went silent carry nothing either. `heal()` lets NEW connections through
 * again; what the silence caught stays silent toward the client: no answer and no close, ever - not even to the
 * client's own goodbye (allowHalfOpen: a caught socket's FIN is not answered), as on a link that drops everything.
 * So a client that only says goodbye keeps its socket; only a client that destroys it is rid of it.
 *
 * SF-6: for the NotificationHub's LISTEN client only. "listen" mode looks for the text `LISTEN` anywhere in a chunk
 * the client sends, which is right for the hub's plain `LISTEN "channel"` queries and nothing else: other traffic
 * (a query that merely contains the word, a split packet, TLS) would be caught wrongly or not at all. Do not reuse
 * it for the app pool or any other client without changing that.
 */
export type SilentMode = "accept" | "listen";
export type SilentProxy = {
  url: string;
  /** Connections accepted so far. */
  accepted: () => number;
  /** Connections the silence caught. */
  caught: () => number;
  /** The proxy's own ports toward the database, to find the client's sessions in pg_stat_activity. */
  upPorts: () => number[];
  goSilent: (mode?: SilentMode) => void;
  heal: () => void;
  close: () => Promise<void>;
};

type Pair = { down: net.Socket; up?: net.Socket; held: boolean; closed: boolean };
type Handler = (down: net.Socket) => void;

export async function startSilentProxy(databaseUrl: string, initial?: SilentMode): Promise<SilentProxy> {
  const target = new URL(databaseUrl);
  let mode: SilentMode | undefined = initial;
  let accepted = 0;
  const pairs = new Set<Pair>();
  const onConnection: Handler = (down) => {
    accepted += 1;
    const pair: Pair = { down, held: mode === "accept", closed: false };
    pairs.add(pair);
    down.on("error", () => undefined);
    down.on("close", () => {
      pair.closed = true;
      pair.up?.destroy();
    });
    // The client's FIN: answered on a working connection, never on a caught one (the proxy's own database-side
    // session of a caught connection is dropped all the same).
    down.on("end", () => {
      if (pair.held) pair.up?.destroy();
      else down.end();
    });
    if (pair.held) {
      down.resume();
      return;
    }
    const up = net.connect(Number(target.port || 5432), target.hostname);
    pair.up = up;
    up.on("error", () => undefined);
    up.on("close", () => void (pair.held || down.destroy()));
    down.on("data", (chunk: Buffer) => {
      if (!pair.held && mode === "listen" && chunk.includes("LISTEN")) pair.held = true;
      if (!pair.held) up.write(chunk);
    });
    up.on("data", (chunk: Buffer) => {
      if (!pair.held) down.write(chunk);
    });
  };
  const server = net.createServer({ allowHalfOpen: true }, onConnection);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const through = new URL(databaseUrl);
  through.hostname = "127.0.0.1";
  through.port = String((server.address() as net.AddressInfo).port);
  const all = () => [...pairs];
  return {
    url: through.toString(),
    accepted: () => accepted,
    caught: () => all().filter((pair) => pair.held).length,
    upPorts: () => all().flatMap((pair) => (pair.closed || pair.held || pair.up?.localPort === undefined ? [] : [pair.up.localPort])),
    goSilent: (next = "accept") => {
      mode = next;
      for (const pair of pairs) pair.held = true;
    },
    heal: () => {
      mode = undefined;
      // The proxy's own held sessions on the database side are dropped; toward the client they stay silent.
      for (const pair of pairs) if (pair.held) pair.up?.destroy();
    },
    close: async () => {
      for (const pair of pairs) {
        pair.down.destroy();
        pair.up?.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
