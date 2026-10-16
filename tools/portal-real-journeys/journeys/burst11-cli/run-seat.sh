#!/usr/bin/env bash
# check/test/run on every local benchmark, direct and behind the s3-refusing proxy.
# usage: run-seat.sh <venv-dir> <tag>
set -u
VENV=$1; TAG=$2
D=$HOME/work/b11-durable
LOGS=$D/logs; mkdir -p "$LOGS"
COG=$VENV/bin/cogworks
S=$HOME/work/burst11-student
run() { # run <week> <bench> <cmd> <mode>
  local week=$1 bench=$2 cmd=$3 mode=$4 dir
  case $week in week1) dir=$S/week1-audio;; week2) dir=$S/week2-vision;; week3) dir=$S/week3-language;; esac
  if [ "$mode" = proxy ]; then
    export HTTP_PROXY=http://127.0.0.1:8899 HTTPS_PROXY=http://127.0.0.1:8899 ALL_PROXY=http://127.0.0.1:8899
    export http_proxy=$HTTP_PROXY https_proxy=$HTTPS_PROXY all_proxy=$ALL_PROXY
    export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1
  else
    unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
  fi
  local f="$LOGS/$TAG-$week-$bench-$cmd-$mode.log"
  echo "\$ cogworks $cmd --benchmark $bench   [$mode, $($VENV/bin/python --version 2>&1)]" >"$f"
  ( cd "$dir" && timeout 1500 "$COG" "$cmd" --benchmark "$bench" ) >>"$f" 2>&1
  local rc=$?
  echo "exit=$rc" >>"$f"
  echo "$TAG $week $bench $cmd $mode exit=$rc"
}
for mode in direct proxy; do
  run week1 audio-identification check "$mode"; run week1 audio-identification test "$mode"; run week1 audio-identification run "$mode"
  run week2 vision-recognition check "$mode";  run week2 vision-recognition test "$mode";  run week2 vision-recognition run "$mode"
  run week2 vision-clustering check "$mode";   run week2 vision-clustering test "$mode";   run week2 vision-clustering run "$mode"
  run week3 language-search check "$mode";     run week3 language-search test "$mode";     run week3 language-search run "$mode"
done
echo "SEAT_DONE $TAG"
