// gp updater: the update helper. It runs in a container of its own, from the
// same image and exact tag as the agent, beside it, and it alone holds the
// Docker socket:
//
//   docker run -d --name gp-<slug>.updater --restart unless-stopped \
//     -v /var/run/docker.sock:/var/run/docker.sock <image> updater --target gp-<slug>
//
//   --target <container>  the agent's container (required)
//   --poll <seconds>      how often it asks the agent (default 10)
//
// Every poll it runs `gp update poll` in the agent's container (docker exec),
// which also tells the agent that a helper is there. When an update or a way
// back is asked for (gp update request or rollback), it:
//   1. pulls <repository>:<version> while the agent still works (a pull that
//      fails with the image already here goes on with that copy);
//   2. runs `gp update begin`, which waits for start's idle test: busy, it
//      tries again at the next poll;
//   3. swaps: stops and removes the agent's container and runs the same one
//      again (same name, volumes, restart policy and settings) on the new tag;
//   4. checks it: within 2 minutes, `gp status --json` in the new container
//      answers with the new version and no error. If not, it is the way back:
//      the container again on the tag it had, then `gp update failed`;
//   5. after a good swap it moves itself onto the new tag too (a short-lived
//      container from the new image replaces this one under the same name),
//      so the helper always runs the agent's tag.
// A missing or stopped agent container is waited for; the helper stays up.
// It logs to stderr (docker logs), never a key or a token.
import { hostname } from "node:os";
import { GpError } from "./out.mjs";
import { docker as makeDocker } from "./dockerapi.mjs";

export const CHECK_MS = 120 * 1000;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * repository and tag of an image reference with an exact tag, also one pinned
 * by digest (<repo>:<tag>@sha256:<64 hex>, as the release's get.sh runs it and
 * as Docker keeps it in Config.Image); null for an id or a digest alone.
 */
export function parseRef(ref) {
  if (typeof ref === "string") ref = ref.replace(/(:[^/@:]+)@sha256:[0-9a-f]{64}$/, "$1");
  if (typeof ref !== "string" || ref.includes("@") || /^(sha256:)?[0-9a-f]{12,64}$/.test(ref)) return null;
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon <= slash) return null;
  return { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) };
}

/** The GP_<KEY>=<value> lines of a gp command's output, as an object. */
export function gpLines(text) {
  const o = {};
  for (const line of String(text).split("\n")) {
    const m = line.match(/^GP_([A-Z0-9_]+)=(.*)$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

const minus = (list = [], base = []) => (list || []).filter((x) => !(base || []).includes(x));

/** The create request that runs container c again on image ref, keeping what was given at its docker run. */
export function recreateConfig(c, ref, oldImage) {
  const imgCfg = oldImage?.Config ?? {};
  const labels = { ...(c.Config.Labels || {}) };
  for (const k of Object.keys(imgCfg.Labels || {})) if (labels[k] === imgCfg.Labels[k]) delete labels[k];
  const h = c.HostConfig || {};
  const cfg = {
    Image: ref,
    Env: minus(c.Config.Env, imgCfg.Env),
    Labels: labels,
    HostConfig: {
      Binds: h.Binds || [],
      RestartPolicy: h.RestartPolicy || { Name: "no" },
      NetworkMode: h.NetworkMode || "default",
      ...(h.PortBindings && Object.keys(h.PortBindings).length ? { PortBindings: h.PortBindings } : {}),
    },
  };
  // The command and entrypoint only when the docker run gave its own.
  if (JSON.stringify(c.Config.Cmd) !== JSON.stringify(imgCfg.Cmd)) cfg.Cmd = c.Config.Cmd;
  if (JSON.stringify(c.Config.Entrypoint) !== JSON.stringify(imgCfg.Entrypoint)) cfg.Entrypoint = c.Config.Entrypoint;
  if (c.Config.User && c.Config.User !== imgCfg.User) cfg.User = c.Config.User;
  return cfg;
}

export class Helper {
  constructor({ target, d = makeDocker(), log = (l) => process.stderr.write(`${new Date().toISOString()} updater: ${l}\n`), sleep = sleepMs, checkMs = CHECK_MS, self = hostname() }) {
    Object.assign(this, { target, d, log, sleep, checkMs, self });
  }

  async gp(args) {
    const r = await this.d.exec(this.target, ["gp", ...args], { user: "node" });
    return { code: r.code, ...gpLines(r.stdout) };
  }

  /** One poll. Returns what happened: idle, waiting, busy, updated, reverted, failed. */
  async step() {
    const c = await this.d.inspect(this.target);
    if (!c || !c.State?.Running) return "waiting";
    let p;
    try {
      p = await this.gp(["update", "poll"]);
    } catch (e) {
      this.log(`could not ask ${this.target}: ${e.message}`);
      return "waiting";
    }
    if (p.code !== 0 || !p.UPDATE_REQUEST || p.UPDATE_REQUEST === "none") return "idle";
    const to = p.UPDATE_VERSION;
    const from = p.VERSION;
    const ref = parseRef(c.Config.Image);
    if (!ref) {
      this.log(`${this.target} runs ${c.Config.Image}, not <repository>:<tag>; it cannot be updated here`);
      await this.gp(["update", "failed", "--reason", "the agent's image has no repository and tag"]);
      return "failed";
    }
    const newRef = `${ref.repo}:${to}`;
    const oldRef = c.Config.Image;
    if (!this.pulled || this.pulled !== newRef) {
      try {
        this.log(`pulling ${newRef}`);
        await this.d.pull(ref.repo, to);
      } catch (e) {
        if (!(await this.d.imageInspect(newRef))) {
          this.log(`could not pull ${newRef}: ${e.message}`);
          await this.gp(["update", "failed", "--reason", `could not pull ${to}`]);
          return "failed";
        }
        this.log(`could not pull ${newRef} (${e.message}); using the copy already here`);
      }
      this.pulled = newRef;
    }
    const b = await this.gp(["update", "begin"]);
    if (b.UPDATE !== "begun") return "busy";
    this.pulled = null;
    this.log(`${p.UPDATE_REQUEST === "rollback" ? "going back" : "updating"}: ${this.target} from ${from} to ${to}`);
    const oldImage = await this.d.imageInspect(c.Image).catch(() => null);
    if (await this.swap(c, oldImage, newRef, to)) {
      this.log(`${this.target} runs ${to}`);
      await this.moveSelf(newRef).catch((e) => this.log(`the helper stays on its tag: ${e.message}`));
      return "updated";
    }
    this.log(`${to} did not pass its check; back to ${oldRef}`);
    if (await this.swap(c, oldImage, oldRef, from)) {
      await this.gp(["update", "failed", "--reason", `${to} did not start`]).catch(() => {});
      return "reverted";
    }
    this.log(`${this.target} did not come back on ${oldRef} either; see its docker logs`);
    return "failed";
  }

  /** Runs the container again on ref; true when gp status in it answers with version and no error in time. */
  async swap(c, oldImage, ref, version) {
    const name = c.Name.replace(/^\//, "");
    const cfg = recreateConfig(c, ref, oldImage);
    await this.d.stop(name, 30);
    await this.d.remove(name);
    await this.d.create(name, cfg);
    await this.d.start(name);
    const until = Date.now() + this.checkMs;
    while (Date.now() < until) {
      try {
        const r = await this.d.exec(name, ["gp", "status", "--json"], { user: "node" });
        const s = JSON.parse(r.stdout);
        if (s.version === version && s.state !== "error") return true;
      } catch {
        // not up yet
      }
      await this.sleep(2000);
    }
    return false;
  }

  /** Puts this helper on ref: a short-lived container from ref replaces it under its name. */
  async moveSelf(ref) {
    const me = await this.d.inspect(this.self);
    if (!me) throw new Error("this helper's own container was not found");
    if (me.Config.Image === ref) return;
    const id = await this.d.create("", {
      Image: ref,
      Cmd: ["updater", "--replace", me.Id],
      HostConfig: { Binds: me.HostConfig?.Binds || [], AutoRemove: true, NetworkMode: me.HostConfig?.NetworkMode || "default" },
    });
    await this.d.start(id);
    this.log(`the helper moves onto ${ref}`);
  }
}

/** The short-lived side of moveSelf: replaces helper old with the same container on this image. */
export async function replaceHelper(oldId, { d = makeDocker(), self = hostname(), log = (l) => process.stderr.write(`updater: ${l}\n`) } = {}) {
  const old = await d.inspect(oldId);
  const me = await d.inspect(self);
  if (!old || !me) throw new GpError("updater-failed", "could not find the helper to replace");
  const oldImage = await d.imageInspect(old.Image).catch(() => null);
  const cfg = recreateConfig(old, me.Config.Image, oldImage);
  cfg.Cmd = old.Config.Cmd;
  const name = old.Name.replace(/^\//, "");
  await d.remove(old.Id);
  await d.create(name, cfg);
  await d.start(name);
  log(`${name} runs ${me.Config.Image}`);
  return 0;
}

export async function updater(argv, out, { d, sleep = sleepMs, forever = true } = {}) {
  const o = { poll: "10" };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!["--target", "--poll", "--replace"].includes(k) || i + 1 >= argv.length) throw new GpError("usage", "usage: updater --target <container> [--poll <seconds>]", 2);
    o[k.slice(2)] = argv[i + 1];
  }
  if (o.replace) return replaceHelper(o.replace, d ? { d } : {});
  if (!o.target || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(o.target)) throw new GpError("usage", "usage: updater --target <container> [--poll <seconds>]", 2);
  const poll = Math.max(1, Number.parseInt(o.poll, 10) || 10) * 1000;
  out.header();
  const h = new Helper({ target: o.target, ...(d ? { d } : {}), sleep });
  h.log(`watching ${o.target}`);
  do {
    try {
      await h.step();
    } catch (e) {
      h.log(`${e.message}`);
    }
    if (forever) await sleep(poll);
  } while (forever);
  return 0;
}
