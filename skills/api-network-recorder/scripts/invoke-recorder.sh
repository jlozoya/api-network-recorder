#!/bin/sh
set -eu
if [ -n "${API_RECORDER_HOME:-}" ]; then
  recorder_directory=$API_RECORDER_HOME
else
  case "$(uname -s)" in
    Darwin) recorder_directory="$HOME/Library/Application Support/ApiNetworkRecorder" ;;
    Linux)
      case "${XDG_DATA_HOME:-}" in
        /*) recorder_data=$XDG_DATA_HOME ;;
        *) recorder_data="$HOME/.local/share" ;;
      esac
      recorder_directory="$recorder_data/api-network-recorder"
      ;;
    *) echo 'Use invoke-recorder.ps1 on Windows.' >&2; exit 1 ;;
  esac
fi
recorder_bridge=${API_RECORDER_BRIDGE:-"$recorder_directory/api-network-recorder-bridge"}
if [ ! -x "$recorder_bridge" ]; then
  echo 'API Network Recorder integration is not installed. Run its installer first.' >&2
  exit 1
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'Usage: sh invoke-recorder.sh TOOL [ARGUMENTS_JSON]' >&2
  exit 1
fi
if [ "$#" -eq 1 ]; then set -- "$1" '{}'; fi
exec "$recorder_bridge" --call "$1" "$2"
