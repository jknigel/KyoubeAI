import { useEffect, useState } from "react";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { PLUGINS_SETTINGS_PATH, type LicenceStatusAnswer, type LicenceView } from "../shared.js";

/** The chip's text when the licence needs an admin's attention; null otherwise. */
export function chipLabel(view: LicenceView): string | null {
  const { status } = view;
  if (!status.needsAttention) return null;
  if (status.state === "expired") return "Licence expired";
  if (status.state === "invalid") return "Licence key not valid";
  if (status.atLimit) return `Users ${status.userCount}/${status.limit}`;
  if (status.expiringSoon && status.daysLeft !== null) return `Licence: ${status.daysLeft}d left`;
  return null;
}

/**
 * A small link at the end of the breadcrumb bar, shown only to instance admins
 * and only when the licence needs attention. Everyone else, and an admin with
 * nothing to fix, sees nothing.
 */
export function LicenceChip(_props: { context?: PluginHostContext }) {
  const navigation = useHostNavigation();
  const status = usePluginAction("license.status");
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    status({}).then((result) => {
      const answer = result as LicenceStatusAnswer;
      if (!cancelled) setLabel(answer.visible ? chipLabel(answer) : null);
    }, () => { if (!cancelled) setLabel(null); });
    return () => { cancelled = true; };
  }, [status]);
  if (!label) return null;
  return (
    <a
      {...navigation.linkProps(PLUGINS_SETTINGS_PATH)}
      title="Open Settings → Plugins → KyoubeAI Licence"
      className="inline-flex h-8 items-center rounded-md border border-amber-500/50 bg-amber-500/10 px-2 text-xs font-medium text-foreground hover:bg-amber-500/20"
    >
      {label}
    </a>
  );
}
