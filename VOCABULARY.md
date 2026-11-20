# Vocabulary

The terms this project uses, one row each. A term earns a row when it is load-bearing and could be read more than one way.

| Term | Meaning |
|---|---|
| **GHOST** | **G**overned **H**arness for **O**perator **S**ystems and **T**asks. The agent this project runs: one always-on Claude Code session, under its operator's own keys, governed by its operator's rules. Written in capitals when it means the acronym; "GHOST Protocol" is the project. |
| **RECAP** | **RE**construction **CAP**ability. Everything that lets a GHOST be rebuilt on a fresh machine and come back as itself: the boot script ([`install/boot.sh`](install/boot.sh)), the encrypted backup it restores (the kit), and the lock that keeps two copies from running at once (the lease); the kit and the lease are still to be built. Said as a word: "does RECAP handle this?", "update RECAP with …". A change to a GHOST's machine that RECAP does not repeat is not done yet. |
| **Task root** | A top-level Buzz message that stands for one task: its thread is the task, and the agent's state reaction on it says whether something is left (open), nothing is (done), or it is an emergency. With DM task roots on, every top-level DM from the operator is one, and so is each result the agent starts in that DM and each alert its instance sends ([DM task roots](adapters/buzz/README.md#dm-task-roots)). Not a thread root in general: a root is a task root only once it carries the agent's state. |
| **Memory backup** | The backup of a GHOST's Claude Code auto-memory: the folder of notes (`MEMORY.md` and the notes beside it) that Claude Code and the agent rewrite as they go. It lives on the branch `memory/<name>` of the instance's own repo ([Memory backup](README.md#memory-backup)). Not the **memory guard**, which is about RAM: earlyoom, killing one process before the machine runs out of memory. A rebuilt machine gets its notes back from the branch with `backup restore`. |
