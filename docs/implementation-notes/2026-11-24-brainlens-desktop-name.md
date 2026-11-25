# BrainLens Desktop product name

Modules: desktop, electron
Contract-Impact: none
Contract-Impact-Reason: The desktop display name and packaging paths change. Existing profiles keep their directory, Electron credential identity, and renderer storage. Agent identifiers, payloads, and approval semantics are preserved.
Contract-Proof: desktop/tests/user-data-path.test.js
Contract-Proof: desktop/tests/llm-key-storage.test.js
Contract-Proof: desktop/tests/source-contract.test.js

The Windows builder and custom macOS packager apply the display name to OS
metadata. Their application manifests retain the same Electron name as the
development launcher, `ieeg-electron-desktop`, which keeps the macOS
safeStorage Keychain service and account stable. The custom macOS bundle also
retains its historical identifier, `org.pyhfo.ieeg-workstation`.

Startup selects an existing `ieeg-electron-desktop` profile in place, even
when a `BrainLens Desktop` directory also exists. With no legacy profile it
uses `BrainLens Desktop`. An explicit `--user-data-dir` is handled by Electron.
If the OS cannot decrypt a stored credential, reading its status leaves the
ciphertext intact and the settings panel offers key entry.
