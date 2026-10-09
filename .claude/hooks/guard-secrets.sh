#!/bin/bash
# PreToolUse guard (wired up in .claude/settings.json). Exit 2 blocks the tool call and
# shows the message to Claude. Enforces CLAUDE.md: never print, log or paste a secret.
#   1. Read/Edit/Write on a .env file (anything but .env.example/.sample/.template).
#   2. Bash that reads an env file with a reading command (cat, grep, sed, ...), or prints a
#      secret variable (echo $...KEY/SECRET/TOKEN, printenv, bare env).
# Sourcing (". ./.env.local", "node --env-file=.env.local") is fine: it prints nothing.
# Limit: it matches command text, so a script that prints a secret would not be caught.
input=$(cat)
tool=$(jq -r '.tool_name // empty' <<<"$input")

block() { echo "Blocked: $1" >&2; exit 2; }
example() { [[ "$1" =~ \.(example|sample|template)$ ]]; }

case "$tool" in
  Read|Edit|Write|NotebookEdit)
    base=$(basename "$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")")
    if [[ "$base" == .env* ]] && ! example "$base"; then
      block "$base holds secrets. Do not read or edit it in this session; check shape with a script that sources it and prints only yes/no, or ask the user to change it in their own terminal."
    fi
    ;;
  Bash)
    cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
    readers='(^|[;&|(`]|\$\()[[:space:]]*(sudo[[:space:]]+)?(cat|head|tail|less|more|bat|nl|tac|grep|egrep|rg|ag|sed|awk|cut|sort|uniq|strings|xxd|od|hexdump|base64|cp|mv|scp|tee|diff)[[:space:]]'
    if grep -qE "$readers" <<<"$cmd"; then
      while read -r tok; do
        [ -n "$tok" ] && ! example "$tok" && block "this command reads $tok, which holds secrets. Source it and test with [ -n \"\$NAME\" ] instead of printing it."
      done < <(grep -oE "(^|[[:space:]/=\"'])\.env[A-Za-z0-9._-]*" <<<"$cmd" | sed -E "s/^[[:space:]\/=\"']//")
    fi
    if grep -qE '(echo|printf|print)[^|;&]*\$\{?[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)' <<<"$cmd" \
      || grep -qE '(^|[;&|(])[[:space:]]*(printenv|env|export -p|declare -p)[[:space:]]*($|[;&|)])' <<<"$cmd" \
      || grep -qE 'printenv[[:space:]]+[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)' <<<"$cmd"; then
      block "this command would print a secret or dump the environment. Check it exists with [ -n \"\$NAME\" ] and print only yes/no."
    fi
    ;;
esac
exit 0
