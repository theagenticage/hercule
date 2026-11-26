// Minimal HTTP CONNECT proxy. Tunnels TLS, logs host names only. cut() destroys open tunnels and refuses new ones.
import net from "node:net";

export interface Proxy {
  url: string;
  port: number;
  hosts: string[];
  cut(): void;
  restore(): void;
  close(): Promise<void>;
}

export const startProxy = async (): Promise<Proxy> => {
  const open = new Set<net.Socket>();
  const hosts: string[] = [];
  let isCut = false;
  const server = net.createServer((client) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onData);
      const rest = head.subarray(end + 4);
      const line = head.subarray(0, head.indexOf("\r\n")).toString();
      const m = /^CONNECT ([^:\s]+):(\d+) /.exec(line);
      if (!m || isCut) {
        client.end(`HTTP/1.1 ${m ? "503 Service Unavailable" : "405 Method Not Allowed"}\r\nConnection: close\r\n\r\n`);
        return;
      }
      const [, host, port] = m;
      const upstream = net.connect(Number(port), host!);
      open.add(upstream);
      upstream.on("close", () => { open.delete(upstream); client.destroy(); });
      upstream.on("error", () => { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); upstream.destroy(); });
      upstream.on("connect", () => {
        hosts.push(`${host}:${port}`);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      client.on("close", () => upstream.destroy());
    };
    client.on("data", onData);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hosts,
    cut() {
      isCut = true;
      for (const s of [...open]) s.destroy();
    },
    restore() {
      isCut = false;
    },
    close() {
      for (const s of [...open]) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
};
