---
name: testing-studio-ui
description: Test H-Gripe Studio UI flows in browser preview or the native Tauri shell. Use for toolbar, editor, native file-picker, viewport, and shortcut runtime verification.
---

# Testing H-Gripe Studio UI

## Choose the Correct Surface

- Use the Vite browser preview for renderer-only toolbar, panel, i18n, and layout changes.
- Use the native Tauri shell for OS file pickers, filesystem paths, real thumbnail commands, viewport frame rendering, and desktop shortcut behavior. Browser preview mocks these bridges and cannot prove native image loading.

## Browser Preview

```powershell
npm --prefix apps/desktop-tauri/studio-ui run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173`.

## Native Desktop Runtime on Windows

Start Vite first:

```powershell
npm --prefix apps/desktop-tauri/studio-ui run dev -- --host 127.0.0.1
```

In a second shell with the MSVC environment:

```powershell
cmd.exe /d /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && cargo run -p hgripe-desktop'
```

If vendored FFmpeg Git LFS objects are unavailable, still-image and general UI flows can use:

```powershell
cmd.exe /d /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && cargo run -p hgripe-desktop --no-default-features'
```

Treat this only as a CPU-fallback test. It does not validate native FFmpeg, video workflows, or the default-feature WGPU surface.

## Native File-Picker Automation

Windows file dialogs can receive paths reliably through the clipboard:

1. Put the folder path on the clipboard with `Set-Clipboard`.
2. In the dialog press `Ctrl+L`, `Ctrl+A`, then `Ctrl+V`.
3. Press Enter, select the file, and click Open.

Keep generated runtime fixtures outside the repository so tests do not dirty the worktree.

## Runtime Evidence

- Record one focused flow after setup is complete.
- Annotate preconditions, test starts, and consolidated pass/fail assertions.
- For load-time claims, record from file confirmation through first visible render and define a concrete threshold before execution.
- Capture before/after screenshots for undo and cancellation behavior.
- Report transient Windows `Not Responding` states even when the app recovers.

## Devin Secrets Needed

None for local browser-preview or native desktop runtime testing.
