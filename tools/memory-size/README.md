# memory-size

Measures an agent's Claude Code auto memory, and says once when a measure first passes the limit set for it. The plugin's [`memory-size`](../../hooks/memory-size) Stop hook runs it at the end of each turn of the instance's own conversation; the hook and its settings are in the [hooks README](../../hooks/README.md#memory-size). It **only reads** the memory folder.

```sh
memory-size measure <folder>
memory-size check <folder> <state file> [--index-lines N] [--index-bytes N] [--notes N] [--folder-kib N]
```

- `measure` prints `index_lines`, `index_bytes` (of `MEMORY.md`), `notes` (the `.md` files in the folder and below it, `MEMORY.md` not counted) and `folder_bytes` (every file in the folder and below it), one `KEY=value` line each. A missing folder measures 0.
- `check` prints one note when a measure is more than its limit and was not at the last check, and nothing otherwise. The note says the limit is the default or one the operator set, and names each passed limit's plugin setting (`memory_limit_index_lines`, `memory_limit_index_bytes`, `memory_limit_notes` or `memory_limit_folder_kib`), to set to another number or to `off`. With no limit set it reads nothing and writes nothing. The state file holds one line per measure past its limit; a measure back at its limit or under it is forgotten, so passing it again is said again.

A bash script (3.2 or later, as macOS ships it) that needs only `find`, `awk`, `wc` and `cat`. Its test, [`test`](test), also runs the hook and ends with its revert proofs.
