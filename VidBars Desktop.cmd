@echo off
title VidBars Desktop
set PATH=%PATH%;C:\Program Files\nodejs
cd /d "D:\Data\AI\ClaudeCode\ProjectVidBars\vidbars"
echo Starting VidBars... the window opens in a few seconds.
echo You can minimize this box. Closing it also closes VidBars.
call npm run desktop
