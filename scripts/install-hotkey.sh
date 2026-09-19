#!/usr/bin/env bash
# project-launcher: global hotkey integration for Hyprland / omarchy.
#
# This is intentionally a thin desktop-integration shim. The core runtime does
# not depend on it. It binds SUPER+P to `launcher ui` (or your preferred app
# launcher command). Idempotent: safe to re-run.
set -euo pipefail

LAUNCHER_BIN="${LAUNCHER_BIN:-launcher}"
BIND="${LAUNCHER_BIND:-SUPER, P}"
ACTION="${LAUNCHER_ACTION:-$LAUNCHER_BIN ui}"
CONF="${HOME}/.config/hypr/bindings.conf"

usage() {
  cat <<EOF
Usage: $0 [install|uninstall|print]

Environment:
  LAUNCHER_BIN     launcher executable (default: launcher)
  LAUNCHER_BIND    Hyprland bind (default: "SUPER, P")
  LAUNCHER_ACTION  command to run (default: "launcher ui")
  CONF             bindings file (default: ~/.config/hypr/bindings.conf)
EOF
}

install_bind() {
  mkdir -p "$(dirname "$CONF")"
  touch "$CONF"
  local line="bind = ${BIND}, exec, ${ACTION}   # project-launcher"
  if grep -q "# project-launcher" "$CONF"; then
    sed -i "s|^bind = .*# project-launcher.*$|${line}|" "$CONF"
    echo "Updated hotkey in $CONF"
  else
    echo "$line" >> "$CONF"
    echo "Added hotkey to $CONF"
  fi
  echo "Reload Hyprland to apply:  hyprctl reload"
}

uninstall_bind() {
  if [[ -f "$CONF" ]]; then
    sed -i '/# project-launcher/d' "$CONF"
    echo "Removed project-launcher hotkey from $CONF"
  fi
}

case "${1:-print}" in
  install) install_bind ;;
  uninstall) uninstall_bind ;;
  print) echo "bind = ${BIND}, exec, ${ACTION}"; echo "target: ${CONF}" ;;
  *) usage; exit 2 ;;
esac
