// A tiny image registry for the tests, on node:http alone: the two calls the
// release check makes (tags/list, manifests/<tag>), behind an anonymous
// Bearer token as ghcr.io and Docker Hub ask for one. Each tag's manifest is
// an empty multi-architecture index, distinct per tag; its digest is the
// sha256 of those bytes, sent as Docker-Content-Digest as registries do.
//
//   node fake-registry.mjs <port> <tag>...   serve on 127.0.0.1:<port> until killed; each request is printed
//                                            as one line "<method> <url>"
import { createServer } from "node:http";
import { createHash } from "node:crypto";

export const manifestOf = (tag) =>
  Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [], annotations: { "org.opencontainers.image.version": tag } }));
export const digestOf = (tag) => `sha256:${createHash("sha256").update(manifestOf(tag)).digest("hex")}`;

/** Starts the registry for repo path "ghost-protocol"; resolves to {server, port}. */
export function fakeRegistry(tags, port = 0) {
  const server = createServer((req, res) => {
    const host = req.headers.host;
    if (req.url.startsWith("/token?")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "anon" }));
    }
    if (req.headers.authorization !== "Bearer anon") {
      res.writeHead(401, { "www-authenticate": `Bearer realm="http://${host}/token",service="fake",scope="repository:ghost-protocol:pull"` });
      return res.end();
    }
    if (req.url === "/v2/ghost-protocol/tags/list") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ name: "ghost-protocol", tags }));
    }
    const m = req.url.match(/^\/v2\/ghost-protocol\/manifests\/([^/]+)$/);
    if (m && tags.includes(m[1])) {
      res.writeHead(200, { "content-type": "application/vnd.oci.image.index.v1+json", "docker-content-digest": digestOf(m[1]) });
      return res.end(manifestOf(m[1]));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, port: server.address().port })));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [port, ...tags] = process.argv.slice(2);
  const { server } = await fakeRegistry(tags, Number(port));
  server.on("request", (req) => console.log(`${req.method} ${req.url}`));
}
