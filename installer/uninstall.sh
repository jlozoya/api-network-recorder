#!/bin/sh
set -eu
recorder_package=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$recorder_package/api-network-recorder-bridge" --uninstall
