import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("shift+alt+enter", {
    description: 'Send "continue" when the agent is stopped',
    handler: (ctx) => {
      if (ctx.isIdle()) pi.sendUserMessage("continue");
    },
  });
}
