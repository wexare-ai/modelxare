#!/bin/sh
# weXare PoC Kubo node configuration. Runs from /container-init.d on every start (idempotent).
set -e
# API and gateway listen inside the container; compose publishes them on 127.0.0.1 only.
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080
# The admin API is for local operator tooling only: never allow browser origins.
ipfs config --json API.HTTPHeaders '{}'
if [ "${KUBO_PUBLIC:-0}" = "1" ]; then
  echo "weXare: public IPFS network enabled (bootstrap + DHT)"
  ipfs bootstrap add --default >/dev/null
  ipfs config Routing.Type auto
else
  # Isolated demo network: nodes exchange blocks only with explicitly connected peers.
  echo "weXare: isolated local IPFS network (set KUBO_PUBLIC=1 to join the public network)"
  ipfs bootstrap rm --all >/dev/null
  ipfs config Routing.Type none
fi
