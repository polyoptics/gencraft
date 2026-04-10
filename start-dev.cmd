@echo off
set PATH=%PATH%;C:\Program Files\nodejs
cd /d "D:\Data\AI\ClaudeCode\ProjectVidBars\vidbars"
if defined PORT (
  npm run dev -- --port %PORT%
) else (
  npm run dev -- --port 5173
)
