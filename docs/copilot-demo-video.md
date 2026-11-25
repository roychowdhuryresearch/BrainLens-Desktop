# Co-pilot demo video — story, shot list, narration & recording guide

A repeatable, screen-recordable demo where a clinician **talks to the built-in AI co-pilot in BrainLens Desktop**
and it drives the whole UI — loading nothing fake, using the real model + real scientific backend on a
real epilepsy recording.

**What the story proves (two audiences at once):**
- **Clinical / research** — an HFO (high-frequency oscillation) surgical work-up done conversationally:
  read the signal → QC → set the ripple band → detect → annotate → name the strongest HFO generators.
- **Technical / AI** — an LLM agent that *operates* a serious app: it really *sees* the waveform (VLM on
  the canvas), reasons over tool results, writes visible controls, and — the differentiator — **every
  data-changing action is STAGED for a human Apply**. Reads are free; writes are gated.

Driver: the app's **own co-pilot chat** (`qa:copilot-demo`). Take style: real model, paced for voiceover,
re-runnable. The harness counts you in, types each prompt on camera, holds on each beat, lingers on the
human-approval gate, and writes `artifacts/copilot-demo/cues.json` (per-beat timecodes) + a screenshot
storyboard so you can cut/caption in post.

---

## Pre-flight checklist

1. **Build** (once): `cd desktop && npm run build`
2. **Model**. Configure `qwen3.5-plus` in the local desktop profile or use
   the example user configuration with `DASHSCOPE_API_KEY` in the environment.
   The model must be reachable from the demo machine.
3. **Quiet the desktop**: macOS Do Not Disturb on; quit chatty apps; hide secrets/other windows.
4. **Screen recorder**: `⌘⇧5` → *Record Selected Window* (pick the Electron window) — or QuickTime →
   *New Screen Recording*. For live narration enable the mic; or record voice separately and dub.
5. **Frame**: the window auto-sizes to **1440×900** at (60,60) (`DEMO_WINDOW=` to disable / resize).

## Run it

```bash
cd desktop
npm run qa:copilot-demo
```

It boots the app + both backends (~60s), loads the EDF, then prints **“START YOUR SCREEN RECORDER NOW”**
and counts down 8s — start recording during the count-in. The story then plays beat by beat. When it
finishes it leaves the Actions ledger up briefly, then exits. Stop your recorder.

**Pacing / re-take knobs** (env):

| Env | Default | Effect |
|---|---|---|
| `DEMO_ONLY=look,detect` | (all) | film only these beats (load always happens) — great for re-shooting one beat |
| `DEMO_START_HOLD_MS` | 8000 | count-in before the story starts |
| `DEMO_TYPE_DELAY` | 30 | ms per typed character (the “typing” feel) |
| `DEMO_SETTLE` | 3500 | hold after a reply lands (reading time) |
| `DEMO_GATE_PAUSE` | 4500 | hold on a STAGED command before Apply (the HITL beat) |
| `DEMO_RESULT_PAUSE` | 4000 | hold after Apply |
| `DEMO_GATE_MANUAL=1` | off | don’t auto-click Apply — **you** click it on camera (waits up to `DEMO_GATE_WAIT`) |
| `PYHFO_ELECTRON_REAL_FIXTURE_RECORDING` | umf001 EDF | film a different recording |

---

## Shot list & narration

Beats match the harness `key`s and `cues.json`. VO is Chinese (primary); UI text stays English.
Recording: `data/Omni-iEEG/sub-sourcesinkumf001 … task-interictalasleep_run-01_ieeg.edf` (real, interictal asleep).

### 0 · Intro — `baseline-loaded`
- **On screen**: the loaded waveform; co-pilot chat open, empty.
- **VO (中文)**: “这是一段真实的癫痫患者颅内脑电记录。平时,医生要手动翻波形、跑检测、一个个看高频振荡,很耗时。今天换种方式——我直接和 AI co-pilot 对话,让它来开整个软件。”
- **VO (EN alt)**: “A real intracranial EEG from an epilepsy-surgery work-up. Instead of clicking through it by hand, I’ll just talk to the app’s AI co-pilot.”

### 1 · Look at the signal — `look`  *(vision)*
- **On screen**: prompt types out; agent replies, may move the viewport.
- **VO**: “我先问:看看屏幕上的波形,有什么异常?——它是真的‘看’了波形图,指出了高频爆发和坏道。”
- **Proves**: clinical HFO/坏道判读 · technical = VLM reads the actual canvas pixels (`inspect_waveform`).

### 2 · Quality control — `qc`  *(tool + reasoning)*
- **VO**: “再让它做质控,检查工频和 Nyquist 极限,判断哪些通道能用、要不要陷波。它调用科学后端,再用人话给结论。”
- **Proves**: clinical QC/notch decision · technical = agent calls PyHFO tools and reasons over the result.

### 3 · Set the ripple band — `detector`  *(visible control write)*
- **On screen**: agent replies, then the view walks into the **Prepare** panel — `fp/fs/notch` now read **80 / 250 / 60**.
- **VO**: “我说:把滤波带设成 80 到 250 赫兹,陷波 60。注意——它没有口头答应,而是真的去改了 Prepare 面板上的参数。”
- **Proves**: technical = the agent writes *visible* controls, not just chat · clinical = the ripple band.

### 4 · Configure the classifier — `classifier`  *(optional, technical)*
- **VO**: “顺手把分类器设成 CPU、batch 64。”  *(trim with `DEMO_ONLY` for a tighter cut.)*

### 5 · Run detection — `detect`  ⭐ **the gate (highlight this beat)**
- **On screen**: agent **STAGES** `detection.run`; the staged card + **Apply** sit visible; then Apply → events appear.
- **VO**: “现在跑 HFO 检测。关键来了——它不会自己执行,而是把命令‘暂存’,等我点 Apply。读操作免费,写操作必须人来把关。我点一下,检测才真正跑。”
- **VO (EN alt)**: “Here’s the important part: it doesn’t run compute on its own — it *stages* the command and waits for me to approve. Reads are free; writes are gated.”
- **Proves**: BOTH — the trust/safety differentiator. Human-in-the-loop. *(Use `DEMO_GATE_MANUAL=1` to click Apply yourself on camera.)*

### 6 · Annotate an event — `annotate`  *(gated write)*
- **VO**: “把第一个检测到的事件标成 confirmed HFO——同样,先暂存,我确认后才写入。”
- **Proves**: review writes are gated too.

### 7 · Final verdict — `verdict`  *(autonomous routing)*
- **On screen**: open question; agent plans + chains tools, then concludes.
- **VO**: “最后给它一个开放问题:这段记录适合做 HFO 分析吗?哪些通道是最强的发生源?它自己规划、串联工具,给出最终判断。”
- **Proves**: L3 autonomous routing · clinical = candidate seizure-onset channels.

### 8 · Outro — `final-actions-ledger`
- **On screen**: the Actions panel — the full list of what the agent did, each write with its approval.
- **VO**: “整场下来,我没点过一次菜单——全程对话。而每一个会改变数据的动作,都有记录、都经过我批准。AI co-pilot 替你跑流程,你保留判断权。”

---

## Editing notes

- **Timecodes**: `artifacts/copilot-demo/cues.json` has `t_start_s` / `t_end_s` per beat (relative to “rolling”) + the reply text — drop captions/lower-thirds straight onto those offsets.
- **Lower-thirds**: surface the command type as it happens — e.g. `detection.run · staged → applied`, `detection.set_parameters · applied` — so the “agent action” is legible.
- **Highlight beat 5**: a slow push-in / brief slow-mo on the *staged → Apply* moment sells the safety story better than anything spoken.
- **Length**: full cut ≈ 2–3 min. Tight 60–75s cut = beats `look → detector → detect → verdict` (`DEMO_ONLY=look,detector,detect,verdict`).
- **UI stays English, VO/captions Chinese** — consistent with the project rule that app strings never localize.

## Re-takes (the model is non-deterministic)

- A beat fumbled (replied text-only / skipped a tool)? Just re-run — the capable model is already pinned. To re-shoot one beat: `DEMO_ONLY=<key>`.
- Replies too long to read? raise `DEMO_SETTLE`. Want a longer pause on the gate? raise `DEMO_GATE_PAUSE`.
- Same harness, asserted variant, if you want an evidence report instead of a film: `npm run qa:copilot-deep`.
