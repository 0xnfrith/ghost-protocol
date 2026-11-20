# shellcheck shell=bash
# menu.sh: the four-line menu. Every item is also a flag, and --yes takes the
# defaults plus the flags given, with no questions. The menu reads from file
# descriptor 3, which install/install opens once on $GP_TTY (default /dev/tty).
# Sourced by install/install only.

RE_HOST='^[A-Za-z0-9][A-Za-z0-9._-]*$'
RE_KIT='^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9:._-]+)?$'

menu_old_label() {
    case "$OLD" in
        dead)     printf 'dead' ;;
        stopped)  printf 'I stopped it' ;;
        running)  printf 'still running (not allowed: stop it first)' ;;
        takeover) printf 'take over from %s' "$TAKEOVER" ;;
    esac
}

menu_print() {
    local kit="$KIT" tr=OFF
    [ "$KIT" = "latest" ] && kit="newest"
    [ "$TRANSCRIPTS" = "1" ] && tr=ON
    printf '  1. Where is the old ghost?  %s\n' "$(menu_old_label)"
    printf '  2. Kit:                     %s\n' "$kit"
    printf '  3. Pull transcripts:        %s\n' "$tr"
    printf '  4. Identity:                %s\n' "$IDENTITY"
}

# One line summarising the choices, for the summary.
menu_choices_line() {
    local kit="$KIT" tr=OFF
    [ "$KIT" = "latest" ] && kit="newest"
    [ "$TRANSCRIPTS" = "1" ] && tr=ON
    printf 'old ghost: %s; kit: %s; transcripts %s; identity: %s' "$(menu_old_label)" "$kit" "$tr" "$IDENTITY"
}

menu_refuse_running() {
    echo "install: the old ghost is still running. Stop it first (ghost stop on that machine)," >&2
    echo "  or rerun with --takeover <host> to take over from it. Nothing was changed." >&2
}

# The interactive menu. Returns 0 to go on, 1 when refused or declined, 4 when
# the terminal gave no answer.
menu_run() {
    local ans k
    while :; do
        heading "Choices"
        menu_print
        printf 'Type a number to change it, Enter to continue: '
        if ! IFS= read -r ans <&3; then
            printf '\n'
            echo "install: no answer from the terminal" >&2
            return 4
        fi
        case "$ans" in
            "")
                if [ "$OLD" = "running" ]; then menu_refuse_running; return 1; fi
                break ;;
            1)
                case "$OLD" in
                    dead) OLD=stopped ;;
                    stopped) OLD=running ;;
                    *) OLD=dead; TAKEOVER="" ;;
                esac ;;
            2)
                printf 'Kit (Enter for newest, or <host>[@<time>]): '
                if ! IFS= read -r k <&3; then printf '\n'; return 4; fi
                if [ -z "$k" ]; then KIT=latest
                elif [[ $k =~ $RE_KIT ]]; then KIT="$k"
                else say "not a kit name: $k"; fi ;;
            3)
                if [ "$TRANSCRIPTS" = "1" ]; then TRANSCRIPTS=0; else TRANSCRIPTS=1; fi ;;
            4)
                if [ "$IDENTITY" = "real" ]; then IDENTITY=rehearsal; else IDENTITY=real; fi ;;
            *)
                say "Type 1, 2, 3 or 4, or press Enter." ;;
        esac
    done
    printf 'Continue? [Y/n] '
    if ! IFS= read -r ans <&3; then
        printf '\n'
        echo "install: no answer from the terminal" >&2
        return 4
    fi
    case "$ans" in
        ""|y|Y|yes|Yes|YES) return 0 ;;
        *) echo "Stopped at your answer. Nothing was changed."; return 1 ;;
    esac
}
