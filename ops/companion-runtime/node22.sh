#!/bin/sh
export NODE_EXTRA_CA_CERTS=/overlaykit-release/ca/root.crt
exec /overlaykit-release/bin/node22 "$@"
