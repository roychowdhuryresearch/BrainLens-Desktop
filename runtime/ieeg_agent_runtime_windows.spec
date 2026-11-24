# -*- mode: python ; coding: utf-8 -*-
#
# Windows build of the LLM agent runtime, mirroring ieeg_agent_runtime_macos.spec.
#
# One binary serves all three modes of scripts/ieeg_agent_runtime_entry.py -- `serve` (the FastAPI
# ReAct runtime), `--ui-broker`, and `--ui-mcp-server` -- because main.ts points
# IEEG_AGENT_RUNTIME_EXECUTABLE, IEEG_UI_BROKER_EXECUTABLE and IEEG_UI_MCP_EXECUTABLE at the same
# path. Without this build the packaged Windows app has no co-pilot at all: running from source
# falls back to `python -m uvicorn runtime.main:app`, but a packaged app takes the executable
# branch and the file simply was not there.
#
# Differences from the macOS spec: no target_arch (that pins arm64 for Apple silicon), and the
# analysis stack stays excluded here for the same reason -- the agent runtime talks to the PyHFO
# backend over HTTP and never imports torch/numpy/mne itself.

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules


ROOT = Path(SPECPATH).resolve()

datas = [
    (str(ROOT / "prompts"), "runtime/prompts"),
    (str(ROOT.parent / "skills" / "skills"), "skills/skills"),
    (str(ROOT.parent / "contracts" / "ui-command-catalog.json"), "contracts"),
]

hiddenimports = []
for package_name in (
    "runtime",
    "ui_mcp",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.protocols.http",
    "uvicorn.protocols.websockets",
    "uvicorn.lifespan",
):
    hiddenimports.extend(collect_submodules(package_name))

a = Analysis(
    [str(ROOT / "scripts" / "ieeg_agent_runtime_entry.py")],
    pathex=[str(ROOT.parent)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "PyQt5",
        "IPython",
        "_tkinter",
        "alabaster",
        "asyncpg",
        "babel",
        "docutils",
        "ipykernel",
        "jedi",
        "matplotlib",
        "mne",
        "numba",
        "numpy",
        "onnxruntime",
        "pandas",
        "parso",
        "psycopg",
        "psycopg_binary",
        "scipy",
        "sklearn",
        "sphinx",
        "sphinxcontrib",
        "tkinter",
        "torch",
        "torchvision",
        "transformers",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

# console=True: Electron reads the broker's startup line from stdout, and a windowed build would
# swallow it (same reasoning as the PyHFO backend spec).
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ieeg-agent-runtime",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="ieeg-agent-runtime",
)
