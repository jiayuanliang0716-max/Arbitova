@echo off
cd /d C:\Users\perfu\a2a-system
claude --dangerously-skip-permissions "讀取 MISSION.md 和 PROGRESS.md，了解目前進度，執行下一個未完成的任務，完成後更新 PROGRESS.md 並執行 git push，每完成一個功能用 Telegram 通知用戶"
