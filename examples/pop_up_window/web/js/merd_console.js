/* ==========================================================================
   ComfyUI extension shim for ANT's MERD Records Consolidator.
   Adds one button to the node that opens the console in an independent tab —
   the console is a full page, not a panel, because a 193-field document does
   not fit in a node widget and pretending otherwise would make it unusable.
   ========================================================================== */
import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "ANT_NODES.MERD.Console",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "ANT_MERD_Records_Consolidator") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;

      this.addWidget("button", "OPEN MERD CONSOLE", null, () => {
        window.open("/ant_merd/console", "_blank", "noopener");
      });

      this.addWidget("button", "check backend", null, async () => {
        try {
          const res = await fetch("/ant_merd/api/bootstrap");
          const body = await res.json();
          if (!res.ok || body.ok === false) throw new Error(body.error || res.status);
          alert(
            `MERD console is up.\n\n` +
            `registry: ${body.registry_dir}\n` +
            `${body.configs.length} config(s) saved\n` +
            `${body.scanned.length} model(s) seen in ComfyUI` +
            (body.scan_ok ? "" : `\n\nscan failed: ${body.scan_error}`)
          );
        } catch (e) {
          alert(
            "MERD console backend did not answer:\n" + e.message +
            "\n\nCheck the ComfyUI console for a MERD route registration error."
          );
        }
      });

      this.size = this.computeSize();
      return r;
    };
  },
});
