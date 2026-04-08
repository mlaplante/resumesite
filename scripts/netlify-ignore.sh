#!/bin/bash
# Skip Netlify builds when only draft blog posts changed.
# Exit 0 = skip build, Exit 1 = proceed with build.

# Always build if no cached commit (first deploy)
if [ -z "$CACHED_COMMIT_REF" ]; then
  echo "No cached commit — building"
  exit 1
fi

# Check if any files changed outside of blog drafts
if git diff --name-only "$CACHED_COMMIT_REF" "$COMMIT_REF" | grep -qvE '^blog-src/src/content/drafts/'; then
  echo "Files changed outside of drafts — building"
  exit 1
else
  echo "Only draft files changed — skipping build"
  exit 0
fi
