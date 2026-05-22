#!/usr/bin/env bash
# Throwaway dev measurement — not for prod. R68/Exp pre-flight.
set -euo pipefail
snap() {
  local label="$1"
  printf 'label=%s ts=%s\n' "$label" "$(date '+%s')"
  vm_stat | awk 'NR==2{free=$3} NR==3{active=$3} NR==4{inactive=$3} NR==7{wired=$4}
                 END{print "  free_pages=" free; print "  active_pages=" active;
                     print "  inactive_pages=" inactive; print "  wired_pages=" wired}'
  ps -A -o rss= | awk '{s+=$1} END{printf "  total_app_rss_MiB=%.1f\n", s/1024}'
}
snap t0
sleep 60
snap t1
