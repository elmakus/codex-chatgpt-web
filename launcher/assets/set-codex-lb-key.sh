#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -n "${CODEX_LB_API_KEY_FILE:-}" ]]; then
  key_file="$CODEX_LB_API_KEY_FILE"
else
  if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    config_home="$XDG_CONFIG_HOME"
  elif [[ -n "${HOME:-}" ]]; then
    config_home="$HOME/.config"
  else
    echo "HOME or XDG_CONFIG_HOME is required to choose the Codex-LB key path." >&2
    exit 1
  fi
  key_file="$config_home/codex-web-gpt/codex-lb-api-key"
fi

case "${1:-}" in
  --clear)
    rm -f "$key_file"
    echo "Removed Codex-LB API key: $key_file"
    exit 0
    ;;
  "") ;;
  *)
    echo "Usage: codex-web-gpt-set-codex-lb-key [--clear]" >&2
    exit 2
    ;;
esac

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "Run this command from an interactive terminal so the API key is not exposed." >&2
  exit 1
fi

read -r -s -p "Codex-LB API key: " key
echo
read -r -s -p "Repeat Codex-LB API key: " key2
echo

if [[ -z "$key" || "$key" != "$key2" ]]; then
  unset key key2
  echo "Keys are empty or do not match." >&2
  exit 1
fi

key_dir="$(dirname "$key_file")"
install -d -m 0700 "$key_dir"
umask 077
tmp_file="${key_file}.tmp.$$"
trap 'rm -f "$tmp_file"' EXIT HUP INT TERM
printf '%s' "$key" > "$tmp_file"
unset key key2
chmod 0600 "$tmp_file"
mv -f "$tmp_file" "$key_file"
trap - EXIT HUP INT TERM

echo "Stored Codex-LB API key at: $key_file"
