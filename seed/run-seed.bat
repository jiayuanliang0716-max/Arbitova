@echo off
echo.
echo ============================================
echo   Arbitova Seed Script - Desktop Runner
echo ============================================
echo.
echo 選擇模式 / Choose mode:
echo   1. Full (100 trades + 20 arbitrations)  [default, ~30 min]
echo   2. Quick test (20 trades + 10 arbs)     [~8 min]
echo   3. Custom count
echo   4. Arbitration only (30 cases)
echo   5. Trades only (100 trades)
echo.
set /p CHOICE="Enter 1-5 (or press Enter for default): "

if "%CHOICE%"=="2" (
    echo Running quick test...
    node seed-transactions.js --count=20
) else if "%CHOICE%"=="3" (
    set /p N="Enter count: "
    echo Running with count=%N%...
    node seed-transactions.js --count=%N%
) else if "%CHOICE%"=="4" (
    set /p N="Enter arbitration count (default 30): "
    if "%N%"=="" set N=30
    echo Running arbitration only, count=%N%...
    node seed-transactions.js --arbitration-only --count=%N%
) else if "%CHOICE%"=="5" (
    set /p N="Enter trade count (default 100): "
    if "%N%"=="" set N=100
    echo Running trades only, count=%N%...
    node seed-transactions.js --trades-only --count=%N%
) else (
    echo Running full suite (default)...
    node seed-transactions.js
)

echo.
pause
