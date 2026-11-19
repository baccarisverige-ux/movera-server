#!/bin/bash
# Healthy = the server answers HTTP at all (the image has no curl; bash opens the socket itself).
# Any answer (even "400 bad query") proves the map is loaded and the server is serving.
exec 3<>"/dev/tcp/127.0.0.1/${PORT:-5000}" || exit 1
printf 'GET /nearest/v1/driving/0,0 HTTP/1.0\r\n\r\n' >&3
head -n 1 <&3 | grep -q '^HTTP/1' || exit 1
