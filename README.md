# <img src="icon.svg" width="36" height="36" alt="" align="absmiddle"> cue9 mote

**A DeepSeek Harness plugin that puts what your agents are doing on a small desk companion.**

dsh-cue9-mote watches DSH activity and sends the matching animation to a desk companion over USB. When the agent needs an approval or has a question, the animation stays in your peripheral vision until you answer. You don't have to keep watching the DSH while the agent works.

This plugin is part of a larger ecosystem managed via the macOS control app — live view, action-to-animation mapping, colours, preview,
and firmware flashing — available at [awychoi/cue9](https://github.com/awychoi/cue9).

## Install

1. In DSH, open **Plugins → Add plugin**.
2. Enter `https://github.com/awychoi/dsh-cue9-mote`, or the absolute path to a local checkout.
3. Enable the bundle and connect the mote over USB.

The bridge needs Python 3 with `pyserial`. It uses `/usr/local/bin/python3` by default;
set `CUE9_PYTHON` to another interpreter. `CUE9_PORT` pins a serial port.

## License

MIT. Copyright © 2026 awychoi.

Not affiliated with DeepSeek.
