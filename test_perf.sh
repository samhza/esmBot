#!/usr/bin/env bash
echo "Testing $1 with $2"
nix run nixpkgs#time -- -v build/esmb-cli magik "$2" /tmp/out.gif 2>&1 | grep -E "User time|Maximum resident"
