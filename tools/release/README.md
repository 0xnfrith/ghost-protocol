# tools/release

`release` cuts a release tag. It is a dry run unless `--apply` is given.

```sh
tools/release/release            # the plan for the version in plugin.json, from the tip of origin/main
tools/release/release --apply   # make the annotated tag and push it; the release workflow runs on the tag
```

Run it from a clone of the repository that is released. It refuses unless:

- the tag is `v<version>`, where `<version>` is the one in `.claude-plugin/plugin.json` at the commit it tags;
- the tag is new, on the remote and here, and higher than every existing `v*` tag (a pre-release is below its release); a tag is never moved or deleted;
- the commit is green: every check in `.github/required-checks` has completed with success, from the app the list names, and no other check run on the commit has failed or is still running.

`--commit <sha>` releases an older commit of `main` (the tag must then be that commit's version). The push is plain, never forced. Tests: `tools/release/test`, in temporary repositories with a stand-in `gh`.

## agree

`tools/release/agree` is the one check that everything naming a release's version names the same one: the tag, `plugin.json`, the image's label (and its `GP_IMAGE_VERSION`) and the pin in the installers, `get.sh` and `get.ps1`, as the release fills them in (`<image>:<version>@<digest>`, with the digest of the pushed image). It names each place that differs and exits 1, so the release stops. Places not given are said to be skipped. The release job runs it twice: before it builds, on the tag and `plugin.json`, and after, with the image and the filled installers.

```sh
tools/release/agree --tag v1.2.3 --image-version 1.2.3 --image-digest sha256:<64 hex> --get-sh get.sh --get-ps1 get.ps1
```

## ci/run

`tools/release/ci/run` is what `.github/workflows/release.yml` runs on a tag. From a clean checkout of the tag it:

1. checks that HEAD is the tag's commit, runs `agree` on the tag and `plugin.json`, and runs the scan's public words over the tree;
2. registers arm64 emulation if the machine has none (an enabled aarch64 entry with the `F` flag in `/proc/sys/fs/binfmt_misc`), with Docker's own route: `docker run --privileged tonistiigi/binfmt --install arm64`, the image pinned by digest;
3. builds `linux/amd64` and `linux/arm64` in one buildx build from `docker/Dockerfile` and pushes `<registry>/<owner>/<name>:pre-<version>`. Not `:<version>`: that tag is added when the release is promoted (see "Ours first" below). An image already at either tag is kept, never rebuilt;
4. checks that both platforms are in the pushed image, and starts `gp` and `claude` in each (the arm64 one under emulation);
5. fills the image and its digest into `get.sh` and `get.ps1`, writes `SHA256SUMS` and `release-notes.md` (all in `release-out/`);
6. runs `agree` again, now with the image's label and digest and the two filled files;
7. makes the GitHub release as a pre-release with those three files (or replaces the files and notes of one that exists and is still a pre-release; a promoted one is left as it is). Promoting it is a hand step, taken once one of our own agents runs it cleanly.

Its settings are environment variables (see the top of the script): `GP_RELEASE_TAG` is required; `GP_RELEASE_REGISTRY`, `GP_RELEASE_LOGIN=0` and `GP_RELEASE_GITHUB=0` let it run against a local registry with no GitHub release; `GP_RELEASE_DRY=1` checks and prints the plan only. Only the run's own token is used, and it goes to the registry on stdin.

To try it without GitHub: start a registry (`docker run -d -p 127.0.0.1:5000:5000 registry:2`), check out a tag of the public tree, and run it with `GP_RELEASE_REGISTRY=localhost:5000 GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0`.

## rehearse

`tools/release/rehearse` is the staging proof's first half, run on this machine with no GitHub and no secret: it publishes a commit (default `HEAD`) into a new local bare repository with `tools/publish/publish` (which scans first), checks that the published tree is exactly the allowlist's export, clones it, tags `v<version>` on the public commit and runs `ci/run` there. By default `ci/run` is a dry run. `--build` does the whole release against a local registry (both architectures, the digest in `get.sh` and `get.ps1`, the notes, no GitHub release); that needs Docker and takes a while, as the arm64 half runs under emulation. The real staging repository is the same steps, with the publish and release workflows doing them.

## Ours first: a release is a pre-release until one of our agents runs it cleanly

A release reaches people three ways, and while it is a pre-release none of them offers it:

- `releases/latest/download/get.sh` (and `get.ps1`): GitHub never makes a pre-release the latest.
- An agent's update check (`gp update check`, every hour): it reads the image repository's tags and offers only plain `x.y.z` ones. The release run pushes `:pre-<version>`, so no install is asked to update to a pre-release.
- The Buzz plugin: it pins `<image>:<version>`, the tag alone, which is not in the registry before the promotion.

What does reach it before then: `releases/download/v<version>/get.sh`, the exact version's address. Its pin, `<image>:<version>@<digest>`, pulls by the digest whether the `<version>` tag is there or not (checked on Docker's containerd image store and its classic one). That is how one of our agents runs it first.

The steps, in order:

1. One of our agents runs the release: from the image (`get.sh` of that version), or from a checkout of the tag.
2. On that agent's machine, once it has run for a while, `tools/release/ran-clean` writes the record of it. It reads and changes nothing, and the record holds no key and no relay address:
   ```sh
   tools/release/ran-clean --container gp-<slug> --out ran.json                 # an agent from the image
   tools/release/ran-clean --checkout <dir> --unit <name>.service --out ran.json # an agent from a checkout, run by its unit
   ```
3. `tools/release/mark promote v<version> --ran ran.json` judges the record against the release, and refuses (exit 2, naming every reason) unless:
   - the agent runs this release: the record's version is the tag's; from the image, its image is the one `get.sh` pins (the digest); from a checkout, the checkout is the tag's commit with no tracked file changed;
   - it runs cleanly: running, never started again (restarts 0); from the image, `gp status` says running, relay connected, Claude active and no error; from a checkout, its unit is active and running;
   - for long enough: up `--min-up` minutes (60 by default) when the record was taken.

   With `--apply` it then clears the pre-release mark, makes it the latest release when it is the highest full one, and puts "Promoted on <date>, after one of our own agents had run it cleanly for <time>." in place of the notes' pre-release line.
4. `tools/release/ci/promote` adds the plain tag, `<image>:<version>`, to the digest the release's `get.sh` pins: the same manifest, byte for byte. From then on every install's update check offers it, and the plugin can pull it. It refuses a release that is still a pre-release, a draft or withdrawn, and a `<version>` tag that is there for another digest (a tag is never moved); run again, it has nothing to do. It is meant for the release workflow, on GitHub's `released` event, with the run's own token; by hand it needs a registry sign-in with write access to the package. `GP_RELEASE_GITHUB=0 GP_RELEASE_LOGIN=0 GP_RELEASE_DIGEST=sha256:<64 hex>` runs it against a local registry.

What this does not do: once promoted, `<version>` stays in the registry. A release withdrawn after that (below) is no longer the latest on GitHub, but an install's update check still offers it while it is the highest `x.y.z` tag; the fix there is the next release.

## mark

`tools/release/mark promote <tag> --ran <record>` and `tools/release/mark withdraw <tag> --reason <words>` are the hand steps after a release. A release is made as a pre-release; `promote` clears that mark, once one of our own agents has run it cleanly (the record and what it must show are above), and makes it the "latest" release when it is the highest full one. `withdraw` marks a bad release: it is a pre-release again (GitHub never offers a pre-release as the latest), its notes lead with `WITHDRAWN: <reason>`, and the highest remaining full release becomes the latest, so `releases/latest/download/get.sh` goes back to a good one at once. A dry run unless `--apply` is given. Nothing is deleted and nothing is pushed to git: no tag, release or image goes away, and a withdrawn release's image stays under its own version.
