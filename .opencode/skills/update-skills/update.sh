#!/usr/bin/env bash
# update.sh - fetch the latest skills from upstream and merge into installed location
#
# The skills directory does NOT need to be a git repository. Clones upstream
# to a temp dir, diffs each SKILL.md against the installed version, copies
# in changes while preserving existing ## Project Context sections.
#
# Compatible with bash 3 (macOS default).

# Self-reinvocation guard: copy this script to a temp file and re-exec from
# there so that replacing update.sh on disk mid-run does not cause errors.
if [ -z "${_UPDATE_SKILLS_SELF_COPY:-}" ]; then
  _tmp_self="$(mktemp)"
  cp "$0" "$_tmp_self"
  chmod +x "$_tmp_self"
  _UPDATE_SKILLS_ORIG_DIR="$(cd "$(dirname "$0")" && pwd)" \
  _UPDATE_SKILLS_SELF_COPY=1 exec bash "$_tmp_self" "$@"
fi

set -euo pipefail

UPSTREAM="https://github.com/garethrhughes/skills.git"

SCRIPT_DIR="${_UPDATE_SKILLS_ORIG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
SKILLS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Upstream   : $UPSTREAM"
echo "Skills dir : $SKILLS_DIR"
echo ""

# Write awk programs to temp files to avoid quoting issues
AWK_EXTRACT="$(mktemp)"
AWK_REPLACE="$(mktemp)"

cat > "$AWK_EXTRACT" << 'AWK'
/^## Project Context/ { b=1 }
b && /^## / && !/^## Project Context/ { b=0 }
b { print }
AWK

cat > "$AWK_REPLACE" << 'AWK'
/^## Project Context/ {
  b=1
  while ((getline ln < ctx_file) > 0) print ln
  close(ctx_file)
  next
}
b && /^## / && !/^## Project Context/ { b=0 }
!b { print }
AWK

extract_project_context() {
  awk -f "$AWK_EXTRACT" "$1"
}

replace_project_context() {
  local file="$1"
  local ctx_file="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v ctx_file="$ctx_file" -f "$AWK_REPLACE" "$file" > "$tmp"
  mv "$tmp" "$file"
}

# Root-level files that are copied verbatim (no Project Context merging)
ROOT_FILES="README.md CLAUDE.md.template"

CLONE_DIR="$(mktemp -d)"
BEFORE_DIR="$(mktemp -d)"
AFTER_DIR="$(mktemp -d)"
CONTEXT_DIR="$(mktemp -d)"
cleanup() { rm -rf "$CLONE_DIR" "$BEFORE_DIR" "$AFTER_DIR" "$CONTEXT_DIR" "$AWK_EXTRACT" "$AWK_REPLACE"; }
trap cleanup EXIT

echo "Fetching upstream skills..."
git clone --depth 1 --quiet "$UPSTREAM" "$CLONE_DIR"
echo "Done."
echo ""

for f in "$SKILLS_DIR"/*/SKILL.md; do
  [ -f "$f" ] || continue
  skill="$(basename "$(dirname "$f")")"
  cp "$f" "$BEFORE_DIR/$skill.md"
  extract_project_context "$f" > "$CONTEXT_DIR/$skill.ctx"
  # Snapshot non-SKILL.md files in the skill dir
  for extra in "$SKILLS_DIR/$skill/"*; do
    [ -f "$extra" ] || continue
    efname="$(basename "$extra")"
    [ "$efname" = "SKILL.md" ] && continue
    cp "$extra" "$BEFORE_DIR/__extra__${skill}__${efname}"
  done
done

# Snapshot root files before update
for rf in $ROOT_FILES; do
  [ -f "$SKILLS_DIR/$rf" ] && cp "$SKILLS_DIR/$rf" "$BEFORE_DIR/__root__$rf"
done

# Snapshot scripts/ before update
if [ -d "$SKILLS_DIR/scripts" ]; then
  for f in "$SKILLS_DIR/scripts/"*; do
    [ -f "$f" ] || continue
    cp "$f" "$BEFORE_DIR/__scripts__$(basename "$f")"
  done
fi

for upstream_skill_dir in "$CLONE_DIR"/*/; do
  [ -d "$upstream_skill_dir" ] || continue
  skill="$(basename "$upstream_skill_dir")"
  upstream_file="$upstream_skill_dir/SKILL.md"
  [ -f "$upstream_file" ] || continue

  installed_dir="$SKILLS_DIR/$skill"
  installed_file="$installed_dir/SKILL.md"

  if [ ! -d "$installed_dir" ]; then
    cp -r "$upstream_skill_dir" "$installed_dir"
  else
    cp "$upstream_file" "$installed_file"
    for upstream_extra in "$upstream_skill_dir"*; do
      [ -f "$upstream_extra" ] || continue
      fname="$(basename "$upstream_extra")"
      [ "$fname" = "SKILL.md" ] && continue
      cp "$upstream_extra" "$installed_dir/$fname"
    done
  fi

  ctx_file="$CONTEXT_DIR/$skill.ctx"
  if [ -f "$ctx_file" ] && [ -s "$ctx_file" ]; then
    replace_project_context "$installed_file" "$ctx_file"
  fi
done

# Remove skills that existed in the installed README (i.e. were upstream skills)
# but are no longer present in the upstream clone.
# Using the pre-update installed README (snapshotted in BEFORE_DIR) ensures we
# catch skills removed from both the upstream repo and its README in the same
# release, and avoids touching local skills that were never listed there.
INSTALLED_README="$BEFORE_DIR/__root__README.md"
if [ -f "$INSTALLED_README" ]; then
  for installed_skill_dir in "$SKILLS_DIR"/*/; do
    [ -d "$installed_skill_dir" ] || continue
    skill="$(basename "$installed_skill_dir")"
    [ -f "$installed_skill_dir/SKILL.md" ] || continue
    if grep -q "\[$skill\](" "$INSTALLED_README" 2>/dev/null && [ ! -d "$CLONE_DIR/$skill" ]; then
      rm -rf "$installed_skill_dir"
    fi
  done
fi

# Copy root-level files from upstream
for rf in $ROOT_FILES; do
  [ -f "$CLONE_DIR/$rf" ] && cp "$CLONE_DIR/$rf" "$SKILLS_DIR/$rf"
done

# Sync scripts/ from upstream
if [ -d "$CLONE_DIR/scripts" ]; then
  mkdir -p "$SKILLS_DIR/scripts"
  for f in "$CLONE_DIR/scripts/"*; do
    [ -f "$f" ] || continue
    cp "$f" "$SKILLS_DIR/scripts/$(basename "$f")"
  done
fi

for f in "$SKILLS_DIR"/*/SKILL.md; do
  [ -f "$f" ] || continue
  skill="$(basename "$(dirname "$f")")"
  cp "$f" "$AFTER_DIR/$skill.md"
  # Snapshot non-SKILL.md files in the skill dir after update
  for extra in "$SKILLS_DIR/$skill/"*; do
    [ -f "$extra" ] || continue
    efname="$(basename "$extra")"
    [ "$efname" = "SKILL.md" ] && continue
    cp "$extra" "$AFTER_DIR/__extra__${skill}__${efname}"
  done
done

# Snapshot root files after update
for rf in $ROOT_FILES; do
  [ -f "$SKILLS_DIR/$rf" ] && cp "$SKILLS_DIR/$rf" "$AFTER_DIR/__root__$rf"
done

# Snapshot scripts/ after update
if [ -d "$SKILLS_DIR/scripts" ]; then
  for f in "$SKILLS_DIR/scripts/"*; do
    [ -f "$f" ] || continue
    cp "$f" "$AFTER_DIR/__scripts__$(basename "$f")"
  done
fi

ADDED=""
REMOVED=""
MODIFIED=""

for after_file in "$AFTER_DIR"/*.md; do
  [ -f "$after_file" ] || continue
  skill="$(basename "$after_file" .md)"
  # skip internal snapshot files (prefixed with __)
  case "$skill" in __*) continue ;; esac
  before_file="$BEFORE_DIR/$skill.md"
  if [ ! -f "$before_file" ]; then
    ADDED="$ADDED $skill"
  elif ! diff -q "$before_file" "$after_file" > /dev/null 2>&1; then
    MODIFIED="$MODIFIED $skill"
  fi
done

for before_file in "$BEFORE_DIR"/*.md; do
  [ -f "$before_file" ] || continue
  skill="$(basename "$before_file" .md)"
  case "$skill" in __*) continue ;; esac
  if [ ! -f "$AFTER_DIR/$skill.md" ]; then
    REMOVED="$REMOVED $skill"
  fi
done

added_count=0; removed_count=0; modified_count=0
for s in $ADDED;    do added_count=$((added_count+1));      done
for s in $REMOVED;  do removed_count=$((removed_count+1));  done
for s in $MODIFIED; do modified_count=$((modified_count+1));done

# Count modified root files
ROOT_MODIFIED=""
for rf in $ROOT_FILES; do
  before="$BEFORE_DIR/__root__$rf"
  after="$AFTER_DIR/__root__$rf"
  [ -f "$after" ] || continue
  if [ ! -f "$before" ]; then
    ROOT_MODIFIED="$ROOT_MODIFIED $rf"
  elif ! diff -q "$before" "$after" > /dev/null 2>&1; then
    ROOT_MODIFIED="$ROOT_MODIFIED $rf"
  fi
done
root_modified_count=0
for rf in $ROOT_MODIFIED; do root_modified_count=$((root_modified_count+1)); done

# Count modified scripts
SCRIPTS_MODIFIED=""
for after_f in "$AFTER_DIR"/__scripts__*; do
  [ -f "$after_f" ] || continue
  fname="$(basename "$after_f" | sed 's/^__scripts__//')"
  before_f="$BEFORE_DIR/__scripts__$fname"
  if [ ! -f "$before_f" ]; then
    SCRIPTS_MODIFIED="$SCRIPTS_MODIFIED $fname"
  elif ! diff -q "$before_f" "$after_f" > /dev/null 2>&1; then
    SCRIPTS_MODIFIED="$SCRIPTS_MODIFIED $fname"
  fi
done
scripts_modified_count=0
for f in $SCRIPTS_MODIFIED; do scripts_modified_count=$((scripts_modified_count+1)); done

# Count modified skill extra files (e.g. update.sh inside update-skills/)
EXTRAS_MODIFIED=""
for after_f in "$AFTER_DIR"/__extra__*; do
  [ -f "$after_f" ] || continue
  key="$(basename "$after_f" | sed 's/^__extra__//')"  # skill__filename
  before_f="$BEFORE_DIR/__extra__$key"
  if [ ! -f "$before_f" ]; then
    EXTRAS_MODIFIED="$EXTRAS_MODIFIED $key"
  elif ! diff -q "$before_f" "$after_f" > /dev/null 2>&1; then
    EXTRAS_MODIFIED="$EXTRAS_MODIFIED $key"
  fi
done
extras_modified_count=0
for e in $EXTRAS_MODIFIED; do extras_modified_count=$((extras_modified_count+1)); done

TOTAL=$(( added_count + removed_count + modified_count + root_modified_count + scripts_modified_count + extras_modified_count ))

if [ $TOTAL -eq 0 ]; then
  echo "STATUS: up-to-date"
  echo "All skills are already up to date. No changes applied."
  exit 0
fi

echo "STATUS: updated"
echo "CHANGES: $TOTAL skill(s) affected"
echo ""

if [ $added_count -gt 0 ]; then
  echo "--- ADDED ($added_count) ---"
  for skill in $ADDED; do echo "  + $skill"; done
  echo ""
fi

if [ $removed_count -gt 0 ]; then
  echo "--- REMOVED ($removed_count) ---"
  for skill in $REMOVED; do echo "  - $skill"; done
  echo ""
fi

if [ $modified_count -gt 0 ]; then
  echo "--- MODIFIED ($modified_count) ---"
  for skill in $MODIFIED; do
    echo ""
    echo "  skill: $skill"
    echo "  diff (## Project Context excluded):"
    diff --unified=3 \
      --label "before/$skill/SKILL.md" \
      --label "after/$skill/SKILL.md" \
      "$BEFORE_DIR/$skill.md" "$AFTER_DIR/$skill.md" \
      | sed 's/^/    /' || true
  done
  echo ""
fi

if [ $root_modified_count -gt 0 ]; then
  echo "--- ROOT FILES UPDATED ($root_modified_count) ---"
  for rf in $ROOT_MODIFIED; do
    echo ""
    echo "  file: $rf"
    diff --unified=3 \
      --label "before/$rf" \
      --label "after/$rf" \
      "$BEFORE_DIR/__root__$rf" "$AFTER_DIR/__root__$rf" \
      | sed 's/^/    /' || true
  done
  echo ""
fi

if [ $scripts_modified_count -gt 0 ]; then
  echo "--- SCRIPTS UPDATED ($scripts_modified_count) ---"
  for f in $SCRIPTS_MODIFIED; do
    echo ""
    echo "  file: scripts/$f"
    before_f="$BEFORE_DIR/__scripts__$f"
    after_f="$AFTER_DIR/__scripts__$f"
    if [ -f "$before_f" ]; then
      diff --unified=3 \
        --label "before/scripts/$f" \
        --label "after/scripts/$f" \
        "$before_f" "$after_f" \
        | sed 's/^/    /' || true
    else
      echo "    (new file)"
    fi
  done
  echo ""
fi

if [ $extras_modified_count -gt 0 ]; then
  echo "--- SKILL FILES UPDATED ($extras_modified_count) ---"
  for e in $EXTRAS_MODIFIED; do
    skill="${e%%__*}"
    fname="${e#*__}"
    echo ""
    echo "  file: $skill/$fname"
    before_f="$BEFORE_DIR/__extra__$e"
    after_f="$AFTER_DIR/__extra__$e"
    if [ -f "$before_f" ]; then
      diff --unified=3 \
        --label "before/$skill/$fname" \
        --label "after/$skill/$fname" \
        "$before_f" "$after_f" \
        | sed 's/^/    /' || true
    else
      echo "    (new file)"
    fi
  done
  echo ""
fi
