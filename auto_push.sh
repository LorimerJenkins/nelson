#!/bin/bash
cd /Users/nelson/nelson || exit 1

# Skip if no changes
if git diff --quiet HEAD && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  exit 0
fi

# Stage all changes (respects .gitignore)
git add -A

# Get the diff summary for commit message generation
DIFF_SUMMARY=$(git diff --cached --stat)
DIFF_DETAIL=$(git diff --cached --no-color | head -200)

# Use Claude to generate a meaningful commit message
COMMIT_MSG=$(claude --print --dangerously-skip-permissions "Generate a concise git commit message (max 72 chars first line, optional body after blank line) for these changes. Return ONLY the commit message, nothing else.

Files changed:
${DIFF_SUMMARY}

Diff preview:
${DIFF_DETAIL}" 2>/dev/null)

# Fallback if Claude fails
if [ -z "$COMMIT_MSG" ] || [ ${#COMMIT_MSG} -gt 500 ]; then
  COMMIT_MSG="auto: sync changes $(date '+%Y-%m-%d %H:%M')"
fi

# Commit and push
git commit -m "$COMMIT_MSG"
git push origin main
