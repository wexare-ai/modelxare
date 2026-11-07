#!/bin/sh
# Kubo for a public modelXare deployment. Runs from /container-init.d on every
# start (idempotent). The gateway serves only what this node pins (never
# fetches other content for strangers); the RPC API is reached only from the
# server itself, e.g. through `ssh -N -L 5101:127.0.0.1:5001 <server>`.
set -e
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080
# The admin API is for the publisher's tools only: never allow browser origins.
ipfs config --json API.HTTPHeaders '{}'
ipfs config --json Gateway.NoFetch true
ipfs config --json Gateway.PublicGateways "{\"${IPFS_DOMAIN:?set IPFS_DOMAIN}\": {\"Paths\": [\"/ipfs\"], \"UseSubdomains\": false}}"
if [ "${IPFS_PUBLIC:-1}" = "1" ]; then
  ipfs bootstrap add --default >/dev/null
  ipfs config Routing.Type auto
else
  # For trying the stack out on a laptop without joining the public network.
  ipfs bootstrap rm --all >/dev/null
  ipfs config Routing.Type none
fi
