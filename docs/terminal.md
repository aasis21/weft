# A terminal shared by laptop and phone

[Documentation handbook: open a terminal](https://aasis21.github.io/weft/#open-terminal)

Open terminal creates or reconnects to one real shell on the laptop. It is separate
from Copilot sessions: a command goes directly to the shell, not to the AI agent.
The laptop window and phone show the same shell, with the same working directory,
environment, and running program.

## Start on the laptop

Terminal access is enabled by default on supported Windows laptops. Start Device Station normally:

```powershell
weft start
```

Use your existing phone pairing. On the device page, select **Open terminal**.
The first open creates the shell and a visible laptop attach window. Later opens
reconnect to that terminal rather than creating another shell or window.

Remote shell access is **enabled by default**. It grants the paired phone direct access
with the local account's permissions; Copilot approval prompts do not mediate these
commands. The registered workspace is only a starting directory, not a sandbox.
To disable it, add or update the following property in `~/.weft/weft.config.json`,
preserving your other settings, then restart Station:

```json
{
  "terminal": {
    "enabled": false
  }
}
```

Set `terminal.enabled` to `true`, or remove that setting, to enable access again.
Configuration changes take effect when Station restarts. No terminal startup flag is required.
Invalid or unreadable configuration stops startup rather than silently enabling access.

Shared terminal currently requires Windows 10 build 18309 or newer, including
Windows 11, and an interactive desktop for the visible laptop window. It uses
ConPTY. Supported installed builds include the native runtime; users do not need
WSL, an SSH server, or C++ compilation tools. The phone enables the action only
when Station advertises terminal support. Other Weft features remain available on
macOS and Linux, but this shared terminal backend is Windows-only.

## Work from the phone

- Tap **Keyboard** and type at the real shell prompt. Press Enter to submit; use
  Up and Down for the shell's history or navigation in an interactive program.
- Ctrl+C, Esc, Tab, Enter, and arrow keys stay visible below the terminal. Tapping
  them keeps the phone keyboard open.
- For a longer command, expand **Write / paste**, prepare your draft, then choose
  **Run** (or Ctrl+Enter / Command+Enter). Pasting into the terminal also opens this
  editor for review instead of sending clipboard text directly to the shell.
  Closing the editor preserves its unsent draft while this page stays open.
- Read and select output without being forced back to the bottom. Use the
  return-to-latest control when ready to follow output again.
- Check who has input control. Choose **Take control** before typing if the laptop
  currently controls the terminal. Local interaction can take control back.
- Open **Details** for the shell, starting directory, permission reminder, and
  **Reattach** control. The starting directory is not a live working-directory display.

The shell determines what input means. If a program is asking a question, submitted
text answers that program; it is not automatically a new shell command. Ctrl+C is
an interrupt request, not a guarantee that every program exits.

Both views use one terminal grid. While the phone owns input, that grid fits its
available display and adjusts when the phone keyboard opens or closes. **Fit to phone**
also lets you request a fit explicitly. While the laptop owns input, the phone leaves
the grid unchanged; a wide terminal can require horizontal movement.

## Leaving, reconnecting, and closing

| Action | Result |
| --- | --- |
| Leave the phone page or lose the network | Shell and local window keep running while Station remains running. |
| Return to the terminal | Attach to the same shell and restore available screen state and bounded scrollback. |
| Confirm Close terminal | End the shell and its running processes, and exit the local attach client. |
| Exit the shell or close its laptop window | End that terminal; the phone shows the closed state. |
| Stop Station or restart the laptop | End the managed terminal. Process survival across restart is not supported. |
| Open after the previous terminal closed | Create a fresh shell with a new terminal identity. |

Reconnect restores output, not commands. Weft does not automatically resend input
whose delivery was uncertain; inspect the terminal before deliberately sending it
again. Scrollback is bounded, and omitted older output is indicated.

## Privacy

Terminal input, output, and reconnect snapshots travel over the existing encrypted
device channel. The laptop attach client uses authenticated local IPC, not another
public network listener.

Weft does not store terminal content in diagnostic event logs or persist the phone's
terminal command history. This does **not** disable a shell's own history, commands
that write files, application logs, or operating-system monitoring. Avoid typing
secrets into commands where the shell or invoked program might record them.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Open terminal is unavailable | Update both endpoints, check `terminal.enabled` in the laptop configuration, and restart Station on a supported Windows laptop. |
| Native terminal runtime is missing or incompatible | Reinstall or update the complete supported release; copying only the JavaScript bundle is insufficient. |
| Laptop window could not open | Read the Station error and fix the local console/terminal launch problem before retrying. |
| Output stops after a connection loss | Reconnect to the existing terminal. Do not open another shell or repeat a command blindly. |
| Phone input is not accepted | Check connection state and input ownership; use Take control if the laptop owns input. |
| Old output is unavailable | The screen and scrollback buffers are bounded, not a persistent transcript archive. |

`weft terminal attach` is the local frontend used by Station. It is not a command to
take over arbitrary pre-existing PowerShell or Windows Terminal windows.
