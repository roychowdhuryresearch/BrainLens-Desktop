# -*- mode: python ; coding: utf-8 -*-

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
    target_arch="arm64",
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
