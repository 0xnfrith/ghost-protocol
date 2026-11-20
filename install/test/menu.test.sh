#!/usr/bin/env bash
# menu.test.sh: the four-line menu, driven through a fake terminal ($GP_TTY).
# Every run here is a dry run, so the menu is all that is under test.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

fresh() { t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"; }
I=(--instance example/instance --dry-run)

# 1. The default: transcripts OFF; Enter, then Enter at "Continue?", goes on.
fresh
t_tty "" ""
t_install "${I[@]}"
check "menu: shows 'Pull transcripts: OFF' by default" out_has '3\. Pull transcripts: +OFF'
check "menu: shows the old ghost as dead by default" out_has '1\. Where is the old ghost\? +dead'
check "menu: shows the newest kit and the real identity" out_has '2\. Kit: +newest'
check "menu: asks 'Continue? [Y/n]' after Enter" out_has 'Continue\? \[Y/n\]'
check "menu: Enter, Enter goes on (exit 0)" rc_is 0
check "menu: the summary records transcripts OFF" out_has 'choices: .*transcripts OFF'

# 2. --yes takes the defaults, with no questions.
fresh
t_install "${I[@]}" --yes
check "--yes: no question is asked" out_lacks 'Type a number|Continue\?'
check "--yes: takes the defaults" out_has 'choices: old ghost: dead; kit: newest; transcripts OFF; identity: real'
check "--yes: exit 0" rc_is 0

# 3. --with-transcripts turns it ON.
fresh
t_install "${I[@]}" --yes --with-transcripts
check "--with-transcripts: shows ON" out_has '3\. Pull transcripts: +ON'
check "--with-transcripts: the summary records ON" out_has 'choices: .*transcripts ON'

# 4. Typing 3 toggles it.
fresh
t_tty 3 "" ""
t_install "${I[@]}"
check "menu: typing 3 turns transcripts ON" out_has '3\. Pull transcripts: +ON'
check "menu: the toggle reaches the summary" out_has 'choices: .*transcripts ON'
check "menu: exit 0 after the toggle" rc_is 0

# 5. Items 2 and 4.
fresh
t_tty 2 "old-host@2026-01-01T00:00Z" 4 "" ""
t_install "${I[@]}"
check "menu: item 2 takes a kit name" out_has 'choices: .*kit: old-host@2026-01-01T00:00Z'
check "menu: item 4 switches to the rehearsal identity" out_has 'choices: .*identity: rehearsal'

# 6. "still running" is refused before any step runs.
fresh
t_tty 1 1 ""
t_install "${I[@]}"
check "menu: 'still running' is refused (exit 1)" rc_is 1
check "menu: the refusal says to stop it or take over" out_has 'still running.*Stop it first'
check "menu: no step ran after the refusal" out_lacks '== 1\. preflight'

# 7. --takeover shows on item 1 and needs no question.
fresh
t_install "${I[@]}" --yes --takeover old-host
check "--takeover: item 1 shows the takeover" out_has '1\. Where is the old ghost\? +take over from old-host'

# 8. Answering n at "Continue?" stops with nothing changed.
fresh
t_tty "" n
t_install --instance example/instance
check "menu: 'n' at Continue stops (exit 1)" rc_is 1
check "menu: nothing was cloned after 'n'" [ ! -e "$T/home/instance" ]

# 9. The terminal runs out of answers: exit 4, not a loop.
fresh
t_tty 3
t_install "${I[@]}"
check "menu: no answer from the terminal exits 4" rc_is 4

# 10. A real run with no terminal and no --yes: exit 4, nothing done.
fresh
t_install --instance example/instance
check "no terminal, no --yes: exit 4" rc_is 4
check "no terminal, no --yes: nothing cloned" [ ! -e "$T/home/instance" ]

# 11. The flags for later steps are accepted, recorded and say so; steps 7-15
#     are plans in a dry run.
fresh
t_install "${I[@]}" --yes --no-service --no-start
check "--no-service: recorded, built in a later PR" out_has '--no-service: recorded; built in a later PR'
check "later flags: exit 0" rc_is 0
check "dry run: steps 7-15 are PLAN lines" sh -c "[ \$(grep -cE '^  PLAN  (secrets|lease|restore|plugins|ears|managed|service|kit-timer|status) ' '$OUT') -eq 9 ]"

# 12. Bad flag values are usage errors (exit 2).
fresh
t_install --instance example/instance --old running --yes
check "--old running is a usage error (exit 2)" rc_is 2
fresh
t_install --instance example/instance --kit 'a b' --yes
check "a bad --kit is a usage error (exit 2)" rc_is 2
fresh
t_install --yes
check "no --instance is a usage error (exit 2)" rc_is 2

finish_tests
