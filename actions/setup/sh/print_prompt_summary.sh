#!/usr/bin/env bash
set +o histexpand
set -euo pipefail
# Print prompt to workflow logs (equivalent to core.info)
echo "Generated Prompt:"
cat "$GH_AW_PROMPT"

# Print prompt to step summary
{
  echo "<details>"
  echo "<summary>Generated Prompt</summary>"
  echo ""
  echo '``````markdown'
  cat "$GH_AW_PROMPT"
  echo '``````'
  echo ""
  echo "</details>"
} >> "$GITHUB_STEP_SUMMARY"

# Print the list of files packed into the activation artifact. These files are
# unpacked into /tmp/gh-aw in downstream jobs and placed for the agent.
if [ -n "${GH_AW_ACTIVATION_ARTIFACT_PATHS:-}" ]; then
  echo "Activation artifact files:"
  {
    echo "<details>"
    echo "<summary>Activation artifact files</summary>"
    echo ""
  } >> "$GITHUB_STEP_SUMMARY"

  found=0
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if [ -d "$entry" ]; then
      while IFS= read -r file; do
        echo "  $file"
        echo "- \`$file\`" >> "$GITHUB_STEP_SUMMARY"
        found=1
      done < <(find "$entry" -type f | sort)
    elif [ -f "$entry" ]; then
      echo "  $entry"
      echo "- \`$entry\`" >> "$GITHUB_STEP_SUMMARY"
      found=1
    fi
  done <<< "$GH_AW_ACTIVATION_ARTIFACT_PATHS"

  if [ "$found" -eq 0 ]; then
    echo "  (none)"
    echo "_No activation artifact files found._" >> "$GITHUB_STEP_SUMMARY"
  fi

  {
    echo ""
    echo "</details>"
  } >> "$GITHUB_STEP_SUMMARY"
fi
