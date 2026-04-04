#!/bin/bash
cd /Users/nelson/nelson || exit 1

# Skip if no changes
if git diff --quiet HEAD && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  exit 0
fi

# Stage all changes (respects .gitignore)
git add -A

# Generate commit message from git diff stat (no Claude call — saves tokens)
CHANGED_FILES=$(git diff --cached --name-only | tr '\n' ', ' | sed 's/,$//')
COMMIT_MSG="auto: update ${CHANGED_FILES}"

# Truncate if too long
if [ ${#COMMIT_MSG} -gt 72 ]; then
  FILE_COUNT=$(git diff --cached --name-only | wc -l | tr -d ' ')
  COMMIT_MSG="auto: update ${FILE_COUNT} files"
fi

# Commit and push
git commit -m "$COMMIT_MSG"
git push origin main
