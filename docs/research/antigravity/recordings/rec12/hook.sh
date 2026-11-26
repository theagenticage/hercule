#!/bin/sh
# usage: hook.sh <behaviour> ; logs start/end with ms timestamps
L=$HERCULE_T12_LOG
echo "START $(date +%s%3N) behaviour=$1" >> $L
cat > /dev/null
case "$1" in
 exit1) echo "END $(date +%s%3N)" >> $L; exit 1;;
 exit2) echo "END $(date +%s%3N)" >> $L; exit 2;;
 notjson) printf 'not json'; echo "END $(date +%s%3N)" >> $L; exit 0;;
 denybare) printf '{"decision":"deny"}'; echo "END $(date +%s%3N)" >> $L; exit 0;;
 sleep*) sleep ${1#sleep}; echo "END $(date +%s%3N)" >> $L; exit 0;;
 *) echo "END $(date +%s%3N)" >> $L; exit 0;;
esac
