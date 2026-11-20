// A small client for the Docker Engine API over its unix socket, for the
// update helper (updater.mjs). It needs no docker command in the image. The
// paths carry no API version, so the daemon answers in its own.
import http from "node:http";

export const SOCKET = process.env.GP_DOCKER_SOCKET || "/var/run/docker.sock";

export class DockerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** One request; resolves { status, body (Buffer) }. A body object is sent as JSON. */
export function request(method, path, { body, socket = SOCKET, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { socketPath: socket, method, path, headers: { Host: "docker", ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new DockerError(0, `the Docker API did not answer ${method} ${path.split("?")[0]} in time`)));
    req.on("error", (e) => reject(e instanceof DockerError ? e : new DockerError(0, `could not reach Docker at ${socket}: ${e.code || e.message}`)));
    if (data) req.write(data);
    req.end();
  });
}

const message = (r) => {
  try {
    return JSON.parse(r.body.toString("utf8")).message || r.body.toString("utf8").trim();
  } catch {
    return r.body.toString("utf8").trim();
  }
};

async function call(method, path, opts = {}, ok = [200, 201, 204, 304]) {
  const r = await request(method, path, opts);
  if (!ok.includes(r.status)) throw new DockerError(r.status, `${method} ${path.split("?")[0]}: ${message(r) || r.status}`);
  return r;
}

const enc = encodeURIComponent;
const json = (r) => (r.body.length ? JSON.parse(r.body.toString("utf8")) : null);

export const docker = (socket = SOCKET) => ({
  /** The container's inspect object, or null when there is none. */
  async inspect(name) {
    const r = await request("GET", `/containers/${enc(name)}/json`, { socket });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new DockerError(r.status, `inspect ${name}: ${message(r)}`);
    return json(r);
  },
  async imageInspect(ref) {
    const r = await request("GET", `/images/${enc(ref)}/json`, { socket });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new DockerError(r.status, `image ${ref}: ${message(r)}`);
    return json(r);
  },
  /** Pulls repo:tag; the API streams progress lines and reports an error as one of them. */
  async pull(repo, tag) {
    const r = await call("POST", `/images/create?fromImage=${enc(repo)}&tag=${enc(tag)}`, { socket, timeoutMs: 30 * 60 * 1000 });
    for (const line of r.body.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.error || o.errorDetail) throw new DockerError(500, `pull ${repo}:${tag}: ${o.error || o.errorDetail.message}`);
    }
  },
  async stop(name, seconds = 30) {
    await call("POST", `/containers/${enc(name)}/stop?t=${seconds}`, { socket, timeoutMs: (seconds + 30) * 1000 }, [204, 304, 404]);
  },
  async remove(name) {
    await call("DELETE", `/containers/${enc(name)}?force=true`, { socket }, [204, 404]);
  },
  async create(name, config) {
    return json(await call("POST", `/containers/create${name ? `?name=${enc(name)}` : ""}`, { socket, body: config })).Id;
  },
  async start(name) {
    await call("POST", `/containers/${enc(name)}/start`, { socket }, [204, 304]);
  },
  /** Runs cmd in the container; resolves { code, stdout, stderr }. */
  async exec(name, cmd, { user } = {}) {
    const e = json(
      await call("POST", `/containers/${enc(name)}/exec`, {
        socket,
        body: { Cmd: cmd, AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, ...(user ? { User: user } : {}) },
      }),
    );
    const r = await call("POST", `/exec/${e.Id}/start`, { socket, body: { Detach: false, Tty: false }, timeoutMs: 180000 });
    const { stdout, stderr } = demux(r.body);
    const info = json(await call("GET", `/exec/${e.Id}/json`, { socket }));
    return { code: info.ExitCode, stdout, stderr };
  },
});

/** Splits the API's multiplexed stream (8-byte headers: stream, 0, 0, 0, size) into stdout and stderr. */
export function demux(buf) {
  const out = [];
  const err = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const kind = buf[i];
    const size = buf.readUInt32BE(i + 4);
    const part = buf.subarray(i + 8, i + 8 + size);
    (kind === 2 ? err : out).push(part);
    i += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}
