#!/bin/bash

PLUGINS_DIR=""
PLUGIN_DIR_NAME="obsidian-paste-png-to-jpeg"

mkdir -p "$PLUGINS_DIR/$PLUGIN_DIR_NAME"
rsync -a build/ "$PLUGINS_DIR/$PLUGIN_DIR_NAME"
touch "$PLUGINS_DIR/$PLUGIN_DIR_NAME/.hotreload"
