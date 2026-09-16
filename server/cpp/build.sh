#!/usr/bin/env bash
# Builds the FindIt C++/SQLite backend into build/findit-server.
# Run from anywhere: ./build.sh
#
# The SQLite amalgamation is not committed. It is unpacked from the copy already
# vendored by the sqlite3 npm package into build/ (which is git-ignored).
set -euo pipefail
cd "$(dirname "$0")"

AMALGAMATION=../node_modules/sqlite3/deps/sqlite-autoconf-3520000.tar.gz
mkdir -p build

if [ ! -f build/sqlite3.c ] || [ ! -f build/sqlite3.h ]; then
  echo "extracting the sqlite3 amalgamation from $AMALGAMATION"
  tar -xzf "$AMALGAMATION" -C build --strip-components=1 \
    sqlite-autoconf-3520000/sqlite3.c sqlite-autoconf-3520000/sqlite3.h
fi

# sqlite3.c is C, so it is compiled by gcc (g++ would force it through the C++ front end).
if [ ! -f build/sqlite3.o ]; then
  echo "compiling sqlite3.c"
  gcc -std=c11 -O2 -c build/sqlite3.c -o build/sqlite3.o \
    -DSQLITE_THREADSAFE=1 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_DQS=0
fi

g++ -std=c++17 -O2 -o build/findit-server main.cpp build/sqlite3.o \
  -Ibuild -lws2_32 -lbcrypt -static

echo "built build/findit-server"
