/**
 * A stand-in for one HTTPS host, for an end-to-end test of a controller that
 * would otherwise reach the real host over the network.
 *
 * The controller sends its requests to the stand-in and nothing leaves the
 * machine. It is the unchanged release binary: the test starts it with the
 * environment `StandIn.controllerEnv` holds. `HTTPS_PROXY` points at a small
 * proxy of the test, which tunnels every `CONNECT` to a local HTTPS server
 * whatever host the controller asked for. `NODE_EXTRA_CA_CERTS` names a
 * self-signed certificate the test made for `host`, so the controller accepts
 * the server as that host. `NO_PROXY` keeps the controller's own traffic with
 * its runner and the app off the proxy. No public operation of the controller
 * has a bypass for this.
 *
 * It runs on Node and on Bun, because the desktop suite and the binary suite
 * both start it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createTcpServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A request the stand-in received. */
export interface StandInRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly body: string;
}

/** What the stand-in answers: a status and a body that is sent as JSON. */
export interface StandInAnswer {
  readonly status: number;
  readonly json: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface StandIn {
  /** The environment to start the controller with, so its requests to `host` reach the stand-in. */
  readonly controllerEnv: Readonly<Record<string, string>>;
  /** Every request received, oldest first. */
  readonly requests: ReadonlyArray<StandInRequest>;
  /** Closes the server and the proxy and deletes the certificate. */
  readonly stop: () => Promise<void>;
}

/** Makes a self-signed certificate for `host` with `openssl`, and writes it into `folder`. */
function writeCertificate(
  folder: string,
  host: string,
): { readonly key: string; readonly cert: string; readonly certFile: string } {
  const keyFile = join(folder, "key.pem");
  const certFile = join(folder, "cert.pem");
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "2",
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=DNS:${host}`,
    ],
    { encoding: "utf8" },
  );
  if (made.status !== 0) {
    throw new Error(`openssl could not make the certificate:\n${made.stderr}`);
  }
  return { key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8"), certFile };
}

/**
 * Starts a stand-in for `host`. `answer` returns the answer to each request,
 * and may read what earlier requests and the test's own state say. The caller
 * calls `stop` when the test ends.
 */
export async function startHttpsStandIn(options: {
  readonly host: string;
  readonly answer: (request: StandInRequest) => StandInAnswer;
}): Promise<StandIn> {
  const folder = mkdtempSync(join(tmpdir(), "hercule-https-stand-in-"));
  const { key, cert, certFile } = writeCertificate(folder, options.host);
  const requests: Array<StandInRequest> = [];

  const https = createHttpsServer({ key, cert }, (request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const received: StandInRequest = {
        method: request.method ?? "GET",
        path: new URL(request.url ?? "/", `https://${options.host}`).pathname,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(received);
      const answer = options.answer(received);
      response.writeHead(answer.status, {
        "content-type": "application/json",
        ...answer.headers,
      });
      response.end(JSON.stringify(answer.json));
    });
  });
  await new Promise<void>((resolve) => https.listen(0, "127.0.0.1", resolve));
  const httpsPort = (https.address() as AddressInfo).port;

  const proxy = createTcpServer((client) => {
    client.once("data", (head) => {
      if (!head.toString("latin1").startsWith("CONNECT ")) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }
      const upstream = connect(httpsPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    client.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;

  return {
    controllerEnv: {
      HTTPS_PROXY: `http://127.0.0.1:${String(proxyPort)}`,
      NO_PROXY: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: certFile,
    },
    requests,
    stop: async () => {
      https.closeAllConnections();
      proxy.close();
      await new Promise<void>((resolve) => https.close(() => resolve()));
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
