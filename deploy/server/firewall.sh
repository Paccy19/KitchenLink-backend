#!/bin/bash
# Keeps the KitchenLink API (port 4000) off the internet: only Caddy (through
# docker0) and the server itself reach it. Safe to run again.
set -euo pipefail
for t in iptables ip6tables; do
  $t -C INPUT -i eth0 -p tcp --dport 4000 -j DROP 2>/dev/null || $t -I INPUT -i eth0 -p tcp --dport 4000 -j DROP
done
