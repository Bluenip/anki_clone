#!/usr/bin/env bash
# Test a different Cloudflare connector transport without changing app/token/config.
set -euo pipefail
mode="${1:---apply}"
unit='cloudflared.service'
dropin='/etc/systemd/system/cloudflared.service.d/90-anki-http2.conf'
content=$'# Managed by anki_clone cloudflared-http2.sh\n[Service]\nEnvironment="TUNNEL_TRANSPORT_PROTOCOL=http2"'
if [[ "$mode" == '--dry-run' ]]; then
  printf 'File: %s\n%s\n\nApply: sudo bash %s --apply\nRestore: sudo bash %s --restore\n' "$dropin" "$content" "$0" "$0"
  exit 0
fi
if [[ "$mode" != '--apply' && "$mode" != '--restore' ]]; then
  echo 'Usage: cloudflared-http2.sh [--dry-run|--apply|--restore]' >&2
  exit 2
fi
if (( EUID != 0 )); then
  echo "Administrator access is required: sudo bash $0 $mode" >&2
  exit 1
fi
if [[ -f "$dropin" ]] && [[ "$(cat "$dropin")" != "$content" ]]; then
  echo "Existing configuration at $dropin is not managed by this script; leaving it untouched." >&2
  exit 1
fi
if [[ "$mode" == '--restore' ]]; then
  rm -f -- "$dropin"
  systemctl daemon-reload
  systemctl restart "$unit"
  echo 'Restored the previous transport selection.'
  exit 0
fi
systemctl is-active --quiet "$unit" || { echo 'cloudflared.service is not active.' >&2; exit 1; }
already_managed=false
[[ ! -f "$dropin" ]] || already_managed=true
mkdir -p -- "$(dirname "$dropin")"
printf '%s\n' "$content" > "$dropin"
systemctl daemon-reload
if systemctl restart "$unit"; then
  for attempt in {1..15}; do
    if curl --max-time 2 -fsS http://127.0.0.1:20241/ready >/dev/null 2>&1; then
      echo 'Tunnel reconnected with HTTP/2. Repeat the upload benchmark to compare speed.'
      echo "To restore: sudo bash $0 --restore"
      exit 0
    fi
    sleep 2
  done
fi
if [[ "$already_managed" == false ]]; then
  rm -f -- "$dropin"
  systemctl daemon-reload
  systemctl restart "$unit"
fi
echo 'The tunnel did not become ready; the newly added configuration was rolled back.' >&2
exit 1
