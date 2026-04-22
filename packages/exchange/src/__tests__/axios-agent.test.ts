/**
 * Tests for buildClobAxiosAgent — verifies connection-pool cap and idle eviction.
 *
 * Both tests use a local https.createServer with an inline self-signed cert
 * generated via node:crypto.  rejectUnauthorized:false is set on each request.
 * Requests are fired via https.request (not axios) because axios is not a direct
 * dependency of @plankton/exchange; the agent itself is the unit under test.
 */
import { describe, it, expect, afterEach } from "vitest";
import https from "node:https";
import crypto from "node:crypto";
import { buildClobAxiosAgent } from "../live/axios-agent.js";

// ---------------------------------------------------------------------------
// Inline self-signed cert generation
// ---------------------------------------------------------------------------

function generateSelfSignedCert(): { key: string; cert: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const certPem = buildMinimalSelfSignedCertPem(privateKey, publicKey);
  return { key: keyPem, cert: certPem };
}

function buildMinimalSelfSignedCertPem(
  privateKey: crypto.KeyObject,
  publicKey: crypto.KeyObject,
): string {
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  const algIdRaw = Buffer.from("300d06092a864886f70d01010b0500", "hex");
  const version = encodeExplicit(0, encodeInteger(Buffer.from([0x02])));
  const serialNumber = encodeInteger(Buffer.from([0x01]));
  const name = encodeSequence(
    encodeSet(encodeSequence(Buffer.concat([encodeOid([2, 5, 4, 3]), encodeUtf8("localhost")]))),
  );
  const notBefore = encodeUtcTime("700101000000Z");
  const notAfter = encodeUtcTime("491231235959Z");
  const validity = encodeSequence(Buffer.concat([notBefore, notAfter]));
  const tbs = encodeSequence(
    Buffer.concat([version, serialNumber, algIdRaw, name, validity, name, spkiDer]),
  );

  const sig = crypto.sign("sha256", tbs, privateKey);
  const sigBitString = encodeBitString(sig);
  const certDer = encodeSequence(Buffer.concat([tbs, algIdRaw, sigBitString]));

  const b64 = certDer.toString("base64");
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

// Minimal ASN.1 DER helpers

function encodeTlv(tag: number, value: Buffer): Buffer {
  const len = value.length;
  let lenBuf: Buffer;
  if (len < 128) {
    lenBuf = Buffer.from([len]);
  } else if (len < 256) {
    lenBuf = Buffer.from([0x81, len]);
  } else {
    lenBuf = Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  }
  return Buffer.concat([Buffer.from([tag]), lenBuf, value]);
}

function encodeSequence(value: Buffer): Buffer {
  return encodeTlv(0x30, value);
}

function encodeSet(value: Buffer): Buffer {
  return encodeTlv(0x31, value);
}

function encodeInteger(value: Buffer): Buffer {
  const v = value[0]! & 0x80 ? Buffer.concat([Buffer.from([0x00]), value]) : value;
  return encodeTlv(0x02, v);
}

function encodeExplicit(tag: number, value: Buffer): Buffer {
  return encodeTlv(0xa0 | tag, value);
}

function encodeBitString(value: Buffer): Buffer {
  return encodeTlv(0x03, Buffer.concat([Buffer.from([0x00]), value]));
}

function encodeOid(components: number[]): Buffer {
  const body: number[] = [40 * components[0]! + components[1]!];
  for (let i = 2; i < components.length; i++) {
    let val = components[i]!;
    const bytes: number[] = [];
    bytes.unshift(val & 0x7f);
    val >>= 7;
    while (val > 0) {
      bytes.unshift((val & 0x7f) | 0x80);
      val >>= 7;
    }
    body.push(...bytes);
  }
  return encodeTlv(0x06, Buffer.from(body));
}

function encodeUtf8(str: string): Buffer {
  return encodeTlv(0x0c, Buffer.from(str, "utf8"));
}

function encodeUtcTime(str: string): Buffer {
  return encodeTlv(0x17, Buffer.from(str, "ascii"));
}

// ---------------------------------------------------------------------------
// Helper: start a local HTTPS server that holds each connection open for
// `holdMs` before responding 200.
// ---------------------------------------------------------------------------

function startHoldServer(
  certPem: string,
  keyPem: string,
  holdMs: number,
): Promise<{ server: https.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = https.createServer({ cert: certPem, key: keyPem }, (_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("ok");
      }, holdMs);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

// Fire a single HTTPS request through the agent and return its body
function makeRequest(agent: https.Agent, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "GET",
        agent,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------

describe("buildClobAxiosAgent", () => {
  let server: https.Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  it("caps concurrent sockets at maxSockets (plan step 2.4)", async () => {
    const { key, cert } = generateSelfSignedCert();
    const { server: srv, port } = await startHoldServer(cert, key, 400);
    server = srv;

    const agent = buildClobAxiosAgent({ maxSockets: 2, maxFreeSockets: 0, idleTimeoutMs: 30_000 });

    // Fire 4 concurrent requests
    const promises = Array.from({ length: 4 }, () => makeRequest(agent, port));

    // Poll socket count while requests are in-flight
    const socketCounts: number[] = [];
    const pollId = setInterval(() => {
      const count = Object.values(agent.sockets).reduce((n, arr) => n + (arr?.length ?? 0), 0);
      socketCounts.push(count);
    }, 20);

    await Promise.all(promises);
    clearInterval(pollId);

    // At no point should more than maxSockets sockets be simultaneously open
    const maxObserved = Math.max(...socketCounts, 0);
    expect(maxObserved).toBeLessThanOrEqual(2);
  }, 10_000);

  it("evicts idle sockets after idleTimeoutMs (plan step 2.5)", async () => {
    const { key, cert } = generateSelfSignedCert();
    const { server: srv, port } = await startHoldServer(cert, key, 0);
    server = srv;

    const idleTimeoutMs = 200;
    const agent = buildClobAxiosAgent({
      maxSockets: 4,
      maxFreeSockets: 2,
      idleTimeoutMs,
    });

    await makeRequest(agent, port);

    // After the request, the socket should move into freeSockets (keepAlive pool).
    // Poll briefly in case it is still transitioning.
    let freeCount = 0;
    const deadline = Date.now() + 100;
    while (freeCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      freeCount = Object.entries(agent.freeSockets)
        .filter(([k]) => k.startsWith(`127.0.0.1:${port}`))
        .reduce((n, [, arr]) => n + (arr?.length ?? 0), 0);
    }
    expect(freeCount).toBeGreaterThan(0);

    // Wait for idle timeout + buffer; socket should be evicted
    await new Promise((r) => setTimeout(r, idleTimeoutMs + 150));

    const freeCountAfter = Object.entries(agent.freeSockets)
      .filter(([k]) => k.startsWith(`127.0.0.1:${port}`))
      .reduce((n, [, arr]) => n + (arr?.length ?? 0), 0);
    expect(freeCountAfter).toBe(0);
  }, 10_000);
});
