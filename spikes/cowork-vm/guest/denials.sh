# Shared, read-only shell fixture support. Callers provide emit_denial().
status_value() { awk -v key="$1:" '$1 == key { print $2; found=1; exit } END { if (!found) exit 1 }' /proc/self/status; }
failure_class() {
    case "$(cat "$1")" in
        *'Read-only file system'*) printf EROFS;;
        *'Permission denied'*) printf EACCES;;
        *'Operation not permitted'*) printf EPERM;;
        *'No such file or directory'*|*'nonexistent directory'*|*'Directory nonexistent'*) printf ENOENT;;
        *'Invalid cross-device link'*|*'Cross-device link'*) printf EXDEV;;
        *'Device or resource busy'*) printf EBUSY;;
        *) printf UNKNOWN;;
    esac
}
denied() {
    denial_id=$1; shift
    expected='["EACCES","EROFS","EPERM"]'
    case "$denial_id" in
        control_direct|sdk_metadata_direct|control_symlink) expected='["ENOENT"]';;
        instructions_hardlink) expected='["EXDEV","EACCES","EROFS","EPERM"]';;
        instruction_parent_rename|workspace_parent_rename|source_parent_rename|memory_rename|protected_ancestor_rename|host-ro_instructions_parent_rename|host-rw_instructions_parent_rename) expected='["EBUSY","EACCES","EROFS","EPERM"]';;
    esac
    positive=$(mktemp -d /workspace/.winter/scratch/denial-positive-XXXXXX)
    mkdir -p "$positive/workspace/.winter/scratch" "$positive/workspace/.winter/memory" "$positive/workspace/source" "$positive/control/sdk" "$positive/run"
    printf seed > "$positive/workspace/.winter/WINTER.md"
    printf seed > "$positive/workspace/source/seed.txt"
    printf seed > "$positive/control/config.json"
    printf seed > "$positive/control/sdk/session.json"
    printf seed > "$positive/workspace/.winter/memory/tool-memory"
    ln -s seed.txt "$positive/workspace/source/seed-alias"
    positive_token="${FIXTURE_UID}-${FIXTURE_POLICY}"
    for group in host-ro host-rw; do
        mkdir -p "$positive/workspace/.winter/$group/instructions" "$positive/workspace/.winter/$group/memory" "$positive/workspace/.winter/$group/writable-memory"
        printf seed > "$positive/workspace/.winter/$group/instructions/WINTER.md"
        printf seed > "$positive/workspace/.winter/$group/memory/seed.txt"
        printf seed > "$positive/workspace/.winter/$group/writable-memory/seed.txt"
        ln -s "$positive/workspace/.winter/$group/instructions/WINTER.md" "$positive/workspace/.winter/scratch/$group-instructions-link-$positive_token"
    done
    printf replacement > "$positive/workspace/.winter/scratch/replacement-$positive_token"
    ln -s "$positive/workspace/.winter/WINTER.md" "$positive/workspace/.winter/scratch/instructions-link-$positive_token"
    ln -s "$positive/control/config.json" "$positive/workspace/.winter/scratch/control-link-$positive_token"
    ln -s "$positive/workspace/source/seed.txt" "$positive/workspace/.winter/scratch/source-link-$positive_token"
    ln -s "$positive/workspace/.winter/WINTER.md" "$positive/workspace/source/.cowork-gate1-$positive_token-instruction-link"
    control_path=${control_root:-${control:-/unexposed-control}}
    # Preserve the command's argv and shell operation shape, changing paths only.
    positive_code=0
    (
        for argument do
            mapped=$(printf '%s' "$argument" | sed -e "s|$control_path|__FIXTURE_CONTROL__|g" -e 's|/workspace|__FIXTURE_WORKSPACE__|g' -e 's|/run/|__FIXTURE_RUN__/|g' -e "s|__FIXTURE_CONTROL__|$positive/control|g" -e "s|__FIXTURE_WORKSPACE__|$positive/workspace|g" -e "s|__FIXTURE_RUN__|$positive/run|g")
            set -- "$@" "$mapped"
            shift
        done
        "$@"
    ) >"$positive/stdout" 2>"$positive/stderr" || positive_code=$?
    actual_code=0
    "$@" >"$positive/denied-stdout" 2>"$positive/denied-stderr" || actual_code=$?
    actual_class=$(failure_class "$positive/denied-stderr")
    positive_passed=false; [ "$positive_code" = 0 ] && positive_passed=true
    result=fail
    if [ "$positive_passed" = true ] && [ "$actual_code" != 0 ]; then
        case "$expected" in *\""$actual_class"\"*) result=pass;; esac
    fi
    emit_denial "$denial_id" "$result" "$actual_code" "$actual_class" "$expected" "$positive_passed" "$positive_code"
    if [ "$result" = fail ] || [ "$actual_class" = UNKNOWN ]; then
        printf 'denial diagnostic id=%s policy=%s uid=%s positiveExit=%s actualExit=%s class=%s\n' "$denial_id" "$FIXTURE_POLICY" "$FIXTURE_UID" "$positive_code" "$actual_code" "$actual_class" >&2
        printf 'positive stderr (at most1024bytes):\n' >&2
        head -c 1024 "$positive/stderr" >&2
        printf '\nnegative stderr (at most1024bytes):\n' >&2
        head -c 1024 "$positive/denied-stderr" >&2
        printf '\n' >&2
    fi
    rm -rf "$positive"
}
