@echo off
rem Double-click launcher for tools/convertDraftClass.js.
rem
rem That tool is a Node CLI, meant to be run from a terminal -- fine for
rem development, not something to hand someone who just wants to flip a file
rem between Madden 26 and 27. This exists so dragging a CAREERDRAFT- file onto
rem this icon (or just double-clicking it) does the same job with no typing.
rem
rem   - Drag a draft-class file onto this icon: Windows passes its path in
rem     %1, forwarded straight through as the tool's <input> argument.
rem   - Double-click with nothing dragged: the tool's own interactive mode
rem     runs and asks you to paste the file's path instead.
rem
rem Requires Node.js on PATH and this .bat to stay next to the tools\ folder
rem (this is the source checkout's convert tool, not something the installed
rem app ships -- see tools/convertDraftClass.js's own header for why).
setlocal
cd /d "%~dp0"
node "tools\convertDraftClass.js" %*
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" echo (exited with an error -- see above)
pause
exit /b %EXITCODE%
